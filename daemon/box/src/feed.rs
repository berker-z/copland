//! The owner's view: `GET /api/wired` with the person's own token, published
//! as a `watch` value the window draws. It runs on the daemon's Tokio
//! runtime. The route is a person's own read, so an agent's token is
//! refused; that is said once and polling stops.
//!
//! It reads again when the owner's live socket (COPL-62) says a board, the
//! person's boards or their agents changed, soon after any of this daemon's
//! runs starts or ends, and on a clock: every fifteen seconds while the
//! socket is down, every two minutes while it is up (a claim that lapses
//! sends nothing, and the hub keeps nothing for a socket that was away).

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use copland_daemon_core::DaemonState;
use copland_daemon_core::Phase;
use copland_daemon_core::api::{Api, Wired};
use copland_daemon_core::config::Owner;
use copland_daemon_core::live::{self, Heard, Link};
use tokio::sync::{Notify, watch};

/// How often it reads when nothing happens here and the live socket is down.
pub const EVERY: Duration = Duration::from_secs(15);
/// How often it reads anyway while the live socket is up.
pub const EVERY_LIVE: Duration = Duration::from_secs(120);
/// After a run starts or ends, a moment for its claim or its last moves to land before reading.
const SETTLE: Duration = Duration::from_secs(2);
/// Reads the live socket asks for are at least this far apart.
const SPACING: Duration = Duration::from_secs(1);

/// What `/api/wired` is made of: tasks on boards (board), which boards the person is on
/// (boards), their agents' names and pauses (agents). Handles are in "people".
fn wanted(topic: &str) -> bool {
    matches!(topic, "board" | "boards" | "agents" | "people")
}

/// The clock's interval for a socket state.
pub fn every(link: Link) -> Duration {
    if link == Link::Connected { EVERY_LIVE } else { EVERY }
}

#[derive(Debug, Clone, Default)]
pub struct Feed {
    /// The instance it reads, for links.
    pub url: String,
    /// The last good read, and when (wall clock) it was taken.
    pub wired: Option<(Wired, SystemTime)>,
    /// What went wrong with the last read, cleared by a good one.
    pub error: Option<String>,
    /// The token can't be used for this at all; nothing more will be read.
    pub refused: bool,
    /// The owner's live socket.
    pub live: Link,
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

/// Which run each agent is on: a change means a run started or ended.
fn runs(st: &DaemonState) -> Vec<Option<String>> {
    st.agents
        .iter()
        .map(|a| match &a.phase {
            Phase::Running { run, .. } => Some(run.clone()),
            _ => None,
        })
        .collect()
}

/// Resolves once some agent's run has started or ended (never, once the daemon is gone).
async fn run_changed(daemon: &mut watch::Receiver<DaemonState>, seen: &mut Vec<Option<String>>) {
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
/// feed stops). Its state goes into the feed; what it hears wakes `wake`.
fn listen(owner: &Owner, tx: watch::Sender<Feed>, wake: Arc<Notify>) -> tokio::task::JoinHandle<()> {
    let (base, token) = (owner.url.clone(), owner.token.clone());
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
                if let Heard::Topics(t) = &h {
                    tracing::debug!(?t, "live: reading your agents' work");
                }
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

pub async fn run(owner: Owner, tx: watch::Sender<Feed>, mut daemon: watch::Receiver<DaemonState>) {
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
    let _socket = Abort(listen(&owner, tx.clone(), wake.clone()));
    let mut link = tx.subscribe();
    loop {
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
                    checked = true;
                }
                Err(e) if e.is_refusal() => return refuse(format!("owner token refused: {e}")),
                Err(e) => fail(format!("asking who the owner token is: {e}"), &mut said),
            }
        }
        if checked {
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
        /* Until the clock (whose interval follows the socket), the socket, or a run here. */
        let since = tokio::time::Instant::now();
        loop {
            let up = link.borrow_and_update().live;
            tokio::select! {
                _ = tokio::time::sleep_until(since + every(up)) => break,
                _ = wake.notified() => {
                    /* A busy board sends a burst; one read every SPACING at most answers it. */
                    tokio::time::sleep_until(since + SPACING).await;
                    break;
                }
                _ = run_changed(&mut daemon, &mut seen) => {
                    tokio::time::sleep(SETTLE).await;
                    break;
                }
                changed = link.changed() => {
                    let now = link.borrow().live;
                    /* Gone down: anything could have been missed, so read now. */
                    if changed.is_err() || (up == Link::Connected && now != Link::Connected) {
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
        assert!(!wanted("inbox") && !wanted("vault") && !wanted("settings"));
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
