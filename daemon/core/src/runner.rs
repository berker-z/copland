//! One runtime process for one run: its MCP config, its log, its keepalive,
//! and stopping it.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::process::Command;
use tokio::sync::watch;
use tokio::time::{Instant, interval_at, timeout};

use crate::api::Api;
use crate::config::{AgentConfig, Secret, fill_command};

/// How often a live runtime's run is kept alive. The lease is ten minutes.
pub const KEEPALIVE: Duration = Duration::from_secs(120);
/// How long a runtime gets between SIGTERM and SIGKILL.
pub const GRACE: Duration = Duration::from_secs(10);

/// How long a runtime may run before the daemon stops it and fails the run. Fixed, on purpose.
pub const CEILING: Duration = Duration::from_secs(2 * 60 * 60);

/// What the runtime is launched to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Brief {
    /// Its run claimed the task: work on it.
    Work,
    /// No claim (the task is someone else's); it was mentioned there.
    Mentioned,
    /// No claim (the task is someone else's); there are comments for it there.
    Commented,
    /// No claim (the task is closed); it was mentioned there.
    Closed,
}

/// The prompt the runtime starts with. Short: the MCP guide carries the rest.
pub fn prompt(handle: &str, task_key: &str, brief: Brief) -> String {
    match brief {
        Brief::Work => format!(
            "You are @{handle} working on {task_key}. Read it with get_task, check your inbox, and work as the copland guide says. When you stop, leave the task in the right stage."
        ),
        Brief::Mentioned => format!(
            "You are @{handle}. You were mentioned on {task_key}, which isn't yours. Read it with get_task, answer in its comments, and don't take it over."
        ),
        Brief::Commented => format!(
            "You are @{handle}. There are new comments for you on {task_key}, which isn't yours. Read it with get_task, answer in its comments if they need you, and don't take it over."
        ),
        Brief::Closed => format!(
            "You are @{handle}. You were mentioned on {task_key}, which is closed. Read it with get_task, answer in its comments, and don't reopen it or take it over."
        ),
    }
}

/// How the runtime ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Exit {
    Code(i32),
    Signal(i32),
    /// The daemon stopped it on shutdown.
    Stopped,
    /// The daemon stopped it at the ceiling.
    TimedOut,
    /// It never started.
    SpawnFailed(String),
}

impl std::fmt::Display for Exit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Exit::Code(c) => write!(f, "exit {c}"),
            Exit::Signal(s) => write!(f, "signal {s}"),
            Exit::Stopped => write!(f, "stopped by the daemon"),
            Exit::TimedOut => write!(f, "stopped at the run ceiling"),
            Exit::SpawnFailed(e) => write!(f, "did not start: {e}"),
        }
    }
}

/// A file deleted when this is dropped.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// The MCP config Claude Code (and others) read: Copland over HTTP, authorised by the run's secret.
pub fn mcp_config_json(url: &str, secret: &Secret) -> String {
    serde_json::json!({
        "mcpServers": {
            "copland": {
                "type": "http",
                "url": format!("{url}/mcp"),
                "headers": { "Authorization": format!("Bearer {}", secret.expose()) }
            }
        }
    })
    .to_string()
}

fn private_dir(dir: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .with_context(|| format!("creating {}", dir.display()))
}

fn private_file(path: &Path, append: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).mode(0o600);
    if append {
        options.create(true).append(true);
    } else {
        options.create_new(true);
    }
    options
        .open(path)
        .with_context(|| format!("opening {}", path.display()))
}

pub struct Launch<'a> {
    pub api: &'a Api,
    pub agent: &'a AgentConfig,
    /// The server's handle for the agent.
    pub handle: &'a str,
    pub run_id: &'a str,
    pub secret: &'a Secret,
    pub task_key: &'a str,
    pub brief: Brief,
    pub state_dir: &'a Path,
    pub runtime_dir: &'a Path,
}

/// Where a run's output goes.
pub fn log_path(state_dir: &Path, run_id: &str) -> PathBuf {
    state_dir.join("runs").join(format!("{run_id}.log"))
}

/// "2h", "90s": a duration the way the log says it.
pub fn span(d: Duration) -> String {
    let s = d.as_secs();
    if s >= 3600 && s % 3600 == 0 {
        format!("{}h", s / 3600)
    } else if s >= 60 && s % 60 == 0 {
        format!("{}m", s / 60)
    } else {
        format!("{s}s")
    }
}

/// Start the runtime, keep its run alive while it lives, stop it if asked or once it reaches the ceiling. Returns how it ended.
pub async fn run(launch: Launch<'_>, shutdown: watch::Receiver<bool>) -> Exit {
    run_until(launch, shutdown, CEILING).await
}

async fn run_until(launch: Launch<'_>, mut shutdown: watch::Receiver<bool>, ceiling: Duration) -> Exit {
    let Launch {
        api,
        agent,
        handle,
        run_id,
        secret,
        task_key,
        brief,
        state_dir,
        runtime_dir,
    } = launch;

    let mcp_dir = runtime_dir.join("copland");
    let mcp_path = mcp_dir.join(format!("mcp-{run_id}.json"));
    let log = log_path(state_dir, run_id);
    let setup = (|| -> Result<(TempFile, File)> {
        private_dir(&mcp_dir)?;
        let mut file = private_file(&mcp_path, false)?;
        let guard = TempFile(mcp_path.clone());
        file.write_all(mcp_config_json(&agent.url, secret).as_bytes())?;
        private_dir(log.parent().expect("log path has a parent"))?;
        let log_file = private_file(&log, true)?;
        Ok((guard, log_file))
    })();
    let (_mcp_file, mut log_file) = match setup {
        Ok(v) => v,
        Err(e) => return Exit::SpawnFailed(format!("{e:#}")),
    };

    let argv = fill_command(&agent.command, &prompt(handle, task_key, brief), &mcp_path);
    let _ = writeln!(
        log_file,
        "# copland-daemon: run {run_id}, @{handle} on {task_key}, in {}\n# argv: {:?}",
        agent.workdir.display(),
        argv
    );
    let stderr = match log_file.try_clone() {
        Ok(f) => f,
        Err(e) => return Exit::SpawnFailed(e.to_string()),
    };

    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .current_dir(&agent.workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr))
        /* Its own process group: a Ctrl-C at the terminal reaches the daemon, not the
        runtime, and stopping it reaches whatever the runtime started too. */
        .process_group(0)
        .kill_on_drop(true)
        .env("COPLAND_URL", &agent.url)
        .env("COPLAND_TASK", task_key)
        .env("COPLAND_RUN", run_id)
        .env("COPLAND_MCP_CONFIG", &mcp_path);
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => return Exit::SpawnFailed(format!("{}: {e}", argv[0])),
    };
    let pid = child.id();
    tracing::info!(run = %short(run_id), task = task_key, pid, log = %log.display(), "runtime started");

    let deadline = Instant::now() + ceiling;
    let mut keepalive = interval_at(Instant::now() + KEEPALIVE, KEEPALIVE);
    let mut alive = true;
    loop {
        tokio::select! {
            status = child.wait() => {
                return match status {
                    Ok(s) => match (s.code(), std::os::unix::process::ExitStatusExt::signal(&s)) {
                        (Some(c), _) => Exit::Code(c),
                        (None, Some(sig)) => Exit::Signal(sig),
                        _ => Exit::Code(-1),
                    },
                    Err(e) => Exit::SpawnFailed(e.to_string()),
                };
            }
            _ = keepalive.tick(), if alive => {
                match api.run(secret, run_id).await {
                    Ok(r) => tracing::debug!(run = %r.short, status = %r.status, "keepalive"),
                    Err(e) if e.is_refusal() => {
                        /* The runtime finished the run itself, or it went stale: its secret is dead. */
                        tracing::info!(run = %short(run_id), "run's credential no longer works ({e}); no more keepalives");
                        alive = false;
                    }
                    Err(e) => tracing::warn!(run = %short(run_id), "keepalive failed: {e}"),
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                tracing::warn!(run = %short(run_id), task = task_key, "still running at the ceiling of {}; stopping it", span(ceiling));
                stop(&mut child, pid).await;
                return Exit::TimedOut;
            }
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    tracing::info!(run = %short(run_id), "stopping the runtime");
                    stop(&mut child, pid).await;
                    return Exit::Stopped;
                }
            }
        }
    }
}

/// SIGTERM to the runtime's process group, then SIGKILL after the grace period.
async fn stop(child: &mut tokio::process::Child, pid: Option<u32>) {
    if let Some(pid) = pid {
        // SAFETY: kill(2) with a negative pid signals that process group; the group is the child's own.
        unsafe { libc::kill(-(pid as i32), libc::SIGTERM) };
    }
    if timeout(GRACE, child.wait()).await.is_err() {
        if let Some(pid) = pid {
            // SAFETY: as above.
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
        let _ = child.wait().await;
    }
}

/// "8f31", the way Copland shows a run.
pub fn short(run_id: &str) -> String {
    run_id.chars().filter(|c| *c != '-').take(4).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_config_is_claude_codes_http_shape() {
        let json: serde_json::Value =
            serde_json::from_str(&mcp_config_json("http://h", &Secret::new("cplr_x"))).unwrap();
        let server = &json["mcpServers"]["copland"];
        assert_eq!(server["type"], "http");
        assert_eq!(server["url"], "http://h/mcp");
        assert_eq!(server["headers"]["Authorization"], "Bearer cplr_x");
    }

    #[test]
    fn short_matches_coplands() {
        assert_eq!(short("8f31a2b4-0000-0000-0000-000000000000"), "8f31");
        assert_eq!(short("8f-31ab"), "8f31");
    }

    #[test]
    fn prompt_names_the_agent_and_task() {
        let p = prompt("me/dev", "COPL-9", Brief::Work);
        assert!(p.starts_with("You are @me/dev working on COPL-9."));
        let p = prompt("me/dev", "COPL-9", Brief::Mentioned);
        assert_eq!(
            p,
            "You are @me/dev. You were mentioned on COPL-9, which isn't yours. Read it with get_task, answer in its comments, and don't take it over."
        );
        assert!(prompt("me/dev", "COPL-9", Brief::Closed).contains("which is closed"));
    }

    #[test]
    fn spans_read_plainly() {
        assert_eq!(span(CEILING), "2h");
        assert_eq!(span(Duration::from_secs(90)), "90s");
        assert_eq!(span(Duration::from_secs(600)), "10m");
    }

    /// A runtime still going at the ceiling is stopped (SIGTERM to its group) and reported as such.
    #[tokio::test]
    async fn the_ceiling_stops_the_runtime() {
        let scratch = std::env::temp_dir().join(format!("copland-ceiling-{}", std::process::id()));
        let agent = AgentConfig {
            url: "http://127.0.0.1:9".into(),
            handle: "me/dev".into(),
            token: Secret::new("cpl_x"),
            command: vec!["sleep".into(), "30".into()],
            workdir: std::env::temp_dir(),
            client: "test".into(),
        };
        let api = Api::new(&agent.url).unwrap();
        let (_tx, shutdown) = watch::channel(false);
        let started = std::time::Instant::now();
        let exit = run_until(
            Launch {
                api: &api,
                agent: &agent,
                handle: "me/dev",
                run_id: "00000000-0000-0000-0000-000000000000",
                secret: &Secret::new("cplr_x"),
                task_key: "T-1",
                brief: Brief::Work,
                state_dir: &scratch,
                runtime_dir: &scratch,
            },
            shutdown,
            Duration::from_millis(300),
        )
        .await;
        let _ = fs::remove_dir_all(&scratch);
        assert_eq!(exit, Exit::TimedOut);
        /* sleep dies on SIGTERM, so the grace period is not waited out. */
        assert!(started.elapsed() < GRACE, "took {:?}", started.elapsed());
    }
}
