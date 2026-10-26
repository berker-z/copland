//! Opening the box from the tray (COPL-201): `copland-box --config <the tray's>`, detached, so
//! quitting the tray leaves it open. The box is a client of the daemon (COPL-204) and offers to
//! start one when none runs, so it is started the same way whether a daemon is up or not. Nothing
//! says whether a box is open on a config already, so each click starts one.

use std::fs::OpenOptions;
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use copland_daemon_core::autostart;

/// The box's binary.
pub const BOX: &str = "copland-box";

/// How long a box is watched for exiting straight away (no display, a missing library).
pub const SETTLE: Duration = Duration::from_secs(2);

/// The box to start: the one beside this tray (they ship together), else the first on PATH.
pub fn box_binary() -> Result<PathBuf> {
    let exe = std::env::current_exe().ok();
    autostart::beside(exe.as_deref(), BOX)
        .or_else(|| autostart::find(BOX))
        .with_context(|| {
            format!("no {BOX} beside the tray or on PATH: it ships with the tray, so install the two together")
        })
}

/// What the box is started with.
pub fn arguments(config: &Path) -> [&std::ffi::OsStr; 2] {
    ["--config".as_ref(), config.as_os_str()]
}

/// Start `program --config <config>` in a process group of its own (a terminal's ctrl+c for the
/// tray doesn't reach it), stdin from /dev/null, output appended to `log`.
pub fn spawn(program: &Path, config: &Path, log: &Path) -> Result<Child> {
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("making {}", dir.display()))?;
    }
    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .with_context(|| format!("opening {}", log.display()))?;
    let err = out.try_clone().with_context(|| format!("opening {}", log.display()))?;
    Command::new(program)
        .args(arguments(config))
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .process_group(0)
        .spawn()
        .with_context(|| format!("starting {}", program.display()))
}

/// Wait up to `settle` for the box to exit; an exit in that time is an error naming its status
/// and `log`. Past it, the child is reaped in the background whenever it exits.
pub fn settle(mut child: Child, settle: Duration, log: &Path) -> Result<()> {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().context("waiting for the box")? {
            if status.success() {
                return Ok(());
            }
            bail!("{BOX} exited ({status}); its output is in {}", log.display());
        }
        if started.elapsed() >= settle {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Open the box on `config`, its output in `<state dir>/box.log`. Blocks for `SETTLE` at most.
pub fn open(config: &Path) -> Result<()> {
    let log = copland_daemon_core::config::default_state_dir().join("box.log");
    let child = spawn(&box_binary()?, config, &log)?;
    settle(child, SETTLE, &log)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("copland-tray-open-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn script(dir: &Path, body: &str) -> PathBuf {
        let p = dir.join(BOX);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn starts_the_box_on_the_config_and_keeps_its_output() {
        let dir = scratch("ok");
        let program = script(&dir, "echo \"$@\"; sleep 5");
        let log = dir.join("state/box.log");
        let config = dir.join("my conf/daemon.toml");
        let child = spawn(&program, &config, &log).unwrap();
        let pid = child.id();
        /* Still running after the settle: started. */
        settle(child, Duration::from_millis(300), &log).unwrap();
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            format!("--config {}\n", config.display())
        );
        /* In a group of its own. */
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
        let fields: Vec<&str> = stat.rsplit_once(')').unwrap().1.split_whitespace().collect();
        assert_eq!(fields[2], pid.to_string());
        let _ = Command::new("kill").arg(pid.to_string()).status();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_box_that_exits_at_once_says_so() {
        let dir = scratch("fails");
        let program = script(&dir, "echo no display >&2; exit 3");
        let log = dir.join("box.log");
        let child = spawn(&program, Path::new("/x/daemon.toml"), &log).unwrap();
        let e = settle(child, Duration::from_secs(5), &log).unwrap_err().to_string();
        assert!(e.starts_with("copland-box exited"), "{e}");
        assert!(e.contains("box.log"), "{e}");
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "no display\n");
        /* One that exits cleanly in the settle is fine. */
        let program = script(&dir, "exit 0");
        settle(spawn(&program, Path::new("/x"), &log).unwrap(), SETTLE, &log).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
