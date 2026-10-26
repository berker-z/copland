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

use anyhow::{Context, Result};

/// Who holds a config's lock, as its file says. Either may be missing for a moment: the file is
/// written just after the lock is taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holder {
    pub pid: Option<u32>,
    pub binary: Option<String>,
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
    let resolved = fs::canonicalize(config).unwrap_or_else(|_| std::path::absolute(config).unwrap_or(config.into()));
    let digest = ring::digest::digest(&ring::digest::SHA256, resolved.as_os_str().as_encoded_bytes());
    let hex: String = digest.as_ref()[..8].iter().map(|b| format!("{b:02x}")).collect();
    runtime_dir.join("copland").join(format!("daemon-{hex}.lock"))
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
    }
}

impl Lock {
    /// Take the config's lock for `binary` (`copland-daemon`, `copland-box`). Fails with `Held`
    /// (downcast the error to read it) when another process, or another `Lock` in this one, has it.
    pub fn take(config: &Path, runtime_dir: &Path, binary: &str) -> Result<Lock> {
        let path = path_for(config, runtime_dir);
        let mut file = open(&path, true).with_context(|| format!("opening the lock {}", path.display()))?;
        if !try_flock(&file, libc::LOCK_EX).with_context(|| format!("locking {}", path.display()))? {
            return Err(Held {
                config: config.into(),
                holder: read_holder(&mut file),
            }
            .into());
        }
        file.set_len(0)
            .and_then(|_| file.seek(SeekFrom::Start(0)))
            .and_then(|_| write!(file, "{}\n{binary}\n", std::process::id()))
            .and_then(|_| file.flush())
            .with_context(|| format!("writing {}", path.display()))?;
        Ok(Lock { _file: file, path })
    }

    /// The lock file.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Whether a daemon is running this config, and who, without taking its lock. It tests with a
/// shared lock for an instant, so a daemon starting in that instant can be refused; it says so.
pub fn running(config: &Path, runtime_dir: &Path) -> Result<Option<Holder>> {
    let path = path_for(config, runtime_dir);
    let mut file = match open(&path, false) {
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
        let err = Lock::take(&config, &dir, "copland-box").unwrap_err();
        let held = err.downcast_ref::<Held>().expect("refused as held");
        assert_eq!(
            held.holder,
            Holder {
                pid: Some(std::process::id()),
                binary: Some("copland-daemon".into())
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
                binary: Some("copland-box".into())
            })
        );
        /* Asking doesn't take it. */
        assert!(Lock::take(&config, &dir, "copland-daemon").is_err());
        drop(lock);
        assert_eq!(running(&config, &dir).unwrap(), None);
        let again = Lock::take(&config, &dir, "copland-daemon").unwrap();
        /* The new holder's line replaces the old one, not appended to it. */
        assert_eq!(
            fs::read_to_string(again.path()).unwrap(),
            format!("{}\ncopland-daemon\n", std::process::id())
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
