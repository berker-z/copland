//! `daemon.toml`: which agents this machine runs, and how.
//!
//! ```toml
//! poll_interval = 30            # seconds, optional
//!
//! [[agent]]
//! url = "https://copland.example.com"
//! handle = "berker-z/dev"       # for display; the server's answer wins
//! token_file = "~/.config/copland/dev.token"
//! command = ["claude", "-p", "{prompt}", "--mcp-config", "{mcp_config}", "--strict-mcp-config"]
//! workdir = "~/work/dev"
//! client = "Claude Code"        # optional, what history says it came through
//! ```

use std::fmt;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;

pub const DEFAULT_POLL_SECS: u64 = 30;
pub const DEFAULT_CLIENT: &str = "Claude Code";
pub const PROMPT: &str = "{prompt}";
pub const MCP_CONFIG: &str = "{mcp_config}";

/// A credential. Its `Debug` never shows it, so it can sit in structs that get logged.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    /// The secret itself, for the one place that sends or writes it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(…)")
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub poll_interval: Duration,
    pub agents: Vec<AgentConfig>,
    /// Some agent has its token written in the config itself.
    inline_token: bool,
}

#[derive(Debug, Clone)]
pub struct AgentConfig {
    /// The instance, without a trailing slash.
    pub url: String,
    /// The handle without "@", as configured. The server's own answer replaces it once known.
    pub handle: String,
    pub token: Secret,
    /// argv, with `{prompt}` and `{mcp_config}` filled in per run.
    pub command: Vec<String>,
    pub workdir: PathBuf,
    pub client: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    poll_interval: Option<u64>,
    #[serde(default, rename = "agent")]
    agents: Vec<RawAgent>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAgent {
    url: String,
    handle: String,
    token: Option<Secret>,
    token_file: Option<String>,
    command: Vec<String>,
    workdir: String,
    client: Option<String>,
}

/// `~/…` against $HOME. Anything else as written.
pub fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ if path == "~" => std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| path.into()),
        _ => PathBuf::from(path),
    }
}

fn xdg(var: &str, fallback: &str) -> PathBuf {
    match std::env::var_os(var) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => expand_home(fallback),
    }
}

/// `$XDG_CONFIG_HOME/copland/daemon.toml`, else `~/.config/copland/daemon.toml`.
pub fn default_config_path() -> PathBuf {
    xdg("XDG_CONFIG_HOME", "~/.config").join("copland").join("daemon.toml")
}

/// Where run logs go: `$XDG_STATE_HOME/copland`, else `~/.local/state/copland`.
pub fn default_state_dir() -> PathBuf {
    xdg("XDG_STATE_HOME", "~/.local/state").join("copland")
}

/// Where a run's MCP config lives while the run does: `$XDG_RUNTIME_DIR` (a per-user tmpfs) or the temp dir.
pub fn default_runtime_dir() -> PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => std::env::temp_dir(),
    }
}

/// A file holding a token should be readable by its owner alone.
fn warn_if_shared(path: &Path, what: &str) {
    if let Ok(meta) = fs::metadata(path) {
        let mode = meta.permissions().mode();
        if mode & 0o077 != 0 {
            tracing::warn!(
                "{what} {} holds a token and is readable by others (mode {:o}); chmod 600 it",
                path.display(),
                mode & 0o777
            );
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let config = Self::parse(&text, |p| {
            warn_if_shared(p, "token file");
            fs::read_to_string(p)
        })
        .with_context(|| format!("in {}", path.display()))?;
        if config.inline_token {
            warn_if_shared(path, "config");
        }
        Ok(config)
    }

    /// Parse and check. `read_token` reads a `token_file` (a seam for tests).
    pub fn parse(text: &str, read_token: impl Fn(&Path) -> std::io::Result<String>) -> Result<Self> {
        let raw: RawConfig = toml::from_str(text)?;
        let poll = raw.poll_interval.unwrap_or(DEFAULT_POLL_SECS);
        if poll < 5 {
            bail!("poll_interval is in seconds and must be at least 5");
        }
        if raw.agents.is_empty() {
            bail!("no [[agent]] configured");
        }
        let mut agents = Vec::new();
        let mut inline_token = false;
        for (n, a) in raw.agents.into_iter().enumerate() {
            let at = format!("agent {} ({})", n + 1, a.handle);
            let url = a.url.trim().trim_end_matches('/').to_string();
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                bail!("{at}: url must start with http:// or https://");
            }
            let handle = a.handle.trim().trim_start_matches('@').to_string();
            if handle.is_empty() {
                bail!("{at}: handle is empty");
            }
            let token = match (a.token, a.token_file) {
                (Some(t), None) => {
                    inline_token = true;
                    t
                }
                (None, Some(file)) => {
                    let path = expand_home(&file);
                    let text =
                        read_token(&path).with_context(|| format!("{at}: reading token_file {}", path.display()))?;
                    Secret::new(text.trim())
                }
                (Some(_), Some(_)) => bail!("{at}: give token or token_file, not both"),
                (None, None) => bail!("{at}: needs token_file (or token)"),
            };
            if !token.expose().starts_with("cpl_") {
                bail!("{at}: the token should be an API token (cpl_…), not a run secret or anything else");
            }
            if a.command.is_empty() || a.command[0].trim().is_empty() {
                bail!("{at}: command is empty");
            }
            if !a.command.iter().any(|arg| arg.contains(MCP_CONFIG)) {
                tracing::warn!(
                    "{at}: command has no {MCP_CONFIG}, so the runtime will not be connected through the run"
                );
            }
            let workdir = expand_home(&a.workdir);
            if !workdir.is_dir() {
                bail!("{at}: workdir {} is not a directory", workdir.display());
            }
            let client = a.client.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
            agents.push(AgentConfig {
                url,
                handle,
                token,
                command: a.command,
                workdir,
                client: client.unwrap_or_else(|| DEFAULT_CLIENT.to_string()),
            });
        }
        Ok(Config {
            poll_interval: Duration::from_secs(poll),
            agents,
            inline_token,
        })
    }
}

/// The command with its placeholders filled in. Placeholders may sit inside a longer argument.
pub fn fill_command(command: &[String], prompt: &str, mcp_config: &Path) -> Vec<String> {
    let mcp = mcp_config.to_string_lossy();
    command
        .iter()
        .map(|arg| arg.replace(PROMPT, prompt).replace(MCP_CONFIG, &mcp))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }

    fn parse(text: &str) -> Result<Config> {
        Config::parse(text, |_| Ok("cpl_fromfile\n".to_string()))
    }

    #[test]
    fn reads_an_agent_with_a_token_file() {
        let c = parse(&format!(
            r#"
            [[agent]]
            url = "http://localhost:5173/"
            handle = "@me/dev"
            token_file = "~/x"
            command = ["claude", "-p", "{{prompt}}", "--mcp-config", "{{mcp_config}}"]
            workdir = "{}"
            "#,
            tmp()
        ))
        .unwrap();
        assert_eq!(c.poll_interval, Duration::from_secs(30));
        let a = &c.agents[0];
        assert_eq!(a.url, "http://localhost:5173");
        assert_eq!(a.handle, "me/dev");
        assert_eq!(a.token.expose(), "cpl_fromfile");
        assert_eq!(a.client, "Claude Code");
        assert_eq!(format!("{:?}", a.token), "Secret(…)");
    }

    #[test]
    fn refuses_both_or_neither_token() {
        let base = format!(
            "url = \"http://x\"\nhandle = \"a/b\"\ncommand = [\"x\"]\nworkdir = \"{}\"\n",
            tmp()
        );
        assert!(parse(&format!("[[agent]]\n{base}")).is_err());
        assert!(parse(&format!("[[agent]]\n{base}token = \"cpl_a\"\ntoken_file = \"f\"\n")).is_err());
        assert!(parse(&format!("[[agent]]\n{base}token = \"cplr_a\"\n")).is_err());
        assert!(parse(&format!("[[agent]]\n{base}token = \"cpl_a\"\n")).is_ok());
    }

    #[test]
    fn refuses_unknown_keys_and_bad_values() {
        let w = tmp();
        assert!(parse(&format!("[[agent]]\nurl=\"http://x\"\nhandle=\"a\"\ntoken=\"cpl_a\"\ncommand=[\"x\"]\nworkdir=\"{w}\"\nmax_runs=2\n")).is_err());
        assert!(
            parse(&format!(
                "[[agent]]\nurl=\"ftp://x\"\nhandle=\"a\"\ntoken=\"cpl_a\"\ncommand=[\"x\"]\nworkdir=\"{w}\"\n"
            ))
            .is_err()
        );
        assert!(
            parse(&format!(
                "[[agent]]\nurl=\"http://x\"\nhandle=\"a\"\ntoken=\"cpl_a\"\ncommand=[]\nworkdir=\"{w}\"\n"
            ))
            .is_err()
        );
        assert!(parse(&format!("poll_interval = 1\n[[agent]]\nurl=\"http://x\"\nhandle=\"a\"\ntoken=\"cpl_a\"\ncommand=[\"x\"]\nworkdir=\"{w}\"\n")).is_err());
        assert!(parse("poll_interval = 30\n").is_err());
    }

    #[test]
    fn fills_placeholders() {
        let cmd: Vec<String> = ["claude", "-p", "{prompt}", "--mcp-config={mcp_config}"]
            .map(String::from)
            .into();
        let filled = fill_command(&cmd, "do it", Path::new("/run/x.json"));
        assert_eq!(filled, ["claude", "-p", "do it", "--mcp-config=/run/x.json"]);
    }
}
