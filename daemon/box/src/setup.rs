//! Setup's plain parts, apart from the window (`wizard.rs` draws and drives them):
//! the one-line text input, the address as typed into the address used, and
//! writing what an approved device code handed over into `daemon.toml`.
//!
//! The tokens are written the moment they arrive, since the server gives them
//! once, together with a note of what still needs saying (`daemon.toml.setup`),
//! so a setup left at the runtimes step picks up there next time.

use std::fs;
use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use copland_daemon_core::api::DeviceIdentity;
use serde::{Deserialize, Serialize};

use crate::runtime::Runtime;

/// What the box calls itself to the server, and in each agent's history.
pub const CLIENT: &str = "copland-box";

/// A single line being typed: the text and a cursor between characters.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LineInput {
    text: String,
    /// A byte offset on a character boundary.
    cursor: usize,
}

impl LineInput {
    pub fn new(text: &str) -> Self {
        let mut i = Self::default();
        i.insert(text);
        i
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    /// The text either side of the cursor.
    pub fn split(&self) -> (&str, &str) {
        self.text.split_at(self.cursor)
    }

    /// Typed or pasted text at the cursor: its first line, without control characters.
    pub fn insert(&mut self, s: &str) {
        let line = s.trim_start_matches(['\r', '\n']).lines().next().unwrap_or("");
        let clean: String = line.chars().filter(|c| !c.is_control()).collect();
        self.text.insert_str(self.cursor, &clean);
        self.cursor += clean.len();
    }

    fn prev(&self) -> usize {
        self.text[..self.cursor]
            .char_indices()
            .next_back()
            .map_or(0, |(i, _)| i)
    }

    fn next(&self) -> usize {
        self.text[self.cursor..]
            .chars()
            .next()
            .map_or(self.cursor, |c| self.cursor + c.len_utf8())
    }

    pub fn backspace(&mut self) {
        let from = self.prev();
        self.text.replace_range(from..self.cursor, "");
        self.cursor = from;
    }

    pub fn delete(&mut self) {
        let to = self.next();
        self.text.replace_range(self.cursor..to, "");
    }

    /// Back to the start of the word before the cursor (ctrl-w, ctrl-backspace).
    pub fn delete_word(&mut self) {
        let before = &self.text[..self.cursor];
        let trimmed = before.trim_end_matches(|c: char| !c.is_alphanumeric());
        let from = trimmed
            .char_indices()
            .rev()
            .find(|(_, c)| !c.is_alphanumeric())
            .map_or(0, |(i, c)| i + c.len_utf8());
        self.text.replace_range(from..self.cursor, "");
        self.cursor = from;
    }

    pub fn left(&mut self) {
        self.cursor = self.prev();
    }

    pub fn right(&mut self) {
        self.cursor = self.next();
    }

    pub fn home(&mut self) {
        self.cursor = 0;
    }

    pub fn end(&mut self) {
        self.cursor = self.text.len();
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

/// The address as typed into an instance's base: `https://` when no scheme is given, and only
/// scheme, host and port kept (a pasted page's path, query or fragment dropped).
pub fn normalize_url(typed: &str) -> Result<String> {
    let t = typed.trim();
    if t.is_empty() {
        bail!("type your Copland's address");
    }
    let (scheme, rest) = match t.split_once("://") {
        Some((s, r)) => {
            let s = s.to_ascii_lowercase();
            if s != "http" && s != "https" {
                bail!("{s}:// isn't a web address; use https://");
            }
            (s, r)
        }
        None => ("https".to_string(), t),
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.contains(char::is_whitespace) || host.contains('@') {
        bail!("that doesn't look like an address");
    }
    /* A port, if any, is digits; "[::1]" alone has none. */
    if let Some((name, port)) = host.rsplit_once(':').filter(|_| !host.ends_with(']')) {
        if name.is_empty() || port.parse::<u16>().map_or(true, |p| p == 0) {
            bail!("{port:?} isn't a port");
        }
    }
    Ok(format!("{scheme}://{}", host.to_ascii_lowercase()))
}

/// This machine's name, for the approval page ("copland-box on <host>").
pub fn hostname() -> String {
    fs::read_to_string("/proc/sys/kernel/hostname")
        .or_else(|_| fs::read_to_string("/etc/hostname"))
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "unknown".into())
}

/// "owner/name" → "name", made safe for a file or directory name.
pub fn agent_name(handle: &str) -> String {
    let name = handle.trim_start_matches('@').rsplit('/').next().unwrap_or(handle);
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let safe = safe.trim_matches('.').to_string();
    if safe.is_empty() { "agent".into() } else { safe }
}

/// `~/…` for a path under $HOME, so the config reads the way people write it.
pub fn tilde(path: &Path) -> String {
    match std::env::var_os("HOME").map(PathBuf::from) {
        Some(home) if !home.as_os_str().is_empty() => match path.strip_prefix(&home) {
            Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
            Ok(rest) => format!("~/{}", rest.display()),
            Err(_) => path.display().to_string(),
        },
        _ => path.display().to_string(),
    }
}

/// Where an agent works unless changed: `~/agents/<name>`.
pub fn default_workdir(name: &str) -> String {
    format!("~/agents/{name}")
}

/// One agent's tokens on disk, without its runtime yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedAgent {
    pub handle: String,
    pub token_file: PathBuf,
}

/// What an approved device code gave, once its tokens are on disk: everything daemon.toml
/// needs but the runtimes. Kept beside the config until it is written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Saved {
    pub url: String,
    pub owner: String,
    pub owner_token_file: PathBuf,
    #[serde(default, rename = "agent")]
    pub agents: Vec<SavedAgent>,
}

/// `daemon.toml` → `daemon.toml.setup`: an approved setup not yet written as a config.
pub fn pending_path(config: &Path) -> PathBuf {
    let mut p = config.as_os_str().to_owned();
    p.push(".setup");
    PathBuf::from(p)
}

/// `daemon.toml` → `daemon.toml.bak`, or `.bak.2`… so an older backup is never lost.
pub fn backup_path(config: &Path) -> PathBuf {
    let with = |s: &str| {
        let mut p = config.as_os_str().to_owned();
        p.push(s);
        PathBuf::from(p)
    };
    let first = with(".bak");
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| with(&format!(".bak.{n}")))
        .find(|p| !p.exists())
        .expect("some free name")
}

pub(crate) fn private_dir(dir: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .with_context(|| format!("making {}", dir.display()))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).with_context(|| format!("chmod 700 {}", dir.display()))
}

/// Write `text` to `path` with mode 0600, replacing it whole (through a temporary file).
pub(crate) fn private_write(path: &Path, text: &str) -> Result<()> {
    let tmp = {
        let mut p = path.as_os_str().to_owned();
        p.push(".tmp");
        PathBuf::from(p)
    };
    let _ = fs::remove_file(&tmp);
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .with_context(|| format!("writing {}", tmp.display()))?;
    f.write_all(text.as_bytes())?;
    f.sync_all()?;
    fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))
}

/// The tokens a device code handed over, into token files beside the config (dir 0700, files
/// 0600): `me.token` for yours, `<name>.token` for each agent's. Records them in the pending
/// file, and gives back what was saved.
pub fn save_tokens(config: &Path, url: &str, owner: &DeviceIdentity, agents: &[DeviceIdentity]) -> Result<Saved> {
    let dir = config
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    private_dir(dir)?;
    let mut used = vec!["me".to_string()];
    let owner_token_file = dir.join("me.token");
    private_write(&owner_token_file, &format!("{}\n", owner.token.expose()))?;
    let mut saved = Vec::new();
    for a in agents {
        let base = agent_name(&a.handle);
        let name = (1..)
            .map(|n| if n == 1 { base.clone() } else { format!("{base}-{n}") })
            .find(|n| !used.contains(n))
            .expect("some free name");
        used.push(name.clone());
        let token_file = dir.join(format!("{name}.token"));
        private_write(&token_file, &format!("{}\n", a.token.expose()))?;
        saved.push(SavedAgent {
            handle: a.handle.trim_start_matches('@').to_string(),
            token_file,
        });
    }
    let saved = Saved {
        url: url.trim_end_matches('/').to_string(),
        owner: owner.handle.trim_start_matches('@').to_string(),
        owner_token_file,
        agents: saved,
    };
    let text = format!(
        "# copland-box --setup was approved and saved these tokens, but hasn't written daemon.toml yet.\n\
         # It picks up from here next time it starts. Delete this file to start over.\n{}",
        toml::to_string(&saved).context("writing the setup note")?
    );
    private_write(&pending_path(config), &text)?;
    Ok(saved)
}

/// A setup that got its tokens but not its config, if there is one.
pub fn load_pending(config: &Path) -> Option<Result<Saved>> {
    let path = pending_path(config);
    let text = fs::read_to_string(&path).ok()?;
    Some(toml::from_str(&text).with_context(|| format!("reading {}", path.display())))
}

/// One agent as it goes into daemon.toml.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub runtime: Runtime,
    /// As written: `~/agents/<name>` by default.
    pub workdir: String,
}

/// A TOML string, quoted and escaped.
fn q(s: &str) -> String {
    toml::Value::String(s.to_string()).to_string()
}

/// daemon.toml for what was saved, each agent with its choice.
pub fn render_config(saved: &Saved, choices: &[Choice]) -> String {
    let mut out = String::new();
    out.push_str("# Written by copland-box --setup. Edit it freely: the daemon reads it at start.\n");
    out.push_str("# The box's agents screen (a) changes agents in place, and copland-box --setup\n");
    out.push_str("# writes it again; either keeps the version before as daemon.toml.bak (.bak.2, ...).\n\n");
    out.push_str(&format!(
        "# Your own token (@{}), for the box's view of all your agents' work.\n",
        saved.owner
    ));
    out.push_str(&format!("owner_token_file = {}\n", q(&tilde(&saved.owner_token_file))));
    out.push_str(
        "\n# What the agents may do is not decided yet. Each command below lets its agent use\n\
         # Copland's MCP tools and nothing else (no shell, no file edits): it reads and moves\n\
         # tasks and comments, and that's all. Widen an agent's command by hand once you\n\
         # have decided what it may touch; setup will keep writing the narrow one.\n",
    );
    for (a, c) in saved.agents.iter().zip(choices) {
        out.push('\n');
        out.push_str(&render_agent(&saved.url, &a.handle, &a.token_file, c));
    }
    out
}

/// The lines saying which runtime an agent uses: `client`, a warning when the template is
/// untested, and `command`, one argument a line.
pub fn render_binding(runtime: Runtime) -> String {
    let mut out = format!("client = {}\n", q(runtime.name()));
    if !runtime.tested() {
        out.push_str(&untested_note(runtime));
    }
    out.push_str("command = [\n");
    for arg in runtime.command() {
        out.push_str(&format!("  {},\n", q(&arg)));
    }
    out.push_str("]\n");
    out
}

fn untested_note(runtime: Runtime) -> String {
    format!(
        "{UNTESTED_START}{} template hasn't been run against Copland yet: check it before relying on it.\n",
        runtime.name()
    )
}

/// How the untested-template note starts, so a rebind can take it out again.
pub(crate) const UNTESTED_START: &str = "# The ";

/// One `[[agent]]` table as setup writes it.
pub fn render_agent(url: &str, handle: &str, token_file: &Path, choice: &Choice) -> String {
    let mut out = String::from("[[agent]]\n");
    out.push_str(&format!("url = {}\n", q(url)));
    out.push_str(&format!("handle = {}\n", q(handle)));
    out.push_str(&format!("token_file = {}\n", q(&tilde(token_file))));
    out.push_str(&format!("workdir = {}\n", q(&choice.workdir)));
    out.push_str(&render_binding(choice.runtime));
    out
}

/// Write daemon.toml (0600) from what was saved, keeping any file already there as a backup,
/// make each workdir, and drop the pending note. Gives back the backup's path, if one was made.
pub fn write_config(config: &Path, saved: &Saved, choices: &[Choice]) -> Result<Option<PathBuf>> {
    if saved.agents.is_empty() {
        bail!("no agents to run: make one in Copland (settings › agents), then run copland-box --setup");
    }
    for c in choices {
        let dir = copland_daemon_core::config::expand_home(&c.workdir);
        fs::create_dir_all(&dir).with_context(|| format!("making {}", dir.display()))?;
    }
    let text = render_config(saved, choices);
    let backup = if config.exists() {
        let b = backup_path(config);
        fs::rename(config, &b).with_context(|| format!("keeping {} as {}", config.display(), b.display()))?;
        Some(b)
    } else {
        None
    };
    if let Some(dir) = config.parent().filter(|d| !d.as_os_str().is_empty()) {
        private_dir(dir)?;
    }
    private_write(config, &text)?;
    let _ = fs::remove_file(pending_path(config));
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;
    use copland_daemon_core::Config;
    use copland_daemon_core::config::Secret;

    fn input(text: &str, cursor: usize) -> LineInput {
        let mut i = LineInput::new(text);
        i.cursor = cursor;
        i
    }

    #[test]
    fn edits_a_line() {
        let mut i = LineInput::new("copland.dev");
        assert_eq!(i.split(), ("copland.dev", ""));
        i.backspace();
        i.backspace();
        i.backspace();
        i.insert("xyz");
        assert_eq!(i.text(), "copland.xyz");
        i.home();
        i.insert("https://");
        assert_eq!(i.split(), ("https://", "copland.xyz"));
        i.delete();
        assert_eq!(i.text(), "https://opland.xyz");
        i.end();
        i.left();
        i.left();
        i.right();
        assert_eq!(i.split(), ("https://opland.xy", "z"));
        /* Walking past either end stays put. */
        i.home();
        i.left();
        i.backspace();
        assert_eq!(i.split(), ("", "https://opland.xyz"));
        i.end();
        i.right();
        i.delete();
        assert_eq!(i.text(), "https://opland.xyz");
    }

    #[test]
    fn keeps_to_character_boundaries() {
        let mut i = LineInput::new("çay·");
        i.backspace();
        assert_eq!(i.text(), "çay");
        i.home();
        i.right();
        assert_eq!(i.split(), ("ç", "ay"));
        i.delete();
        assert_eq!(i.text(), "çy");
    }

    #[test]
    fn pastes_one_clean_line() {
        let mut i = input("", 0);
        i.insert("\n  copland.example.com\tx\nsecond line");
        assert_eq!(i.text(), "  copland.example.comx");
        i.clear();
        assert_eq!(i, LineInput::default());
    }

    #[test]
    fn deletes_a_word() {
        let mut i = LineInput::new("https://copland.example.com");
        i.delete_word();
        assert_eq!(i.text(), "https://copland.example.");
        i.delete_word();
        assert_eq!(i.text(), "https://copland.");
        let mut i = LineInput::new("abc");
        i.delete_word();
        assert_eq!(i.text(), "");
    }

    #[test]
    fn normalizes_addresses() {
        let n = |s: &str| normalize_url(s).unwrap();
        assert_eq!(n("copland.example.com"), "https://copland.example.com");
        assert_eq!(n("  Copland.Example.com/ "), "https://copland.example.com");
        assert_eq!(n("https://copland.example.com///"), "https://copland.example.com");
        assert_eq!(n("http://localhost:5173"), "http://localhost:5173");
        assert_eq!(n("HTTPS://x.dev/b/COPL?y=1#z"), "https://x.dev");
        assert_eq!(n("localhost:8787/settings"), "https://localhost:8787");
        assert!(normalize_url("").is_err());
        assert!(normalize_url("ftp://x").is_err());
        assert!(normalize_url("https://").is_err());
        assert!(normalize_url("two words").is_err());
        assert!(normalize_url("user@host").is_err());
        assert!(normalize_url("localhost:8790x").is_err());
        assert!(normalize_url("localhost:").is_err());
        assert_eq!(n("[::1]:8787"), "https://[::1]:8787");
        assert_eq!(n("http://[::1]"), "http://[::1]");
    }

    #[test]
    fn names_agents_safely() {
        assert_eq!(agent_name("berker-z/dev"), "dev");
        assert_eq!(agent_name("@me/../x y"), "x-y");
        assert_eq!(agent_name("me/.."), "agent");
        assert_eq!(agent_name("solo"), "solo");
    }

    #[test]
    fn backs_up_without_losing_an_older_backup() {
        let dir = scratch("backup");
        fs::create_dir_all(&dir).unwrap();
        let c = dir.join("daemon.toml");
        assert_eq!(backup_path(&c), dir.join("daemon.toml.bak"));
        fs::write(dir.join("daemon.toml.bak"), "").unwrap();
        assert_eq!(backup_path(&c), dir.join("daemon.toml.bak.2"));
        fs::remove_dir_all(&dir).unwrap();
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("copland-setup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn id(handle: &str, token: &str) -> DeviceIdentity {
        DeviceIdentity {
            handle: handle.into(),
            token: Secret::new(token),
        }
    }

    #[test]
    fn writes_a_config_the_daemon_reads_back() {
        let dir = scratch("roundtrip");
        let config = dir.join("conf").join("daemon.toml");
        let agents = [
            id("me/dev", "cpl_dev"),
            id("me/me", "cpl_agentme"),
            id("other/dev", "cpl_dev2"),
        ];
        let saved = save_tokens(&config, "http://localhost:5173/", &id("me", "cpl_owner"), &agents).unwrap();

        /* Tokens are private, each in its own file, the owner's apart from an agent called "me". */
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(config.parent().unwrap()), 0o700);
        let files: Vec<_> = saved.agents.iter().map(|a| a.token_file.clone()).collect();
        assert_eq!(
            files,
            [
                dir.join("conf/dev.token"),
                dir.join("conf/me-2.token"),
                dir.join("conf/dev-2.token")
            ]
        );
        for f in files.iter().chain([&saved.owner_token_file]) {
            assert_eq!(mode(f), 0o600);
        }
        assert_eq!(fs::read_to_string(&saved.owner_token_file).unwrap(), "cpl_owner\n");

        /* A setup stopped here picks up from the note. */
        assert_eq!(load_pending(&config).unwrap().unwrap(), saved);

        let choices: Vec<Choice> = ["a", "b", "c"]
            .iter()
            .zip([Runtime::ClaudeCode, Runtime::Codex, Runtime::ClaudeCode])
            .map(|(n, runtime)| Choice {
                runtime,
                workdir: dir.join("agents").join(n).display().to_string(),
            })
            .collect();
        fs::write(&config, "old").unwrap();
        let backup = write_config(&config, &saved, &choices).unwrap();
        assert_eq!(backup, Some(dir.join("conf/daemon.toml.bak")));
        assert_eq!(fs::read_to_string(dir.join("conf/daemon.toml.bak")).unwrap(), "old");
        assert_eq!(mode(&config), 0o600);
        assert!(load_pending(&config).is_none());
        assert!(dir.join("agents/b").is_dir());

        let c = Config::load(&config).unwrap();
        assert_eq!(c.agents.len(), 3);
        assert_eq!(c.agents[0].url, "http://localhost:5173");
        assert_eq!(c.agents[0].handle, "me/dev");
        assert_eq!(c.agents[0].token.expose(), "cpl_dev");
        assert_eq!(c.agents[0].client, "Claude Code");
        assert_eq!(c.agents[0].command, Runtime::ClaudeCode.command());
        assert_eq!(c.agents[1].command, Runtime::Codex.command());
        assert_eq!(c.agents[1].client, "Codex");
        assert_eq!(c.agents[2].token.expose(), "cpl_dev2");
        assert_eq!(c.agents[1].workdir, dir.join("agents/b"));
        let owner = c.owner.unwrap();
        assert_eq!(
            (owner.url.as_str(), owner.token.expose()),
            ("http://localhost:5173", "cpl_owner")
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_to_write_a_config_without_agents() {
        let dir = scratch("noagents");
        let config = dir.join("daemon.toml");
        let saved = save_tokens(&config, "http://x", &id("me", "cpl_o"), &[]).unwrap();
        assert!(write_config(&config, &saved, &[]).is_err());
        assert!(!config.exists());
        assert!(load_pending(&config).is_some());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn writes_paths_under_home_with_a_tilde() {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        assert_eq!(
            tilde(&home.join(".config/copland/me.token")),
            "~/.config/copland/me.token"
        );
        assert_eq!(tilde(Path::new("/etc/x")), "/etc/x");
        assert_eq!(default_workdir("dev"), "~/agents/dev");
    }
}
