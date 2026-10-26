//! The box's own log file (COPL-163). Started from a launcher (Hyprland's exec, a .desktop
//! file) the box's stderr goes nowhere, so its log also goes to `box.log` in the state dir,
//! next to `runs/`. It is capped: past `CAP` bytes the file moves to `box.log.1` (replacing
//! the one before) and a new one starts, so the two together never pass twice the cap.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// How big `box.log` gets before it is rotated.
pub const CAP: u64 = 1024 * 1024;

/// The log file under a state dir.
pub fn path_in(state_dir: &Path) -> PathBuf {
    state_dir.join("box.log")
}

/// Where the previous log goes when the file reaches its cap.
fn previous(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".1");
    PathBuf::from(name)
}

/// An append-only log file that rotates itself at `cap` bytes. `&LogFile` is a writer, so
/// `Arc<LogFile>` is a tracing `MakeWriter`; each event arrives as one write, so a line is
/// never split across the two files.
pub struct LogFile {
    path: PathBuf,
    cap: u64,
    open: Mutex<(File, u64)>,
}

impl LogFile {
    /// Opens (or makes) the file, its directory too, readable by its owner alone: run ids and
    /// task keys are in it. A file already past the cap is rotated first.
    pub fn open(path: &Path, cap: u64) -> io::Result<LogFile> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let file = Self::append(path)?;
        let len = file.metadata()?.len();
        let log = LogFile {
            path: path.to_path_buf(),
            cap,
            open: Mutex::new((file, len)),
        };
        if len >= cap {
            let mut open = log.open.lock().unwrap_or_else(|e| e.into_inner());
            log.rotate(&mut open)?;
        }
        Ok(log)
    }

    fn append(path: &Path) -> io::Result<File> {
        OpenOptions::new().create(true).append(true).mode(0o600).open(path)
    }

    fn rotate(&self, open: &mut (File, u64)) -> io::Result<()> {
        fs::rename(&self.path, previous(&self.path))?;
        *open = (Self::append(&self.path)?, 0);
        Ok(())
    }
}

impl Write for &LogFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        if open.1 > 0 && open.1 + buf.len() as u64 > self.cap {
            /* Can't rotate (the file was moved or the dir went read-only): keep writing where we are. */
            let _ = self.rotate(&mut open);
        }
        let n = open.0.write(buf)?;
        open.1 += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).0.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("copland-box-log-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn lives_next_to_the_runs() {
        assert_eq!(path_in(Path::new("/s/copland")), Path::new("/s/copland/box.log"));
    }

    #[test]
    fn makes_its_directory_and_keeps_the_file_private() {
        let dir = dir("private");
        let path = path_in(&dir.join("nested"));
        let log = LogFile::open(&path, CAP).unwrap();
        (&log).write_all(b"hello\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello\n");
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn appends_to_what_an_earlier_box_wrote() {
        let dir = dir("append");
        let path = path_in(&dir);
        (&LogFile::open(&path, CAP).unwrap()).write_all(b"one\n").unwrap();
        (&LogFile::open(&path, CAP).unwrap()).write_all(b"two\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "one\ntwo\n");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rotates_at_the_cap_and_keeps_one_old_file() {
        let dir = dir("rotate");
        let path = path_in(&dir);
        let log = LogFile::open(&path, 10).unwrap();
        (&log).write_all(b"aaaaaa\n").unwrap();
        (&log).write_all(b"bbbbbb\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "bbbbbb\n");
        assert_eq!(fs::read_to_string(previous(&path)).unwrap(), "aaaaaa\n");
        (&log).write_all(b"cccccc\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "cccccc\n");
        assert_eq!(fs::read_to_string(previous(&path)).unwrap(), "bbbbbb\n");
        /* A line longer than the cap still goes in whole, into a file of its own. */
        (&log).write_all(b"a line past the cap\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "a line past the cap\n");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_already_past_the_cap_is_rotated_on_open() {
        let dir = dir("reopen");
        let path = path_in(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, "x".repeat(20)).unwrap();
        let log = LogFile::open(&path, 10).unwrap();
        (&log).write_all(b"new\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new\n");
        assert_eq!(fs::read_to_string(previous(&path)).unwrap().len(), 20);
        fs::remove_dir_all(&dir).unwrap();
    }
}
