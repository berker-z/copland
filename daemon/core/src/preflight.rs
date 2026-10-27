//! Preflight (COPL-161): whether this machine can run its agents, checked before a run finds out.
//!
//! Six kinds of check, each a [`Check`] with a status, a one-line detail and, when there is a way
//! out, a [`Fix`]:
//!
//! - each runtime the agents start is on PATH and logged in (`claude auth status`, `codex login status`);
//! - git is there and has a name and an email to commit as (global or system config);
//! - git can reach GitHub over https without asking: its credential helper has a login for github.com;
//! - `code_dir` is there (or can be made), is writable, and a git worktree can be made in it;
//! - `code_dir`'s filesystem has `min_free_gb` free, and when it hasn't, what under it takes the space;
//! - each agent's token is good, and read and write (`agent::whoami`).
//!
//! Beside them, [`repo_access`] (COPL-178) says whether one board repo can be cloned and pushed
//! from here. It isn't in [`run`]: the daemon checks each repo its agents' boards have when it
//! starts and when a board names a repo it hasn't checked, and claims no coding task on one it
//! can't push to.
//!
//! [`run`] does them all; each is also a function of its own, so a front end can run one again.
//! They are async, on Tokio, and every program they start is given [`CHECK_TIMEOUT`] and killed
//! after it. Nothing they say holds a secret: the credential helper's answer is read for whether
//! it has a password and dropped. [`terminal`] is the one blocking part, offering the fixes on a
//! terminal for `copland-daemon --check --fix` and `copland-box --check --fix`.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::agent::whoami;
use crate::api::{Api, RepoCapability, RuntimeCapability};
use crate::config::{AgentConfig, Config, Runtime};
use crate::runner::locate;

/// How long any program a check starts may take before the check counts it as failed.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Status {
    Ok,
    /// Works for now, or only matters for some runs; worth a look.
    Warn,
    /// Runs will fail on it.
    Fail,
}

impl Status {
    /// ✓, ! or ✗.
    pub fn mark(self) -> &'static str {
        match self {
            Status::Ok => "✓",
            Status::Warn => "!",
            Status::Fail => "✗",
        }
    }
}

/// One step of a fix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Run this argv with the terminal handed to it: a login that opens a browser or asks things.
    Run(Vec<String>),
    /// Ask for a name and an email and set them with `git config --global user.name/user.email`.
    GitIdentity,
    /// Make this directory, with its parents.
    CreateDir(PathBuf),
}

impl Action {
    /// What it does, as a command someone could type.
    pub fn describe(&self) -> String {
        match self {
            Action::Run(argv) => argv.join(" "),
            Action::GitIdentity => "git config --global user.name …; git config --global user.email …".into(),
            Action::CreateDir(dir) => format!("mkdir -p {}", dir.display()),
        }
    }
}

/// The way out of a failing check: what to do, in words, and the steps that do it, if any can be
/// run from here (none when it takes something only a person can do elsewhere).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fix {
    pub description: String,
    pub actions: Vec<Action>,
}

impl Fix {
    fn manual(description: impl Into<String>) -> Self {
        Self {
            description: description.into(),
            actions: Vec::new(),
        }
    }

    fn runs(description: impl Into<String>, actions: Vec<Action>) -> Self {
        Self {
            description: description.into(),
            actions,
        }
    }

    /// Whether there is something to run.
    pub fn runnable(&self) -> bool {
        !self.actions.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    /// Short and stable: "claude-code", "git", "github", "code_dir", "token @me/dev".
    pub name: String,
    pub status: Status,
    /// One line, no secrets.
    pub detail: String,
    pub fix: Option<Fix>,
}

impl Check {
    fn new(name: impl Into<String>, status: Status, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status,
            detail: detail.into(),
            fix: None,
        }
    }

    fn ok(name: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(name, Status::Ok, detail)
    }

    fn warn(name: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(name, Status::Warn, detail)
    }

    fn fail(name: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(name, Status::Fail, detail)
    }

    fn with_fix(mut self, fix: Fix) -> Self {
        self.fix = Some(fix);
        self
    }

    /// "✓ git  git 2.56.0, commits as …", the name padded to `width`.
    pub fn line(&self, width: usize) -> String {
        format!("{} {:width$}  {}", self.status.mark(), self.name, self.detail)
    }
}

/// The worst status among them; Ok for none.
pub fn worst(checks: &[Check]) -> Status {
    checks.iter().map(|c| c.status).max().unwrap_or(Status::Ok)
}

/// How many failed.
pub fn failures(checks: &[Check]) -> usize {
    checks.iter().filter(|c| c.status == Status::Fail).count()
}

/// One line per check, and under each that isn't ok, its fix.
pub fn render(checks: &[Check]) -> String {
    let width = checks.iter().map(|c| c.name.chars().count()).max().unwrap_or(0);
    let mut out = String::new();
    for c in checks {
        out.push_str(&c.line(width));
        out.push('\n');
        if let (Some(fix), true) = (&c.fix, c.status != Status::Ok) {
            let pad = " ".repeat(width + 4);
            out.push_str(&format!("{pad}fix: {}\n", fix.description));
            for a in &fix.actions {
                out.push_str(&format!("{pad}  $ {}\n", a.describe()));
            }
        }
    }
    out
}

/// Every check, for every agent in the config: runtimes, git, GitHub, code_dir, disk, tokens, in
/// that order. With no agent that has a `code_command`, nothing clones or commits, so the git, GitHub
/// and code_dir checks only warn.
pub async fn run(config: &Config) -> Vec<Check> {
    let coding = config.agents.iter().any(|a| a.code_command.is_some());
    let (runtimes, git, github, code, space, tokens) = tokio::join!(
        runtimes(&config.agents),
        git_identity(),
        github(),
        code_dir(&config.code_dir),
        disk(&config.code_dir, config.min_free_gb),
        async {
            let mut out = Vec::new();
            for a in &config.agents {
                out.push(token(a).await);
            }
            out
        },
    );
    let mut checks = runtimes;
    for mut c in [git, github, code] {
        if !coding && c.status == Status::Fail {
            c.status = Status::Warn;
            c.detail
                .push_str(" (no agent has a code_command, so nothing needs it yet)");
        }
        checks.push(c);
    }
    checks.push(space);
    checks.extend(tokens);
    checks
}

/// The runtimes the agents start, once each however many agents share one: `command`'s, and
/// `code_command`'s when there is one.
pub async fn runtimes(agents: &[AgentConfig]) -> Vec<Check> {
    let mut seen: Vec<(Runtime, String, Vec<String>, Vec<String>)> = Vec::new();
    for a in agents {
        for (runtime, argv) in uses(a) {
            let program = program_of(&runtime, &argv);
            match seen.iter_mut().find(|(r, p, ..)| *r == runtime && *p == program) {
                Some((.., handles)) => {
                    if !handles.contains(&a.handle) {
                        handles.push(a.handle.clone());
                    }
                }
                None => seen.push((runtime, program, argv, vec![a.handle.clone()])),
            }
        }
    }
    let mut out = Vec::new();
    for (runtime, _, argv, handles) in seen {
        let mut c = self::runtime(&runtime, &argv).await;
        let who: Vec<String> = handles.iter().map(|h| format!("@{h}")).collect();
        c.detail.push_str(&format!(" (for {})", who.join(", ")));
        out.push(c);
    }
    out
}

/// The runtimes an agent starts, with the argv each starts with: `command`'s, and `code_command`'s
/// when there is one.
fn uses(a: &AgentConfig) -> Vec<(Runtime, Vec<String>)> {
    match &a.code_command {
        Some(code) => vec![
            (Runtime::detect(&a.command), a.command.clone()),
            (a.runtime.clone(), code.clone()),
        ],
        None => vec![(a.runtime.clone(), a.command.clone())],
    }
}

/// The programs runs start, each once: every agent's runtimes, as `runtimes` looks for them, then
/// git, gh and (on Linux) bubblewrap.
pub fn programs(agents: &[AgentConfig]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let tools = ["git", "gh"].into_iter().map(String::from);
    let bwrap = cfg!(target_os = "linux").then(|| crate::sandbox::BWRAP.to_string());
    let all = agents
        .iter()
        .flat_map(uses)
        .map(|(r, argv)| program_of(&r, &argv))
        .chain(tools)
        .chain(bwrap);
    for p in all {
        if !p.is_empty() && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// Where each program was found (COPL-216), or that it wasn't, under the PATH it was looked up on.
pub fn render_found(path: &str, found: &[(String, Option<PathBuf>)]) -> String {
    let width = found.iter().map(|(p, _)| p.chars().count()).max().unwrap_or(0);
    let mut out = format!("PATH: {path}\n");
    for (program, at) in found {
        let at = at.as_ref().map_or("not found".to_string(), |p| p.display().to_string());
        out.push_str(&format!("  {program:<width$}  {at}\n"));
    }
    out
}

/// `render_found` for `programs`, on this process's PATH.
pub fn found_on_path(agents: &[AgentConfig]) -> String {
    let found: Vec<_> = programs(agents)
        .into_iter()
        .map(|p| {
            let at = locate(&p);
            (p, at)
        })
        .collect();
    let path = std::env::var("PATH").unwrap_or_default();
    render_found(&path, &found)
}

/// What an agent's daemon reports of its runtimes (COPL-179): the checks `runtimes` makes, for this
/// agent's, once each, by name. A runtime not known here is logged in as far as anyone can tell.
pub async fn runtime_capabilities(agent: &AgentConfig) -> Vec<RuntimeCapability> {
    let mut out: Vec<RuntimeCapability> = Vec::new();
    for (runtime, argv) in uses(agent) {
        let check = self::runtime(&runtime, &argv).await;
        if out.iter().any(|r| r.name == check.name) {
            continue;
        }
        let on_path = locate(&program_of(&runtime, &argv)).is_some();
        out.push(RuntimeCapability {
            name: check.name,
            on_path,
            logged_in: on_path && check.status == Status::Ok,
        });
    }
    out
}

/// The program to look for: the runtime's own (`claude`, `codex`), as the argv names it when it
/// starts it directly (a path stays a path), else argv's program for a runtime not known here.
fn program_of(runtime: &Runtime, argv: &[String]) -> String {
    let first = argv.first().cloned().unwrap_or_default();
    let own = match runtime {
        Runtime::ClaudeCode => "claude",
        Runtime::Codex => "codex",
        Runtime::Unknown(_) => return first,
    };
    if Path::new(&first).file_name() == Some(OsStr::new(own)) {
        first
    } else {
        own.to_string()
    }
}

/// One runtime: found where, and logged in. A runtime not known here is only looked for.
pub async fn runtime(runtime: &Runtime, argv: &[String]) -> Check {
    let name = match runtime {
        Runtime::Unknown(n) if n.is_empty() => "runtime".to_string(),
        r => r.name().to_string(),
    };
    let program = program_of(runtime, argv);
    let Some(path) = locate(&program) else {
        let install = match runtime {
            Runtime::ClaudeCode => "install Claude Code (npm i -g @anthropic-ai/claude-code)".to_string(),
            Runtime::Codex => "install Codex (npm i -g @openai/codex)".to_string(),
            Runtime::Unknown(_) => format!("install {program}"),
        };
        return Check::fail(name, format!("{program} not found on PATH")).with_fix(Fix::manual(format!(
            "{install} on the PATH above (your login shell's is on it), then restart the daemon"
        )));
    };
    let at = path.display().to_string();
    match runtime {
        Runtime::ClaudeCode => match output(&path, &["auth", "status"], &[], None).await {
            Ok(out) => match claude_status(&out.stdout, out.success) {
                Ok(method) => Check::ok(name, format!("{at}, logged in{}", via(method))),
                Err(why) => Check::fail(name, format!("{at}: {why}")).with_fix(login(
                    "Claude Code",
                    &program,
                    &["auth", "login"],
                )),
            },
            Err(e) => Check::fail(name, format!("{at}: `claude auth status` {e}")),
        },
        Runtime::Codex => match output(&path, &["login", "status"], &[], None).await {
            Ok(out) if out.success => Check::ok(
                name,
                format!("{at}, logged in{}", via(codex_method(&out.stdout, &out.stderr))),
            ),
            Ok(_) => Check::fail(name, format!("{at}: not logged in")).with_fix(login("Codex", &program, &["login"])),
            Err(e) => Check::fail(name, format!("{at}: `codex login status` {e}")),
        },
        Runtime::Unknown(_) => Check::ok(
            name,
            format!("{at} (a runtime Copland doesn't know: login not checked)"),
        ),
    }
}

fn via(method: Option<String>) -> String {
    method.map(|m| format!(" with {m}")).unwrap_or_default()
}

fn login(what: &str, program: &str, args: &[&str]) -> Fix {
    let mut argv = vec![program.to_string()];
    argv.extend(args.iter().map(|a| a.to_string()));
    Fix::runs(format!("log in to {what}"), vec![Action::Run(argv)])
}

/// `claude auth status`'s answer: JSON with `"loggedIn": true`, and exit 0. Ok with how
/// (`authMethod`, "claude.ai"), else why not. Reads nothing else: the email and org stay unsaid.
pub fn claude_status(stdout: &str, success: bool) -> Result<Option<String>, String> {
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|_| "`claude auth status` didn't answer in JSON (too old?)".to_string())?;
    let logged_in = value.get("loggedIn").and_then(|v| v.as_bool()).unwrap_or(false);
    if !logged_in || !success {
        return Err("not logged in".into());
    }
    Ok(value
        .get("authMethod")
        .and_then(|v| v.as_str())
        .filter(|m| !m.is_empty() && m.len() < 40)
        .map(str::to_string))
}

/// How `codex login status` says it is logged in: "ChatGPT" or "an API key". Nothing else of what
/// it said is kept (with a key it prints part of it).
pub fn codex_method(stdout: &str, stderr: &str) -> Option<String> {
    let said = format!("{stdout}\n{stderr}");
    if said.contains("ChatGPT") {
        Some("ChatGPT".into())
    } else if said.contains("API key") {
        Some("an API key".into())
    } else {
        None
    }
}

/// git is there and has a name and an email in its global or system config.
pub async fn git_identity() -> Check {
    git_identity_in(&[]).await
}

/// `git_identity` with environment overrides (a test's `GIT_CONFIG_GLOBAL`).
async fn git_identity_in(env: &[(&str, &OsStr)]) -> Check {
    let Some(git) = locate("git") else {
        return Check::fail("git", "git not found on PATH")
            .with_fix(Fix::manual("install git (2.5 or newer) from your package manager"));
    };
    let version = match output(&git, &["--version"], env, None).await {
        Ok(out) if out.success => out.stdout.trim().to_string(),
        Ok(out) => return Check::fail("git", format!("`git --version`: {}", first_line(&out.stderr))),
        Err(e) => return Check::fail("git", format!("`git --version` {e}")),
    };
    let mut found = Vec::new();
    for key in ["user.name", "user.email"] {
        let mut value = None;
        for scope in ["--global", "--system"] {
            if let Ok(out) = output(&git, &["config", scope, "--get", key], env, None).await {
                let v = out.stdout.trim();
                if out.success && !v.is_empty() {
                    value = Some(v.to_string());
                    break;
                }
            }
        }
        found.push(value);
    }
    match (&found[0], &found[1]) {
        (Some(name), Some(email)) => Check::ok("git", format!("{version}, commits as {name} <{email}>")),
        (name, email) => {
            let missing: Vec<&str> = [("user.name", name), ("user.email", email)]
                .iter()
                .filter(|(_, v)| v.is_none())
                .map(|(k, _)| *k)
                .collect();
            Check::fail(
                "git",
                format!("{version}, but no {} to commit as", missing.join(" or ")),
            )
            .with_fix(Fix::runs(
                "tell git who commits: your name and email, in your global git config",
                vec![Action::GitIdentity],
            ))
        }
    }
}

/// git reaches GitHub over https without asking: its credential helper hands over a login for
/// github.com. Asked the way a push would (`git credential fill`), with prompts off, so what it
/// says is what a run's push gets. `gh auth status` alone wouldn't do: gh can be logged in with
/// git not using it, and another helper (libsecret, osxkeychain) can hold the login without gh.
pub async fn github() -> Check {
    github_in(&[]).await
}

async fn github_in(env: &[(&str, &OsStr)]) -> Check {
    let Some(git) = locate("git") else {
        return Check::fail("github", "git not found on PATH");
    };
    let mut env: Vec<(&str, &OsStr)> = env.to_vec();
    env.extend([
        ("GIT_TERMINAL_PROMPT", OsStr::new("0")),
        /* Empty, so no askpass program is tried either (git takes an empty one as none). */
        ("GIT_ASKPASS", OsStr::new("")),
    ]);
    let asked = output(
        &git,
        &["-c", "credential.interactive=false", "credential", "fill"],
        &env,
        Some("protocol=https\nhost=github.com\n\n"),
    )
    .await;
    let failed = |detail: String| Check::fail("github", detail).with_fix(github_fix());
    match asked {
        Ok(out) => match credential_login(&out.stdout, out.success) {
            Some(user) => Check::ok(
                "github",
                match user {
                    Some(u) => format!("git's credential helper has a github.com login ({u})"),
                    None => "git's credential helper has a github.com login".into(),
                },
            ),
            None => failed(format!(
                "git has no login for github.com: {}",
                first_line(&out.stderr).trim_start_matches("fatal: ")
            )),
        },
        Err(e) => failed(format!("`git credential fill` {e}")),
    }
}

/// Whether `git credential fill` gave a password, and for whom. Only the username leaves here.
fn credential_login(stdout: &str, success: bool) -> Option<Option<String>> {
    if !success {
        return None;
    }
    let mut user = None;
    let mut password = false;
    for line in stdout.lines() {
        if let Some(u) = line.strip_prefix("username=") {
            user = Some(u.to_string()).filter(|u| !u.is_empty());
        } else if let Some(p) = line.strip_prefix("password=") {
            password = !p.is_empty();
        }
    }
    password.then_some(user)
}

fn github_fix() -> Fix {
    let Some(gh) = locate("gh") else {
        return Fix::manual(
            "install GitHub's CLI (gh: https://cli.github.com, or your package manager), then run \
             `gh auth login` and `gh auth setup-git`; any other git credential helper with a github.com login works too",
        );
    };
    let gh = gh.display().to_string();
    let run = |args: &[&str]| {
        let mut argv = vec![gh.clone()];
        argv.extend(args.iter().map(|a| a.to_string()));
        Action::Run(argv)
    };
    Fix::runs(
        "log in to GitHub with gh, and make gh git's credential helper",
        vec![
            run(&["auth", "login", "--hostname", "github.com", "--git-protocol", "https"]),
            run(&["auth", "setup-git"]),
        ],
    )
}

/// The branch a push check names, which its dry run never makes.
const PUSH_CHECK_REF: &str = "refs/heads/copland-push-check";

/// Whether this machine can clone and push one board repo (COPL-178), the way a coding run would:
/// `git ls-remote` for clone, and for push a dry push of a throwaway commit to a branch that is
/// never made (`--dry-run` connects as a push does, so a remote that would refuse it says so, and
/// sends nothing). The same for GitHub and a plain remote. Prompts are off and every git gets
/// [`CHECK_TIMEOUT`]; a remote's or git's words have any login in a URL taken out. `repo` is the
/// name shown ("owner/name"), `remote` what is cloned.
pub async fn repo_access(repo: &str, remote: &str) -> RepoCapability {
    repo_access_in(repo, remote, &[]).await
}

async fn repo_access_in(repo: &str, remote: &str, env: &[(&str, &OsStr)]) -> RepoCapability {
    let failed = |clone: bool, detail: String| RepoCapability {
        repo: repo.to_string(),
        clone,
        push: false,
        detail: Some(scrub(&detail)),
    };
    let Some(git) = locate("git") else {
        return failed(false, "git not found on PATH".into());
    };
    let mut env: Vec<(&str, &OsStr)> = env.to_vec();
    env.extend([
        ("GIT_TERMINAL_PROMPT", OsStr::new("0")),
        ("GIT_ASKPASS", OsStr::new("")),
    ]);
    let quiet = ["-c", "credential.interactive=false"];
    let listed = output(
        &git,
        &[&quiet[..], &["ls-remote", "--quiet", remote, "HEAD"]].concat(),
        &env,
        None,
    )
    .await;
    if let Some(why) = refused(listed) {
        return failed(false, format!("can't clone: {why}"));
    }
    let scratch = match scratch_commit(&git).await {
        Ok(s) => s,
        Err(e) => return failed(true, format!("clones, but its push couldn't be checked: {e}")),
    };
    let dir = scratch.0.to_string_lossy();
    let refspec = format!("HEAD:{PUSH_CHECK_REF}");
    let push = [
        &quiet[..],
        &[
            "-C",
            &dir,
            "push",
            "--dry-run",
            "--quiet",
            "--no-verify",
            remote,
            &refspec,
        ],
    ]
    .concat();
    match refused(output(&git, &push, &env, None).await) {
        Some(why) => failed(true, format!("clones, but can't push: {why}")),
        None => RepoCapability {
            repo: repo.to_string(),
            clone: true,
            push: true,
            detail: None,
        },
    }
}

/// Why a git command didn't do it, None when it did.
fn refused(out: Result<Output, String>) -> Option<String> {
    match out {
        Ok(out) if out.success => None,
        Ok(out) => Some(git_reason(&out.stderr)),
        Err(e) => Some(format!("git {e}")),
    }
}

/// What git said went wrong, in a line: the remote's own words when it gave some ("Permission to
/// o/r.git denied to me."), else git's last fatal or error line, without its prefix.
fn git_reason(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let said = lines
        .iter()
        .find_map(|l| l.strip_prefix("remote: ").map(str::trim).filter(|l| !l.is_empty()))
        .or_else(|| {
            lines
                .iter()
                .rev()
                .find_map(|l| l.strip_prefix("fatal: ").or_else(|| l.strip_prefix("error: ")))
        })
        .or_else(|| lines.last().copied())
        .unwrap_or("no reason given");
    said.chars().take(200).collect()
}

/// `text` with the login taken out of any URL in it: `https://me:token@host/` → `https://host/`.
pub fn scrub(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let (head, tail) = rest.split_at(at + 3);
        out.push_str(head);
        let end = tail.find(|c: char| c == '/' || c.is_whitespace()).unwrap_or(tail.len());
        rest = match tail[..end].rfind('@') {
            Some(login) => &tail[login + 1..],
            None => tail,
        };
    }
    out.push_str(rest);
    out
}

/// A repo with one empty commit in the temp dir, removed when dropped: what a push check pushes.
async fn scratch_commit(git: &Path) -> Result<Scratch, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let scratch = Scratch(std::env::temp_dir().join(format!("copland-push-check-{}-{nanos}", std::process::id())));
    let dir = scratch.0.to_string_lossy().into_owned();
    let steps: [&[&str]; 2] = [
        &["init", "--quiet", &dir],
        &[
            "-c",
            "user.name=copland",
            "-c",
            "user.email=copland@localhost",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
            &dir,
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "copland push check",
        ],
    ];
    for args in steps {
        if let Some(why) = refused(output(git, args, &[], None).await) {
            return Err(why);
        }
    }
    Ok(scratch)
}

/// The code directory is there, writable, and takes a git worktree: a throwaway repo and a
/// worktree of it, made in a temp dir inside it and removed.
pub async fn code_dir(dir: &Path) -> Check {
    let shown = dir.display().to_string();
    if dir.is_dir() {
        return match worktree_probe(dir).await {
            Ok(()) => Check::ok("code_dir", format!("{shown}: writable, and git worktrees work there")),
            Err(e) => Check::fail("code_dir", format!("{shown}: {e}")),
        };
    }
    if dir.exists() {
        return Check::fail("code_dir", format!("{shown} is there but isn't a directory")).with_fix(Fix::manual(
            "move it out of the way, or set code_dir in daemon.toml to a directory",
        ));
    }
    let ancestor = dir.ancestors().skip(1).find(|a| a.exists());
    match ancestor {
        Some(a) if a.is_dir() && writable(a) => Check::warn("code_dir", format!("{shown} isn't there yet"))
            .with_fix(Fix::runs("make it", vec![Action::CreateDir(dir.to_path_buf())])),
        Some(a) => Check::fail(
            "code_dir",
            format!("{shown} isn't there and can't be made: {} isn't writable", a.display()),
        )
        .with_fix(Fix::manual("set code_dir in daemon.toml to a directory you can write")),
        None => Check::fail("code_dir", format!("{shown} isn't there and can't be made")),
    }
}

/// A GB, as disks are sold and `df -H` counts.
const GB: u64 = 1_000_000_000;
/// How many of the biggest things under `code_dir` a disk warning names.
const USAGE_SHOWN: usize = 5;

/// `code_dir`'s filesystem has at least `min_gb` GB free (COPL-187): a coding run's worktree and
/// build output take gigabytes, and a full disk fails it halfway. Below that it warns, naming the
/// biggest things under `code_dir`. Measured where `code_dir` would be made when it isn't there yet.
pub async fn disk(dir: &Path, min_gb: u64) -> Check {
    let Some(there) = dir.ancestors().find(|a| a.exists()) else {
        return Check::warn("disk", format!("{} isn't there to measure", dir.display()));
    };
    let free = match free_bytes(there) {
        Ok(free) => free,
        Err(e) => {
            return Check::warn(
                "disk",
                format!("can't tell how much is free on {}: {e}", there.display()),
            );
        }
    };
    if free >= min_gb.saturating_mul(GB) {
        return disk_check(free, min_gb, None);
    }
    let root = dir.to_path_buf();
    let usage = tokio::time::timeout(CHECK_TIMEOUT, tokio::task::spawn_blocking(move || usage(&root)))
        .await
        .ok()
        .and_then(Result::ok);
    disk_check(free, min_gb, Some(usage))
}

/// The disk check from what was measured: `usage` is None when there's enough free, Some(None)
/// when what's under `code_dir` took too long to add up.
fn disk_check(free: u64, min_gb: u64, usage: Option<Option<Vec<(String, u64)>>>) -> Check {
    let said = format!("{} free", gb(free));
    let Some(usage) = usage else {
        return Check::ok("disk", format!("{said}, of the {min_gb} GB wanted"));
    };
    let under = match usage {
        Some(u) if u.is_empty() => "nothing of it is under code_dir".to_string(),
        Some(u) => {
            let named: Vec<String> = u
                .iter()
                .take(USAGE_SHOWN)
                .map(|(name, bytes)| format!("{name} {}", gb(*bytes)))
                .collect();
            format!("code_dir has {}", named.join(", "))
        }
        None => "code_dir took too long to measure".to_string(),
    };
    Check::warn("disk", format!("{said}, under the {min_gb} GB wanted; {under}")).with_fix(Fix::manual(
        "free some space: a closed task's worktree goes by itself, and build/ (shared build output) can be \
         removed while no run builds, at the price of compiling again; or lower min_free_gb in daemon.toml",
    ))
}

/// "12.3 GB".
fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / GB as f64)
}

/// Bytes free to an unprivileged user on the filesystem holding `path`.
fn free_bytes(path: &Path) -> std::io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    // SAFETY: a zeroed statvfs is a valid out-parameter, and the path is NUL-terminated for the call.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
}

/// What takes the space under `code_dir`, biggest first: each task's worktree (`work/COPL-12`),
/// the clones (`repos`) and the shared build output (`build`) each as a whole, and anything else
/// at its top level by name. Empty ones are left out.
fn usage(code_dir: &Path) -> Vec<(String, u64)> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(code_dir) else {
        return out;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let path = e.path();
        if name == "work" && path.is_dir() && !path.is_symlink() {
            for w in std::fs::read_dir(&path).into_iter().flatten().flatten() {
                let size = du(&w.path(), &mut seen);
                out.push((format!("work/{}", w.file_name().to_string_lossy()), size));
            }
        } else {
            out.push((name, du(&path, &mut seen)));
        }
    }
    out.retain(|(_, size)| *size > 0);
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out
}

/// What `path` takes on disk, as `du` counts it: blocks, not lengths, without following symlinks,
/// and a file with hard links (cargo's `deps/` and the binaries beside them) once.
fn du(path: &Path, seen: &mut std::collections::HashSet<(u64, u64)>) -> u64 {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = path.symlink_metadata() else {
        return 0;
    };
    if meta.nlink() > 1 && !meta.is_dir() && !seen.insert((meta.dev(), meta.ino())) {
        return 0;
    }
    let mut size = meta.blocks().saturating_mul(512);
    if meta.is_dir() {
        for e in std::fs::read_dir(path).into_iter().flatten().flatten() {
            size = size.saturating_add(du(&e.path(), seen));
        }
    }
    size
}

fn writable(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: a NUL-terminated path that lives for the call.
    unsafe { libc::access(c.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
}

/// Removed, with what is in it, when dropped.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Make a repo with one commit in a temp dir under `dir`, and a worktree of it beside it. The
/// commit is made with an identity and settings of its own (no signing, no hooks), so it tests the
/// directory and git's worktrees, not the user's config.
async fn worktree_probe(dir: &Path) -> Result<(), String> {
    let git = locate("git").ok_or("git not found on PATH")?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let scratch = Scratch(dir.join(format!(".copland-check-{}-{nanos}", std::process::id())));
    std::fs::create_dir(&scratch.0).map_err(|e| format!("can't write here: {e}"))?;
    let repo = scratch.0.join("repo");
    let tree = scratch.0.join("tree");
    let (repo_s, tree_s) = (repo.to_string_lossy(), tree.to_string_lossy());
    let own = [
        "-c",
        "user.name=copland",
        "-c",
        "user.email=copland@localhost",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
    ];
    let steps: [Vec<&str>; 3] = [
        vec!["init", "--quiet", &repo_s],
        [
            &own[..],
            &[
                "-C",
                &repo_s,
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "copland check",
            ],
        ]
        .concat(),
        [
            &own[..],
            &[
                "-C",
                &repo_s,
                "worktree",
                "add",
                "--quiet",
                "-b",
                "copland-check",
                &tree_s,
            ],
        ]
        .concat(),
    ];
    for args in &steps {
        let out = output(&git, args, &[("GIT_TERMINAL_PROMPT", OsStr::new("0"))], None).await?;
        if !out.success {
            let step = args
                .iter()
                .find(|a| ["init", "commit", "worktree"].contains(a))
                .unwrap_or(&"git");
            return Err(format!("`git {step}` failed: {}", first_line(&out.stderr)));
        }
    }
    if !tree.join(".git").is_file() {
        return Err("git made no worktree".into());
    }
    Ok(())
}

/// The agent's token is good, and read and write (`whoami`).
pub async fn token(agent: &AgentConfig) -> Check {
    let name = format!("token @{}", agent.handle);
    let fix = || {
        Fix::manual(
            "run `copland-daemon --setup` (or `copland-box --setup`) to approve this machine again (or make a read and write token on the \
             agent's page in Copland's settings and put it in its token_file)",
        )
    };
    let api = match Api::new(&agent.url) {
        Ok(api) => api,
        Err(e) => return Check::fail(name, format!("{e:#}")),
    };
    match whoami(&api, agent).await {
        Ok(me) => Check::ok(
            name,
            format!(
                "@{} ({}) on {}, read and write",
                me.user.handle, me.user.kind, agent.url
            ),
        ),
        Err(e) => Check::fail(name, format!("{} on {}: {e:#}", agent.handle, agent.url)).with_fix(fix()),
    }
}

/// What a program said: whether it exited 0, and its output.
struct Output {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Run `program` with `args`, `env` on top of ours and `input` on its stdin (else none), for at
/// most CHECK_TIMEOUT. Err says why it couldn't be asked: "couldn't start: …", "took longer than 10s".
async fn output(program: &Path, args: &[&str], env: &[(&str, &OsStr)], input: Option<&str>) -> Result<Output, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .envs(env.iter().copied())
        .stdin(if input.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let ask = async {
        let mut child = cmd.spawn().map_err(|e| format!("couldn't start: {e}"))?;
        if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
            let _ = stdin.write_all(text.as_bytes()).await;
        }
        child.wait_with_output().await.map_err(|e| e.to_string())
    };
    let out = tokio::time::timeout(CHECK_TIMEOUT, ask)
        .await
        .map_err(|_| format!("took longer than {}s", CHECK_TIMEOUT.as_secs()))??;
    Ok(Output {
        success: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// The first line that says something, cut to a line's length.
fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("no reason given");
    line.chars().take(200).collect()
}

/// Offering the fixes on a terminal, for `copland-daemon --check --fix` and `copland-box --check --fix`. Blocking: it reads stdin and
/// hands the terminal to what it runs, so call it from no async task (or in `spawn_blocking`).
pub mod terminal {
    use std::io::{self, BufRead, Write};
    use std::process::Command;

    use super::{Action, Check, Status};

    /// For each check that isn't ok and has a fix to run, ask y/N and on yes run it. How many ran
    /// through. A step that fails says so and ends that fix.
    pub fn offer_fixes(checks: &[Check]) -> io::Result<usize> {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        let mut done = 0;
        for c in checks {
            let Some(fix) = c.fix.as_ref().filter(|f| f.runnable() && c.status != Status::Ok) else {
                continue;
            };
            println!("\n{} {}: {}", c.status.mark(), c.name, c.detail);
            println!("  fix: {}", fix.description);
            for a in &fix.actions {
                println!("    $ {}", a.describe());
            }
            if !ask(&mut input, "  run it? [y/N] ")?.eq_ignore_ascii_case("y") {
                continue;
            }
            let mut ok = true;
            for a in &fix.actions {
                if let Err(e) = apply(a, &mut input) {
                    println!("  {} {}: {e}", Status::Fail.mark(), a.describe());
                    ok = false;
                    break;
                }
            }
            if ok {
                done += 1;
            }
        }
        Ok(done)
    }

    /// Print `prompt`, read a line; "" at the end of input.
    fn ask(input: &mut impl BufRead, prompt: &str) -> io::Result<String> {
        print!("{prompt}");
        io::stdout().flush()?;
        let mut line = String::new();
        input.read_line(&mut line)?;
        Ok(line.trim().to_string())
    }

    fn apply(action: &Action, input: &mut impl BufRead) -> Result<(), String> {
        match action {
            Action::Run(argv) => run(argv),
            Action::CreateDir(dir) => std::fs::create_dir_all(dir).map_err(|e| e.to_string()),
            Action::GitIdentity => {
                for (key, what) in [("user.name", "your name"), ("user.email", "your email")] {
                    let value = ask(input, &format!("  {what} for git commits ({key}, empty to leave it): "))
                        .map_err(|e| e.to_string())?;
                    if !value.is_empty() {
                        run(&["git".into(), "config".into(), "--global".into(), key.into(), value])?;
                    }
                }
                Ok(())
            }
        }
    }

    /// Run with the terminal inherited; Err unless it exits 0.
    fn run(argv: &[String]) -> Result<(), String> {
        let (program, args) = argv.split_first().ok_or("nothing to run")?;
        let status = Command::new(program).args(args).status().map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("exit {}", status.code().unwrap_or(-1)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("copland-preflight-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    #[test]
    fn reads_claudes_auth_status() {
        let yes = r#"{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.c", "orgId": "x"}"#;
        assert_eq!(claude_status(yes, true), Ok(Some("claude.ai".into())));
        assert_eq!(claude_status(r#"{"loggedIn": true}"#, true), Ok(None));
        assert_eq!(claude_status(yes, false), Err("not logged in".into()));
        assert_eq!(
            claude_status(r#"{"loggedIn": false, "authMethod": "none"}"#, false),
            Err("not logged in".into())
        );
        assert!(
            claude_status("Usage: claude [options]", true)
                .unwrap_err()
                .contains("JSON")
        );
    }

    #[test]
    fn says_how_codex_is_logged_in_and_nothing_else() {
        assert_eq!(
            codex_method("", "Logged in using ChatGPT\n").as_deref(),
            Some("ChatGPT")
        );
        let key = codex_method("Logged in using an API key - sk-proj-***abcd", "");
        assert_eq!(key.as_deref(), Some("an API key"));
        assert_eq!(codex_method("ok", ""), None);
    }

    #[test]
    fn a_credential_counts_only_with_a_password() {
        let full = "protocol=https\nhost=github.com\nusername=me\npassword=gho_secret\n";
        assert_eq!(credential_login(full, true), Some(Some("me".into())));
        assert_eq!(credential_login("password=x\n", true), Some(None));
        assert_eq!(credential_login("username=me\npassword=\n", true), None);
        assert_eq!(credential_login(full, false), None);
    }

    #[test]
    fn the_worst_status_and_the_failures_decide() {
        let checks = vec![
            Check::ok("a", "fine"),
            Check::warn("b", "hm"),
            Check::fail("long-name", "no").with_fix(Fix::runs("do it", vec![Action::CreateDir("/x/y".into())])),
        ];
        assert_eq!(worst(&checks), Status::Fail);
        assert_eq!(failures(&checks), 1);
        assert_eq!(worst(&checks[..2]), Status::Warn);
        assert_eq!(worst(&[]), Status::Ok);
        assert_eq!(failures(&checks[..2]), 0);
        let text = render(&checks);
        assert_eq!(
            text,
            "✓ a          fine\n! b          hm\n✗ long-name  no\n             fix: do it\n               $ mkdir -p /x/y\n"
        );
        /* A fix on a check that passed isn't shown. */
        let passed = Check::ok("a", "fine").with_fix(Fix::manual("x"));
        assert_eq!(render(&[passed]), "✓ a  fine\n");
    }

    #[test]
    fn says_where_each_program_was_found_and_on_which_path() {
        let found = [
            ("claude".to_string(), Some(PathBuf::from("/home/me/.local/bin/claude"))),
            ("droid".to_string(), None),
            ("git".to_string(), Some(PathBuf::from("/usr/bin/git"))),
        ];
        assert_eq!(
            render_found("/home/me/.local/bin:/usr/bin", &found),
            "PATH: /home/me/.local/bin:/usr/bin\n  claude  /home/me/.local/bin/claude\n  \
             droid   not found\n  git     /usr/bin/git\n"
        );
    }

    #[test]
    fn looks_for_the_runtimes_own_program() {
        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(program_of(&Runtime::ClaudeCode, &argv(&["claude", "-p"])), "claude");
        assert_eq!(
            program_of(&Runtime::ClaudeCode, &argv(&["/opt/bin/claude"])),
            "/opt/bin/claude"
        );
        assert_eq!(
            program_of(&Runtime::Codex, &argv(&["sh", "-c", "exec codex", "copland-codex"])),
            "codex"
        );
        assert_eq!(
            program_of(&Runtime::Unknown("hermes".into()), &argv(&["hermes", "run"])),
            "hermes"
        );
    }

    /// Against a config of the test's own: no name and email fails with the fix that asks for
    /// them; both, in the global file, pass.
    #[tokio::test]
    async fn git_identity_comes_from_the_global_config() {
        let dir = scratch("identity");
        let global = dir.0.join("gitconfig");
        std::fs::write(&global, "").unwrap();
        let env = [
            ("HOME", dir.0.as_os_str()),
            ("GIT_CONFIG_GLOBAL", global.as_os_str()),
            ("GIT_CONFIG_SYSTEM", OsStr::new("/dev/null")),
            ("GIT_CONFIG_NOSYSTEM", OsStr::new("1")),
        ];
        let none = git_identity_in(&env).await;
        assert_eq!(none.status, Status::Fail, "{none:?}");
        assert!(none.detail.contains("no user.name or user.email"), "{}", none.detail);
        assert_eq!(none.fix.unwrap().actions, vec![Action::GitIdentity]);

        std::fs::write(&global, "[user]\n\tname = Ada\n").unwrap();
        let half = git_identity_in(&env).await;
        assert!(half.detail.contains("no user.email"), "{}", half.detail);

        std::fs::write(&global, "[user]\n\tname = Ada\n\temail = ada@example.com\n").unwrap();
        let both = git_identity_in(&env).await;
        assert_eq!(both.status, Status::Ok, "{both:?}");
        assert!(
            both.detail.ends_with("commits as Ada <ada@example.com>"),
            "{}",
            both.detail
        );
    }

    /// With a credential helper that knows nothing and prompts off, GitHub fails without waiting
    /// on anyone; with one that answers, it passes and shows the username alone.
    #[tokio::test]
    async fn github_asks_the_credential_helper_without_prompting() {
        let dir = scratch("github");
        let global = dir.0.join("gitconfig");
        let env = [
            ("HOME", dir.0.as_os_str()),
            ("GIT_CONFIG_GLOBAL", global.as_os_str()),
            ("GIT_CONFIG_SYSTEM", OsStr::new("/dev/null")),
            ("GIT_CONFIG_NOSYSTEM", OsStr::new("1")),
            ("SSH_ASKPASS", OsStr::new("")),
        ];
        std::fs::write(&global, "").unwrap();
        let none = github_in(&env).await;
        assert_eq!(none.status, Status::Fail, "{none:?}");
        assert!(none.fix.is_some());

        std::fs::write(
            &global,
            "[credential]\n\thelper = \"!f() { echo username=me; echo password=hunter2; }; f\"\n",
        )
        .unwrap();
        let some = github_in(&env).await;
        assert_eq!(some.status, Status::Ok, "{some:?}");
        assert!(
            some.detail.contains("(me)") && !some.detail.contains("hunter2"),
            "{}",
            some.detail
        );
    }

    #[test]
    fn a_login_in_a_url_is_never_said() {
        assert_eq!(
            scrub("fatal: unable to access 'https://me:ghp_secret@github.com/o/r.git/': 403"),
            "fatal: unable to access 'https://github.com/o/r.git/': 403"
        );
        assert_eq!(
            scrub("ssh://git@host:22/r and https://x@y"),
            "ssh://host:22/r and https://y"
        );
        assert_eq!(scrub("no url here, a@b"), "no url here, a@b");
        assert_eq!(scrub("https://host/a@b"), "https://host/a@b");
    }

    #[test]
    fn says_what_the_remote_said_or_gits_last_word() {
        let github = "remote: Permission to o/r.git denied to me.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403\n";
        assert_eq!(git_reason(github), "Permission to o/r.git denied to me.");
        let plain =
            "fatal: '/nope' does not appear to be a git repository\nfatal: Could not read from remote repository.\n";
        assert_eq!(git_reason(plain), "Could not read from remote repository.");
        assert_eq!(
            git_reason("error: failed to push some refs"),
            "failed to push some refs"
        );
        assert_eq!(git_reason("\n"), "no reason given");
    }

    /// Against remotes on disk: one it can clone and push, one that isn't there, and one whose
    /// pushes go somewhere that isn't (`pushInsteadOf`), so it clones and can't push.
    #[tokio::test]
    async fn a_repo_is_checked_for_clone_and_push() {
        let dir = scratch("repo-access");
        let bare = dir.0.join("r.git");
        let made = std::process::Command::new("git")
            .args(["init", "--quiet", "--bare"])
            .arg(&bare)
            .status()
            .unwrap();
        assert!(made.success());
        let global = dir.0.join("gitconfig");
        std::fs::write(&global, "").unwrap();
        let env = [
            ("GIT_CONFIG_GLOBAL", global.as_os_str()),
            ("GIT_CONFIG_NOSYSTEM", OsStr::new("1")),
        ];
        let remote = bare.to_string_lossy().into_owned();
        let ok = repo_access_in("o/r", &remote, &env).await;
        assert_eq!((ok.clone, ok.push, ok.detail.as_deref()), (true, true, None), "{ok:?}");
        let refs = std::process::Command::new("git")
            .args(["-C", &remote, "for-each-ref"])
            .output()
            .unwrap();
        assert!(refs.stdout.is_empty(), "the dry push made a branch");

        let gone = dir.0.join("gone.git").to_string_lossy().into_owned();
        let none = repo_access_in("o/gone", &gone, &env).await;
        assert!(!none.clone && !none.push, "{none:?}");
        assert!(none.detail.as_deref().unwrap().starts_with("can't clone: "), "{none:?}");

        std::fs::write(&global, format!("[url \"{gone}\"]\n\tpushInsteadOf = {remote}\n")).unwrap();
        let read_only = repo_access_in("o/r", &remote, &env).await;
        assert!(read_only.clone && !read_only.push, "{read_only:?}");
        assert!(
            read_only
                .detail
                .as_deref()
                .unwrap()
                .starts_with("clones, but can't push: "),
            "{read_only:?}"
        );
    }

    #[tokio::test]
    async fn a_worktree_is_made_in_code_dir_and_cleaned_up() {
        let dir = scratch("code");
        let c = code_dir(&dir.0).await;
        assert_eq!(c.status, Status::Ok, "{c:?}");
        assert_eq!(
            std::fs::read_dir(&dir.0).unwrap().count(),
            0,
            "the probe left something behind"
        );

        let missing = dir.0.join("a/b");
        let c = code_dir(&missing).await;
        assert_eq!(c.status, Status::Warn, "{c:?}");
        assert_eq!(c.fix.unwrap().actions, vec![Action::CreateDir(missing.clone())]);

        let file = dir.0.join("file");
        std::fs::write(&file, "").unwrap();
        assert_eq!(code_dir(&file).await.status, Status::Fail);
    }

    #[test]
    fn the_disk_check_warns_under_the_minimum_and_says_what_takes_the_space() {
        let ok = disk_check(25 * GB, 20, None);
        assert_eq!(
            (ok.status, ok.detail.as_str()),
            (Status::Ok, "25.0 GB free, of the 20 GB wanted")
        );

        let usage: Vec<(String, u64)> = (1..=7).rev().map(|n| (format!("work/COPL-{n}"), n * GB)).collect();
        let low = disk_check(12_900_000_000, 20, Some(Some(usage)));
        assert_eq!(low.status, Status::Warn);
        assert_eq!(
            low.detail,
            "12.9 GB free, under the 20 GB wanted; code_dir has work/COPL-7 7.0 GB, work/COPL-6 6.0 GB, \
             work/COPL-5 5.0 GB, work/COPL-4 4.0 GB, work/COPL-3 3.0 GB"
        );
        assert!(low.fix.is_some_and(|f| !f.runnable()));
        assert!(
            disk_check(0, 20, Some(None))
                .detail
                .ends_with("code_dir took too long to measure")
        );
        assert!(
            disk_check(0, 20, Some(Some(Vec::new())))
                .detail
                .ends_with("nothing of it is under code_dir")
        );
    }

    #[tokio::test]
    async fn the_disk_is_measured_and_what_is_under_code_dir_added_up() {
        let dir = scratch("disk");
        for d in ["work/COPL-1", "work/COPL-2", "repos/o/r", "build/o/r/debug"] {
            std::fs::create_dir_all(dir.0.join(d)).unwrap();
        }
        std::fs::write(dir.0.join("work/COPL-1/big"), vec![1u8; 300_000]).unwrap();
        std::fs::write(dir.0.join("build/o/r/debug/lib"), vec![1u8; 200_000]).unwrap();
        /* A hard link (as cargo makes them) counts once. */
        std::fs::hard_link(dir.0.join("build/o/r/debug/lib"), dir.0.join("build/o/r/debug/bin")).unwrap();
        std::os::unix::fs::symlink("/", dir.0.join("work/COPL-2/root")).unwrap();
        let u = usage(&dir.0);
        let names: Vec<&str> = u.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(&names[..2], ["work/COPL-1", "build"], "{u:?}");
        assert!(u[0].1 >= 300_000 && u[1].1 >= 200_000 && u[1].1 < 400_000, "{u:?}");
        /* No filesystem has this much free, and one where code_dir is yet to be made is measured too. */
        assert_eq!(disk(&dir.0, u64::MAX / GB).await.status, Status::Warn);
        assert_eq!(disk(&dir.0.join("not/yet"), 0).await.status, Status::Ok);
    }

    #[tokio::test]
    async fn a_runtime_not_on_path_fails_with_how_to_get_it() {
        let c = runtime(&Runtime::Unknown("nope".into()), &["copland-no-such-program".into()]).await;
        assert_eq!(c.status, Status::Fail);
        assert!(c.detail.contains("not found on PATH"), "{}", c.detail);
        assert!(!c.fix.unwrap().runnable());
    }

    /// COPL-179: what the daemon reports of an agent's runtimes, both of them, once each.
    #[tokio::test]
    async fn an_agents_runtimes_are_reported_on_path_and_logged_in() {
        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let mut agent = AgentConfig {
            url: "http://127.0.0.1:9".into(),
            handle: "me/dev".into(),
            token: crate::config::Secret::new("cpl_x"),
            command: argv(&["sh"]),
            workdir: std::env::temp_dir(),
            client: "test".into(),
            code_command: Some(argv(&["copland-no-such-program"])),
            writable: Vec::new(),
            runtime: Runtime::detect(&argv(&["copland-no-such-program"])),
            code_dir: "/tmp/copland-code".into(),
            max_runs: 1,
            account: None,
            resume_chains: false,
        };
        let said = |name: &str, on_path, logged_in| RuntimeCapability {
            name: name.into(),
            on_path,
            logged_in,
        };
        assert_eq!(
            runtime_capabilities(&agent).await,
            [said("sh", true, true), said("copland-no-such-program", false, false)]
        );
        agent.code_command = Some(argv(&["sh"]));
        agent.runtime = Runtime::detect(&argv(&["sh"]));
        assert_eq!(runtime_capabilities(&agent).await, [said("sh", true, true)]);
    }
}
