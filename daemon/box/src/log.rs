//! The box's own log file (COPL-163). Started from a launcher (Hyprland's exec, a .desktop
//! file) the box's stderr goes nowhere, so its log also goes to `box.log` in the state dir,
//! next to `runs/`. It is capped: past `CAP` bytes the file moves to `box.log.1` (replacing
//! the one before) and a new one starts, so the two together never pass twice the cap.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tracing_subscriber::EnvFilter;
use tracing_subscriber::field::RecordFields;
use tracing_subscriber::fmt::format::{DefaultFields, Writer};
use tracing_subscriber::fmt::{FormatFields, MakeWriter};
use tracing_subscriber::registry::LookupSpan;

/// What the box logs when `COPLAND_LOG` doesn't say (COPL-166): Copland's own crates at info,
/// everything else (GPUI's locale, fonts and Vulkan setup, hyper, rustls) only at warn.
pub const DEFAULT_FILTER: &str = "warn,copland_box=info,copland_daemon_core=info";

/// The filter for both of the box's logs: `COPLAND_LOG` when it is set and parses, replacing
/// the default entirely, otherwise `DEFAULT_FILTER`.
pub fn filter(copland_log: Option<String>) -> EnvFilter {
    copland_log
        .and_then(|directives| EnvFilter::try_new(directives).ok())
        .unwrap_or_else(|| EnvFilter::new(DEFAULT_FILTER))
}

/// The layer that writes to the file: no colour, no target, like stderr's otherwise.
pub fn file_layer<S, W>(writer: W) -> impl tracing_subscriber::Layer<S>
where
    S: tracing::Subscriber + for<'a> LookupSpan<'a>,
    W: for<'w> MakeWriter<'w> + Send + Sync + 'static,
{
    tracing_subscriber::fmt::layer()
        .with_target(false)
        .with_ansi(false)
        .fmt_fields(PlainFields)
        .with_writer(writer)
}

/// `DefaultFields` under a type of its own. A span's fields are formatted once per formatter
/// type and kept on the span, so with the same type as stderr's layer the file got stderr's
/// coloured `agent{handle=…}` escapes.
struct PlainFields;

impl<'w> FormatFields<'w> for PlainFields {
    fn format_fields<R: RecordFields>(&self, writer: Writer<'w>, fields: R) -> std::fmt::Result {
        DefaultFields::new().format_fields(writer, fields)
    }
}

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

    /// What a subscriber writes while `emit` runs: the file's layer under `filter`, with a
    /// coloured stderr-style layer beside it like the box has.
    fn logged(filter: EnvFilter, emit: impl FnOnce()) -> String {
        use tracing_subscriber::prelude::*;
        let file = std::sync::Arc::new(Mutex::new(Vec::new()));
        let to_file = {
            let file = file.clone();
            move || Captured(file.clone())
        };
        let stderr = tracing_subscriber::fmt::layer()
            .with_target(false)
            .with_ansi(true)
            .with_writer(io::sink);
        let subscriber = tracing_subscriber::registry()
            .with(filter)
            .with(stderr)
            .with(file_layer(to_file));
        tracing::subscriber::with_default(subscriber, emit);
        String::from_utf8(file.lock().unwrap().clone()).unwrap()
    }

    struct Captured(std::sync::Arc<Mutex<Vec<u8>>>);

    impl Write for Captured {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn a_start() {
        tracing::debug!(target: "gpui::platform::linux", "Locale: en-US");
        tracing::info!(target: "blade_graphics::vulkan::init", "Enabling Vulkan Portability");
        tracing::warn!(target: "blade_graphics::vulkan::init", "no presentation");
        tracing::info!(target: "copland_box", "copland-box started");
        tracing::debug!(target: "copland_box", "a poll");
        tracing::info!(target: "copland_daemon_core::daemon", "watching the inbox");
    }

    #[test]
    fn by_default_keeps_only_coplands_info_and_everyones_warnings() {
        let out = logged(filter(None), a_start);
        assert!(out.contains("copland-box started"), "{out}");
        assert!(out.contains("watching the inbox"), "{out}");
        assert!(out.contains("no presentation"), "{out}");
        assert!(!out.contains("Locale"), "{out}");
        assert!(!out.contains("Vulkan"), "{out}");
        assert!(!out.contains("a poll"), "{out}");
    }

    #[test]
    fn copland_log_replaces_the_default_entirely() {
        let out = logged(filter(Some("debug".into())), a_start);
        assert!(
            out.contains("Locale") && out.contains("Vulkan") && out.contains("a poll"),
            "{out}"
        );
        let out = logged(filter(Some("error".into())), a_start);
        assert!(
            !out.contains("copland-box started") && !out.contains("no presentation"),
            "{out}"
        );
        /* One that doesn't parse leaves the default. */
        let out = logged(filter(Some("copland_box=loud".into())), a_start);
        assert!(out.contains("copland-box started") && !out.contains("Vulkan"), "{out}");
    }

    #[test]
    fn writes_span_fields_to_the_file_without_colour() {
        let out = logged(filter(None), || {
            let _agent = tracing::info_span!(target: "copland_box", "agent", handle = "berker-z/dev").entered();
            tracing::info!(target: "copland_box", "claimed");
        });
        assert!(out.contains("agent{handle=\"berker-z/dev\"}: claimed"), "{out}");
        assert!(!out.contains('\x1b'), "{out:?}");
    }
}
