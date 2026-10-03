//! What the menu's settings and about panels do outside daemon.toml (COPL-65):
//! starting the box at login through an XDG autostart entry, and asking GitHub
//! whether a newer box has been released.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};

use crate::APP_ID;

/* ---------- start at login ---------- */

/// `$XDG_CONFIG_HOME/autostart` (`~/.config/autostart`), from the environment it is given.
pub fn autostart_dir(xdg_config_home: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    match xdg_config_home.filter(|p| p.is_absolute()) {
        Some(c) => Some(c.join("autostart")),
        None => home.map(|h| h.join(".config").join("autostart")),
    }
}

/// The autostart entry this box would write or remove, for this process's environment.
pub fn autostart_file() -> Option<PathBuf> {
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    autostart_dir(xdg.as_deref(), home.as_deref()).map(|d| d.join(format!("{APP_ID}.desktop")))
}

/// What the entry runs, and anything worth saying about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exec {
    pub program: String,
    /// Set when the program is a path that the next upgrade will leave behind.
    pub caveat: Option<String>,
}

/// The program to start at login. `copland-box` on PATH first, as found there, not resolved:
/// a Nix profile's `bin/copland-box` is a link that moves to each new build, where the store
/// path it points at stays the old one. Without it, this binary, said plainly when it is a
/// store path (a later build won't be the one that starts) or a build tree.
pub fn exec(path_var: Option<&str>, current: Option<&Path>) -> Exec {
    let on_path = path_var.into_iter().flat_map(|p| p.split(':')).find_map(|dir| {
        let c = Path::new(dir).join(APP_ID);
        (!dir.is_empty() && Path::new(dir).is_absolute() && is_executable(&c)).then_some(c)
    });
    if let Some(p) = on_path {
        return Exec {
            program: p.display().to_string(),
            caveat: None,
        };
    }
    let Some(cur) = current else {
        return Exec {
            program: APP_ID.into(),
            caveat: Some("not on PATH; the entry runs copland-box by name".into()),
        };
    };
    let s = cur.display().to_string();
    let caveat = if s.starts_with("/nix/store/") {
        Some("this exact build, from the Nix store: install it in a profile to follow upgrades".into())
    } else if s.contains("/target/") {
        Some("a build from target/: install the box to start the real one".into())
    } else {
        None
    };
    Exec { program: s, caveat }
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// One argument of `Exec=`, quoted when it must be (the desktop entry spec's rules).
fn quote(arg: &str) -> String {
    let plain = !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+=:,@".contains(c));
    if plain {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    for c in arg.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    /* `%` is a field code in Exec, so a literal one is doubled. */
    out.replace('%', "%%")
}

/// The autostart entry: the program, and `--config` when the box was started with one that
/// isn't the default.
pub fn autostart_entry(program: &str, config: Option<&Path>) -> String {
    let mut exec = quote(program);
    if let Some(c) = config {
        exec.push_str(" --config ");
        exec.push_str(&quote(&c.display().to_string()));
    }
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Copland\n\
         Comment=Your Copland agents, on this machine\n\
         Exec={exec}\n\
         Icon={APP_ID}\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n\
         # Written by copland-box (menu › settings › start at login); that switch removes it.\n"
    )
}

/// Write the entry at `file`, or remove it. Gives what it runs, and its caveat.
pub fn set_autostart(file: &Path, on: bool, config: Option<&Path>, exec: &Exec) -> Result<()> {
    if !on {
        return match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(e).with_context(|| format!("removing {}", file.display()))
            }
            _ => Ok(()),
        };
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("making {}", dir.display()))?;
    }
    std::fs::write(file, autostart_entry(&exec.program, config)).with_context(|| format!("writing {}", file.display()))
}

/* ---------- newer releases ---------- */

/// This box's version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The repo the releases are on, and the tags that are the box's.
pub const REPO: &str = "berker-z/copland";
const TAG: &str = "box-v";
/// A check is good for this long; it is cached between starts.
const FRESH: Duration = Duration::from_secs(12 * 3600);

/// "box-v1.2.3" or "1.2.3" as numbers; None for anything else (a pre-release suffix included).
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let v = s.strip_prefix(TAG).unwrap_or(s);
    let mut parts = v.split('.').map(|p| p.parse::<u64>().ok());
    let out = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(out)
}

/// One release as GitHub lists it.
#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub tag_name: String,
    pub html_url: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
}

/// The newest box release of `releases` when it is newer than `current`.
pub fn newer<'a>(current: &str, releases: &'a [Release]) -> Option<&'a Release> {
    let now = parse_version(current)?;
    releases
        .iter()
        .filter(|r| !r.draft && !r.prerelease && r.tag_name.starts_with(TAG))
        .filter_map(|r| parse_version(&r.tag_name).map(|v| (v, r)))
        .filter(|(v, _)| *v > now)
        .max_by_key(|(v, _)| *v)
        .map(|(_, r)| r)
}

/// What the last check found, kept in `$XDG_STATE_HOME/copland/release.toml`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checked {
    /// Unix seconds.
    pub at: u64,
    /// The newer release's tag and page, if there was one.
    pub newer: Option<(String, String)>,
}

pub fn release_cache() -> PathBuf {
    copland_daemon_core::config::default_state_dir().join("release.toml")
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// The cached answer while it is fresh and was about this version.
pub fn cached(path: &Path) -> Option<Checked> {
    let c: Checked = toml::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let fresh = unix_now().saturating_sub(c.at) < FRESH.as_secs();
    let still = c.newer.as_ref().is_none_or(|(tag, _)| {
        parse_version(tag)
            .zip(parse_version(VERSION))
            .is_some_and(|(t, v)| t > v)
    });
    (fresh && still).then_some(c)
}

/// Ask GitHub (no credential, one request), and keep the answer. An error says why, quietly.
pub async fn check(cache: PathBuf) -> std::result::Result<Checked, String> {
    if let Some(c) = cached(&cache) {
        return Ok(c);
    }
    let api = copland_daemon_core::api::Api::new("https://api.github.com").map_err(|e| format!("{e:#}"))?;
    let releases: Vec<Release> = api
        .get_public(&format!("/repos/{REPO}/releases?per_page=30"))
        .await
        .map_err(|e| e.to_string())?;
    let c = Checked {
        at: unix_now(),
        newer: newer(VERSION, &releases).map(|r| (r.tag_name.clone(), r.html_url.clone())),
    };
    if let Some(dir) = cache.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&cache, toml::to_string(&c).unwrap_or_default());
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_box_versions() {
        assert_eq!(parse_version("box-v0.2.10"), Some((0, 2, 10)));
        assert_eq!(parse_version("1.0.0"), Some((1, 0, 0)));
        assert_eq!(parse_version("box-v1.0"), None);
        assert_eq!(parse_version("box-v1.0.0-rc1"), None);
        assert_eq!(parse_version("v1.0.0.1"), None);
        let r = |tag: &str, pre: bool| Release {
            tag_name: tag.into(),
            html_url: format!("https://github.com/{REPO}/releases/tag/{tag}"),
            draft: false,
            prerelease: pre,
        };
        let list = [
            r("box-v0.1.0", false),
            r("box-v0.10.0", false),
            r("box-v0.9.3", false),
            r("box-v1.0.0", true),
            r("v9.9.9", false),
        ];
        /* 0.10 is newer than 0.9: numbers, not text. */
        assert_eq!(newer("0.1.0", &list).map(|r| r.tag_name.as_str()), Some("box-v0.10.0"));
        assert!(newer("0.10.0", &list).is_none());
        assert!(newer("0.11.0", &list).is_none());
        assert!(newer("nonsense", &list).is_none());
    }

    #[test]
    fn caches_a_check_for_this_version_only() {
        let dir = std::env::temp_dir().join(format!("copland-release-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("release.toml");
        let write = |c: &Checked| std::fs::write(&path, toml::to_string(c).unwrap()).unwrap();
        write(&Checked {
            at: unix_now(),
            newer: Some(("box-v99.0.0".into(), "u".into())),
        });
        assert!(cached(&path).is_some());
        /* Older than a day's half: asked again. */
        write(&Checked {
            at: unix_now() - 13 * 3600,
            newer: None,
        });
        assert!(cached(&path).is_none());
        /* Says a release is newer that this build already is (upgraded since): asked again. */
        write(&Checked {
            at: unix_now(),
            newer: Some(("box-v0.0.1".into(), "u".into())),
        });
        assert!(cached(&path).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn finds_where_the_autostart_entry_goes_and_what_it_runs() {
        assert_eq!(
            autostart_dir(Some(Path::new("/x/conf")), Some(Path::new("/home/me"))),
            Some(PathBuf::from("/x/conf/autostart"))
        );
        assert_eq!(
            autostart_dir(Some(Path::new("relative")), Some(Path::new("/home/me"))),
            Some(PathBuf::from("/home/me/.config/autostart"))
        );
        assert_eq!(autostart_dir(None, None), None);

        let dir = std::env::temp_dir().join(format!("copland-autostart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let bin = dir.join("profile/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let path = format!("/nonexistent:{}", bin.display());
        /* Not on PATH: this binary, with what's odd about it. */
        let e = exec(
            Some(&path),
            Some(Path::new("/nix/store/abc-copland-box/bin/copland-box")),
        );
        assert_eq!(e.program, "/nix/store/abc-copland-box/bin/copland-box");
        assert!(e.caveat.unwrap().contains("Nix store"));
        assert!(
            exec(None, Some(Path::new("/src/daemon/target/release/copland-box")))
                .caveat
                .is_some()
        );
        assert!(
            exec(None, Some(Path::new("/usr/local/bin/copland-box")))
                .caveat
                .is_none()
        );
        /* On PATH (a profile's link): that, unresolved. */
        {
            use std::os::unix::fs::PermissionsExt as _;
            let b = bin.join(APP_ID);
            std::fs::write(&b, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&b, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let e = exec(Some(&path), Some(Path::new("/nix/store/abc/bin/copland-box")));
        assert_eq!(
            e,
            Exec {
                program: bin.join(APP_ID).display().to_string(),
                caveat: None
            }
        );

        /* Written and removed, under a scratch directory only. */
        let file = dir.join("autostart").join(format!("{APP_ID}.desktop"));
        set_autostart(&file, true, Some(Path::new("/tmp/my conf/daemon.toml")), &e).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.starts_with("[Desktop Entry]\nType=Application\n"));
        assert!(text.contains(&format!(
            "Exec={} --config \"/tmp/my conf/daemon.toml\"\n",
            bin.join(APP_ID).display()
        )));
        set_autostart(&file, false, None, &e).unwrap();
        assert!(!file.exists());
        /* Removing what isn't there is fine. */
        set_autostart(&file, false, None, &e).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(quote("a$b"), "\"a\\$b\"");
        assert_eq!(quote("50%"), "\"50%%\"");
    }
}
