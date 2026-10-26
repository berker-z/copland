//! What the menu's settings and about panels do outside daemon.toml (COPL-65):
//! starting the box, and the tray (COPL-201), at login through XDG autostart entries, and asking
//! GitHub whether a newer box has been released.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::APP_ID;

/* ---------- start at login ---------- */

/* Writing autostart entries is core's (`autostart`), shared with the tray's entry and setup. */
pub use copland_daemon_core::autostart::Exec;
use copland_daemon_core::autostart::{self, TRAY};

/// The autostart entry this box would write or remove, for this process's environment.
pub fn autostart_file() -> Option<PathBuf> {
    autostart::file(APP_ID)
}

/// The tray's autostart entry, which the menu's "tray at login" writes or removes.
pub fn tray_autostart_file() -> Option<PathBuf> {
    autostart::file(TRAY)
}

/// The box to start at login: on PATH, else this binary (see `autostart::exec`).
pub fn exec(path_var: Option<&str>, current: Option<&Path>) -> Exec {
    autostart::exec(APP_ID, path_var, current)
}

/// The tray to start at login: on PATH, else the one beside this box.
pub fn tray_exec(path_var: Option<&str>, current: Option<&Path>) -> Exec {
    autostart::exec(TRAY, path_var, autostart::beside(current, TRAY).as_deref())
}

/// Write the box's entry at `file`, or remove it.
pub fn set_autostart(file: &Path, on: bool, config: Option<&Path>, exec: &Exec) -> Result<()> {
    autostart::set(file, on, &autostart::BOX, config, exec)
}

/// Write the tray's entry at `file`, or remove it.
pub fn set_tray_autostart(file: &Path, on: bool, config: Option<&Path>, exec: &Exec) -> Result<()> {
    autostart::set(file, on, &autostart::TRAY_ENTRY, config, exec)
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
    fn writes_the_box_and_the_tray_entries() {
        let dir = std::env::temp_dir().join(format!("copland-autostart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        {
            use std::os::unix::fs::PermissionsExt as _;
            let t = bin.join(TRAY);
            std::fs::write(&t, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&t, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let me = bin.join(APP_ID);
        let e = exec(None, Some(&me));
        assert_eq!(e.program, me.display().to_string());
        /* The tray beside this box, when PATH has none. */
        let t = tray_exec(Some("/nonexistent"), Some(&me));
        assert_eq!((t.program, t.caveat), (bin.join(TRAY).display().to_string(), None));
        assert_eq!(tray_exec(None, Some(Path::new("/nowhere/copland-box"))).program, TRAY);

        let file = dir.join("autostart").join(format!("{APP_ID}.desktop"));
        set_autostart(&file, true, Some(Path::new("/tmp/my conf/daemon.toml")), &e).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.starts_with("[Desktop Entry]\nType=Application\nName=Copland\n"));
        assert!(text.contains(&format!(
            "Exec={} --config \"/tmp/my conf/daemon.toml\"\n",
            me.display()
        )));
        set_autostart(&file, false, None, &e).unwrap();
        assert!(!file.exists());

        let tray = dir.join("autostart").join(format!("{TRAY}.desktop"));
        set_tray_autostart(&tray, true, None, &tray_exec(None, Some(&me))).unwrap();
        let text = std::fs::read_to_string(&tray).unwrap();
        assert!(text.contains(&format!("Exec={}\n", bin.join(TRAY).display())));
        assert!(text.contains("tray at login"));
        set_tray_autostart(&tray, false, None, &e).unwrap();
        assert!(!tray.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
