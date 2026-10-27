//! The PATH the runtimes are looked up on (COPL-216), built when the daemon starts rather than
//! frozen into its service at install: a runtime installed or moved later is found at the next
//! start, and a Nix store path that went stale is never written down to go stale.
//!
//! In order, de-duplicated, with relative and missing directories dropped: the PATH the daemon was
//! started with (so a declared one, like the Nix module's `runtimes`, wins), then the user's login
//! shell's, then the usual places runtimes install themselves. [`set`] puts it on the process once,
//! so runs, `locate` and the sandboxes' lookups all see the same one.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// How long the login shell may take to say its PATH before it is killed and left out.
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Around the PATH the login shell prints, so whatever its profile prints too is told apart.
const MARK: &str = "__COPLAND_PATH__";

/// Where runtimes install themselves, under home, then system-wide (Homebrew's on macOS).
fn usual(home: Option<&Path>, macos: bool) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = home
        .map(|h| {
            [".local/bin", ".npm-global/bin", ".cargo/bin", ".bun/bin"]
                .iter()
                .map(|d| h.join(d))
                .collect()
        })
        .unwrap_or_default();
    out.push("/usr/local/bin".into());
    if macos {
        out.push("/opt/homebrew/bin".into());
    }
    out
}

/// The PATH to look runtimes up on: `start`'s entries, then `login`'s, then the usual places,
/// each once, keeping only absolute directories that are there.
pub fn build(start: Option<&OsStr>, login: Option<&OsStr>, home: Option<&Path>, macos: bool) -> OsString {
    let mut seen: Vec<PathBuf> = Vec::new();
    let given = [start, login].into_iter().flatten().flat_map(std::env::split_paths);
    for dir in given.chain(usual(home, macos)) {
        if dir.is_absolute() && dir.is_dir() && !seen.contains(&dir) {
            seen.push(dir);
        }
    }
    std::env::join_paths(seen).unwrap_or_default()
}

/// The PATH in what the login shell printed, between the marks; None when it isn't there.
pub fn parse_login(stdout: &str) -> Option<String> {
    let (_, rest) = stdout.split_once(MARK)?;
    let (path, _) = rest.split_once(MARK)?;
    (!path.is_empty()).then(|| path.to_string())
}

/// `shell -l -c` printing its PATH, given `timeout`, after which it and whatever it started are
/// killed. None when it fails, hangs or prints no PATH.
pub fn login_path(shell: &Path, timeout: Duration) -> Option<String> {
    let mut child = Command::new(shell)
        .args(["-l", "-c", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        let _ = tx.send(out);
    });
    let out = rx.recv_timeout(timeout);
    if out.is_err() {
        /* The whole group: a profile's background job would hold the pipe open. */
        unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
    }
    let _ = child.wait();
    parse_login(&String::from_utf8_lossy(&out.ok()?))
}

/// The user's login shell: `$SHELL`, else the one their passwd entry names.
fn login_shell() -> Option<PathBuf> {
    if let Some(s) = std::env::var_os("SHELL").filter(|s| !s.is_empty()) {
        return Some(s.into());
    }
    /* SAFETY: getpwuid's entry is read at once, before anything else could call it. */
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() {
            return None;
        }
        let shell = std::ffi::CStr::from_ptr((*pw).pw_shell).to_str().ok()?;
        (!shell.is_empty()).then(|| PathBuf::from(shell))
    }
}

/// Build the PATH and set it for this process; returns it. Call it before any other thread starts
/// (setting the environment is not thread safe). Left as it was when nothing is found at all.
pub fn set() -> OsString {
    let start = std::env::var_os("PATH");
    let login = login_shell().and_then(|s| login_path(&s, LOGIN_TIMEOUT));
    let home = std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from);
    let path = build(
        start.as_deref(),
        login.as_deref().map(OsStr::new),
        home.as_deref(),
        cfg!(target_os = "macos"),
    );
    if path.is_empty() {
        return start.unwrap_or_default();
    }
    /* SAFETY: the caller is the only thread yet. */
    unsafe { std::env::set_var("PATH", &path) };
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("copland-search-path-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn dirs(root: &Path, names: &[&str]) -> Vec<String> {
        names
            .iter()
            .map(|n| {
                let d = root.join(n);
                fs::create_dir_all(&d).unwrap();
                d.display().to_string()
            })
            .collect()
    }

    fn split(p: &OsStr) -> Vec<String> {
        std::env::split_paths(p).map(|d| d.display().to_string()).collect()
    }

    #[test]
    fn start_then_login_then_the_usual_places_each_once() {
        let root = scratch("build");
        let d = dirs(&root, &["nix", "bin", "login", "home/.local/bin", "home/.cargo/bin"]);
        let missing = root.join("gone").display().to_string();
        let start = format!("{}:{}:relative/bin::{missing}:{}/", d[0], d[1], d[0]);
        let login = format!("{}:{}:{}", d[2], d[1], d[3]);
        let home = root.join("home");
        let path = build(Some(OsStr::new(&start)), Some(OsStr::new(&login)), Some(&home), false);
        let mut want = vec![d[0].clone(), d[1].clone(), d[2].clone(), d[3].clone(), d[4].clone()];
        if Path::new("/usr/local/bin").is_dir() {
            want.push("/usr/local/bin".into());
        }
        assert_eq!(split(&path), want);
        /* Nothing given: the usual places that are there. */
        let bare = split(&build(None, None, Some(&home), false));
        assert_eq!(&bare[..2], &[d[3].clone(), d[4].clone()]);
        /* Homebrew's only on macOS. */
        assert!(!usual(None, false).contains(&PathBuf::from("/opt/homebrew/bin")));
        assert_eq!(
            usual(None, true),
            [PathBuf::from("/usr/local/bin"), "/opt/homebrew/bin".into()]
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reads_the_path_between_the_marks() {
        assert_eq!(
            parse_login(&format!("Welcome!\nnvm: using 22\n{MARK}/a:/b{MARK}")).as_deref(),
            Some("/a:/b")
        );
        assert_eq!(parse_login(&format!("{MARK}/a{MARK}\nbye\n")).as_deref(), Some("/a"));
        assert_eq!(parse_login("/a:/b"), None);
        assert_eq!(parse_login(&format!("{MARK}/a")), None);
        assert_eq!(parse_login(&format!("{MARK}{MARK}")), None);
    }

    fn shell(dir: &Path, body: &str) -> PathBuf {
        let p = dir.join("sh");
        fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn a_noisy_login_shell_still_gives_its_path() {
        let dir = scratch("noisy");
        /* -l -c SCRIPT: the profile prints, sets PATH, then the script runs. */
        let sh = shell(
            &dir,
            "echo 'Last login: today'\nPATH=/from/login:/usr/bin\nexec /bin/sh -c \"$3\"",
        );
        assert_eq!(login_path(&sh, LOGIN_TIMEOUT).as_deref(), Some("/from/login:/usr/bin"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_login_shell_that_hangs_or_fails_gives_none_in_time() {
        let dir = scratch("hangs");
        let sh = shell(&dir, "sleep 30 &\nsleep 30");
        let started = std::time::Instant::now();
        assert_eq!(login_path(&sh, Duration::from_millis(300)), None);
        assert!(started.elapsed() < Duration::from_secs(5));
        let sh = shell(&dir, "echo nope; exit 1");
        assert_eq!(login_path(&sh, LOGIN_TIMEOUT), None);
        assert_eq!(login_path(&dir.join("absent"), LOGIN_TIMEOUT), None);
        /* With none, the PATH is still built from the rest. */
        let d = dirs(&dir, &["bin"]);
        assert_eq!(split(&build(Some(OsStr::new(&d[0])), None, None, false))[0], d[0]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
