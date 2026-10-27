//! Whether a program is somewhere a service or a login entry can keep running it from (COPL-219).
//! A systemd unit, or an autostart entry, names the program by its path, and keeps naming it
//! after the tarball it came from is deleted, moved or replaced by the next version's. So the
//! service and the entries run a program from a stable place: `~/.local/bin` (where the tarball's
//! layout goes), a system directory a package would use, or anywhere else that isn't plainly
//! temporary. Refused: a temporary directory, a download directory, a cargo `target/`, and any
//! directory whose name has a version in it (`copland-box-0.5.0-linux-x86_64`, `0.5.0`).
//!
//! `check` is the pure classifier, on `Places` it is given; `check_here` is it in this process's
//! environment, with the fix worked out from what is on disk. Nix's store is the caller's to
//! tell apart first (`service::nix_managed`): its paths have versions in them and are stable.

use std::path::{Path, PathBuf};

/// The programs a release ships together, which the fix copies.
pub const BINARIES: [&str; 3] = ["copland-daemon", "copland-box", "copland-tray"];

/// Where things go that don't last, and where they do, for one environment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Places {
    /// `$HOME`: its own name is the user's, whatever it looks like.
    pub home: Option<PathBuf>,
    /// Temporary directories: /tmp, /var/tmp, /dev/shm, `$TMPDIR`.
    pub temp: Vec<PathBuf>,
    /// Download directories: ~/Downloads, and the XDG download dir.
    pub downloads: Vec<PathBuf>,
}

/// The directories a program is always fine in: a package's, and the default install's.
const SYSTEM: [&str; 4] = ["/usr/bin", "/usr/local/bin", "/bin", "/usr/sbin"];

impl Places {
    /// The places for this process: `HOME`, `TMPDIR`, `XDG_DOWNLOAD_DIR` or the one in
    /// `$XDG_CONFIG_HOME/user-dirs.dirs`. Each resolved as well as given, so a link (macOS's
    /// /tmp, a downloads dir on another disk) is recognised from either side.
    pub fn here() -> Self {
        let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        let home = env("HOME").filter(|h| h.is_absolute());
        let mut temp: Vec<PathBuf> = ["/tmp", "/var/tmp", "/dev/shm"].map(PathBuf::from).into();
        temp.extend(env("TMPDIR").filter(|t| t.is_absolute()));
        let mut downloads: Vec<PathBuf> = home.iter().map(|h| h.join("Downloads")).collect();
        let config = env("XDG_CONFIG_HOME")
            .filter(|c| c.is_absolute())
            .or_else(|| home.as_ref().map(|h| h.join(".config")));
        let user_dirs = config.and_then(|c| std::fs::read_to_string(c.join("user-dirs.dirs")).ok());
        downloads.extend(
            env("XDG_DOWNLOAD_DIR")
                .filter(|d| d.is_absolute())
                .or_else(|| user_dirs.as_deref().and_then(|t| download_dir(t, home.as_deref()))),
        );
        let resolved = |v: Vec<PathBuf>| -> Vec<PathBuf> {
            let mut out = Vec::new();
            for p in v {
                let r = std::fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
                for p in [p, r] {
                    if !out.contains(&p) {
                        out.push(p);
                    }
                }
            }
            out
        };
        Places {
            home,
            temp: resolved(temp),
            downloads: resolved(downloads),
        }
    }

    /// `~/.local/bin`, where the tarball's layout puts the binaries.
    pub fn local_bin(&self) -> Option<PathBuf> {
        self.home.as_ref().map(|h| h.join(".local/bin"))
    }
}

/// `XDG_DOWNLOAD_DIR` in a `user-dirs.dirs` (`XDG_DOWNLOAD_DIR="$HOME/Downloads"`).
pub fn download_dir(user_dirs: &str, home: Option<&Path>) -> Option<PathBuf> {
    let value = user_dirs.lines().find_map(|l| {
        let v = l
            .trim()
            .strip_prefix("XDG_DOWNLOAD_DIR")?
            .trim_start()
            .strip_prefix('=')?;
        Some(v.trim().trim_matches('"').to_string())
    })?;
    let path = match value.strip_prefix("$HOME") {
        Some(rest) => home?.join(rest.trim_start_matches('/')),
        None => PathBuf::from(value),
    };
    (path.is_absolute() && path != Path::new("/") && Some(path.as_path()) != home).then_some(path)
}

/// Why a program's place won't last.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Why {
    /// It is under this temporary directory.
    Temp(PathBuf),
    /// It is under this download directory.
    Downloads(PathBuf),
    /// It is a build in a cargo `target/`.
    Build,
    /// This directory of its path has a version in its name.
    Versioned(String),
}

impl std::fmt::Display for Why {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Why::Temp(d) => write!(f, "under {}, which is cleaned out", d.display()),
            Why::Downloads(d) => write!(f, "under {}, a download folder", d.display()),
            Why::Build => write!(f, "a build in cargo's target/, which the next build replaces"),
            Why::Versioned(c) => write!(
                f,
                "in {c}, a folder named for one version, which the next one won't be in"
            ),
        }
    }
}

/// A program somewhere a service or a login entry can't keep running it from, and how to put
/// it somewhere that can.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unstable {
    pub program: PathBuf,
    pub why: Why,
    /// The command that copies it (and what ships with it) to `~/.local/bin`.
    pub fix: String,
}

impl std::fmt::Display for Unstable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} is {}: a service or login entry that runs it from there stops working once it is moved, \
             deleted or upgraded, so nothing was written. Install it to ~/.local/bin and run that one:\n\n  {}\n",
            self.program.display(),
            self.why,
            self.fix
        )
    }
}

impl std::error::Error for Unstable {}

/// Whether a directory's name has a version in it: digits, a dot, digits (`0.5.0`,
/// `copland-box-0.5.0-linux-x86_64`, `v1.2`).
pub fn versioned(name: &str) -> bool {
    let b = name.as_bytes();
    (1..b.len().saturating_sub(1)).any(|i| b[i] == b'.' && b[i - 1].is_ascii_digit() && b[i + 1].is_ascii_digit())
}

/// Why `program` (an absolute path, its links already resolved) won't last where it is, or None
/// when it will. `~/.local/bin` and the system directories always do; then temporary and
/// download directories, a cargo `target/` and a versioned directory (below `$HOME`, whose own
/// name doesn't count) are refused, and anywhere else is fine.
pub fn why(program: &Path, places: &Places) -> Option<Why> {
    let dir = program.parent()?;
    if SYSTEM.iter().any(|s| dir == Path::new(s)) || places.local_bin().is_some_and(|l| dir == l) {
        return None;
    }
    if let Some(t) = places.temp.iter().find(|t| dir.starts_with(t)) {
        return Some(Why::Temp(t.clone()));
    }
    if let Some(d) = places.downloads.iter().find(|d| dir.starts_with(d)) {
        return Some(Why::Downloads(d.clone()));
    }
    if dir.components().any(|c| c.as_os_str() == "target") {
        return Some(Why::Build);
    }
    let below = match places.home.as_deref() {
        Some(h) if dir.starts_with(h) => dir.strip_prefix(h).unwrap_or(dir),
        _ => dir,
    };
    below
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .find(|c| versioned(c))
        .map(|c| Why::Versioned(c.to_string()))
}

/// The command that copies what ships beside `program` to `~/.local/bin`: the whole tarball when
/// `program` is in its `bin/` (`tarball` says a `share/` is beside it), else the `binaries` that
/// are there.
pub fn fix(program: &Path, tarball: bool, binaries: &[&str]) -> String {
    let dir = program.parent().unwrap_or(Path::new("/"));
    let q = |p: &Path| crate::autostart::quote(&p.display().to_string());
    match dir
        .parent()
        .filter(|_| tarball && dir.file_name().is_some_and(|n| n == "bin"))
    {
        Some(root) => format!("cd {} && cp -r --remove-destination bin share ~/.local/", q(root)),
        None => {
            let files: Vec<String> = binaries.iter().map(|b| q(&dir.join(b))).collect();
            format!(
                "mkdir -p ~/.local/bin && install -m 755 {} ~/.local/bin/",
                files.join(" ")
            )
        }
    }
}

/// `program`'s place checked on `places`: Ok when it will last, else what's wrong and the fix.
pub fn check(program: &Path, places: &Places, tarball: bool, binaries: &[&str]) -> Result<(), Unstable> {
    match why(program, places) {
        None => Ok(()),
        Some(why) => Err(Unstable {
            program: program.to_path_buf(),
            why,
            fix: fix(program, tarball, binaries),
        }),
    }
}

/// `check` on `places`, with the fix read from disk: whether `program` is in a tarball's `bin/`
/// (a `share/` beside it), and which of `BINARIES` are beside it (`program` itself when none is).
pub fn on_disk(program: &Path, places: &Places) -> Result<(), Unstable> {
    let dir = program.parent().unwrap_or(Path::new("/"));
    let tarball = dir.file_name().is_some_and(|n| n == "bin") && dir.parent().is_some_and(|r| r.join("share").is_dir());
    let mut binaries: Vec<&str> = BINARIES.iter().copied().filter(|b| dir.join(b).is_file()).collect();
    if binaries.is_empty() {
        binaries.extend(program.file_name().and_then(|n| n.to_str()));
    }
    check(program, places, tarball, &binaries)
}

/// `on_disk` in this process's environment, on `program` with its links resolved.
pub fn check_here(program: &Path) -> Result<(), Unstable> {
    let program = std::fs::canonicalize(program).unwrap_or_else(|_| program.to_path_buf());
    on_disk(&program, &Places::here())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn places() -> Places {
        Places {
            home: Some("/home/me".into()),
            temp: vec!["/tmp".into(), "/var/tmp".into(), "/run/user/1000/tmp".into()],
            downloads: vec!["/home/me/Downloads".into(), "/home/me/Indirilenler".into()],
        }
    }

    fn why_for(p: &str) -> Option<Why> {
        why(Path::new(p), &places())
    }

    #[test]
    fn stable_places_are_used_as_they_are() {
        for p in [
            "/home/me/.local/bin/copland-daemon",
            "/usr/bin/copland-daemon",
            "/usr/local/bin/copland-daemon",
            "/opt/copland/bin/copland-daemon",
            "/home/me/bin/copland-daemon",
            "/home/me/apps/copland/bin/copland-daemon",
        ] {
            assert_eq!(why_for(p), None, "{p}");
        }
        /* The home's own name is the user's: only what's below it counts. */
        let odd = Places {
            home: Some("/home/me.2.0".into()),
            ..places()
        };
        assert_eq!(why(Path::new("/home/me.2.0/bin/copland-daemon"), &odd), None);
        /* ~/.local/bin is fine even under a temporary home (a CI container's). */
        let ci = Places {
            home: Some("/tmp/home".into()),
            ..places()
        };
        assert_eq!(why(Path::new("/tmp/home/.local/bin/copland-daemon"), &ci), None);
        assert!(matches!(
            why(Path::new("/tmp/home/x/copland-daemon"), &ci),
            Some(Why::Temp(_))
        ));
    }

    #[test]
    fn temporary_download_build_and_versioned_places_are_refused() {
        assert_eq!(why_for("/tmp/x/bin/copland-daemon"), Some(Why::Temp("/tmp".into())));
        assert_eq!(
            why_for("/run/user/1000/tmp/copland-daemon"),
            Some(Why::Temp("/run/user/1000/tmp".into()))
        );
        assert_eq!(
            why_for("/home/me/Downloads/copland/bin/copland-daemon"),
            Some(Why::Downloads("/home/me/Downloads".into()))
        );
        assert_eq!(
            why_for("/home/me/Indirilenler/bin/copland-daemon"),
            Some(Why::Downloads("/home/me/Indirilenler".into()))
        );
        assert_eq!(
            why_for("/home/me/src/copland/daemon/target/release/copland-daemon"),
            Some(Why::Build)
        );
        assert_eq!(
            why_for("/home/me/copland-box-0.5.0-linux-x86_64/bin/copland-daemon"),
            Some(Why::Versioned("copland-box-0.5.0-linux-x86_64".into()))
        );
        assert_eq!(
            why_for("/opt/copland/0.5.0/bin/copland-daemon"),
            Some(Why::Versioned("0.5.0".into()))
        );
        /* Not /tmpfoo: a directory, not a prefix of a name. */
        assert_eq!(why_for("/tmpfoo/bin/copland-daemon"), None);
        assert!(versioned("v1.2") && versioned("0.5.0") && !versioned("x86_64") && !versioned(".config"));
        assert!(!versioned("1.") && !versioned(".5"));
    }

    #[test]
    fn finds_the_xdg_download_dir() {
        let home = Some(Path::new("/home/me"));
        let dirs = "# written by xdg-user-dirs-update\nXDG_DESKTOP_DIR=\"$HOME/Desktop\"\n\
                    XDG_DOWNLOAD_DIR=\"$HOME/Indirilenler\"\n";
        assert_eq!(download_dir(dirs, home), Some("/home/me/Indirilenler".into()));
        assert_eq!(
            download_dir("XDG_DOWNLOAD_DIR=\"/data/dl\"\n", home),
            Some("/data/dl".into())
        );
        /* Pointing at $HOME itself (xdg-user-dirs does, for a dir it disabled) isn't one. */
        assert_eq!(download_dir("XDG_DOWNLOAD_DIR=\"$HOME/\"\n", home), None);
        assert_eq!(download_dir("XDG_DOWNLOAD_DIR=\"$HOME/x\"\n", None), None);
        assert_eq!(download_dir("", home), None);
    }

    #[test]
    fn says_why_and_how_to_fix_it() {
        let tarball = Path::new("/home/me/Downloads/copland-box-0.5.0-linux-x86_64/bin/copland-daemon");
        let e = check(tarball, &places(), true, &BINARIES).unwrap_err();
        assert_eq!(
            e.fix,
            "cd /home/me/Downloads/copland-box-0.5.0-linux-x86_64 && cp -r --remove-destination bin share ~/.local/"
        );
        let says = e.to_string();
        assert!(
            says.starts_with(
                "/home/me/Downloads/copland-box-0.5.0-linux-x86_64/bin/copland-daemon is under /home/me/Downloads, \
                 a download folder: a service or login entry that runs it from there stops working"
            ),
            "{says}"
        );
        assert!(says.contains("nothing was written"), "{says}");
        let build = Path::new("/home/me/my src/daemon/target/release/copland-daemon");
        assert_eq!(
            check(build, &places(), false, &["copland-daemon", "copland-tray"])
                .unwrap_err()
                .fix,
            "mkdir -p ~/.local/bin && install -m 755 \"/home/me/my src/daemon/target/release/copland-daemon\" \
             \"/home/me/my src/daemon/target/release/copland-tray\" ~/.local/bin/"
        );
        assert_eq!(
            check(Path::new("/usr/bin/copland-daemon"), &places(), false, &BINARIES),
            Ok(())
        );
    }
}
