//! What the box writes as you (COPL-109): a message to one of your agents, your
//! inbox marked read. The token it reads with is read-only and can't, so these
//! use a second one, read and write, in a file of its own beside it
//! (`me.write.token`, named by `owner_write_token_file`). The box asks for it
//! through a device login the first time you message an agent (`agents.rs`),
//! not before: only someone who wants to write from the box keeps a token on
//! disk that can do anything they can. Signing out revokes and deletes it with
//! the rest (`menu::sign_out`).

use std::path::{Path, PathBuf};

use anyhow::Result;
use copland_daemon_core::Config;
use copland_daemon_core::api::ApiError;
use copland_daemon_core::config::Secret;

use crate::{edit, setup};

/// The key in daemon.toml, and the file the token is kept in.
pub const KEY: &str = "owner_write_token_file";
pub const FILE: &str = "me.write.token";

/// The instance and the write token, when daemon.toml has one.
pub fn token(config: &Path) -> Option<(String, Secret)> {
    let owner = Config::load(config).ok()?.owner?;
    Some((owner.url, owner.write?))
}

/// The token from a device login, into its file beside the config (0600) and named in
/// daemon.toml, the old one kept as a backup. Nothing else changes, so the daemon needn't reload.
pub fn save(config: &Path, token: &Secret) -> Result<PathBuf> {
    let dir = config
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    setup::private_dir(dir)?;
    let file = dir.join(FILE);
    setup::private_write(&file, &format!("{}\n", token.expose()))?;
    let text = std::fs::read_to_string(config)?;
    let text = edit::set_key(&text, KEY, Some(&edit::toml_str(&setup::tilde(&file))));
    edit::save(config, &text)?;
    Ok(file)
}

/// Drop a token Copland no longer takes: out of daemon.toml and off the disk, so the next
/// message asks for a new one.
pub fn forget(config: &Path) -> Result<()> {
    let text = std::fs::read_to_string(config)?;
    let file = toml::from_str::<toml::Table>(&text).ok().and_then(|t| {
        t.get(KEY)
            .and_then(|v| v.as_str())
            .map(copland_daemon_core::config::expand_home)
    });
    edit::save(config, &edit::set_key(&text, KEY, None))?;
    if let Some(f) = file {
        let _ = std::fs::remove_file(f);
    }
    Ok(())
}

/// What a write's failure says, and whether the token itself was refused (revoked, expired).
pub fn failed(e: &ApiError) -> (String, bool) {
    match e.status() {
        Some(401) => (
            "copland refused the box's write token, so the box forgot it: m asks for a new one".into(),
            true,
        ),
        _ => (e.to_string(), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_the_token_beside_the_config_and_forgets_it() {
        let dir = std::env::temp_dir().join(format!("copland-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("me.token"), "cpl_me\n").unwrap();
        let config = dir.join("daemon.toml");
        let text = format!(
            "owner_token_file = \"{0}/me.token\"\n\n[[agent]]\nurl = \"http://x\"\nhandle = \"me/dev\"\ntoken = \"cpl_a\"\ncommand = [\"x\"]\nworkdir = \"{0}\"\n",
            dir.display()
        );
        std::fs::write(&config, &text).unwrap();
        assert!(token(&config).is_none());

        let file = save(&config, &Secret::new("cpl_w")).unwrap();
        assert_eq!(file, dir.join(FILE));
        let (url, t) = token(&config).unwrap();
        assert_eq!((url.as_str(), t.expose()), ("http://x", "cpl_w"));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        let saved = std::fs::read_to_string(&config).unwrap();
        assert!(saved.contains(KEY) && saved.contains("[[agent]]"));

        forget(&config).unwrap();
        assert!(token(&config).is_none() && !file.exists());
        assert!(!std::fs::read_to_string(&config).unwrap().contains(KEY));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_refused_token_is_forgotten_and_anything_else_just_said() {
        let refused = ApiError::Status {
            status: 401,
            code: None,
            message: "revoked".into(),
        };
        assert!(failed(&refused).1);
        let other = ApiError::Status {
            status: 403,
            code: None,
            message: "no".into(),
        };
        assert_eq!(failed(&other), ("403: no".into(), false));
        assert!(!failed(&ApiError::Transport("down".into())).1);
    }
}
