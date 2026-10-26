//! The status socket (COPL-184): the daemon's state for anything outside its process, and a
//! way to stop one of its runs, on a Unix socket next to the config's lock
//! (`<runtime dir>/copland/daemon-<hash>.sock`, `Lock::socket`).
//!
//! Newline-delimited JSON, one request per line, one answer per line:
//! - `{"op":"status"}` answers one `Status` snapshot.
//! - `{"op":"watch"}` answers a snapshot now and another on every change of the state, until
//!   the client hangs up. Requests sent meanwhile are answered in between.
//! - `{"op":"stop_run","slot":1,"run":"aaaa"}` stops that run as the box's ■ does
//!   (`RunStopper::stop`) and answers `{"ok":true}`.
//!
//! Anything else (an unknown op, a line that isn't JSON, an unknown slot or run) answers
//! `{"error":"…"}` and keeps the connection. Only the socket's owner can connect: the socket is
//! 0600 in a 0700 directory, and a peer of another uid is hung up on.

use std::fs;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};

use crate::daemon::RunStopper;
use crate::state::DaemonState;
use crate::status::Status;

/// The longest request line read; a longer one is answered with an error and hung up on.
const MAX_LINE: u64 = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    Status,
    Watch,
    StopRun { slot: u64, run: String },
}

/// The socket being served. Dropping it stops serving, hangs up every client and removes the socket.
#[derive(Debug)]
pub struct Server {
    path: PathBuf,
    task: JoinHandle<()>,
}

impl Server {
    /// Serve `state` on `path`. A socket already there is taken to be a dead daemon's and replaced:
    /// whoever calls this holds the config's lock, so no live daemon is using it. Must be called
    /// inside a Tokio runtime.
    pub fn start(path: &Path, state: watch::Receiver<DaemonState>, stopper: RunStopper) -> Result<Self> {
        if let Some(dir) = path.parent() {
            crate::setup::private_dir(dir)?;
        }
        match fs::symlink_metadata(path) {
            Ok(m) if m.file_type().is_socket() => {
                fs::remove_file(path).with_context(|| format!("removing the stale socket {}", path.display()))?
            }
            Ok(_) => bail!("{} is there and is not a socket", path.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        }
        let listener = UnixListener::bind(path).with_context(|| format!("listening on {}", path.display()))?;
        /* The directory is 0700, so nobody else could reach it before this either. */
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("chmod 600 {}", path.display()))?;
        tracing::info!(socket = %path.display(), "serving status");
        Ok(Self {
            path: path.to_path_buf(),
            task: tokio::spawn(accept(listener, state, stopper)),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
        let _ = fs::remove_file(&self.path);
    }
}

async fn accept(listener: UnixListener, state: watch::Receiver<DaemonState>, stopper: RunStopper) {
    let uid = unsafe { libc::getuid() };
    /* Aborting this task drops these, which hangs up every client. */
    let mut clients = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => match stream.peer_cred() {
                    Ok(peer) if peer.uid() == uid => {
                        clients.spawn(serve(stream, state.clone(), stopper.clone()));
                    }
                    Ok(peer) => tracing::warn!(uid = peer.uid(), "status socket: hung up on another user"),
                    Err(e) => tracing::warn!("status socket: can't tell who connected: {e}"),
                },
                Err(e) => {
                    /* Out of descriptors, most likely: try again in a moment rather than spin. */
                    tracing::warn!("status socket: {e}");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            },
            Some(_) = clients.join_next(), if !clients.is_empty() => {}
        }
    }
}

/// One line read: a request, the client gone, or a line too long to read.
enum Line {
    Request(Vec<u8>),
    Gone,
    TooLong,
}

async fn read_line(reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>) -> Line {
    let mut buf = Vec::new();
    match reader.take(MAX_LINE).read_until(b'\n', &mut buf).await {
        Ok(0) | Err(_) => Line::Gone,
        Ok(_) if buf.last() == Some(&b'\n') => Line::Request(buf),
        Ok(n) if n as u64 == MAX_LINE => Line::TooLong,
        /* The client hung up mid-line: answer what it sent. */
        Ok(_) => Line::Request(buf),
    }
}

fn snapshot(state: &mut watch::Receiver<DaemonState>) -> String {
    serde_json::to_string(&Status::of(&state.borrow_and_update())).expect("a Status is always JSON")
}

fn error(message: impl std::fmt::Display) -> String {
    json!({ "error": message.to_string() }).to_string()
}

fn stop_run(state: &watch::Receiver<DaemonState>, stopper: &RunStopper, slot: u64, run: &str) -> String {
    let st = state.borrow();
    let Some(agent) = st.agents.iter().find(|a| a.slot == slot) else {
        return error(format!("no agent in slot {slot}"));
    };
    if !agent.runs.iter().any(|r| r.run == run) {
        return error(format!("no run {run} going for @{} (slot {slot})", agent.handle));
    }
    stopper.stop(slot, run);
    json!({ "ok": true }).to_string()
}

async fn serve(stream: UnixStream, mut state: watch::Receiver<DaemonState>, stopper: RunStopper) {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut watching = false;
    loop {
        let answer = tokio::select! {
            line = read_line(&mut reader) => match line {
                Line::Gone => return,
                Line::TooLong => {
                    let _ = write.write_all(format!("{}\n", error("request line too long")).as_bytes()).await;
                    return;
                }
                Line::Request(line) => {
                    if line.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    match serde_json::from_slice::<Request>(&line) {
                        Ok(Request::Status) => snapshot(&mut state),
                        Ok(Request::Watch) => {
                            watching = true;
                            snapshot(&mut state)
                        }
                        Ok(Request::StopRun { slot, run }) => stop_run(&state, &stopper, slot, &run),
                        Err(e) => error(format!("bad request: {e}")),
                    }
                }
            },
            changed = state.changed(), if watching => match changed {
                Ok(()) => snapshot(&mut state),
                /* The daemon is gone. */
                Err(_) => return,
            },
        };
        if write.write_all(format!("{answer}\n").as_bytes()).await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::MetadataExt;

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};

    use super::*;
    use crate::agent::StopRequest;
    use crate::state::{AgentState, Phase};

    struct Client {
        lines: tokio::io::Lines<BufReader<OwnedReadHalf>>,
        write: OwnedWriteHalf,
    }

    impl Client {
        async fn connect(path: &Path) -> Self {
            let (read, write) = UnixStream::connect(path).await.unwrap().into_split();
            Self {
                lines: BufReader::new(read).lines(),
                write,
            }
        }

        async fn send(&mut self, line: &str) {
            self.write.write_all(format!("{line}\n").as_bytes()).await.unwrap();
        }

        async fn next(&mut self) -> serde_json::Value {
            let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
                .await
                .expect("an answer in time")
                .unwrap()
                .expect("the connection still open");
            serde_json::from_str(&line).unwrap()
        }

        async fn ask(&mut self, line: &str) -> serde_json::Value {
            self.send(line).await;
            self.next().await
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("copland-socket-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
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

    #[tokio::test]
    async fn a_client_reads_watches_and_stops_runs() {
        let dir = scratch("serve");
        let path = dir.join("copland").join("daemon-test.sock");
        let (state_tx, state) = watch::channel(running());
        let (stop_tx, mut stops) = watch::channel::<StopRequest>(None);
        let server = Server::start(&path, state, RunStopper(stop_tx)).unwrap();
        assert_eq!(server.path(), path);
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777, 0o700);

        let mut c = Client::connect(&path).await;
        let status = c.ask(r#"{"op":"status"}"#).await;
        assert_eq!(status["version"], 1);
        assert_eq!(status["agents"][0]["slot"], 2);
        assert_eq!(status["agents"][0]["runs"][0]["run"], "aaaa");

        /* Bad requests are answered and the connection stays. */
        let e = c.ask(r#"{"op":"dance"}"#).await;
        assert!(e["error"].as_str().unwrap().contains("unknown variant"), "{e}");
        assert!(c.ask("not json").await["error"].is_string());
        assert!(
            c.ask(r#"{"op":"stop_run","slot":9,"run":"aaaa"}"#).await["error"]
                .as_str()
                .unwrap()
                .contains("no agent in slot 9")
        );
        assert!(
            c.ask(r#"{"op":"stop_run","slot":2,"run":"zzzz"}"#).await["error"]
                .as_str()
                .unwrap()
                .contains("no run zzzz")
        );
        assert!(stops.borrow_and_update().is_none());

        /* Stopping a run going asks its loop to stop it. */
        assert_eq!(
            c.ask(r#"{"op":"stop_run","slot":2,"run":"aaaa"}"#).await,
            json!({ "ok": true })
        );
        assert_eq!(*stops.borrow_and_update(), Some((2, "aaaa".to_string())));

        /* Watching: a snapshot now, another on a change, and requests still answered meanwhile. */
        let mut w = Client::connect(&path).await;
        assert_eq!(w.ask(r#"{"op":"watch"}"#).await["agents"][0]["state"], "running");
        state_tx.send_modify(|s| s.agents[0].run_ended("aaaa"));
        let changed = w.next().await;
        assert_eq!(changed["agents"][0]["state"], "watching");
        assert_eq!(changed["agents"][0]["runs"], json!([]));
        state_tx.send_modify(|s| s.stopping = true);
        assert_eq!(w.next().await["stopping"], true);
        assert!(w.ask(r#"{"op":"stop_run","slot":2,"run":"aaaa"}"#).await["error"].is_string());

        /* Dropping the server hangs up and removes the socket. */
        drop(server);
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_dead_daemons_socket_is_replaced_and_anything_else_is_left_alone() {
        let dir = scratch("stale");
        let path = dir.join("daemon-test.sock");
        fs::create_dir_all(&dir).unwrap();
        /* A socket nobody listens on any more, as a daemon killed with SIGKILL leaves. */
        drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
        assert!(path.exists());
        let (_tx, state) = watch::channel(running());
        let (stop_tx, _) = watch::channel::<StopRequest>(None);
        let server = Server::start(&path, state.clone(), RunStopper(stop_tx.clone())).unwrap();
        assert_eq!(
            Client::connect(&path).await.ask(r#"{"op":"status"}"#).await["version"],
            1
        );
        drop(server);

        fs::write(&path, "mine").unwrap();
        let err = Server::start(&path, state, RunStopper(stop_tx)).unwrap_err();
        assert!(err.to_string().contains("not a socket"), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
        let _ = fs::remove_dir_all(&dir);
    }
}
