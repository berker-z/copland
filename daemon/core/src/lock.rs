//! One daemon per config (COPL-175). Two daemons on one config, or a daemon and a box (which
//! runs the same loop in-process), would both run the same agents. So whoever starts the loop
//! takes an exclusive `flock` on a file under `<runtime dir>/copland/`, named after the config's
//! canonical path, and holds it for the process's life. The kernel lets it go on exit or crash,
//! so a lock is never stale; the file only says who holds it (pid and binary), for the message
//! a second start fails with and for `running`.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

/// Who holds a config's lock, as its file says. Either may be missing for a moment: the file is
/// written just after the lock is taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holder {
    pub pid: Option<u32>,
    pub binary: Option<String>,
    /// Its version (COPL-219: `--check` tells it from the binary's on disk after an upgrade).
    /// None from a daemon older than that.
    pub version: Option<String>,
}

impl std::fmt::Display for Holder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.pid {
            Some(pid) => write!(f, "pid {pid}")?,
            None => write!(f, "pid unknown")?,
        }
        if let Some(b) = &self.binary {
            write!(f, ", {b}")?;
        }
        Ok(())
    }
}

/// The config's lock, held until dropped (or the process ends).
#[derive(Debug)]
pub struct Lock {
    _file: File,
    path: PathBuf,
}

/// The config is already being run.
#[derive(Debug)]
pub struct Held {
    pub config: PathBuf,
    pub holder: Holder,
}

impl std::fmt::Display for Held {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "a daemon is already running {} ({}); stop it, or give this one a config of its own with --config",
            self.config.display(),
            self.holder
        )
    }
}

impl std::error::Error for Held {}

/// The lock file for a config: `<runtime_dir>/copland/daemon-<hash>.lock`, the hash a SHA-256 of
/// the config's canonical path (as given, made absolute, when it can't be resolved), so the same
/// file reached by two paths is one lock.
pub fn path_for(config: &Path, runtime_dir: &Path) -> PathBuf {
    named("daemon", config, runtime_dir)
}

/// The tray's lock for a config (COPL-224), `tray-<hash>.lock` beside the daemon's: one tray per
/// config, and `copland-daemon stop` finds the tray to stop by it.
pub fn tray_path_for(config: &Path, runtime_dir: &Path) -> PathBuf {
    named("tray", config, runtime_dir)
}

fn named(kind: &str, config: &Path, runtime_dir: &Path) -> PathBuf {
    let resolved = fs::canonicalize(config).unwrap_or_else(|_| std::path::absolute(config).unwrap_or(config.into()));
    let digest = ring::digest::digest(&ring::digest::SHA256, resolved.as_os_str().as_encoded_bytes());
    let hex: String = digest.as_ref()[..8].iter().map(|b| format!("{b:02x}")).collect();
    runtime_dir.join("copland").join(format!("{kind}-{hex}.lock"))
}

fn open(path: &Path, create: bool) -> std::io::Result<File> {
    if let (true, Some(dir)) = (create, path.parent()) {
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    }
    /* Never truncated on open: the holder's pid is in it until the lock is ours. */
    OpenOptions::new()
        .read(true)
        .write(create)
        .create(create)
        .truncate(false)
        .mode(0o600)
        .open(path)
}

/// `flock` without waiting. Ok(false) when someone else holds it.
fn try_flock(file: &File, op: libc::c_int) -> std::io::Result<bool> {
    if unsafe { libc::flock(file.as_raw_fd(), op | libc::LOCK_NB) } == 0 {
        return Ok(true);
    }
    let e = std::io::Error::last_os_error();
    if e.raw_os_error() == Some(libc::EWOULDBLOCK) {
        Ok(false)
    } else {
        Err(e)
    }
}

fn read_holder(file: &mut File) -> Holder {
    let mut text = String::new();
    let _ = file
        .seek(SeekFrom::Start(0))
        .and_then(|_| file.read_to_string(&mut text));
    let mut lines = text.lines();
    Holder {
        pid: lines.next().and_then(|l| l.trim().parse().ok()),
        binary: lines
            .next()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(str::to_string),
        version: lines
            .next()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string),
    }
}

impl Lock {
    /// Take the config's lock for `binary` (`copland-daemon`, `copland-box`). Fails with `Held`
    /// (downcast the error to read it) when another process, or another `Lock` in this one, has it.
    pub fn take(config: &Path, runtime_dir: &Path, binary: &str) -> Result<Lock> {
        Self::take_at(path_for(config, runtime_dir), config, binary)
    }

    /// Take the tray's lock for a config (`tray_path_for`), as `take` does the daemon's.
    pub fn take_tray(config: &Path, runtime_dir: &Path, binary: &str) -> Result<Lock> {
        Self::take_at(tray_path_for(config, runtime_dir), config, binary)
    }

    fn take_at(path: PathBuf, config: &Path, binary: &str) -> Result<Lock> {
        let mut file = open(&path, true).with_context(|| format!("opening the lock {}", path.display()))?;
        /* `running` tests a lock for an instant, and the daemon tests its tray's every second
        (`tray_gone`): a lock refused once is tried again before it counts as held. */
        let mut tries = 0;
        while !try_flock(&file, libc::LOCK_EX).with_context(|| format!("locking {}", path.display()))? {
            tries += 1;
            if tries < TRIES {
                std::thread::sleep(RETRY);
                continue;
            }
            return Err(Held {
                config: config.into(),
                holder: read_holder(&mut file),
            }
            .into());
        }
        file.set_len(0)
            .and_then(|_| file.seek(SeekFrom::Start(0)))
            .and_then(|_| {
                write!(
                    file,
                    "{}\n{binary}\n{}\n",
                    std::process::id(),
                    env!("CARGO_PKG_VERSION")
                )
            })
            .and_then(|_| file.flush())
            .with_context(|| format!("writing {}", path.display()))?;
        Ok(Lock { _file: file, path })
    }

    /// The lock file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Where this config's daemon serves its status (COPL-184): next to the lock, the same name
    /// with `.sock`. Whoever holds the lock owns it, so a socket already there is a dead daemon's.
    pub fn socket(&self) -> PathBuf {
        self.path.with_extension("sock")
    }
}

/// Where the daemon running `config` serves its status, as `Lock::socket` says, for a client
/// that doesn't hold the lock (`copland-daemon status`, COPL-185).
pub fn socket_for(config: &Path, runtime_dir: &Path) -> PathBuf {
    path_for(config, runtime_dir).with_extension("sock")
}

/// Whether a daemon is running this config, and who, without taking its lock. It tests with a
/// shared lock for an instant, so a daemon starting in that instant can be refused; it says so.
pub fn running(config: &Path, runtime_dir: &Path) -> Result<Option<Holder>> {
    running_at(&path_for(config, runtime_dir))
}

/// Whether a tray is showing this config, and whose, as `running` says for the daemon.
pub fn tray_running(config: &Path, runtime_dir: &Path) -> Result<Option<Holder>> {
    running_at(&tray_path_for(config, runtime_dir))
}

/// How often a lock is tried before it counts as held, and how long between tries.
const TRIES: u32 = 3;
const RETRY: Duration = Duration::from_millis(20);

/// How long a workstation's daemon waits for its tray to come back before it stops (COPL-225):
/// longer than the tray's unit waits to restart it (`RestartSec=10`) and it takes to show again.
pub const TRAY_GRACE: Duration = Duration::from_secs(30);

/// Whether a tray that has shown a config is gone for good (COPL-225), from what `tray_running`
/// says each time it is asked. Nothing is gone until a tray has been seen; after that, it is
/// gone once no tray has held the lock for `grace`, so a tray that restarts (its unit's
/// `Restart=`, `systemctl restart`, a second one taking over) is not.
#[derive(Debug)]
pub struct TrayWatch {
    grace: Duration,
    last_seen: Option<Instant>,
}

impl TrayWatch {
    pub fn new(grace: Duration) -> Self {
        TrayWatch { grace, last_seen: None }
    }

    /// A tray showing (`showing`) or not at `now`: true once the one seen is gone for good.
    pub fn saw(&mut self, showing: bool, now: Instant) -> bool {
        if showing {
            self.last_seen = Some(now);
            return false;
        }
        self.last_seen
            .is_some_and(|seen| now.saturating_duration_since(seen) >= self.grace)
    }
}

/// Resolves once the tray showing `config` is gone for good (`TrayWatch`), asking every `every`.
/// A workstation's daemon stops then: the tray is how its user sees and stops it, so one left
/// running without it would go on unseen. Never resolves while no tray has shown the config.
pub async fn tray_gone(config: PathBuf, runtime_dir: PathBuf, grace: Duration, every: Duration) {
    let mut watch = TrayWatch::new(grace);
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        /* A lock that can't be read says nothing either way: counted as showing. */
        let showing = tray_running(&config, &runtime_dir).map_or(true, |h| h.is_some());
        if watch.saw(showing, Instant::now()) {
            return;
        }
    }
}

fn running_at(path: &Path) -> Result<Option<Holder>> {
    let mut file = match open(path, false) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("opening the lock {}", path.display())),
    };
    if try_flock(&file, libc::LOCK_SH).with_context(|| format!("testing {}", path.display()))? {
        /* Nobody has it; dropping the file lets ours go. */
        return Ok(None);
    }
    Ok(Some(read_holder(&mut file)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("copland-lock-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_second_lock_on_the_same_config_is_refused() {
        let dir = scratch("same");
        let config = dir.join("daemon.toml");
        fs::write(&config, "").unwrap();
        let first = Lock::take(&config, &dir, "copland-daemon").unwrap();
        assert!(first.path().starts_with(dir.join("copland")));
        assert_eq!(first.socket(), first.path().with_extension("sock"));
        assert!(first.socket().to_string_lossy().ends_with(".sock"));
        assert_eq!(socket_for(&config, &dir), first.socket());
        let err = Lock::take(&config, &dir, "copland-box").unwrap_err();
        let held = err.downcast_ref::<Held>().expect("refused as held");
        assert_eq!(
            held.holder,
            Holder {
                pid: Some(std::process::id()),
                binary: Some("copland-daemon".into()),
                version: Some(env!("CARGO_PKG_VERSION").into())
            }
        );
        assert!(err.to_string().contains("already running"), "{err}");
        assert!(
            err.to_string()
                .contains(&format!("pid {}, copland-daemon", std::process::id())),
            "{err}"
        );
        /* The same file by another path is the same config. */
        let other_path = dir.join(".").join("daemon.toml");
        assert!(Lock::take(&other_path, &dir, "copland-box").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_different_config_is_its_own_lock() {
        let dir = scratch("different");
        let (a, b) = (dir.join("a.toml"), dir.join("b.toml"));
        fs::write(&a, "").unwrap();
        fs::write(&b, "").unwrap();
        let _a = Lock::take(&a, &dir, "copland-daemon").unwrap();
        let _b = Lock::take(&b, &dir, "copland-daemon").unwrap();
        assert_ne!(path_for(&a, &dir), path_for(&b, &dir));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dropping_it_lets_it_go() {
        let dir = scratch("drop");
        let config = dir.join("daemon.toml");
        fs::write(&config, "").unwrap();
        assert_eq!(running(&config, &dir).unwrap(), None);
        let lock = Lock::take(&config, &dir, "copland-box").unwrap();
        assert_eq!(
            running(&config, &dir).unwrap(),
            Some(Holder {
                pid: Some(std::process::id()),
                binary: Some("copland-box".into()),
                version: Some(env!("CARGO_PKG_VERSION").into())
            })
        );
        /* Asking doesn't take it. */
        assert!(Lock::take(&config, &dir, "copland-daemon").is_err());
        drop(lock);
        /* Another test spawning a program meanwhile shares the lock until its child's exec: std's
        spawn walks PATH in a vfork child holding a copy of every descriptor, a long PATH (Nix's)
        takes a while, and the lock is let go only once the last copy closes. */
        let gone = std::time::Instant::now();
        while running(&config, &dir).unwrap().is_some() {
            assert!(
                gone.elapsed() < std::time::Duration::from_secs(5),
                "still held after the drop"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let again = Lock::take(&config, &dir, "copland-daemon").unwrap();
        /* The new holder's line replaces the old one, not appended to it. */
        assert_eq!(
            fs::read_to_string(again.path()).unwrap(),
            format!(
                "{}\ncopland-daemon\n{}\n",
                std::process::id(),
                env!("CARGO_PKG_VERSION")
            )
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /* COPL-225: a workstation's daemon goes with its tray, but not before one has shown it, and
    not while one restarts within the grace. */
    #[test]
    fn a_tray_is_gone_only_after_the_grace() {
        let grace = Duration::from_secs(30);
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut w = TrayWatch::new(grace);
        assert!(!w.saw(false, at(0)));
        assert!(!w.saw(false, at(600)), "no tray yet: nothing to go with");
        assert!(!w.saw(true, at(601)));
        assert!(!w.saw(false, at(602)));
        assert!(!w.saw(false, at(612)), "restarting");
        assert!(!w.saw(true, at(615)), "back");
        assert!(!w.saw(false, at(616)));
        assert!(!w.saw(false, at(644)));
        assert!(w.saw(false, at(645)), "gone for good");
    }

    #[tokio::test]
    async fn the_daemon_hears_its_tray_go() {
        let dir = scratch("tray-gone");
        let config = dir.join("daemon.toml");
        fs::write(&config, "").unwrap();
        let tray = Lock::take_tray(&config, &dir, "copland-tray").unwrap();
        let (grace, every) = (Duration::from_secs(1), Duration::from_millis(20));
        let mut gone = tokio::spawn(tray_gone(config.clone(), dir.clone(), grace, every));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!gone.is_finished(), "the tray is showing");
        drop(tray);
        /* Not straight away: it waits out the grace (`TrayWatch` holds it to the second). */
        let soon = tokio::time::timeout(Duration::from_millis(200), &mut gone).await;
        assert!(soon.is_err(), "gone before the grace");
        tokio::time::timeout(Duration::from_secs(5), gone)
            .await
            .unwrap()
            .unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }
}
