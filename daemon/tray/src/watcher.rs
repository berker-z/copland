//! The tray's side of the status socket (COPL-198): watch the daemon running a config, pass on
//! what the menu asks of it, and when nobody answers, say so and try again every few seconds.
//! It never starts the daemon.

use std::path::PathBuf;
use std::time::Duration;

use copland_daemon_core::client::{Answer, Connection, Request};
use copland_daemon_core::lock;
use copland_daemon_core::status::Status;
use tokio::sync::{mpsc, watch};

/// How long the tray waits before trying a socket nobody answered on again.
pub const RETRY: Duration = Duration::from_secs(3);

/// What the tray knows: the daemon's last snapshot (None while none answers), and the last thing
/// that went wrong, until the next request goes through or the connection changes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Seen {
    pub status: Option<Status>,
    pub error: Option<String>,
}

/// Follow the daemon running `config` into `seen` and send it `requests` (holds, releases, stops)
/// until `requests` closes.
pub async fn run(
    config: PathBuf,
    runtime_dir: PathBuf,
    retry: Duration,
    mut requests: mpsc::UnboundedReceiver<Request>,
    seen: watch::Sender<Seen>,
) {
    let socket = lock::socket_for(&config, &runtime_dir);
    loop {
        let lost = match Connection::open(&socket).await {
            Ok(Some(conn)) => match follow(conn, &mut requests, &seen).await {
                Some(lost) => lost,
                None => return,
            },
            Ok(None) => None,
            Err(e) => Some(format!("{e:#}")),
        };
        /* A lock held with no socket is a daemon from before it, which `status` calls an error too. */
        let error = match lock::running(&config, &runtime_dir) {
            Ok(Some(holder)) if lost.is_none() => Some(format!(
                "a daemon is running {} ({holder}) but serves no status: restart it",
                config.display()
            )),
            _ => lost,
        };
        set(&seen, None, error);
        let wait = tokio::time::sleep(retry);
        tokio::pin!(wait);
        loop {
            tokio::select! {
                () = &mut wait => break,
                request = requests.recv() => match request {
                    Some(_) => seen.send_modify(|s| s.error = Some("the daemon isn't running".into())),
                    None => return,
                },
            }
        }
    }
}

fn set(seen: &watch::Sender<Seen>, status: Option<Status>, error: Option<String>) {
    seen.send_if_modified(|s| {
        let new = Seen { status, error };
        let changed = *s != new;
        *s = new;
        changed
    });
}

/// Watch on `conn` until the daemon hangs up, Some(what went wrong, if anything), or `requests`
/// closes, None.
async fn follow(
    mut conn: Connection,
    requests: &mut mpsc::UnboundedReceiver<Request>,
    seen: &watch::Sender<Seen>,
) -> Option<Option<String>> {
    if let Err(e) = conn.send(&Request::Watch).await {
        return Some(Some(format!("{e:#}")));
    }
    loop {
        tokio::select! {
            answer = conn.next() => match answer {
                Ok(Some(Answer::Status(s))) => {
                    seen.send_if_modified(|seen| {
                        /* The first snapshot after a reconnect clears what not being connected said. */
                        let error = if seen.status.is_none() { None } else { seen.error.take() };
                        let changed = seen.status.as_ref() != Some(&s) || seen.error != error;
                        seen.status = Some(s);
                        seen.error = error;
                        changed
                    });
                }
                Ok(Some(Answer::Ok)) => {
                    seen.send_if_modified(|s| s.error.take().is_some());
                }
                Ok(Some(Answer::Error(e))) => seen.send_modify(|s| s.error = Some(e)),
                Ok(None) => return Some(None),
                Err(e) => return Some(Some(format!("{e:#}"))),
            },
            request = requests.recv() => match request {
                Some(r) => {
                    if let Err(e) = conn.send(&r).await {
                        return Some(Some(format!("{e:#}")));
                    }
                }
                None => return None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use copland_daemon_core::agent::StopRequest;
    use copland_daemon_core::socket::Server;
    use copland_daemon_core::{AgentState, DaemonState, Holder, Phase, RunStopper};

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
        )
        .unwrap();
        Daemon { state, stops, server }
    }

    async fn until(seen: &mut watch::Receiver<Seen>, what: impl Fn(&Seen) -> bool) -> Seen {
        let came = tokio::time::timeout(Duration::from_secs(5), seen.wait_for(|s| what(s)))
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
        let watching = tokio::spawn(run(config.clone(), dir.clone(), Duration::from_millis(50), rx, seen_tx));

        /* No daemon yet: not running, and a request says so. */
        requests.send(Request::Hold { slot: 2, held: true }).unwrap();
        until(&mut seen, |s| s.error.as_deref() == Some("the daemon isn't running")).await;
        assert_eq!(seen.borrow().status, None);

        /* It comes up: the tray finds it on a retry and watches. */
        let mut d = serve(&config, &dir);
        let s = until(&mut seen, |s| s.status.is_some()).await;
        assert_eq!(s.error, None);
        assert_eq!(s.status.unwrap().agents[0].runs[0].run, "aaaa");

        /* Holding and releasing by slot, and the watch showing it. */
        requests.send(Request::Hold { slot: 2, held: true }).unwrap();
        until(&mut seen, |s| s.status.as_ref().is_some_and(|s| s.agents[0].held)).await;
        assert!(d.state.borrow().agents[0].held);
        requests.send(Request::Hold { slot: 2, held: false }).unwrap();
        until(&mut seen, |s| s.status.as_ref().is_some_and(|s| !s.agents[0].held)).await;

        /* Stopping a run asks its loop to; one that isn't going is the daemon's error, shown. */
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

        /* It goes away: not running, and back when it returns. */
        drop(d.server);
        until(&mut seen, |s| s.status.is_none()).await;
        let d = serve(&config, &dir);
        let s = until(&mut seen, |s| s.status.is_some()).await;
        assert_eq!(s.status.unwrap().agents[0].runs[0].run, "aaaa");

        /* The menu's channel closing ends it. */
        drop(requests);
        tokio::time::timeout(Duration::from_secs(5), watching)
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
        let watching = tokio::spawn(run(config.clone(), dir.clone(), Duration::from_millis(50), rx, seen_tx));
        let s = until(&mut seen, |s| s.error.is_some()).await;
        assert!(s.error.unwrap().contains("serves no status"));
        assert_eq!(s.status, None);
        drop(requests);
        tokio::time::timeout(Duration::from_secs(5), watching)
            .await
            .unwrap()
            .unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
