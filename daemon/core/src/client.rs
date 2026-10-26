//! `copland-daemon status` (COPL-185): the status socket (COPL-184) read from a terminal or a
//! script. One snapshot as text or JSON, or every change until interrupted.
//!
//! "Not running" is an answer, not an error: `Outcome::NotRunning`, which the command exits 3
//! on (`NOT_RUNNING`), so a script can tell it from something going wrong (exit 1).

use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::lock;
use crate::status::Status;

/// The exit code for "no daemon is running this config".
pub const NOT_RUNNING: i32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mode {
    /// The JSON as the socket sends it, one snapshot per line, rather than `Status::render`.
    pub json: bool,
    /// Every change until interrupted, rather than one snapshot.
    pub watch: bool,
    /// Clear the screen before each text snapshot when watching (stdout is a terminal);
    /// otherwise they are separated by a `---` line.
    pub clear: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Shown: one snapshot, or a watch the reader stopped (closed the pipe).
    Shown,
    /// Nobody serves the socket: no daemon is running the config, or it ended while watched.
    NotRunning { socket: PathBuf, ended: bool },
}

impl Outcome {
    /// What to tell a person when it is `NotRunning`, `named` when the command had `--config`.
    pub fn says(&self, config: &Path, named: bool) -> Option<String> {
        let Outcome::NotRunning { ended, .. } = self else {
            return None;
        };
        let start = if named {
            format!("copland-daemon --config {}", config.display())
        } else {
            "copland-daemon".into()
        };
        Some(if *ended {
            format!("the daemon running {} stopped", config.display())
        } else {
            format!(
                "no daemon is running {}: start it with `{start}`, or open the box",
                config.display()
            )
        })
    }
}

/// Show the status of the daemon running `config` on `out`.
pub async fn status(config: &Path, runtime_dir: &Path, mode: Mode, out: &mut (dyn Write + Send)) -> Result<Outcome> {
    let socket = lock::socket_for(config, runtime_dir);
    match show(&socket, mode, out).await? {
        Outcome::NotRunning { ended: false, .. } => {
            /* No socket, yet something holds the lock: a daemon from before the socket. */
            if let Some(holder) = lock::running(config, runtime_dir)? {
                bail!(
                    "a daemon is running {} ({holder}) but serves no status at {}: it predates `status`; restart it",
                    config.display(),
                    socket.display()
                );
            }
            Ok(Outcome::NotRunning { socket, ended: false })
        }
        o => Ok(o),
    }
}

/// Show what the daemon serving `socket` says, on `out`.
pub async fn show(socket: &Path, mode: Mode, out: &mut (dyn Write + Send)) -> Result<Outcome> {
    let not_running = |ended| Outcome::NotRunning {
        socket: socket.to_path_buf(),
        ended,
    };
    let stream = match UnixStream::connect(socket).await {
        Ok(s) => s,
        /* No socket, or one a killed daemon left that nobody listens on. */
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
            return Ok(not_running(false));
        }
        Err(e) => return Err(e).with_context(|| format!("connecting to {}", socket.display())),
    };
    let (read, mut write) = stream.into_split();
    let op = if mode.watch { "watch" } else { "status" };
    write
        .write_all(format!("{{\"op\":\"{op}\"}}\n").as_bytes())
        .await
        .with_context(|| format!("asking {}", socket.display()))?;
    let mut lines = BufReader::new(read).lines();
    let mut shown = 0usize;
    let mut last = String::new();
    loop {
        let Some(line) = lines
            .next_line()
            .await
            .with_context(|| format!("reading {}", socket.display()))?
        else {
            if shown == 0 {
                bail!("the daemon at {} hung up without answering", socket.display());
            }
            return Ok(not_running(true));
        };
        let status = parse(&line)?;
        let text = if mode.json {
            format!("{}\n", line.trim_end())
        } else {
            let text = status.render();
            /* A poll changes the state without changing what the text says. */
            if text == last {
                continue;
            }
            last = text.clone();
            match (mode.watch, mode.clear, shown) {
                (true, true, _) => format!("\x1b[H\x1b[2J{text}"),
                (true, false, 1..) => format!("---\n{text}"),
                _ => text,
            }
        };
        match out.write_all(text.as_bytes()).and_then(|_| out.flush()) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::BrokenPipe => return Ok(Outcome::Shown),
            Err(e) => return Err(e).context("writing the status"),
        }
        shown += 1;
        if !mode.watch {
            return Ok(Outcome::Shown);
        }
    }
}

/// One answer from the socket: a `Status`, or `{"error":…}`.
fn parse(line: &str) -> Result<Status> {
    let value: serde_json::Value = serde_json::from_str(line).context("the daemon's answer isn't JSON")?;
    if let Some(e) = value.get("error") {
        bail!("the daemon says: {}", e.as_str().unwrap_or(&e.to_string()));
    }
    serde_json::from_value(value).context("the daemon's answer isn't a status")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use tokio::sync::watch;

    use super::*;
    use crate::agent::StopRequest;
    use crate::daemon::RunStopper;
    use crate::socket::Server;
    use crate::state::{AgentState, DaemonState, Phase};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("copland-client-{name}-{}", std::process::id()));
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

    /// A `Write` the test can read while `show` is still writing to it.
    #[derive(Clone, Default)]
    struct Shared(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Shared {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }

        async fn until(&self, what: impl Fn(&str) -> bool) -> String {
            for _ in 0..500 {
                let t = self.text();
                if what(&t) {
                    return t;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("never came: {:?}", self.text());
        }
    }

    const ONCE: Mode = Mode {
        json: false,
        watch: false,
        clear: false,
    };

    #[tokio::test]
    async fn each_mode_prints_what_the_daemon_says() {
        let dir = scratch("modes");
        let config = dir.join("daemon.toml");
        fs::write(&config, "").unwrap();
        let (state_tx, state) = watch::channel(running());
        let (stop_tx, _) = watch::channel::<StopRequest>(None);
        let server = Server::start(&lock::socket_for(&config, &dir), state, RunStopper(stop_tx)).unwrap();

        /* status: Status::render. */
        let mut out = Vec::new();
        assert_eq!(status(&config, &dir, ONCE, &mut out).await.unwrap(), Outcome::Shown);
        let expected = Status::of(&running()).render();
        assert_eq!(String::from_utf8(out).unwrap(), expected);
        assert!(expected.contains("@me/dev  ● T-1"), "{expected}");

        /* status --json: one line, the snapshot. */
        let mut out = Vec::new();
        let json = Mode { json: true, ..ONCE };
        assert_eq!(status(&config, &dir, json, &mut out).await.unwrap(), Outcome::Shown);
        let out = String::from_utf8(out).unwrap();
        assert_eq!(out.lines().count(), 1);
        assert!(out.ends_with('\n'));
        let s: Status = serde_json::from_str(&out).unwrap();
        assert_eq!(s, Status::of(&running()));

        /* status --watch --json: a line now and one per change. */
        let lines = Shared::default();
        let watching = {
            let (config, dir, mut out) = (config.clone(), dir.clone(), lines.clone());
            tokio::spawn(async move {
                let mode = Mode {
                    json: true,
                    watch: true,
                    clear: false,
                };
                status(&config, &dir, mode, &mut out).await
            })
        };
        lines.until(|t| t.lines().count() == 1).await;
        state_tx.send_modify(|s| s.agents[0].run_ended("aaaa"));
        let t = lines.until(|t| t.lines().count() == 2).await;
        let second: Status = serde_json::from_str(t.lines().nth(1).unwrap()).unwrap();
        assert_eq!(second.agents[0].state, "watching");

        /* status --watch: the text again on a change, not on one it doesn't show. */
        let text = Shared::default();
        let reprinting = {
            let (config, dir, mut out) = (config.clone(), dir.clone(), text.clone());
            tokio::spawn(async move {
                let mode = Mode { watch: true, ..ONCE };
                status(&config, &dir, mode, &mut out).await
            })
        };
        text.until(|t| t.contains("○ watching")).await;
        state_tx.send_modify(|s| s.agents[0].last_poll = Some(std::time::SystemTime::UNIX_EPOCH));
        state_tx.send_modify(|s| s.stopping = true);
        let t = text.until(|t| t.contains("---\nstopping\n")).await;
        assert_eq!(t.matches("---").count(), 1, "{t}");

        /* The daemon ending ends both watches as not running. */
        drop(server);
        let socket = lock::socket_for(&config, &dir);
        for w in [watching, reprinting] {
            let o = tokio::time::timeout(Duration::from_secs(5), w)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(
                o,
                Outcome::NotRunning {
                    socket: socket.clone(),
                    ended: true
                }
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn no_daemon_is_not_running_and_an_old_one_is_an_error() {
        let dir = scratch("none");
        let config = dir.join("daemon.toml");
        fs::write(&config, "").unwrap();
        let socket = lock::socket_for(&config, &dir);
        let none = Outcome::NotRunning {
            socket: socket.clone(),
            ended: false,
        };
        let mut out = Vec::new();
        assert_eq!(status(&config, &dir, ONCE, &mut out).await.unwrap(), none);
        let says = none.says(&config, true).unwrap();
        assert!(says.starts_with("no daemon is running"), "{says}");
        assert!(says.contains("--config"), "{says}");
        assert_eq!(Outcome::Shown.says(&config, false), None);

        /* A socket a killed daemon left behind is not running too. */
        fs::create_dir_all(socket.parent().unwrap()).unwrap();
        drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
        assert_eq!(status(&config, &dir, ONCE, &mut out).await.unwrap(), none);
        assert!(out.is_empty());
        fs::remove_file(&socket).unwrap();

        /* The lock held with no socket: a daemon from before it, which is an error. */
        let _lock = lock::Lock::take(&config, &dir, "copland-daemon").unwrap();
        let err = status(&config, &dir, ONCE, &mut out).await.unwrap_err();
        assert!(err.to_string().contains("serves no status"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }
}
