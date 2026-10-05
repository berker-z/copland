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
//!
//! With the same token it also reads what the menu and the bell show (COPL-64,
//! COPL-65), each when its topic says it changed and on the same clock: the
//! person's unread mentions and their agents' messages (`/api/inbox?unread=true`, "inbox";
//! messages since COPL-109), their boards
//! (`/api/boards`, "boards") and their theme (`/api/settings`, "settings").
//! After each read the notifier decides whether anything new needs saying.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use copland_daemon_core::DaemonState;
use copland_daemon_core::Phase;
use copland_daemon_core::api::{Api, BoardRef, InboxItem, Wired};
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
/// Reads the live socket asks for are at least this far apart.
const SPACING: Duration = Duration::from_secs(1);
/// The unread inbox is read at most this many pages of a hundred.
const INBOX_PAGES: usize = 3;

/// What `/api/wired` is made of: tasks on boards (board), which boards the person is on
/// (boards), their agents' names and pauses (agents). Handles are in "people". The person's
/// inbox and settings are the bell's and the theme's.
fn wanted(topic: &str) -> bool {
    matches!(topic, "board" | "boards" | "agents" | "people" | "inbox" | "settings")
}

/// What a wake should read again.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Due {
    pub wired: bool,
    pub inbox: bool,
    pub boards: bool,
    pub settings: bool,
}

impl Due {
    pub const ALL: Due = Due {
        wired: true,
        inbox: true,
        boards: true,
        settings: true,
    };

    /// What a burst of live messages asks to read, given the last `/api/wired` read (none yet:
    /// read it). A board change is skipped when the burst says which tasks it touched (COPL-151)
    /// and none is one /wired shows or one of the agents is, or was, assigned to: every task it
    /// can show is assigned to one of them, so a change to anything else can't show here.
    pub fn of(burst: &Burst, wired: Option<&Wired>) -> Due {
        let has = |t: &str| burst.contains(t);
        let board = has("board")
            && match (&burst.touched, wired) {
                (Some(touched), Some(w)) => {
                    let shown = [&w.todo, &w.doing, &w.blocked, &w.done]
                        .into_iter()
                        .flatten()
                        .any(|t| touched.tasks.contains(&t.id));
                    shown || w.agents.iter().any(|a| touched.assignees.contains(&a.id))
                }
                _ => true,
            };
        Due {
            wired: board || has("boards") || has("agents") || has("people"),
            inbox: has("inbox"),
            boards: has("boards"),
            settings: has("settings"),
        }
    }

    fn add(&mut self, o: Due) {
        self.wired |= o.wired;
        self.inbox |= o.inbox;
        self.boards |= o.boards;
        self.settings |= o.settings;
    }
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
pub fn links_up(st: &DaemonState, feed: Option<&Feed>) -> Option<bool> {
    let links: Vec<Link> = st
        .agents
        .iter()
        .filter(|a| a.phase != Phase::Stopped && !a.retiring)
        .map(|a| a.live)
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
fn runs(st: &DaemonState) -> Vec<Vec<String>> {
    st.agents
        .iter()
        .map(|a| a.runs.iter().map(|r| r.run.clone()).collect())
        .collect()
}

/// Resolves once some agent's run has started or ended (never, once the daemon is gone).
async fn run_changed(daemon: &mut watch::Receiver<DaemonState>, seen: &mut Vec<Vec<String>>) {
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
    mut daemon: watch::Receiver<DaemonState>,
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
        let now = std::mem::take(&mut *due.lock().expect("not poisoned"));
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
        let now = if checked { now } else { Due::ALL };
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
                    tokio::time::sleep_until(since + SPACING).await;
                    break;
                }
                _ = run_changed(&mut daemon, &mut seen) => {
                    tokio::time::sleep(SETTLE).await;
                    due.lock().expect("not poisoned").wired = true;
                    break;
                }
                changed = link.changed() => {
                    let now = link.borrow().live;
                    /* Gone down: anything could have been missed, so read now. */
                    if changed.is_err() || (up == Link::Connected && now != Link::Connected) {
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
                inbox: false
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
        };
        let wired = Wired {
            agents: vec![WiredAgent {
                id: "dev".into(),
                handle: "me/dev".into(),
                name: "dev".into(),
                paused: false,
            }],
            todo: vec![task("t-todo")],
            doing: vec![],
            blocked: vec![],
            done: vec![task("t-done")],
            done_count: 1,
            done_window_hours: 24,
        };
        let set = |v: &[&str]| v.iter().map(|s| s.to_string()).collect();
        let board = |tasks: &[&str], assignees: &[&str]| Burst {
            topics: set(&["board"]),
            touched: Some(Touched {
                tasks: set(tasks),
                assignees: set(assignees),
            }),
        };
        let reads = |b: &Burst, w: Option<&Wired>| Due::of(b, w).wired;
        /* Someone else's task, with nobody of yours on it: nothing to read. */
        assert!(!reads(&board(&["other"], &["kim"]), Some(&wired)));
        assert!(!reads(&board(&[], &[]), Some(&wired)));
        /* A task it shows, done ones too. */
        assert!(reads(&board(&["t-todo"], &[]), Some(&wired)));
        assert!(reads(&board(&["t-done"], &["kim"]), Some(&wired)));
        /* One of your agents on it, before or after: newly assigned, or out of backlog. */
        assert!(reads(&board(&["new"], &["kim", "dev"]), Some(&wired)));
        /* Nothing read yet, or a burst that didn't say what it touched: read. */
        assert!(reads(&board(&["other"], &[]), None));
        let unsaid = Burst {
            topics: set(&["board"]),
            touched: None,
        };
        assert!(reads(&unsaid, Some(&wired)));
        /* Other topics still read it, whatever the board part says. */
        let mut agents = board(&["other"], &[]);
        agents.topics.insert("agents".into());
        assert!(reads(&agents, Some(&wired)));
        /* And a burst with no board in it reads nothing for the board's sake. */
        let inbox = Burst {
            topics: set(&["inbox"]),
            touched: Some(Touched::default()),
        };
        assert!(!reads(&inbox, Some(&wired)));
    }

    #[test]
    fn the_status_dot_is_up_only_when_every_socket_is() {
        let agent = |live: Link, phase: Phase| {
            let mut a = copland_daemon_core::AgentState::new("me/dev", "http://x");
            a.live = live;
            a.phase = phase;
            a
        };
        let st = |agents: Vec<copland_daemon_core::AgentState>| DaemonState {
            agents,
            stopping: false,
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
