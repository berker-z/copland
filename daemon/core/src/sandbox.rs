//! The sandbox a coding run works in (COPL-79): bubblewrap around whatever
//! runtime the agent's command starts, so it doesn't matter which one it is.
//!
//! The whole filesystem is visible but read-only. Writable: the task's
//! worktree, the clone's `.git` (where the worktree's commits land), a fresh
//! empty /tmp, and the paths the agent's config lists under `writable`
//! (a runtime's own state, like `~/.claude`, and caches). Anything it edits,
//! with a shell or its own tools, lands in one of those or fails. The network
//! is the machine's: bubblewrap can't limit hosts, so a run can reach what
//! the machine can. A runtime's own sandbox can still go on top, in its
//! command.
//!
//! It needs `bwrap` on PATH and unprivileged user namespaces. Without them a
//! coding run doesn't start, rather than starting unsandboxed.

use std::path::{Path, PathBuf};

pub const BWRAP: &str = "bwrap";

/// What a sandboxed run may write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Writable {
    pub worktree: PathBuf,
    /// The clone's `.git`, shared by its worktrees.
    pub git_dir: PathBuf,
    /// From the agent's config. Missing ones are skipped (`--bind-try`).
    pub extra: Vec<PathBuf>,
}

/// `argv`, run inside bubblewrap in the worktree.
pub fn wrap(argv: &[String], w: &Writable) -> Vec<String> {
    let p = |path: &Path| path.to_string_lossy().to_string();
    let mut out: Vec<String> = [
        BWRAP,
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    for path in [&w.git_dir, &w.worktree] {
        out.extend(["--bind".into(), p(path), p(path)]);
    }
    for path in &w.extra {
        out.extend(["--bind-try".into(), p(path), p(path)]);
    }
    out.extend(["--chdir".into(), p(&w.worktree), "--".into()]);
    out.extend(argv.iter().cloned());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_comes_last_after_the_binds() {
        let w = Writable {
            worktree: "/c/work/COPL-1".into(),
            git_dir: "/c/repos/o/r/.git".into(),
            extra: vec!["/h/.claude".into()],
        };
        let argv = wrap(&["claude".into(), "-p".into(), "hi".into()], &w);
        assert_eq!(argv[0], "bwrap");
        let s = argv.join(" ");
        assert!(s.contains("--ro-bind / /"));
        assert!(s.contains("--bind /c/work/COPL-1 /c/work/COPL-1"));
        assert!(s.contains("--bind /c/repos/o/r/.git /c/repos/o/r/.git"));
        assert!(s.contains("--bind-try /h/.claude /h/.claude"));
        assert!(s.ends_with("--chdir /c/work/COPL-1 -- claude -p hi"));
    }

    /// The real thing, when this machine can run bubblewrap: writes inside land, writes outside fail.
    #[test]
    fn writes_outside_fail_and_inside_land() {
        if std::process::Command::new(BWRAP).arg("--version").output().is_err() {
            eprintln!("no bwrap here; skipping");
            return;
        }
        let root = std::env::temp_dir().join(format!("copland-sandbox-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (worktree, git_dir, extra, outside) = (
            root.join("work"),
            root.join("git"),
            root.join("state"),
            root.join("outside"),
        );
        for d in [&worktree, &git_dir, &extra, &outside] {
            std::fs::create_dir_all(d).unwrap();
        }
        let w = Writable {
            worktree: worktree.clone(),
            git_dir: git_dir.clone(),
            extra: vec![extra.clone(), root.join("missing")],
        };
        let script = format!(
            "touch in && touch {g}/in && touch {e}/in && touch /tmp/in && ! touch {o}/out 2>/dev/null && pwd",
            g = git_dir.display(),
            e = extra.display(),
            o = outside.display()
        );
        let argv = wrap(&["sh".into(), "-c".into(), script], &w);
        let out = std::process::Command::new(&argv[0]).args(&argv[1..]).output().unwrap();
        if !out.status.success() && String::from_utf8_lossy(&out.stderr).contains("namespace") {
            eprintln!(
                "bwrap can't make namespaces here; skipping: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            return;
        }
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), worktree.to_string_lossy());
        assert!(worktree.join("in").exists() && git_dir.join("in").exists() && extra.join("in").exists());
        assert!(!outside.join("out").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
