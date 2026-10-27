//! What the tray shows, kept from the daemon running a config (COPL-198): its status through
//! `core::watcher::Watcher` (COPL-200), which finds the daemon again after it goes away and never
//! starts one, and the last thing that went wrong. The menu's requests go to the same `Watcher`.

use std::path::PathBuf;
use std::sync::Arc;

use copland_daemon_core::lock;
use copland_daemon_core::status::Status;
use copland_daemon_core::watcher::{Connection, Watcher};
use tokio::sync::{mpsc, watch};

/// What the menu asks of the daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Hold { slot: u64 },
    Release { slot: u64 },
    StopRun { slot: u64, run: String },
}

/// What the tray knows: the daemon's last snapshot (None while it isn't running), and the last
/// thing that went wrong, until the next request goes through or the connection changes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Seen {
    pub status: Option<Status>,
    pub error: Option<String>,
}

/// Follow the daemon running `config` into `seen`, and send it `requests`, until `requests` closes.
pub async fn run(
    config: PathBuf,
    runtime_dir: PathBuf,
    mut requests: mpsc::UnboundedReceiver<Request>,
    seen: watch::Sender<Seen>,
) {
    let watcher = Arc::new(Watcher::start(&config, &runtime_dir));
    let mut connection = watcher.subscribe();
    let mut now = connection.borrow_and_update().clone();
    /* What the last request came back with, until something changes it. */
    let mut refused: Option<String> = None;
    /* Requests are answered on tasks of their own, so a slow one holds up no snapshot. */
    let (answered, mut answers) = mpsc::unbounded_channel();
    loop {
        let shown = match &now {
            Connection::Connected(s) => Seen {
                status: Some(s.clone()),
                error: refused.clone(),
            },
            Connection::Unreadable(why) => Seen {
                status: None,
                error: refused.clone().or_else(|| Some(why.clone())),
            },
            Connection::Connecting | Connection::NotRunning => Seen {
                status: None,
                error: refused.clone().or_else(|| old_daemon(&config, &runtime_dir)),
            },
        };
        seen.send_if_modified(|s| {
            let changed = *s != shown;
            *s = shown;
            changed
        });
        tokio::select! {
            changed = connection.changed() => {
                if changed.is_err() {
                    return;
                }
                let next = connection.borrow_and_update().clone();
                if kind(&next) != kind(&now) {
                    refused = None;
                }
                now = next;
            }
            request = requests.recv() => {
                let Some(request) = request else { return };
                let (watcher, answered) = (watcher.clone(), answered.clone());
                tokio::spawn(async move {
                    let answer = match &request {
                        Request::Hold { slot } => watcher.hold(*slot).await,
                        Request::Release { slot } => watcher.release(*slot).await,
                        Request::StopRun { slot, run } => watcher.stop_run(*slot, run).await,
                    };
                    let _ = answered.send(answer.err().map(|e| format!("{e:#}")));
                });
            }
            Some(answer) = answers.recv() => refused = answer,
        }
    }
}

/// Which of the tray's three faces a connection shows: running, unreadable or not running.
fn kind(c: &Connection) -> u8 {
    match c {
        Connection::Connected(_) => 0,
        Connection::Unreadable(_) => 1,
        Connection::Connecting | Connection::NotRunning => 2,
    }
}

/// A daemon from before the status socket holding the config's lock, which `copland-daemon
/// status` calls an error too.
fn old_daemon(config: &std::path::Path, runtime_dir: &std::path::Path) -> Option<String> {
    let holder = lock::running(config, runtime_dir).ok()??;
    Some(format!(
        "a daemon is running {} ({holder}) but serves no status: restart it",
        config.display()
    ))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::time::Duration;

    use copland_daemon_core::agent::StopRequest;
    use copland_daemon_core::socket::Server;
    use copland_daemon_core::{AgentState, DaemonState, Holder, Phase, Reloader, RunStopper};

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        /* /tmp, not $TMPDIR: macOS's is long enough to push the socket past SUN_LEN. */
        let dir = PathBuf::from("/tmp").join(format!("copland-tray-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn running() -> DaemonState {
        let mut a = AgentState::new("me/dev", "http://x");
        a.slot = 2;
        a.phase = Phase::Idle;
        a.run_started("aaaa", "T-1");
        DaemonState {
            agents: vec![a],
            stopping: false,
            autostart: false,
        }
    }

    struct Daemon {
        state: watch::Sender<DaemonState>,
        stops: watch::Receiver<StopRequest>,
        server: Server,
    }

    fn serve(config: &Path, dir: &Path) -> Daemon {
        let (state, rx) = watch::channel(running());
        let (stop_tx, stops) = watch::channel::<StopRequest>(None);
        let server = Server::start(
            &lock::socket_for(config, dir),
            rx,
            RunStopper::new(stop_tx),
            Holder::new(state.clone()),
            Reloader::new(config.to_path_buf(), tokio::sync::mpsc::unbounded_channel().0),
        )
        .unwrap();
        Daemon { state, stops, server }
    }

    async fn until(seen: &mut watch::Receiver<Seen>, what: impl Fn(&Seen) -> bool) -> Seen {
        let came = tokio::time::timeout(Duration::from_secs(10), seen.wait_for(|s| what(s)))
            .await
            .map(|s| s.unwrap().clone());
        came.unwrap_or_else(|_| panic!("never came: {:?}", seen.borrow()))
    }

    #[tokio::test]
    async fn it_watches_holds_stops_and_follows_the_daemon_away_and_back() {
        let dir = scratch("follow");
        let config = dir.join("daemon.toml");
        fs::write(&config, "").unwrap();
        let (requests, rx) = mpsc::unbounded_channel();
        let (seen_tx, mut seen) = watch::channel(Seen::default());
        let following = tokio::spawn(run(config.clone(), dir.clone(), rx, seen_tx));

        /* No daemon yet: not running, and a request says why it can't be done. */
        requests.send(Request::Hold { slot: 2 }).unwrap();
        let s = until(&mut seen, |s| s.error.is_some()).await;
        assert!(s.error.unwrap().contains("no daemon is serving"));
        assert_eq!(s.status, None);

        /* It comes up: found on a retry, watched, and the error is gone with the change. */
        let mut d = serve(&config, &dir);
        let s = until(&mut seen, |s| s.status.is_some()).await;
        assert_eq!(s.error, None);
        assert_eq!(s.status.unwrap().agents[0].runs[0].run, "aaaa");

        /* Holding and releasing by slot, and the watch showing it. */
        requests.send(Request::Hold { slot: 2 }).unwrap();
        until(&mut seen, |s| s.status.as_ref().is_some_and(|s| s.agents[0].held)).await;
        assert!(d.state.borrow().agents[0].held);
        requests.send(Request::Release { slot: 2 }).unwrap();
        until(&mut seen, |s| s.status.as_ref().is_some_and(|s| !s.agents[0].held)).await;

        /* A run that isn't going is the daemon's error, shown; stopping one going clears it. */
        requests
            .send(Request::StopRun {
                slot: 2,
                run: "zzzz".into(),
            })
            .unwrap();
        let s = until(&mut seen, |s| s.error.is_some()).await;
        assert!(s.error.unwrap().contains("no run zzzz"));
        assert!(d.stops.borrow_and_update().is_none());
        requests
            .send(Request::StopRun {
                slot: 2,
                run: "aaaa".into(),
            })
            .unwrap();
        until(&mut seen, |s| s.error.is_none()).await;
        assert_eq!(*d.stops.borrow_and_update(), Some((2, "aaaa".to_string())));
        d.state.send_modify(|s| s.agents[0].run_ended("aaaa"));
        until(&mut seen, |s| {
            s.status.as_ref().is_some_and(|s| s.agents[0].runs.is_empty())
        })
        .await;

        /* It goes away: not running, and back when another starts. */
        drop(d.server);
        until(&mut seen, |s| s.status.is_none()).await;
        let d = serve(&config, &dir);
        let s = until(&mut seen, |s| s.status.is_some()).await;
        assert_eq!(s.status.unwrap().agents[0].runs[0].run, "aaaa");

        /* The menu's channel closing ends it. */
        drop(requests);
        tokio::time::timeout(Duration::from_secs(5), following)
            .await
            .unwrap()
            .unwrap();
        drop(d);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_lock_held_with_no_socket_is_an_old_daemon() {
        let dir = scratch("old");
        let config = dir.join("daemon.toml");
        fs::write(&config, "").unwrap();
        let _lock = lock::Lock::take(&config, &dir, "copland-daemon").unwrap();
        let (requests, rx) = mpsc::unbounded_channel();
        let (seen_tx, mut seen) = watch::channel(Seen::default());
        let following = tokio::spawn(run(config.clone(), dir.clone(), rx, seen_tx));
        let s = until(&mut seen, |s| s.error.is_some()).await;
        assert!(s.error.unwrap().contains("serves no status"));
        assert_eq!(s.status, None);
        drop(requests);
        tokio::time::timeout(Duration::from_secs(5), following)
            .await
            .unwrap()
            .unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
