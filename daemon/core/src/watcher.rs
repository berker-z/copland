//! The status socket (COPL-184) for a program that lives alongside the daemon (COPL-200): the
//! tray, an agents screen outside the box. `Watcher` keeps the daemon's status as a value that
//! keeps up, `watch::Receiver<Connection>`, through the socket's `watch`, and keeps it up across
//! the daemon ending and another one starting: when it goes away the watcher tries again every
//! `RETRY` and picks up a daemon started later, without the caller doing anything. Its
//! `stop_run`, `hold`, `release` and `reload` ask the same daemon to do something.
//!
//! `client.rs` is the same socket for a terminal, which shows a snapshot and ends.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::client;
use crate::daemon::Reloaded;
use crate::lock;
use crate::status::{Status, VERSION};

/// How long after the daemon goes away the watcher tries again.
const RETRY: Duration = Duration::from_secs(1);

/// The longest a request waits for its answer.
const ANSWER: Duration = Duration::from_secs(5);

/// Where the daemon is, as far as the watcher knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Connection {
    /// Before the first try has said anything.
    Connecting,
    /// The daemon's latest snapshot.
    Connected(Status),
    /// No daemon serves the socket (none there, a dead one's left behind, or it hung up), or the
    /// one there is stopping.
    NotRunning,
    /// Something answers that this can't read, and why: a status `version` it doesn't know (a
    /// newer daemon), an answer that isn't a status, a socket it can't connect to. Nothing of
    /// what it said is drawn. The watcher keeps listening, and tries again once it hangs up.
    Unreadable(String),
}

/// The daemon running a config, watched. Dropping it stops watching.
#[derive(Debug)]
pub struct Watcher {
    socket: PathBuf,
    connection: watch::Receiver<Connection>,
    task: JoinHandle<()>,
}

impl Watcher {
    /// Watch the daemon running `config`, on the socket it serves under `runtime_dir`
    /// (`lock::socket_for`). Must be called inside a Tokio runtime.
    pub fn start(config: &Path, runtime_dir: &Path) -> Self {
        let socket = lock::socket_for(config, runtime_dir);
        let (tx, connection) = watch::channel(Connection::Connecting);
        Self {
            task: tokio::spawn(keep(socket.clone(), tx)),
            socket,
            connection,
        }
    }

    /// The connection as it is now, and every change to it.
    pub fn subscribe(&self) -> watch::Receiver<Connection> {
        self.connection.clone()
    }

    /// The socket it watches.
    pub fn socket(&self) -> &Path {
        &self.socket
    }

    /// Stop the run `run` of the agent in `slot`, as the box's ■ does.
    pub async fn stop_run(&self, slot: u64, run: &str) -> Result<()> {
        self.ask(json!({ "op": "stop_run", "slot": slot, "run": run }))
            .await
            .map(drop)
    }

    /// Hold the agent in `slot` on this machine: it starts nothing until released.
    pub async fn hold(&self, slot: u64) -> Result<()> {
        self.ask(json!({ "op": "hold", "slot": slot })).await.map(drop)
    }

    /// Release the agent in `slot`.
    pub async fn release(&self, slot: u64) -> Result<()> {
        self.ask(json!({ "op": "release", "slot": slot })).await.map(drop)
    }

    /// Have the daemon read its config file again and run it (COPL-197), as after saving
    /// `daemon.toml`, and say what changed. A file that doesn't load is the daemon's `Err`, and
    /// nothing changed.
    pub async fn reload(&self) -> Result<Reloaded> {
        let answer = self.ask(json!({ "op": "reload" })).await?;
        serde_json::from_value(answer["reloaded"].clone()).context("the daemon's answer doesn't say what it reloaded")
    }

    /// Send `request` on a connection of its own, which keeps its answer apart from the watch's
    /// snapshots, and give what the daemon answered: `Err` with the socket's `error` text.
    async fn ask(&self, request: Value) -> Result<Value> {
        let socket = &self.socket;
        let asking = async {
            let stream = match UnixStream::connect(socket).await {
                Ok(s) => s,
                Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
                    bail!("no daemon is serving {}", socket.display())
                }
                Err(e) => return Err(e).with_context(|| format!("connecting to {}", socket.display())),
            };
            let (read, mut write) = stream.into_split();
            write
                .write_all(format!("{request}\n").as_bytes())
                .await
                .with_context(|| format!("asking {}", socket.display()))?;
            let line = BufReader::new(read)
                .lines()
                .next_line()
                .await
                .with_context(|| format!("reading {}", socket.display()))?
                .with_context(|| format!("the daemon at {} hung up without answering", socket.display()))?;
            client::ok(&line)
        };
        tokio::time::timeout(ANSWER, asking).await.with_context(|| {
            format!(
                "the daemon at {} didn't answer in {}s",
                socket.display(),
                ANSWER.as_secs()
            )
        })?
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Set `to`, waking the receivers only when it differs.
fn set(tx: &watch::Sender<Connection>, to: Connection) {
    tx.send_if_modified(|now| {
        if *now == to {
            return false;
        }
        *now = to;
        true
    });
}

async fn keep(socket: PathBuf, tx: watch::Sender<Connection>) {
    loop {
        let ended = follow(&socket, &tx).await;
        set(&tx, ended);
        tokio::time::sleep(RETRY).await;
    }
}

/// Watch the daemon at `socket` until it hangs up, and say what that leaves.
async fn follow(socket: &Path, tx: &watch::Sender<Connection>) -> Connection {
    let stream = match UnixStream::connect(socket).await {
        Ok(s) => s,
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
            return Connection::NotRunning;
        }
        Err(e) => return Connection::Unreadable(format!("connecting to {}: {e}", socket.display())),
    };
    /* The write half stays open while watching: the server takes its end as the client leaving. */
    let (read, mut write) = stream.into_split();
    if write.write_all(b"{\"op\":\"watch\"}\n").await.is_err() {
        return Connection::NotRunning;
    }
    let mut lines = BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        set(tx, snapshot(&line));
    }
    Connection::NotRunning
}

/// One line of the watch.
fn snapshot(line: &str) -> Connection {
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Connection::Unreadable(format!("the daemon's answer isn't JSON: {e}")),
    };
    if let Some(e) = value.get("error") {
        return Connection::Unreadable(format!("the daemon says: {}", e.as_str().unwrap_or(&e.to_string())));
    }
    match value.get("version").and_then(Value::as_u64) {
        Some(v) if v == u64::from(VERSION) => {}
        Some(v) => {
            return Connection::Unreadable(format!(
                "the daemon writes status version {v}, and this reads version {VERSION}"
            ));
        }
        None => return Connection::Unreadable("the daemon's answer has no status version".into()),
    }
    /* Fields it doesn't know are ignored: the JSON is only ever added to. */
    match serde_json::from_value::<Status>(value) {
        Ok(s) if s.stopping => Connection::NotRunning,
        Ok(s) => Connection::Connected(s),
        Err(e) => Connection::Unreadable(format!("the daemon's answer isn't a status: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tokio::net::UnixListener;

    use super::*;
    use crate::agent::StopRequest;
    use crate::daemon::{Holder, Reloader, RunStopper};
    use crate::socket::Server;
    use crate::state::{AgentState, DaemonState, Phase};

    fn scratch(name: &str) -> (PathBuf, PathBuf) {
        /* /tmp, not $TMPDIR: macOS's is long enough to push the socket past SUN_LEN. */
        let dir = PathBuf::from("/tmp").join(format!("copland-watcher-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let config = dir.join("daemon.toml");
        fs::write(&config, "").unwrap();
        (dir, config)
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

    struct Served {
        server: Server,
        state: watch::Sender<DaemonState>,
        stops: watch::Receiver<StopRequest>,
    }

    fn serve(socket: &Path, st: DaemonState) -> Served {
        let (state, rx) = watch::channel(st);
        let (stop_tx, stops) = watch::channel::<StopRequest>(None);
        let server = Server::start(
            socket,
            rx,
            RunStopper(stop_tx),
            Holder(state.clone()),
            Reloader::nowhere(),
        )
        .unwrap();
        Served { server, state, stops }
    }

    /// Wait for the connection to be what `what` says, and give it.
    async fn until(rx: &mut watch::Receiver<Connection>, what: impl FnMut(&Connection) -> bool) -> Connection {
        let came = tokio::time::timeout(Duration::from_secs(5), rx.wait_for(what))
            .await
            .map(|c| c.unwrap().clone());
        came.unwrap_or_else(|_| panic!("never came; it is {:?}", *rx.borrow()))
    }

    fn connected(c: &Connection) -> Option<&Status> {
        match c {
            Connection::Connected(s) => Some(s),
            _ => None,
        }
    }

    #[tokio::test]
    async fn reload_says_what_changed_or_why_not() {
        let (dir, config) = scratch("reload");
        let socket = lock::socket_for(&config, &dir);
        let (state, rx) = watch::channel(running());
        let (stop_tx, _) = watch::channel::<StopRequest>(None);
        let (reload_tx, mut reloads) = tokio::sync::mpsc::unbounded_channel();
        let _server = Server::start(
            &socket,
            rx,
            RunStopper(stop_tx),
            Holder(state),
            Reloader::new(config.clone(), reload_tx),
        )
        .unwrap();
        let watcher = Watcher::start(&config, &dir);
        until(&mut watcher.subscribe(), |c| connected(c).is_some()).await;

        /* A file that doesn't load never reaches the daemon. */
        fs::write(&config, "[[agent]\n").unwrap();
        let err = watcher.reload().await.unwrap_err();
        assert!(err.to_string().contains("loading the config"), "{err}");
        assert!(reloads.try_recv().is_err());

        /* One that does is run by whoever owns the daemon, and its answer comes back. */
        fs::write(
            &config,
            format!(
                "[[agent]]\nurl=\"http://x\"\nhandle=\"me/new\"\ntoken=\"cpl_t\"\ncommand=[\"claude\"]\nworkdir=\"{}\"\n",
                dir.display()
            ),
        )
        .unwrap();
        let owner = tokio::spawn(async move {
            let req = reloads.recv().await.unwrap();
            assert_eq!(req.config.agents[0].handle, "me/new");
            let _ = req.reply.send(Ok(Reloaded {
                started: vec!["me/new".into()],
                stopped: vec!["me/dev".into()],
                ..Reloaded::default()
            }));
        });
        let done = watcher.reload().await.unwrap();
        assert_eq!(
            (done.started, done.stopped),
            (vec!["me/new".to_string()], vec!["me/dev".to_string()])
        );
        owner.await.unwrap();
        drop(watcher);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn it_follows_the_daemon_through_changes_restarts_and_requests() {
        let (dir, config) = scratch("follow");
        let watcher = Watcher::start(&config, &dir);
        let socket = lock::socket_for(&config, &dir);
        assert_eq!(watcher.socket(), socket);
        let mut rx = watcher.subscribe();

        /* No daemon yet. */
        until(&mut rx, |c| *c == Connection::NotRunning).await;
        let err = watcher.hold(2).await.unwrap_err();
        assert!(err.to_string().contains("no daemon is serving"), "{err}");

        /* One starting later is picked up, and its snapshot arrives. */
        let mut d = serve(&socket, running());
        let c = until(&mut rx, |c| connected(c).is_some()).await;
        assert_eq!(connected(&c).unwrap(), &Status::of(&d.state.borrow()));

        /* stop_run reaches the RunStopper; one it can't do says the socket's error. */
        watcher.stop_run(2, "aaaa").await.unwrap();
        assert_eq!(*d.stops.borrow_and_update(), Some((2, "aaaa".to_string())));
        let err = watcher.stop_run(2, "zzzz").await.unwrap_err();
        assert!(err.to_string().contains("no run zzzz"), "{err}");

        /* A change arrives. */
        d.state.send_modify(|s| s.agents[0].run_ended("aaaa"));
        let c = until(&mut rx, |c| connected(c).is_some_and(|s| s.agents[0].runs.is_empty())).await;
        assert_eq!(connected(&c).unwrap().agents[0].state, "watching");

        /* Hold and release, seen in the watch too. */
        watcher.hold(2).await.unwrap();
        assert!(d.state.borrow().agents[0].held);
        until(&mut rx, |c| connected(c).is_some_and(|s| s.agents[0].held)).await;
        let err = watcher.hold(9).await.unwrap_err();
        assert!(err.to_string().contains("no agent in slot 9"), "{err}");
        watcher.release(2).await.unwrap();
        until(&mut rx, |c| connected(c).is_some_and(|s| !s.agents[0].held)).await;

        /* The daemon going away is not running, and the next one is picked up. */
        drop(d.server);
        until(&mut rx, |c| *c == Connection::NotRunning).await;
        let d = serve(&socket, running());
        until(&mut rx, |c| connected(c).is_some_and(|s| s.agents[0].runs.len() == 1)).await;

        /* A daemon that is stopping is not running either. */
        d.state.send_modify(|s| s.stopping = true);
        until(&mut rx, |c| *c == Connection::NotRunning).await;

        drop(watcher);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn unknown_fields_are_ignored_and_an_unknown_version_is_unreadable() {
        let (dir, config) = scratch("version");
        let socket = lock::socket_for(&config, &dir);
        fs::create_dir_all(socket.parent().unwrap()).unwrap();
        let listener = UnixListener::bind(&socket).unwrap();
        let watcher = Watcher::start(&config, &dir);
        let mut rx = watcher.subscribe();

        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let asked = BufReader::new(read).lines().next_line().await.unwrap().unwrap();
        assert_eq!(asked, r#"{"op":"watch"}"#);

        /* A field from a newer daemon, at the top and in an agent. */
        let status = Status::of(&running());
        let mut v = serde_json::to_value(&status).unwrap();
        v["someday"] = json!({ "x": 1 });
        v["agents"][0]["someday"] = json!(true);
        write.write_all(format!("{v}\n").as_bytes()).await.unwrap();
        let c = until(&mut rx, |c| connected(c).is_some()).await;
        assert_eq!(connected(&c).unwrap(), &status);

        /* A version it doesn't know is said, not drawn. */
        v["version"] = json!(2);
        write.write_all(format!("{v}\n").as_bytes()).await.unwrap();
        let c = until(&mut rx, |c| matches!(c, Connection::Unreadable(_))).await;
        assert_eq!(
            c,
            Connection::Unreadable("the daemon writes status version 2, and this reads version 1".into())
        );

        /* Nor is something that isn't a status. */
        write.write_all(b"{\"version\":1,\"agents\":7}\n").await.unwrap();
        let c = until(
            &mut rx,
            |c| matches!(c, Connection::Unreadable(s) if s.contains("isn't a status")),
        )
        .await;
        assert!(matches!(c, Connection::Unreadable(_)));

        /* Hanging up is not running. */
        drop(write);
        drop(listener);
        until(&mut rx, |c| *c == Connection::NotRunning).await;
        let _ = fs::remove_dir_all(&dir);
    }
}
