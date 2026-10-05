//! `daemon.toml`: which agents this machine runs, and how.
//!
//! ```toml
//! poll_interval = 30            # seconds, optional
//! # The box's alone (the headless daemon ignores them): theme, motion, notifications,
//! # compact, boards, and your own
//! # token for /api/wired, for the agents' url or owner_url.
//! owner_token_file = "~/.config/copland/me.token"
//! # Optional, the box's too: your read-and-write token, for messaging your agents and marking
//! # your inbox read from it (COPL-109). The box asks for it the first time you message one.
//! owner_write_token_file = "~/.config/copland/me.write.token"
//!
//! [[agent]]
//! url = "https://copland.example.com"
//! handle = "berker-z/dev"       # for display; the server's answer wins
//! token_file = "~/.config/copland/dev.token"
//! command = ["claude", "-p", "{prompt}", "--mcp-config", "{mcp_config}", "--strict-mcp-config"]
//! workdir = "~/work/dev"
//! client = "Claude Code"        # optional, what history says it came through
//! # Optional: tasks on a board with a GitHub repo run this instead, in the task's worktree,
//! # inside a sandbox (sandbox/) where only the worktree and `writable` can be written.
//! code_command = ["claude", "-p", "{prompt}", "--mcp-config", "{mcp_config}", "--strict-mcp-config"]
//! writable = ["~/.claude", "~/.claude.json", "~/.cache"]
//! # Optional: which runtime code_command starts, for its sandbox (sandbox/): "claude-code",
//! # "codex", "droid", or any other name. Left out, it's read off code_command's program.
//! runtime = "claude-code"
//! max_runs = 10                 # optional; runs going at once (coding tasks side by side)
//! ```
//!
//! `code_dir = "~/copland"` (top level, optional) is where repos are cloned and tasks'
//! worktrees made (workspace.rs).

use std::fmt;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;

pub const DEFAULT_POLL_SECS: u64 = 30;
pub const DEFAULT_CODE_DIR: &str = "~/copland";
/// How many runs an agent may have going at once, unless its config says (COPL-82).
pub const DEFAULT_MAX_RUNS: usize = 10;
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
    /// Where repos are cloned and coding tasks' worktrees made.
    pub code_dir: PathBuf,
    pub agents: Vec<AgentConfig>,
    /// The box's colour theme by name (`theme = "nord"`). Only the window reads it; the headless daemon ignores it.
    pub theme: Option<String>,
    /// The box animates (`motion = false` makes it a still picture). Only the window reads it.
    pub motion: Option<bool>,
    /// Desktop notifications for what needs you (`notifications = false` turns them off). Only the window reads it.
    pub notifications: Option<bool>,
    /// The box as its status line alone, in a small window. Only the window reads it.
    pub compact: Option<bool>,
    /// The boards whose tickets the box shows, by key; None is all of them. Display only: the
    /// agents still wake for any board. Only the window reads it.
    pub boards: Option<Vec<String>>,
    /// Your own token, for the box's view of all your agents' work. Only the window reads it.
    pub owner: Option<Owner>,
    /// Some token is written in the config itself.
    inline_token: bool,
}

/// The person the agents belong to, as the box reads `/api/wired` with: one token, for one instance.
#[derive(Debug, Clone)]
pub struct Owner {
    /// `owner_url`, or the agents' url when they all share one; no trailing slash.
    pub url: String,
    pub token: Secret,
    /// A read-and-write token for the same person (`owner_write_token_file`), for what the box
    /// writes as them: messages to their agents, their inbox marked read. None until asked for.
    pub write: Option<Secret>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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
    /// argv for a task on a board with a repo, run sandboxed in the task's worktree; None runs those
    /// like any other task, with `command` in `workdir`.
    pub code_command: Option<Vec<String>>,
    /// What a sandboxed run may write besides its worktree: the runtime's own state, caches.
    pub writable: Vec<PathBuf>,
    /// The runtime `code_command` starts (else `command`), which picks the sandbox coding runs get.
    pub runtime: Runtime,
    /// The config's `code_dir`, the same for every agent.
    pub code_dir: PathBuf,
    /// Runs going at once, at most. Only coding tasks run side by side; the rest share `workdir`, one at a time.
    pub max_runs: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    poll_interval: Option<u64>,
    code_dir: Option<String>,
    theme: Option<String>,
    motion: Option<bool>,
    notifications: Option<bool>,
    compact: Option<bool>,
    boards: Option<Vec<String>>,
    owner_url: Option<String>,
    owner_token: Option<Secret>,
    owner_token_file: Option<String>,
    owner_write_token: Option<Secret>,
    owner_write_token_file: Option<String>,
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
    code_command: Option<Vec<String>>,
    #[serde(default)]
    writable: Vec<String>,
    runtime: Option<String>,
    max_runs: Option<usize>,
}

/// The runtime an agent's coding runs start (COPL-141): `runtime =` in its config, else read off
/// its command. Each gets a sandbox backend of its own once one has been checked; until then, and
/// for any runtime not known here, it gets the platform's fallback (sandbox/).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Runtime {
    ClaudeCode,
    Codex,
    /// Factory's droid, which sandboxes its own runs (sandbox/droid.rs).
    Droid,
    /// Any other, by the name given or the program's: not an error, it gets the fallback.
    Unknown(String),
}

impl Runtime {
    /// As written in `runtime =`.
    pub fn named(name: &str) -> Self {
        match name {
            "claude-code" => Runtime::ClaudeCode,
            "codex" => Runtime::Codex,
            "droid" => Runtime::Droid,
            other => Runtime::Unknown(other.to_string()),
        }
    }

    /// Read off an argv: the file name of its program, `claude`, `codex` or `droid`. A shell running a
    /// script (`sh -c '…' copland-codex …`, as the box writes Codex's command) goes by the name the
    /// script is given, without its `copland-`.
    pub fn detect(argv: &[String]) -> Self {
        let name = |arg: &String| {
            Path::new(arg)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        let program = argv.first().map(name).unwrap_or_default();
        let shell = matches!(program.as_str(), "sh" | "bash" | "dash" | "zsh");
        let program = match argv.get(3) {
            Some(script) if shell && argv[1] == "-c" => {
                let script = name(script);
                script.strip_prefix("copland-").unwrap_or(&script).to_string()
            }
            _ => program,
        };
        match program.as_str() {
            "claude" => Runtime::ClaudeCode,
            "codex" => Runtime::Codex,
            "droid" => Runtime::Droid,
            _ => Runtime::Unknown(program),
        }
    }

    /// As written in `runtime =`, for the logs.
    pub fn name(&self) -> &str {
        match self {
            Runtime::ClaudeCode => "claude-code",
            Runtime::Codex => "codex",
            Runtime::Droid => "droid",
            Runtime::Unknown(name) => name,
        }
    }
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
        let code_dir = expand_home(raw.code_dir.as_deref().unwrap_or(DEFAULT_CODE_DIR));
        let mut agents = Vec::new();
        let mut inline_token = false;
        for (n, a) in raw.agents.into_iter().enumerate() {
            let at = format!("agent {} ({})", n + 1, a.handle);
            let url = check_url(&a.url).with_context(|| format!("{at}: url"))?;
            let handle = a.handle.trim().trim_start_matches('@').to_string();
            if handle.is_empty() {
                bail!("{at}: handle is empty");
            }
            let token = secret(
                (a.token, a.token_file),
                ("token", "token_file"),
                &read_token,
                &mut inline_token,
            )
            .with_context(|| at.clone())?;
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
            let max_runs = a.max_runs.unwrap_or(DEFAULT_MAX_RUNS);
            if !(1..=50).contains(&max_runs) {
                bail!("{at}: max_runs must be between 1 and 50");
            }
            if let Some(code) = &a.code_command {
                if code.is_empty() || code[0].trim().is_empty() {
                    bail!("{at}: code_command is empty");
                }
            }
            let runtime = match a.runtime.as_deref().map(str::trim) {
                Some("") => bail!("{at}: runtime is empty; leave it out to read it off code_command"),
                Some(name) => Runtime::named(name),
                None => Runtime::detect(a.code_command.as_ref().unwrap_or(&a.command)),
            };
            agents.push(AgentConfig {
                url,
                handle,
                token,
                command: a.command,
                workdir,
                client: client.unwrap_or_else(|| DEFAULT_CLIENT.to_string()),
                code_command: a.code_command,
                writable: a.writable.iter().map(|w| expand_home(w)).collect(),
                runtime,
                code_dir: code_dir.clone(),
                max_runs,
            });
        }
        let owner = match (raw.owner_token, raw.owner_token_file) {
            (None, None) => {
                if raw.owner_url.is_some() {
                    bail!("owner_url is set but there is no owner_token_file (or owner_token)");
                }
                if raw.owner_write_token.is_some() || raw.owner_write_token_file.is_some() {
                    bail!("owner_write_token_file is set but there is no owner_token_file (or owner_token)");
                }
                None
            }
            pair => {
                let token = secret(
                    pair,
                    ("owner_token", "owner_token_file"),
                    &read_token,
                    &mut inline_token,
                )?;
                let url = match &raw.owner_url {
                    Some(u) => check_url(u).context("owner_url")?,
                    None => {
                        let first = &agents[0].url;
                        if agents.iter().any(|a| &a.url != first) {
                            bail!(
                                "the agents are on more than one Copland, so say which one owner_token_file is for with owner_url"
                            );
                        }
                        first.clone()
                    }
                };
                let write = match (raw.owner_write_token, raw.owner_write_token_file) {
                    (None, None) => None,
                    pair => Some(secret(
                        pair,
                        ("owner_write_token", "owner_write_token_file"),
                        &read_token,
                        &mut inline_token,
                    )?),
                };
                Some(Owner { url, token, write })
            }
        };
        Ok(Config {
            poll_interval: Duration::from_secs(poll),
            code_dir,
            agents,
            theme: raw.theme.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()),
            motion: raw.motion,
            notifications: raw.notifications,
            compact: raw.compact,
            boards: raw.boards.map(|b| {
                b.iter()
                    .map(|k| k.trim().to_ascii_uppercase())
                    .filter(|k| !k.is_empty())
                    .collect()
            }),
            owner,
            inline_token,
        })
    }
}

/// An instance's address, without a trailing slash.
fn check_url(url: &str) -> Result<String> {
    let url = url.trim().trim_end_matches('/').to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        bail!("must start with http:// or https://");
    }
    Ok(url)
}

/// An API token given inline or in a file (exactly one of the two), checked to be one.
fn secret(
    given: (Option<Secret>, Option<String>),
    (key, file_key): (&str, &str),
    read_token: impl Fn(&Path) -> std::io::Result<String>,
    inline_token: &mut bool,
) -> Result<Secret> {
    let token = match given {
        (Some(t), None) => {
            *inline_token = true;
            t
        }
        (None, Some(file)) => {
            let path = expand_home(&file);
            let text = read_token(&path).with_context(|| format!("reading {file_key} {}", path.display()))?;
            Secret::new(text.trim())
        }
        (Some(_), Some(_)) => bail!("give {key} or {file_key}, not both"),
        (None, None) => bail!("needs {file_key} (or {key})"),
    };
    if !token.expose().starts_with("cpl_") {
        bail!("the {key} should be an API token (cpl_…), not a run secret or anything else");
    }
    Ok(token)
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
    fn coding_keys_have_defaults_and_bounds() {
        let w = tmp();
        let base =
            format!("[[agent]]\nurl=\"http://x\"\nhandle=\"a\"\ntoken=\"cpl_a\"\ncommand=[\"x\"]\nworkdir=\"{w}\"\n");
        let plain = parse(&base).unwrap();
        let a = &plain.agents[0];
        assert_eq!(a.max_runs, DEFAULT_MAX_RUNS);
        assert!(a.code_command.is_none() && a.writable.is_empty());
        assert_eq!(a.code_dir, expand_home(DEFAULT_CODE_DIR));
        let coding = parse(&format!(
            "code_dir=\"/c\"\n{base}code_command=[\"y\",\"{{prompt}}\"]\nwritable=[\"/s\"]\nmax_runs=3\n"
        ))
        .unwrap();
        let a = &coding.agents[0];
        assert_eq!(
            a.code_command.as_deref(),
            Some(&["y".to_string(), "{prompt}".to_string()][..])
        );
        assert_eq!(a.writable, vec![PathBuf::from("/s")]);
        assert_eq!((a.max_runs, a.code_dir.clone()), (3, PathBuf::from("/c")));
        assert!(parse(&format!("{base}max_runs=0\n")).is_err());
        assert!(parse(&format!("{base}max_runs=51\n")).is_err());
        assert!(parse(&format!("{base}code_command=[]\n")).is_err());
    }

    /// `runtime =` wins; without it the runtime is read off code_command (else command); a name
    /// neither knows is an unknown runtime, not an error (COPL-141).
    #[test]
    fn the_runtime_is_given_or_read_off_the_command() {
        let w = tmp();
        let claude = format!(
            "[[agent]]\nurl=\"http://x\"\nhandle=\"a\"\ntoken=\"cpl_a\"\ncommand=[\"claude\",\"-p\"]\nworkdir=\"{w}\"\n"
        );
        let runtime = |text: String| parse(&text).unwrap().agents[0].runtime.clone();
        assert_eq!(runtime(claude.clone()), Runtime::ClaudeCode);
        assert_eq!(
            runtime(format!("{claude}code_command=[\"/usr/local/bin/codex\",\"exec\"]\n")),
            Runtime::Codex
        );
        assert_eq!(
            runtime(format!("{claude}code_command=[\"codex\"]\nruntime=\"claude-code\"\n")),
            Runtime::ClaudeCode
        );
        assert_eq!(
            runtime(format!("{claude}code_command=[\"hermes\",\"run\"]\n")),
            Runtime::Unknown("hermes".into())
        );
        assert_eq!(
            runtime(format!("{claude}runtime=\" hermes \"\n")),
            Runtime::Unknown("hermes".into())
        );
        assert!(parse(&format!("{claude}runtime=\"\"\n")).is_err());

        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            Runtime::detect(&argv(&[
                "sh",
                "-c",
                "exec codex exec \"$1\"",
                "copland-codex",
                "{prompt}"
            ])),
            Runtime::Codex
        );
        assert_eq!(
            Runtime::detect(&argv(&["/bin/bash", "-c", "exec claude -p \"$1\"", "claude"])),
            Runtime::ClaudeCode
        );
        assert_eq!(
            Runtime::detect(&argv(&["sh", "-c", "codex"])),
            Runtime::Unknown("sh".into())
        );
        assert_eq!(
            Runtime::detect(&argv(&[
                "/usr/local/bin/droid",
                "exec",
                "--skip-permissions-unsafe",
                "{prompt}"
            ])),
            Runtime::Droid
        );
        assert_eq!(Runtime::detect(&[]), Runtime::Unknown(String::new()));
        assert_eq!(Runtime::named("codex").name(), "codex");
        assert_eq!(Runtime::named("droid"), Runtime::Droid);
        assert_eq!(Runtime::Droid.name(), "droid");
    }

    #[test]
    fn refuses_unknown_keys_and_bad_values() {
        let w = tmp();
        assert!(parse(&format!("[[agent]]\nurl=\"http://x\"\nhandle=\"a\"\ntoken=\"cpl_a\"\ncommand=[\"x\"]\nworkdir=\"{w}\"\nmax_jobs=2\n")).is_err());
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
    fn reads_the_box_theme() {
        let agent = format!(
            "[[agent]]\nurl=\"http://x\"\nhandle=\"a\"\ntoken=\"cpl_a\"\ncommand=[\"x\"]\nworkdir=\"{}\"\n",
            tmp()
        );
        assert_eq!(parse(&agent).unwrap().theme, None);
        let c = parse(&format!("theme = \"gruvbox\"\n{agent}")).unwrap();
        assert_eq!(c.theme.as_deref(), Some("gruvbox"));
        assert_eq!((c.notifications, c.compact, c.boards), (None, None, None));
        let c = parse(&format!(
            "notifications = false\ncompact = true\nboards = [\"copl\", \" HOME \", \"\"]\n{agent}"
        ))
        .unwrap();
        assert_eq!(c.notifications, Some(false));
        assert_eq!(c.compact, Some(true));
        assert_eq!(c.boards, Some(vec!["COPL".to_string(), "HOME".to_string()]));
    }

    #[test]
    fn reads_the_owner_token_for_the_agents_url() {
        let agent = |url: &str| {
            format!(
                "[[agent]]\nurl=\"{url}\"\nhandle=\"a\"\ntoken=\"cpl_a\"\ncommand=[\"x\"]\nworkdir=\"{}\"\n",
                tmp()
            )
        };
        let one = agent("http://x/");
        let c = parse(&one).unwrap();
        assert!(c.owner.is_none());
        assert_eq!(c.motion, None);

        let c = parse(&format!("owner_token_file = \"~/me\"\nmotion = false\n{one}")).unwrap();
        let owner = c.owner.unwrap();
        assert_eq!(owner.url, "http://x");
        assert_eq!(owner.token.expose(), "cpl_fromfile");
        assert!(owner.write.is_none());
        assert_eq!(c.motion, Some(false));

        /* The write token is the same person's, so it comes with the owner token or not at all. */
        let c = parse(&format!(
            "owner_token_file = \"~/me\"\nowner_write_token_file = \"~/me.write\"\n{one}"
        ))
        .unwrap();
        assert_eq!(c.owner.unwrap().write.unwrap().expose(), "cpl_fromfile");
        assert!(parse(&format!("owner_write_token_file = \"~/me.write\"\n{one}")).is_err());
        assert!(
            parse(&format!(
                "owner_token = \"cpl_me\"\nowner_write_token = \"cplr_x\"\n{one}"
            ))
            .is_err()
        );

        let two = format!("{one}{}", agent("http://y"));
        assert!(parse(&format!("owner_token = \"cpl_me\"\n{two}")).is_err());
        let c = parse(&format!("owner_token = \"cpl_me\"\nowner_url = \"http://y/\"\n{two}")).unwrap();
        assert_eq!(c.owner.unwrap().url, "http://y");

        assert!(parse(&format!("owner_url = \"http://x\"\n{one}")).is_err());
        assert!(parse(&format!("owner_token = \"cplr_me\"\n{one}")).is_err());
        assert!(parse(&format!("owner_token = \"cpl_me\"\nowner_token_file = \"f\"\n{one}")).is_err());
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
