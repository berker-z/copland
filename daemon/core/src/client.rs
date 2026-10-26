//! `copland-daemon status` (COPL-185): the status socket (COPL-184) read from a terminal or a
//! script. One snapshot as text or JSON, or every change until interrupted. `copland-daemon hold`
//! and `release` (COPL-186) hold an agent on this machine through it, and let it go; `reload`
//! (COPL-197) has it read its config again.
//!
//! "Not running" is an answer, not an error: `Outcome::NotRunning`, which the command exits 3
//! on (`NOT_RUNNING`), so a script can tell it from something going wrong (exit 1).

use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::daemon::Reloaded;
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
        Outcome::NotRunning { ended: false, .. } => not_running(config, runtime_dir, socket),
        o => Ok(o),
    }
}

/// Nothing answers at `socket`: no daemon, unless something holds the lock, which is a daemon
/// from before the socket.
fn not_running(config: &Path, runtime_dir: &Path, socket: PathBuf) -> Result<Outcome> {
    if let Some(holder) = lock::running(config, runtime_dir)? {
        bail!(
            "a daemon is running {} ({holder}) but serves no status at {}: it predates `status`; restart it",
            config.display(),
            socket.display()
        );
    }
    Ok(Outcome::NotRunning { socket, ended: false })
}

/// A connection to the daemon running a config, asking one request at a time.
struct Asker {
    socket: PathBuf,
    lines: tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>,
    write: tokio::net::unix::OwnedWriteHalf,
}

impl Asker {
    /// Connect to the daemon running `config`, or say why not.
    async fn connect(config: &Path, runtime_dir: &Path) -> Result<Result<Self, Outcome>> {
        let socket = lock::socket_for(config, runtime_dir);
        let stream = match UnixStream::connect(&socket).await {
            Ok(s) => s,
            Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
                return not_running(config, runtime_dir, socket).map(Err);
            }
            Err(e) => return Err(e).with_context(|| format!("connecting to {}", socket.display())),
        };
        let (read, write) = stream.into_split();
        Ok(Ok(Self {
            socket,
            lines: BufReader::new(read).lines(),
            write,
        }))
    }

    async fn ask(&mut self, request: &str) -> Result<String> {
        self.write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .with_context(|| format!("asking {}", self.socket.display()))?;
        self.lines
            .next_line()
            .await
            .with_context(|| format!("reading {}", self.socket.display()))?
            .with_context(|| format!("the daemon at {} hung up without answering", self.socket.display()))
    }
}

/// Have the daemon running `config` load it again and run what it says now (COPL-197), and say
/// on `out` what changed. A config that doesn't load is an error, and the daemon goes on as it was.
pub async fn reload(config: &Path, runtime_dir: &Path, out: &mut (dyn Write + Send)) -> Result<Outcome> {
    let mut daemon = match Asker::connect(config, runtime_dir).await? {
        Ok(a) => a,
        Err(o) => return Ok(o),
    };
    let answer = ok(&daemon.ask(r#"{"op":"reload"}"#).await?)?;
    let reloaded: Reloaded = serde_json::from_value(answer["reloaded"].clone())
        .context("the daemon's answer doesn't say what it reloaded")?;
    out.write_all(reloaded.says(config).as_bytes())
        .context("writing the answer")?;
    Ok(Outcome::Shown)
}

/// Hold (`held`) or release the agent `handle` (as the server says it, or as `daemon.toml` has
/// it, with or without the @) of the daemon running `config`, and say so on `out`. Holding is
/// this machine's alone: Copland's pause is untouched (see daemon/README.md's "The status socket").
pub async fn hold(
    config: &Path,
    runtime_dir: &Path,
    handle: &str,
    held: bool,
    out: &mut (dyn Write + Send),
) -> Result<Outcome> {
    let mut daemon = match Asker::connect(config, runtime_dir).await? {
        Ok(a) => a,
        Err(o) => return Ok(o),
    };
    let status = parse(&daemon.ask(r#"{"op":"status"}"#).await?)?;
    let wanted = handle.trim_start_matches('@');
    let Some(agent) = status
        .agents
        .iter()
        .find(|a| a.handle == wanted || a.configured.trim_start_matches('@') == wanted)
    else {
        let runs: Vec<String> = status.agents.iter().map(|a| format!("@{}", a.handle)).collect();
        bail!(
            "the daemon running {} has no agent @{wanted}; it runs {}",
            config.display(),
            if runs.is_empty() {
                "none".into()
            } else {
                runs.join(", ")
            }
        );
    };
    let op = if held { "hold" } else { "release" };
    done(&daemon.ask(&format!(r#"{{"op":"{op}","slot":{}}}"#, agent.slot)).await?)?;
    let says = if held {
        format!(
            "@{} held on this machine: it starts nothing until `copland-daemon release {}`; runs going finish\n",
            agent.handle, agent.handle
        )
    } else {
        format!("@{} released on this machine\n", agent.handle)
    };
    out.write_all(says.as_bytes()).context("writing the answer")?;
    Ok(Outcome::Shown)
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

/// The answer to a request that changes something: `{"ok":true}`, or `{"error":…}` as an error
/// saying the socket's text.
pub(crate) fn done(line: &str) -> Result<()> {
    ok(line).map(drop)
}

/// The same, keeping what else `{"ok":true,…}` says.
pub(crate) fn ok(line: &str) -> Result<serde_json::Value> {
    let answer: serde_json::Value = serde_json::from_str(line).context("the daemon's answer isn't JSON")?;
    if let Some(e) = answer.get("error") {
        bail!("the daemon says: {}", e.as_str().unwrap_or(&e.to_string()));
    }
    Ok(answer)
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
    use crate::daemon::{Holder, Reloader, RunStopper};
    use crate::socket::Server;
    use crate::state::{AgentState, DaemonState, Phase};

    fn scratch(name: &str) -> PathBuf {
        /* /tmp, not $TMPDIR: macOS's is long enough to push the socket past SUN_LEN. */
        let dir = PathBuf::from("/tmp").join(format!("copland-client-{name}-{}", std::process::id()));
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
        let server = Server::start(
            &lock::socket_for(&config, &dir),
            state,
            RunStopper(stop_tx),
            Holder(state_tx.clone()),
            Reloader::nowhere(),
        )
        .unwrap();

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
    async fn hold_and_release_name_the_agent_by_handle() {
        let dir = scratch("hold");
        let config = dir.join("daemon.toml");
        fs::write(&config, "").unwrap();
        let mut st = running();
        st.agents[0].handle = "me/dev-renamed".into();
        let (state_tx, state) = watch::channel(st);
        let (stop_tx, _) = watch::channel::<StopRequest>(None);
        let _server = Server::start(
            &lock::socket_for(&config, &dir),
            state,
            RunStopper(stop_tx),
            Holder(state_tx.clone()),
            Reloader::nowhere(),
        )
        .unwrap();

        /* By the handle the server says, with the @. */
        let mut out = Vec::new();
        assert_eq!(
            hold(&config, &dir, "@me/dev-renamed", true, &mut out).await.unwrap(),
            Outcome::Shown
        );
        assert!(state_tx.borrow().agents[0].held);
        let said = String::from_utf8(out).unwrap();
        assert!(said.starts_with("@me/dev-renamed held on this machine"), "{said}");
        let mut out = Vec::new();
        status(&config, &dir, ONCE, &mut out).await.unwrap();
        assert!(String::from_utf8(out).unwrap().contains("held on this machine"));

        /* By the handle daemon.toml has. */
        let mut out = Vec::new();
        hold(&config, &dir, "me/dev", false, &mut out).await.unwrap();
        assert!(!state_tx.borrow().agents[0].held);
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "@me/dev-renamed released on this machine\n"
        );

        let err = hold(&config, &dir, "me/ops", true, &mut Vec::new()).await.unwrap_err();
        assert!(
            err.to_string().contains("no agent @me/ops; it runs @me/dev-renamed"),
            "{err}"
        );
        drop(_server);
        assert!(matches!(
            hold(&config, &dir, "me/dev", true, &mut Vec::new()).await.unwrap(),
            Outcome::NotRunning { ended: false, .. }
        ));
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
