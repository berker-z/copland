//! The sandbox a coding run works in (COPL-79), around the runtime the agent's `code_command`
//! starts. Which one is a backend picked from the agent's runtime and the platform (COPL-141): the
//! runtime's own, when it has one we've checked (`claude_code`, `codex`; none yet), else the
//! platform's fallback, bubblewrap on Linux (`bubblewrap`) and Seatbelt on macOS (`seatbelt`,
//! COPL-140). Every backend is given the same `Writable` and holds to it, which `conformance`
//! tests.
//!
//! The whole filesystem is visible but read-only. Writable: the task's
//! worktree, the clone's `.git` (where the worktree's commits land), a temp
//! dir of the run's own (a fresh empty /tmp under bubblewrap, `TMPDIR` under
//! Seatbelt), and the paths the agent's config lists under `writable` (a
//! runtime's own state, like `~/.claude`, and caches). Anything it edits, with
//! a shell or its own tools, lands in one of those or fails. The network is
//! the machine's: neither fallback limits hosts, so a run can reach what the
//! machine can.
//!
//! When the runtime exits, or is stopped, what it started goes with it: by
//! itself under a backend with a process namespace (bubblewrap, COPL-120),
//! otherwise because the runner kills the runtime's process group once it
//! exits (`ends_its_children` false), which takes everything except what left
//! the group itself (`setsid`, a daemonizing server).
//!
//! Without a working backend a coding run doesn't start, rather than starting
//! unsandboxed: the daemon looks for its `program` every poll, and runs
//! `probe` once to see that it works.

use std::path::PathBuf;

use crate::config::{AgentConfig, Runtime};

mod bubblewrap;
mod claude_code;
mod codex;
mod seatbelt;

pub use bubblewrap::{BWRAP, Bubblewrap};
pub use seatbelt::{SANDBOX_EXEC, Seatbelt, profile};

/// What a sandboxed run may write, and where it starts. The one description every backend gets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Writable {
    /// Writable, and there: a coding run's worktree and its clone's `.git`; none for a run that
    /// only reads the repo (a lead planning, COPL-87).
    pub dirs: Vec<PathBuf>,
    /// From the agent's config. Missing ones are skipped.
    pub extra: Vec<PathBuf>,
    /// The run's working directory.
    pub chdir: PathBuf,
    /// The run's own temp dir when the backend `needs_tmp`, made and removed by the runner:
    /// writable, and the run's `TMPDIR`. Ignored by one that doesn't.
    pub tmp: Option<PathBuf>,
}

/// One way of sandboxing a coding run.
pub trait Backend: Sync + std::fmt::Debug {
    /// What the logs call it.
    fn name(&self) -> &'static str;
    /// The program it starts, looked for on PATH (or a path).
    fn program(&self) -> &'static str;
    /// `argv`, run inside the sandbox in `w.chdir`. The runner starts it there too.
    fn wrap(&self, argv: &[String], w: &Writable) -> Vec<String>;
    /// Whether it works on this machine, or what it said when it doesn't. Run once `program` is
    /// found, so a machine that has it but can't use it says so before a run fails on it.
    fn probe(&self) -> Result<(), String>;
    /// What the agent's line says when `probe` failed: what it said, and the likely way out.
    fn broken(&self, said: &str) -> String;
    /// Whether everything a run started ends with its runtime by itself. When not, the runner
    /// kills the runtime's process group once it exits.
    fn ends_its_children(&self) -> bool;
    /// Whether a run needs a temp dir made for it (`Writable::tmp`).
    fn needs_tmp(&self) -> bool;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Linux,
    MacOs,
}

impl Platform {
    /// The one this was built for. Any other Unix goes as Linux does: bubblewrap.
    pub const HERE: Platform = if cfg!(target_os = "macos") {
        Platform::MacOs
    } else {
        Platform::Linux
    };
}

/// The backend a runtime's coding runs get on a platform: its own when it has one, else the
/// platform's fallback.
pub fn backend(runtime: &Runtime, platform: Platform) -> &'static dyn Backend {
    let own = match runtime {
        Runtime::ClaudeCode => claude_code::backend(platform),
        Runtime::Codex => codex::backend(platform),
        Runtime::Unknown(_) => None,
    };
    own.unwrap_or_else(|| fallback(platform))
}

/// What a runtime without a backend of its own gets.
pub fn fallback(platform: Platform) -> &'static dyn Backend {
    match platform {
        Platform::Linux => &Bubblewrap,
        Platform::MacOs => &Seatbelt,
    }
}

/// The agent's backend on this machine.
pub fn of(agent: &AgentConfig) -> &'static dyn Backend {
    backend(&agent.runtime, Platform::HERE)
}

/// Runs a probe's command: Ok when it exits 0, else the first line it said (or its exit code).
fn run_probe(mut command: std::process::Command) -> Result<(), String> {
    let out = command.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&out.stderr);
    match said.lines().map(str::trim).find(|l| !l.is_empty()) {
        Some(line) => Err(line.chars().take(200).collect()),
        None => Err(format!("exit {}", out.status.code().unwrap_or(-1))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No runtime has a backend of its own yet: every one gets the platform's fallback, the
    /// unknown ones included.
    #[test]
    fn every_runtime_gets_the_platforms_fallback() {
        for runtime in [Runtime::ClaudeCode, Runtime::Codex, Runtime::Unknown("hermes".into())] {
            assert_eq!(backend(&runtime, Platform::Linux).name(), "bubblewrap");
            assert_eq!(backend(&runtime, Platform::MacOs).name(), "seatbelt");
        }
        let linux = fallback(Platform::Linux);
        assert_eq!(linux.program(), BWRAP);
        assert!(linux.ends_its_children() && !linux.needs_tmp());
        let mac = fallback(Platform::MacOs);
        assert_eq!(mac.program(), SANDBOX_EXEC);
        assert!(!mac.ends_its_children() && mac.needs_tmp());
        assert_eq!(
            Platform::HERE,
            if cfg!(target_os = "macos") {
                Platform::MacOs
            } else {
                Platform::Linux
            }
        );
    }
}

/// The one test every backend runs, for real on a machine where it works: writes inside the
/// worktree, the clone's `.git`, the run's temp dir and `writable` land; writes outside them fail;
/// a lead (no dirs) can't write its worktree but can its extras. An adapter adds its runtime's
/// file tools on top.
#[cfg(test)]
pub(crate) mod conformance {
    use super::*;
    use std::path::Path;

    pub(crate) fn check(backend: &dyn Backend) {
        /* Not under /tmp: bubblewrap gives every run an empty /tmp of its own. */
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("core sits in the workspace")
            .join("target")
            .join(format!("copland-{}-{}", backend.name(), std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (worktree, git_dir, extra, outside) = (
            root.join("work"),
            root.join("git"),
            root.join("state"),
            root.join("outside"),
        );
        let tmp = backend.needs_tmp().then(|| root.join("tmp"));
        for d in [&worktree, &git_dir, &extra, &outside].into_iter().chain(&tmp) {
            std::fs::create_dir_all(d).unwrap();
        }
        let w = Writable {
            dirs: vec![git_dir.clone(), worktree.clone()],
            extra: vec![extra.clone(), root.join("missing")],
            chdir: worktree.clone(),
            tmp: tmp.clone(),
        };
        let tmp_file = if backend.needs_tmp() {
            "\"$TMPDIR/in\""
        } else {
            "/tmp/in"
        };
        let script = format!(
            "touch in && touch {g}/in && touch {e}/in && touch {tmp_file} && echo hi >/dev/null \
             && ! touch {o}/out 2>/dev/null && ! touch \"$HOME/copland-{name}-{pid}\" 2>/dev/null && pwd -P",
            g = git_dir.display(),
            e = extra.display(),
            o = outside.display(),
            name = backend.name(),
            pid = std::process::id(),
        );
        let run = |w: &Writable, script: String| {
            let argv = backend.wrap(&["sh".into(), "-c".into(), script], w);
            std::process::Command::new(&argv[0])
                .args(&argv[1..])
                .current_dir(&w.chdir)
                .output()
                .unwrap()
        };
        let out = run(&w, script);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            worktree.canonicalize().unwrap().to_string_lossy()
        );
        for d in [&worktree, &git_dir, &extra].into_iter().chain(&tmp) {
            assert!(d.join("in").exists(), "{} wasn't written", d.display());
        }
        assert!(!outside.join("out").exists());

        /* Reading only (a lead): nothing in the worktree may be written, the extras still may. */
        let read = Writable {
            dirs: Vec::new(),
            extra: vec![extra.clone()],
            chdir: worktree.clone(),
            tmp,
        };
        let script = format!(
            "ls >/dev/null && ! touch read 2>/dev/null && touch {e}/read",
            e = extra.display()
        );
        let out = run(&read, script);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(!worktree.join("read").exists() && extra.join("read").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
