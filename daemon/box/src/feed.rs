//! The owner's view: `GET /api/wired` with the person's own token, published
//! as a `watch` value the window draws. It runs on the daemon's Tokio
//! runtime. The route is a person's own read, so an agent's token is
//! refused; that is said once and polling stops.
//!
//! It reads again when the owner's live socket (COPL-62) says a board, the
//! person's boards or their agents changed (a board only when the change could
//! show here: COPL-151, `Due::of`), soon after any of this daemon's
//! runs starts or ends, and on a clock: every fifteen seconds while the
//! socket is down, every two minutes while it is up (a claim that lapses
//! sends nothing, and the hub keeps nothing for a socket that was away).
//! Reads are at least `SPACING` apart however often it is woken (COPL-209):
//! a burst, or a socket that keeps dropping, is one read a window, trailing,
//! covering everything that came in meanwhile.
//!
//! A board change that names its tasks reads just those (COPL-211:
//! `/api/wired?tasks=`) and sorts them onto the last whole read (`merge`);
//! the whole of it is read again for a change that names none, for the
//! person's boards, agents or people, on the clock, after a run here, and
//! whenever the tasks alone can't say what the whole would (`merge`).
//!
//! With the same token it also reads what the menu and the bell show (COPL-64,
//! COPL-65), each when its topic says it changed and on the same clock: the
//! person's unread mentions and their agents' messages (`/api/inbox?unread=true`, "inbox";
//! messages since COPL-109), their boards
//! (`/api/boards`, "boards") and their theme (`/api/settings`, "settings").
//! After each read the notifier decides whether anything new needs saying.

use std::cmp::Ordering as Cmp;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use copland_daemon_core::Status;
use copland_daemon_core::api::{Api, BoardRef, InboxItem, WIRED_MAX_TASKS, Wired, WiredPart, WiredTask};
use copland_daemon_core::config::Owner;
use copland_daemon_core::live::{self, Burst, Heard, Link};
use tokio::sync::{Notify, watch};

use crate::notify::{Desktop, Notifier};

/// How often it reads when nothing happens here and the live socket is down.
pub const EVERY: Duration = Duration::from_secs(15);
/// How often it reads anyway while the live socket is up.
pub const EVERY_LIVE: Duration = Duration::from_secs(120);
/// After a run starts or ends, a moment for its claim or its last moves to land before reading.
const SETTLE: Duration = Duration::from_secs(2);
/// Reads are at least this far apart, however often the live socket asks or drops (COPL-209):
/// a busy board's burst is one read, trailing, with whatever else came in meanwhile.
pub const SPACING: Duration = Duration::from_secs(5);
/// What wakes a quiet feed waits this long for the rest of its burst.
pub const QUICK: Duration = Duration::from_millis(300);
/// The unread inbox is read at most this many pages of a hundred.
const INBOX_PAGES: usize = 3;

/// What `/api/wired` is made of: tasks on boards (board), which boards the person is on
/// (boards), their agents' names and pauses (agents). Handles are in "people". The person's
/// inbox and settings are the bell's and the theme's.
fn wanted(topic: &str) -> bool {
    matches!(topic, "board" | "boards" | "agents" | "people" | "inbox" | "settings")
}

/// What a wake should read again.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Due {
    /// The whole of `/api/wired`.
    pub wired: bool,
    /// Just these tasks of it, when the whole isn't due (COPL-211).
    pub tasks: BTreeSet<String>,
    pub inbox: bool,
    pub boards: bool,
    pub settings: bool,
}

impl Due {
    pub const ALL: Due = Due {
        wired: true,
        tasks: BTreeSet::new(),
        inbox: true,
        boards: true,
        settings: true,
    };

    /// What a burst of live messages asks to read, given the last `/api/wired` read (none yet:
    /// read it). A board change that says which tasks it touched (COPL-151) reads those of them
    /// /wired shows, or all of them when one of the agents is, or was, assigned to one (COPL-211):
    /// every task it can show is assigned to one of them, so a change to anything else can't show
    /// here. One that doesn't say, or touches too many, reads the whole.
    pub fn of(burst: &Burst, wired: Option<&Wired>) -> Due {
        let has = |t: &str| burst.contains(t);
        let (whole, tasks) = match (has("board"), &burst.touched, wired) {
            (false, _, _) => (false, BTreeSet::new()),
            (true, Some(touched), Some(w)) => {
                let tasks: BTreeSet<String> = if w.agents.iter().any(|a| touched.assignees.contains(&a.id)) {
                    touched.tasks.clone()
                } else {
                    shown(w)
                        .filter(|t| touched.tasks.contains(&t.id))
                        .map(|t| t.id.clone())
                        .collect()
                };
                (tasks.len() > WIRED_MAX_TASKS, tasks)
            }
            (true, _, _) => (true, BTreeSet::new()),
        };
        let whole = whole || has("boards") || has("agents") || has("people");
        Due {
            wired: whole,
            tasks: if whole { BTreeSet::new() } else { tasks },
            inbox: has("inbox"),
            boards: has("boards"),
            settings: has("settings"),
        }
    }

    fn add(&mut self, o: Due) {
        self.wired |= o.wired;
        self.tasks.extend(o.tasks);
        if self.wired || self.tasks.len() > WIRED_MAX_TASKS {
            self.wired = true;
            self.tasks.clear();
        }
        self.inbox |= o.inbox;
        self.boards |= o.boards;
        self.settings |= o.settings;
    }
}

/// Every task the read shows, on any pole.
fn shown(w: &Wired) -> impl Iterator<Item = &WiredTask> {
    [&w.todo, &w.doing, &w.blocked, &w.done].into_iter().flatten()
}

/// Sorts a read of some tasks onto the last whole read, in the order the server keeps each pole
/// (`sort` in `src/worker/routes/wired.ts`): todo and blocked by board, stage and rank, doing live
/// first and oldest first, done newest first and at most `done_limit`. False, leaving `w` as it
/// was, when only the whole read can say what it would: while done holds fewer than its count
/// (the rest are past its limit), a task that wasn't shown and now is may be one of those, and a
/// done one that leaves takes its place from them.
pub fn merge(w: &mut Wired, part: WiredPart) -> bool {
    let asked: BTreeSet<&str> = part.tasks.iter().map(String::as_str).collect();
    let capped = (w.done_count as usize) > w.done.len();
    let returned: BTreeSet<&str> = [&part.todo, &part.doing, &part.blocked, &part.done]
        .into_iter()
        .flatten()
        .map(|t| t.id.as_str())
        .collect();
    let left_done = w
        .done
        .iter()
        .filter(|t| asked.contains(t.id.as_str()) && !part.done.iter().any(|d| d.id == t.id))
        .count();
    if capped && (left_done > 0 || returned.iter().any(|id| !shown(w).any(|t| t.id == *id))) {
        return false;
    }
    let was_done = w.done.iter().filter(|t| asked.contains(t.id.as_str())).count();
    for pole in [&mut w.todo, &mut w.doing, &mut w.blocked, &mut w.done] {
        pole.retain(|t| !asked.contains(t.id.as_str()));
    }
    let added_done = part.done.len();
    w.todo.extend(part.todo);
    w.doing.extend(part.doing);
    w.blocked.extend(part.blocked);
    w.done.extend(part.done);
    let by_place = |a: &WiredTask, b: &WiredTask| {
        a.board_id
            .cmp(&b.board_id)
            .then(a.stage.cmp(&b.stage))
            .then(a.rank.partial_cmp(&b.rank).unwrap_or(Cmp::Equal))
    };
    let since = |t: &WiredTask| t.since.clone().unwrap_or_default();
    w.todo.sort_by(by_place);
    w.blocked.sort_by(by_place);
    w.doing
        .sort_by(|a, b| b.live.cmp(&a.live).then_with(|| since(a).cmp(&since(b))));
    w.done.sort_by_key(|t| std::cmp::Reverse(since(t)));
    w.done_count = (w.done_count as usize - was_done + added_done) as u32;
    w.done_limit = part.done_limit;
    w.done.truncate(part.done_limit as usize);
    true
}

/// When to read after a wake at `now`, the last read having ended at `since`: a moment for the
/// rest of the burst, and never inside the last read's window.
pub fn read_at(since: tokio::time::Instant, now: tokio::time::Instant) -> tokio::time::Instant {
    (since + SPACING).max(now + QUICK)
}

/// The clock's interval for a socket state.
pub fn every(link: Link) -> Duration {
    if link == Link::Connected { EVERY_LIVE } else { EVERY }
}

#[derive(Debug, Clone, Default)]
pub struct Feed {
    /// The instance it reads, for links.
    pub url: String,
    /// The person the token is, once asked ("berker-z").
    pub who: Option<String>,
    /// The last good read, and when (wall clock) it was taken.
    pub wired: Option<(Wired, SystemTime)>,
    /// What went wrong with the last read, cleared by a good one.
    pub error: Option<String>,
    /// The token can't be used for this at all; nothing more will be read.
    pub refused: bool,
    /// The owner's live socket.
    pub live: Link,
    /// The person's unread mentions and messages (from their agents), newest first, once read.
    pub inbox: Option<Vec<InboxItem>>,
    /// The boards the person is on, once read.
    pub boards: Option<Vec<BoardRef>>,
    /// The person's theme in Copland, once read.
    pub theme: Option<String>,
}

/// What the feed tells you about on the desktop, besides drawing it: the notifier, where the
/// notes go, and whether they are wanted right now (the settings panel's switch).
pub struct Notices {
    pub notifier: Notifier,
    pub desktop: Desktop,
    pub enabled: Arc<AtomicBool>,
}

/// Whether the box's live sockets are up, for the status line: the running agents' and the
/// owner's (unless its token was refused). Some(false) once any is down, Some(true) when all
/// are up, None while none has connected or failed yet (nothing to say).
pub fn links_up(st: &Status, feed: Option<&Feed>) -> Option<bool> {
    let links: Vec<Link> = st
        .agents
        .iter()
        .filter(|a| a.state != "stopped" && !a.retiring)
        .map(|a| a.link())
        .chain(feed.filter(|f| !f.refused).map(|f| f.live))
        .collect();
    if links.contains(&Link::Reconnecting) {
        Some(false)
    } else if !links.is_empty() && links.iter().all(|l| *l == Link::Connected) {
        Some(true)
    } else {
        None
    }
}

/// The runs each agent has going: a change means a run started or ended.
fn runs(st: &Status) -> Vec<Vec<String>> {
    st.agents
        .iter()
        .map(|a| a.runs.iter().map(|r| r.run.clone()).collect())
        .collect()
}

/// Resolves once some agent's run has started or ended (never, once the daemon is gone).
async fn run_changed(daemon: &mut watch::Receiver<Status>, seen: &mut Vec<Vec<String>>) {
    loop {
        if daemon.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
        let now = runs(&daemon.borrow_and_update());
        if &now != seen {
            *seen = now;
            return;
        }
    }
}

/// The owner's live socket, for as long as the returned task lives (it is aborted when the
/// feed stops). Its state goes into the feed; what it hears is added to `due` and wakes `wake`.
fn listen(
    owner: &Owner,
    tx: watch::Sender<Feed>,
    due: Arc<Mutex<Due>>,
    wake: Arc<Notify>,
) -> tokio::task::JoinHandle<()> {
    let (base, token) = (owner.url.clone(), owner.token.clone());
    /* What /wired last showed, for whether a board change could show there. */
    let shown = tx.subscribe();
    tokio::spawn(async move {
        live::listen(
            &base,
            &token,
            None,
            wanted,
            move |l| {
                tx.send_if_modified(|f| {
                    let changed = f.live != l;
                    f.live = l;
                    changed
                });
            },
            move |h| {
                let d = match &h {
                    Heard::Topics(b) => {
                        let d = Due::of(b, shown.borrow().wired.as_ref().map(|(w, _)| w));
                        tracing::debug!(?b, ?d, "live: what to read again");
                        d
                    }
                    Heard::Resync => Due::ALL,
                };
                due.lock().expect("not poisoned").add(d);
                wake.notify_one();
            },
        )
        .await
    })
}

struct Abort(tokio::task::JoinHandle<()>);

impl Drop for Abort {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// What the bell lists from the person's inbox: mentions and messages.
fn wanted_item(i: &InboxItem) -> bool {
    matches!(i.kind.as_str(), "mentioned" | "message")
}

/// The person's unread mentions and messages, newest first: a few pages of their unread inbox at most.
async fn unread(api: &Api, owner: &Owner) -> Result<Vec<InboxItem>, copland_daemon_core::api::ApiError> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..INBOX_PAGES {
        let page = api.inbox_unread(&owner.token, 100, cursor.as_deref()).await?;
        out.extend(page.items.into_iter().filter(wanted_item));
        match page.next {
            Some(n) => cursor = Some(n),
            None => break,
        }
    }
    Ok(out)
}

pub async fn run(
    owner: Owner,
    tx: watch::Sender<Feed>,
    mut daemon: watch::Receiver<Status>,
    mut notices: Option<Notices>,
) {
    let refuse = |why: String| {
        tracing::error!("{why}");
        tx.send_modify(|f| {
            f.error = Some(why);
            f.refused = true;
        });
    };
    let api = match Api::new(&owner.url) {
        Ok(api) => api,
        Err(e) => return refuse(format!("owner token: {e:#}")),
    };
    let mut seen = runs(&daemon.borrow());
    let mut checked = false;
    let mut said: Option<String> = None;
    /* The same failure every poll (server down) is logged once, until it changes. */
    let fail = |message: String, said: &mut Option<String>| {
        if said.as_deref() != Some(message.as_str()) {
            tracing::warn!("{message}");
        }
        tx.send_modify(|f| f.error = Some(message.clone()));
        *said = Some(message);
    };
    let wake = Arc::new(Notify::new());
    let due = Arc::new(Mutex::new(Due::ALL));
    let _socket = Abort(listen(&owner, tx.clone(), due.clone(), wake.clone()));
    let mut link = tx.subscribe();
    /* The extra reads' failures are quieter: logged once each until they change. */
    let mut extra_said: [Option<String>; 3] = Default::default();
    let quiet = |said: &mut Option<String>, what: &str, e: String| {
        if said.as_deref() != Some(e.as_str()) {
            tracing::warn!("reading {what}: {e}");
            *said = Some(e);
        }
    };
    loop {
        let mut now = std::mem::take(&mut *due.lock().expect("not poisoned"));
        if !checked {
            /* /api/wired would refuse an agent's token too, but this says why. */
            match api.me(&owner.token).await {
                Ok(me) if me.user.kind != "person" => {
                    return refuse(format!(
                        "owner_token is @{}, an agent; the box needs your own token for done and blocked",
                        me.user.handle
                    ));
                }
                Ok(me) => {
                    tracing::info!(url = %owner.url, "reading your agents' work as @{}", me.user.handle);
                    tx.send_modify(|f| f.who = Some(me.user.handle.clone()));
                    checked = true;
                }
                Err(e) if e.is_refusal() => return refuse(format!("owner token refused: {e}")),
                Err(e) => fail(format!("asking who the owner token is: {e}"), &mut said),
            }
        }
        /* Until the first good look at who it is, everything is still due. */
        if !checked {
            now = Due::ALL;
        }
        /* Just the tasks a change named (COPL-211); the whole when they can't say (`merge`). */
        if checked && !now.wired && !now.tasks.is_empty() {
            let tasks: Vec<String> = now.tasks.iter().cloned().collect();
            let last = tx.borrow().wired.as_ref().map(|(w, _)| w.clone());
            now.wired = match (last, api.wired_tasks(&owner.token, &tasks).await) {
                (Some(mut w), Ok(part)) => {
                    let merged = merge(&mut w, part);
                    if merged {
                        tx.send_modify(|f| {
                            f.wired = Some((w, SystemTime::now()));
                            f.error = None;
                        });
                    }
                    !merged
                }
                (_, Err(e)) => {
                    tracing::debug!("reading some of /api/wired: {e}; reading it whole");
                    true
                }
                (None, Ok(_)) => true,
            };
        }
        if checked && now.wired {
            match api.wired(&owner.token).await {
                Ok(w) => {
                    if said.take().is_some() {
                        tracing::info!("reading your agents' work again");
                    }
                    tx.send_modify(|f| {
                        f.wired = Some((w, SystemTime::now()));
                        f.error = None;
                    });
                }
                Err(e) if e.is_refusal() => return refuse(format!("reading /api/wired: {e}")),
                Err(e) => fail(format!("reading /api/wired: {e}"), &mut said),
            }
        }
        if checked && now.inbox {
            match unread(&api, &owner).await {
                Ok(m) => {
                    extra_said[0] = None;
                    tx.send_modify(|f| f.inbox = Some(m));
                }
                Err(e) => quiet(&mut extra_said[0], "your inbox", e.to_string()),
            }
        }
        if checked && now.boards {
            match api.boards(&owner.token).await {
                Ok(b) => {
                    extra_said[1] = None;
                    tx.send_modify(|f| f.boards = Some(b));
                }
                Err(e) => quiet(&mut extra_said[1], "your boards", e.to_string()),
            }
        }
        if checked && now.settings {
            match api.settings(&owner.token).await {
                Ok(s) => {
                    extra_said[2] = None;
                    tx.send_if_modified(|f| {
                        let changed = f.theme.as_deref() != Some(s.theme.as_str());
                        f.theme = Some(s.theme.clone());
                        changed
                    });
                }
                Err(e) => quiet(&mut extra_said[2], "your settings", e.to_string()),
            }
        }
        if let Some(n) = notices.as_mut() {
            let notes = n.notifier.check(&tx.borrow());
            if n.enabled.load(Ordering::Relaxed) {
                for note in notes {
                    n.desktop.send(note);
                }
            }
        }
        /* Until the clock (whose interval follows the socket), the socket, or a run here. */
        let since = tokio::time::Instant::now();
        loop {
            let up = link.borrow_and_update().live;
            tokio::select! {
                _ = tokio::time::sleep_until(since + every(up)) => {
                    due.lock().expect("not poisoned").add(Due::ALL);
                    break;
                }
                _ = wake.notified() => {
                    /* A busy board sends a burst; one read every SPACING at most answers it. */
                    tokio::time::sleep_until(read_at(since, tokio::time::Instant::now())).await;
                    break;
                }
                _ = run_changed(&mut daemon, &mut seen) => {
                    tokio::time::sleep(SETTLE).await;
                    tokio::time::sleep_until(since + SPACING).await;
                    due.lock().expect("not poisoned").wired = true;
                    break;
                }
                changed = link.changed() => {
                    let now = link.borrow().live;
                    /* Gone down: anything could have been missed, so read, but no sooner than the
                       window allows: a network that keeps dropping is one read a window. */
                    if changed.is_err() || (up == Link::Connected && now != Link::Connected) {
                        tokio::time::sleep_until(read_at(since, tokio::time::Instant::now())).await;
                        due.lock().expect("not poisoned").add(Due::ALL);
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polls_slowly_only_while_the_socket_is_up() {
        assert_eq!(every(Link::Connected), EVERY_LIVE);
        assert_eq!(every(Link::Reconnecting), EVERY);
        assert_eq!(every(Link::Connecting), EVERY);
        assert!(wanted("board") && wanted("agents") && wanted("boards"));
        assert!(wanted("inbox") && wanted("settings") && !wanted("vault") && !wanted("notes"));
    }

    #[test]
    fn a_burst_is_one_read_a_window() {
        use tokio::time::Instant;
        assert!(SPACING >= Duration::from_secs(5));
        let since = Instant::now();
        /* Woken just after a read: wait for the window's end, so the rest of the burst goes in it. */
        assert_eq!(read_at(since, since + Duration::from_millis(100)), since + SPACING);
        assert_eq!(read_at(since, since + SPACING - QUICK), since + SPACING);
        /* Woken after a quiet spell: a moment for the rest of the burst, then read. */
        let later = since + SPACING * 3;
        assert_eq!(read_at(since, later), later + QUICK);
    }

    #[test]
    fn each_topic_reads_only_what_it_changed() {
        let of = |t: &[&str]| {
            let burst = Burst {
                topics: t.iter().map(|s| s.to_string()).collect(),
                touched: None,
            };
            Due::of(&burst, None)
        };
        assert_eq!(
            of(&["board"]),
            Due {
                wired: true,
                ..Default::default()
            }
        );
        assert_eq!(
            of(&["inbox"]),
            Due {
                inbox: true,
                ..Default::default()
            }
        );
        assert_eq!(
            of(&["boards", "settings"]),
            Due {
                wired: true,
                boards: true,
                settings: true,
                ..Default::default()
            }
        );
        let mut d = Due::default();
        d.add(of(&["inbox"]));
        d.add(of(&["agents"]));
        assert!(d.inbox && d.wired && !d.boards);
    }

    #[test]
    fn a_board_change_reads_wired_only_when_it_could_show_there() {
        use copland_daemon_core::api::{WiredAgent, WiredTask};
        use copland_daemon_core::live::Touched;
        let task = |id: &str| WiredTask {
            id: id.into(),
            board_id: "b".into(),
            key: "B-1".into(),
            title: "t".into(),
            agent_id: "dev".into(),
            since: None,
            live: false,
            host: None,
            stage: 0,
            rank: 0.0,
        };
        let wired = Wired {
            agents: vec![WiredAgent {
                id: "dev".into(),
                handle: "me/dev".into(),
                name: "dev".into(),
                paused: false,
                hosts: Vec::new(),
                live_on_two_hosts: false,
            }],
            todo: vec![task("t-todo")],
            doing: vec![],
            blocked: vec![],
            done: vec![task("t-done")],
            done_count: 1,
            done_window_hours: 24,
            done_limit: 20,
        };
        let set = |v: &[&str]| v.iter().map(|s| s.to_string()).collect();
        let board = |tasks: &[&str], assignees: &[&str]| Burst {
            topics: set(&["board"]),
            touched: Some(Touched {
                tasks: set(tasks),
                assignees: set(assignees),
            }),
        };
        /* What it reads: the whole of /api/wired, or just these tasks of it. */
        let reads = |b: &Burst, w: Option<&Wired>| {
            let d = Due::of(b, w);
            (d.wired, d.tasks.into_iter().collect::<Vec<_>>())
        };
        let none = (false, Vec::<String>::new());
        let just = |ids: &[&str]| (false, ids.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        let whole = (true, Vec::<String>::new());
        /* Someone else's task, with nobody of yours on it: nothing to read. */
        assert_eq!(reads(&board(&["other"], &["kim"]), Some(&wired)), none);
        assert_eq!(reads(&board(&[], &[]), Some(&wired)), none);
        /* A task it shows, done ones too: just that one (COPL-211), not the others it touched. */
        assert_eq!(
            reads(&board(&["t-todo", "other"], &[]), Some(&wired)),
            just(&["t-todo"])
        );
        assert_eq!(reads(&board(&["t-done"], &["kim"]), Some(&wired)), just(&["t-done"]));
        /* One of your agents on it, before or after: newly assigned, or out of backlog. Every
        task touched, since which of them it is on isn't said. */
        assert_eq!(
            reads(&board(&["new", "t-todo"], &["kim", "dev"]), Some(&wired)),
            just(&["new", "t-todo"])
        );
        /* Nothing read yet, or a burst that didn't say what it touched: the whole. */
        assert_eq!(reads(&board(&["other"], &[]), None), whole);
        let unsaid = Burst {
            topics: set(&["board"]),
            touched: None,
        };
        assert_eq!(reads(&unsaid, Some(&wired)), whole);
        /* Too many tasks for one narrow read: the whole. */
        let many: Vec<String> = (0..=WIRED_MAX_TASKS).map(|n| format!("n{n}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert_eq!(reads(&board(&many, &["dev"]), Some(&wired)), whole);
        /* Other topics still read it whole, whatever the board part says. */
        let mut agents = board(&["t-todo"], &[]);
        agents.topics.insert("agents".into());
        assert_eq!(reads(&agents, Some(&wired)), whole);
        /* And a burst with no board in it reads nothing for the board's sake. */
        let inbox = Burst {
            topics: set(&["inbox"]),
            touched: Some(Touched::default()),
        };
        assert_eq!(reads(&inbox, Some(&wired)), none);
        /* Bursts add up: tasks gather until there are too many, or the whole is due. */
        let mut d = Due::of(&board(&["t-todo"], &[]), Some(&wired));
        d.add(Due::of(&board(&["t-done"], &[]), Some(&wired)));
        assert_eq!((d.wired, d.tasks.len()), (false, 2));
        d.add(Due::of(&agents, Some(&wired)));
        assert!(d.wired && d.tasks.is_empty());
        let mut d = Due::default();
        for n in 0..=WIRED_MAX_TASKS {
            d.add(Due {
                tasks: [format!("n{n}")].into(),
                ..Default::default()
            });
        }
        assert!(d.wired && d.tasks.is_empty());
    }

    fn at(id: &str, board: &str, stage: u32, rank: f64, since: Option<&str>, live: bool) -> WiredTask {
        WiredTask {
            id: id.into(),
            board_id: board.into(),
            key: format!("{board}-{id}"),
            title: id.into(),
            agent_id: "dev".into(),
            since: since.map(str::to_string),
            live,
            host: None,
            stage,
            rank,
        }
    }

    fn whole(todo: Vec<WiredTask>, doing: Vec<WiredTask>, done: Vec<WiredTask>, done_count: u32) -> Wired {
        Wired {
            agents: Vec::new(),
            todo,
            doing,
            blocked: Vec::new(),
            done,
            done_count,
            done_window_hours: 24,
            done_limit: 2,
        }
    }

    fn part(tasks: &[&str], todo: Vec<WiredTask>, doing: Vec<WiredTask>, done: Vec<WiredTask>) -> WiredPart {
        WiredPart {
            tasks: tasks.iter().map(|s| s.to_string()).collect(),
            todo,
            doing,
            blocked: Vec::new(),
            done,
            done_limit: 2,
        }
    }

    fn ids(pole: &[WiredTask]) -> Vec<&str> {
        pole.iter().map(|t| t.id.as_str()).collect()
    }

    #[test]
    fn some_tasks_read_sort_onto_the_whole_as_the_server_would() {
        let mut w = whole(
            vec![
                at("a", "b1", 1, 1.0, None, false),
                at("c", "b1", 1, 3.0, None, false),
                at("z", "b2", 1, 0.0, None, false),
            ],
            vec![
                at("live", "b1", 2, 0.0, Some("2026-10-27T10:00:00Z"), true),
                at("idle", "b1", 2, 5.0, None, false),
            ],
            vec![at("old", "b1", 4, 0.0, Some("2026-10-27T08:00:00Z"), false)],
            1,
        );
        /* c moves up between a and the rest; a is claimed, and its claim is newer than live's. */
        let p = part(
            &["a", "c"],
            vec![at("c", "b1", 1, 0.5, None, false)],
            vec![at("a", "b1", 2, 1.0, Some("2026-10-27T11:00:00Z"), true)],
            vec![],
        );
        assert!(merge(&mut w, p));
        assert_eq!(ids(&w.todo), ["c", "z"]);
        assert_eq!(ids(&w.doing), ["live", "a", "idle"]);
        /* idle is done, newest first; z leaves every pole (moved to backlog, or unassigned). */
        let p = part(
            &["idle", "z"],
            vec![],
            vec![],
            vec![at("idle", "b1", 4, 0.0, Some("2026-10-27T12:00:00Z"), false)],
        );
        assert!(merge(&mut w, p));
        assert_eq!(
            (ids(&w.todo), ids(&w.doing), ids(&w.done)),
            (vec!["c"], vec!["live", "a"], vec!["idle", "old"])
        );
        assert_eq!(w.done_count, 2);
        /* An edit to one already done counts it once; one more past the limit is counted, not listed. */
        let p = part(
            &["old"],
            vec![],
            vec![],
            vec![at("old", "b1", 4, 0.0, Some("2026-10-27T08:00:00Z"), false)],
        );
        assert!(merge(&mut w, p));
        assert_eq!((ids(&w.done), w.done_count), (vec!["idle", "old"], 2));
        let p = part(
            &["c"],
            vec![],
            vec![],
            vec![at("c", "b1", 4, 0.0, Some("2026-10-27T13:00:00Z"), false)],
        );
        assert!(merge(&mut w, p));
        assert_eq!(
            (ids(&w.todo), ids(&w.done), w.done_count),
            (Vec::<&str>::new(), vec!["c", "idle"], 3)
        );
    }

    #[test]
    fn past_the_done_limit_only_the_whole_read_can_say() {
        /* Three done, two listed: the third is somewhere the box can't see. */
        let w = whole(
            vec![at("t", "b1", 1, 0.0, None, false)],
            vec![],
            vec![
                at("d1", "b1", 4, 0.0, Some("2026-10-27T12:00:00Z"), false),
                at("d2", "b1", 4, 0.0, Some("2026-10-27T11:00:00Z"), false),
            ],
            3,
        );
        /* A task it didn't show, now on a pole: maybe the unlisted done one, reopened. */
        let mut v = w.clone();
        assert!(!merge(
            &mut v,
            part(&["x"], vec![at("x", "b1", 1, 1.0, None, false)], vec![], vec![])
        ));
        assert_eq!(v, w);
        /* A listed done one reopened: the unlisted one would take its place. */
        assert!(!merge(
            &mut v,
            part(&["d1"], vec![at("d1", "b1", 1, 1.0, None, false)], vec![], vec![])
        ));
        /* Shown tasks changing in place are fine. */
        assert!(merge(
            &mut v,
            part(
                &["t", "d2"],
                vec![at("t", "b1", 1, 2.0, None, false)],
                vec![],
                vec![at("d2", "b1", 4, 0.0, Some("2026-10-27T11:00:00Z"), false)]
            )
        ));
        assert_eq!(
            (ids(&v.todo), ids(&v.done), v.done_count),
            (vec!["t"], vec!["d1", "d2"], 3)
        );
    }

    #[test]
    fn the_status_dot_is_up_only_when_every_socket_is() {
        use copland_daemon_core::{AgentState, DaemonState, Phase};
        let agent = |live: Link, phase: Phase| {
            let mut a = AgentState::new("me/dev", "http://x");
            a.live = live;
            a.phase = phase;
            a
        };
        let st = |agents: Vec<AgentState>| {
            Status::of(&DaemonState {
                agents,
                stopping: false,
                autostart: false,
            })
        };
        let feed = |live: Link, refused: bool| Feed {
            live,
            refused,
            ..Default::default()
        };
        assert_eq!(links_up(&st(vec![]), None), None);
        assert_eq!(
            links_up(&st(vec![agent(Link::Connecting, Phase::Starting)]), None),
            None
        );
        assert_eq!(
            links_up(&st(vec![agent(Link::Connected, Phase::Idle)]), None),
            Some(true)
        );
        let up = st(vec![agent(Link::Connected, Phase::Idle)]);
        assert_eq!(links_up(&up, Some(&feed(Link::Connected, false))), Some(true));
        assert_eq!(links_up(&up, Some(&feed(Link::Reconnecting, false))), Some(false));
        /* A refused owner token says so elsewhere; its socket doesn't count. */
        assert_eq!(links_up(&up, Some(&feed(Link::Reconnecting, true))), Some(true));
        /* Still connecting: not yet up, not down either. */
        assert_eq!(links_up(&up, Some(&feed(Link::Connecting, false))), None);
        /* A stopped agent's socket is gone and doesn't count. */
        let stopped = st(vec![
            agent(Link::Connected, Phase::Idle),
            agent(Link::Reconnecting, Phase::Stopped),
        ]);
        assert_eq!(links_up(&stopped, None), Some(true));
    }
}
