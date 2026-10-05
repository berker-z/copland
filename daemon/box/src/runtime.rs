//! The runtimes setup knows how to launch, and how each one is given the
//! prompt and the run's MCP connection: one adapter per runtime, as an argv
//! template for `daemon.toml`. The daemon itself knows nothing of these; it
//! fills `{prompt}` and `{mcp_config}` (a Claude Code-shaped MCP JSON file
//! holding the run's URL and secret) into whatever `command` says.

use std::path::{Path, PathBuf};
use std::time::Duration;

use copland_daemon_core::config::{MCP_CONFIG, PROMPT};

/// How long `--version` may take before the runtime counts as broken.
const VERSION_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Runtime {
    ClaudeCode,
    Codex,
}

/// The tools the agents may use: Copland's MCP and nothing else. Kept narrow on purpose.
const COPLAND_TOOLS: [&str; 14] = [
    "guide",
    "whoami",
    "get_task",
    "list_tasks",
    "my_work",
    "inbox",
    "mark_read",
    "claim_task",
    "release_task",
    "finish_run",
    "comment_on_task",
    "move_task",
    "update_task",
    "create_task",
];

/// Claude Code's settings for a run (COPL-139): the heartbeat hook, so the run stays alive between
/// Copland calls and, given the hook's event, hears comments on its task at its next step. The same
/// hooks as Copland's own `.claude/settings.json`, which a test holds it to, so a run in that repo
/// gets them once.
const CLAUDE_SETTINGS: &str = concat!(
    r#"{"hooks":{"PostToolUse":[{"matcher":"^(?!mcp__copland__)","hooks":[{"type":"mcp_tool","server":"copland","#,
    r#""tool":"heartbeat","input":{"event":"${hook_event_name}"},"timeout":10}]}],"#,
    r#""UserPromptSubmit":[{"hooks":[{"type":"mcp_tool","server":"copland","tool":"heartbeat","#,
    r#""input":{"event":"${hook_event_name}"},"timeout":10}]}]}}"#,
);

/// Codex can't read the MCP JSON file, so a shell takes the run's secret out of it into an
/// environment variable Codex reads as the bearer token, kept from Codex's own shell commands;
/// the URL is the daemon's `COPLAND_URL`. `$1` is the prompt, `$2` the MCP config file, and
/// whatever follows goes on to `codex exec`: in a coding run, the daemon's sandbox policy
/// (COPL-143), whose `copland` profile replaces the read-only one here. Without it, as a plain
/// `command`, Codex's commands read and don't write or reach the network.
const CODEX_SCRIPT: &str = concat!(
    r#"COPLAND_RUN_SECRET=$(sed -n 's/.*"Bearer \([^"]*\)".*/\1/p' "$2") || exit 1; "#,
    r#"[ -n "$COPLAND_RUN_SECRET" ] || { echo "no run secret in $2" >&2; exit 1; }; "#,
    r#"export COPLAND_RUN_SECRET; prompt=$1; shift 2; "#,
    r#"exec codex exec --ephemeral --skip-git-repo-check --ignore-user-config "#,
    r#"-c approval_policy='"never"' "#,
    r#"-c 'permissions.copland={filesystem={":root"="read"},network={enabled=false}}' "#,
    r#"-c default_permissions='"copland"' "#,
    r#"-c "mcp_servers.copland.url=$COPLAND_URL/mcp" "#,
    r#"-c mcp_servers.copland.bearer_token_env_var=COPLAND_RUN_SECRET "#,
    r#"-c 'shell_environment_policy.exclude=["COPLAND_RUN_SECRET"]' "#,
    r#""$@" -- "$prompt""#,
);

impl Runtime {
    /// In the order setup prefers them.
    pub const ALL: [Runtime; 2] = [Runtime::ClaudeCode, Runtime::Codex];

    /// The executable looked for on PATH.
    pub fn program(self) -> &'static str {
        match self {
            Runtime::ClaudeCode => "claude",
            Runtime::Codex => "codex",
        }
    }

    /// What history says the work came through (`client` in daemon.toml).
    pub fn name(self) -> &'static str {
        match self {
            Runtime::ClaudeCode => "Claude Code",
            Runtime::Codex => "Codex",
        }
    }

    /// Where to get it, for when it's missing.
    pub fn install_hint(self) -> &'static str {
        match self {
            Runtime::ClaudeCode => "npm i -g @anthropic-ai/claude-code",
            Runtime::Codex => "npm i -g @openai/codex",
        }
    }

    /// The argv for daemon.toml: the prompt as the task, Copland's MCP as the only tools.
    pub fn command(self) -> Vec<String> {
        let s = |v: &str| v.to_string();
        match self {
            /* As in daemon/README.md: no built-in tools, only your Copland MCP, nothing asked. */
            Runtime::ClaudeCode => {
                let mut c: Vec<String> = [
                    "claude",
                    "-p",
                    PROMPT,
                    "--mcp-config",
                    MCP_CONFIG,
                    "--strict-mcp-config",
                    "--tools",
                    "",
                    "--permission-mode",
                    "dontAsk",
                    "--no-session-persistence",
                    "--settings",
                    CLAUDE_SETTINGS,
                    "--allowedTools",
                ]
                .map(s)
                .into();
                /* --allowedTools is variadic, so it stays last. */
                c.extend(COPLAND_TOOLS.iter().map(|t| format!("mcp__copland__{t}")));
                c
            }
            /* Codex has no flag for an MCP config file nor a way to take its shell away; a
            read-only profile and none of your own Codex config is the nearest to the above. A
            coding run's sandbox comes after it, from the daemon (COPL-143). */
            Runtime::Codex => vec![
                s("sh"),
                s("-c"),
                s(CODEX_SCRIPT),
                s("copland-codex"),
                s(PROMPT),
                s(MCP_CONFIG),
            ],
        }
    }
}

/// A runtime found on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub runtime: Runtime,
    pub path: PathBuf,
    /// From `--version`, when it answered in time with something that reads as one.
    pub version: Option<String>,
}

/// The first executable `program` in the PATH-style list `path`.
pub fn find_in(program: &str, path: &std::ffi::OsStr) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(path)
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.join(program))
        .find(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

/// The version number in what `--version` printed: "2.1.283 (Claude Code)", "codex-cli 0.159.2".
pub fn parse_version(out: &str) -> Option<String> {
    out.lines().next()?.split_whitespace().find_map(|word| {
        let w = word
            .trim_start_matches('v')
            .trim_matches(|c: char| c == '(' || c == ')' || c == ',');
        let mut parts = w.split('.');
        let first = parts.next()?;
        let rest: Vec<&str> = parts.collect();
        let numeric = |p: &str| !p.is_empty() && p.chars().next().is_some_and(|c| c.is_ascii_digit());
        (numeric(first)
            && first.chars().all(|c| c.is_ascii_digit())
            && !rest.is_empty()
            && rest.iter().all(|p| numeric(p)))
        .then(|| w.to_string())
    })
}

/// `program --version`, given a few seconds. Needs a Tokio runtime.
async fn version_of(path: &Path) -> Option<String> {
    let run = tokio::process::Command::new(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(VERSION_TIMEOUT, run).await.ok()?.ok()?;
    parse_version(&String::from_utf8_lossy(&out.stdout))
        .or_else(|| parse_version(&String::from_utf8_lossy(&out.stderr)))
}

/// Every runtime on PATH, in the order setup prefers them. Needs a Tokio runtime.
pub async fn detect() -> Vec<Found> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut found = Vec::new();
    for runtime in Runtime::ALL {
        if let Some(p) = find_in(runtime.program(), &path) {
            let version = version_of(&p).await;
            found.push(Found {
                runtime,
                path: p,
                version,
            });
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_versions_as_the_runtimes_print_them() {
        assert_eq!(parse_version("2.1.283 (Claude Code)\n").as_deref(), Some("2.1.283"));
        assert_eq!(parse_version("codex-cli 0.159.2").as_deref(), Some("0.159.2"));
        assert_eq!(parse_version("tool v1.2.3-beta\n").as_deref(), Some("1.2.3-beta"));
        assert_eq!(parse_version("usage: claude [options]"), None);
        assert_eq!(parse_version("build 42"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn finds_an_executable_on_a_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("copland-rt-{}", std::process::id()));
        let (a, b) = (dir.join("a"), dir.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("claude"), "").unwrap();
        std::fs::write(b.join("claude"), "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(b.join("claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(find_in("claude", &path), Some(b.join("claude")));
        assert_eq!(find_in("codex", &path), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn each_template_takes_the_prompt_and_the_mcp_config() {
        for r in Runtime::ALL {
            let c = r.command();
            assert!(c.iter().any(|a| a == PROMPT), "{r:?}");
            assert!(c.iter().any(|a| a == MCP_CONFIG), "{r:?}");
        }
        let claude = Runtime::ClaudeCode.command();
        assert_eq!(
            claude.iter().filter(|a| a.starts_with("mcp__copland__")).count(),
            COPLAND_TOOLS.len()
        );
        let at = claude.iter().position(|a| a == "--allowedTools").unwrap();
        assert!(claude[at + 1..].iter().all(|a| a.starts_with("mcp__copland__")));
    }

    /// The daemon reads each template's runtime off it, for its sandbox (COPL-141): Codex's `sh`
    /// wrapper included, by the name it gives its script.
    #[test]
    fn the_daemon_knows_each_template_for_its_runtime() {
        use copland_daemon_core::config::Runtime as Kind;
        for r in Runtime::ALL {
            let kind = match r {
                Runtime::ClaudeCode => Kind::ClaudeCode,
                Runtime::Codex => Kind::Codex,
            };
            assert_eq!(Kind::detect(&r.command()), kind, "{r:?}");
        }
    }

    /// The run's hooks are Copland's own `.claude/settings.json`, byte for byte but for spacing, so a
    /// run in that repo runs the heartbeat once, and a change to one is a change to both (COPL-139).
    #[test]
    fn claude_runs_get_the_repos_heartbeat_hook() {
        let claude = Runtime::ClaudeCode.command();
        let at = claude.iter().position(|a| a == "--settings").unwrap();
        assert_eq!(claude[at + 1], CLAUDE_SETTINGS);
        let repo =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.claude/settings.json")).unwrap();
        let bare = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        assert_eq!(bare(&repo), CLAUDE_SETTINGS);
        assert!(CLAUDE_SETTINGS.contains(r#""input":{"event":"${hook_event_name}"}"#));
    }

    #[test]
    fn the_codex_wrapper_takes_the_secret_out_of_the_mcp_config() {
        /* The script up to `exec`, run by a real shell on the daemon's own MCP JSON. */
        let json = copland_daemon_core::runner::mcp_config_json(
            "http://h",
            &copland_daemon_core::config::Secret::new("cplr_s3cret"),
        );
        let dir = std::env::temp_dir().join(format!("copland-codex-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("mcp.json");
        std::fs::write(&file, json).unwrap();
        let script = CODEX_SCRIPT.split("exec codex").next().unwrap().to_string()
            + r#"printf '%s|%s|%s' "$COPLAND_RUN_SECRET" "$prompt" "$#""#;
        let out = std::process::Command::new("sh")
            .args(["-c", &script, "copland-codex", "do it"])
            .arg(&file)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "cplr_s3cret|do it|0");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// In a coding run the daemon's Codex backend appends its sandbox policy to the template
    /// (COPL-143): the template hands it on to `codex exec` after its own read-only profile, so
    /// the backend's wins, with the prompt last. Run through a real shell with a `codex` that
    /// prints what it was given.
    #[test]
    fn the_codex_template_hands_the_daemons_sandbox_on_to_codex() {
        use copland_daemon_core::sandbox::{Backend, Codex, Writable, codex_forbidden};
        let template = Runtime::Codex.command();
        assert_eq!(
            codex_forbidden(&template),
            None,
            "the daemon would refuse it as a code_command"
        );
        let dir = std::env::temp_dir().join(format!("copland-codex-argv-{}", std::process::id()));
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let fake = bin.join("codex");
        std::fs::write(&fake, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n").unwrap();
        std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let mcp = dir.join("mcp.json");
        std::fs::write(
            &mcp,
            copland_daemon_core::runner::mcp_config_json(
                "http://h",
                &copland_daemon_core::config::Secret::new("cplr_x"),
            ),
        )
        .unwrap();
        let filled: Vec<String> = template
            .iter()
            .map(|a| a.replace(PROMPT, "do it").replace(MCP_CONFIG, &mcp.to_string_lossy()))
            .collect();
        let w = Writable {
            dirs: vec![dir.clone()],
            extra: Vec::new(),
            chdir: dir.clone(),
            tmp: None,
        };
        let argv = Codex.wrap(&filled, &w);
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        let out = std::process::Command::new(&argv[0])
            .args(&argv[1..])
            .env("PATH", path)
            .env("COPLAND_URL", "http://h")
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let got: Vec<String> = String::from_utf8_lossy(&out.stdout).lines().map(String::from).collect();
        assert_eq!(got[0], "exec");
        assert_eq!(got[got.len() - 2..], ["--".to_string(), "do it".to_string()]);
        let profiles: Vec<usize> = (0..got.len())
            .filter(|&i| got[i].starts_with("permissions.copland="))
            .collect();
        assert_eq!(profiles.len(), 2, "{got:?}");
        assert!(got[profiles[0]].contains("enabled=false"));
        assert!(got[profiles[1]].contains(&format!("{:?}=\"write\"", dir.canonicalize().unwrap())));
        let chosen = |i: usize| got[i] == "default_permissions=\"copland\"";
        assert!(
            (profiles[1]..got.len()).any(chosen),
            "the daemon's profile is chosen after it"
        );
        assert!(got.contains(&"mcp_servers.copland.url=http://h/mcp".to_string()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
