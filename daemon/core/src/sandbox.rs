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
//! It has a process namespace of its own (COPL-120): when the runtime exits,
//! or is stopped, everything it started goes with it. `--new-session` puts
//! the runtime outside the process group the daemon signals, so without that
//! a dev server it backgrounded would outlive the run and keep its port.
//!
//! It needs bubblewrap and unprivileged user namespaces. Without them a
//! coding run doesn't start, rather than starting unsandboxed. The Nix
//! package builds in bubblewrap's store path (COPL-137), so it doesn't depend
//! on the PATH it was started with; any other build looks for `bwrap` on PATH.

use std::path::{Path, PathBuf};

/// The bubblewrap runs start: `COPLAND_BWRAP` at build time when it was set (the Nix package sets
/// it to bubblewrap's store path), else `bwrap` on PATH.
pub const BWRAP: &str = match option_env!("COPLAND_BWRAP") {
    Some(path) => path,
    None => "bwrap",
};

/// What a sandboxed run may write, and where it starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Writable {
    /// Writable, and there: a coding run's worktree and its clone's `.git`; none for a run that
    /// only reads the repo (a lead planning, COPL-87).
    pub dirs: Vec<PathBuf>,
    /// From the agent's config. Missing ones are skipped (`--bind-try`).
    pub extra: Vec<PathBuf>,
    /// The run's working directory.
    pub chdir: PathBuf,
}

/// `argv`, run inside bubblewrap in `chdir`.
pub fn wrap(argv: &[String], w: &Writable) -> Vec<String> {
    let p = |path: &Path| path.to_string_lossy().to_string();
    let mut out: Vec<String> = [
        BWRAP,
        "--die-with-parent",
        "--new-session",
        "--unshare-pid",
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
    for path in &w.dirs {
        out.extend(["--bind".into(), p(path), p(path)]);
    }
    for path in &w.extra {
        out.extend(["--bind-try".into(), p(path), p(path)]);
    }
    out.extend(["--chdir".into(), p(&w.chdir), "--".into()]);
    out.extend(argv.iter().cloned());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_comes_last_after_the_binds() {
        let w = Writable {
            dirs: vec!["/c/repos/o/r/.git".into(), "/c/work/COPL-1".into()],
            extra: vec!["/h/.claude".into()],
            chdir: "/c/work/COPL-1".into(),
        };
        let argv = wrap(&["claude".into(), "-p".into(), "hi".into()], &w);
        assert_eq!(argv[0], BWRAP);
        let s = argv.join(" ");
        assert!(s.contains("--ro-bind / /"));
        assert!(s.contains("--unshare-pid"));
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
        /* Not under /tmp: the sandbox gives every run an empty /tmp of its own. */
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("core sits in the workspace")
            .join("target")
            .join(format!("copland-sandbox-{}", std::process::id()));
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
            dirs: vec![git_dir.clone(), worktree.clone()],
            extra: vec![extra.clone(), root.join("missing")],
            chdir: worktree.clone(),
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

        /* Reading only (a lead): nothing in the worktree may be written, the extras still may. */
        let read = Writable {
            dirs: Vec::new(),
            extra: vec![extra.clone()],
            chdir: worktree.clone(),
        };
        let script = format!(
            "ls >/dev/null && ! touch read 2>/dev/null && touch {e}/read",
            e = extra.display()
        );
        let argv = wrap(&["sh".into(), "-c".into(), script], &read);
        let out = std::process::Command::new(&argv[0]).args(&argv[1..]).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(!worktree.join("read").exists() && extra.join("read").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// What a run starts in the background, detached the way a dev server is, ends with the run
    /// (COPL-120), so it doesn't hold its port after the run is over.
    #[test]
    fn what_a_run_leaves_running_ends_with_it() {
        if std::process::Command::new(BWRAP).arg("--version").output().is_err() {
            eprintln!("no bwrap here; skipping");
            return;
        }
        /* A duration nothing else on the machine sleeps for, to find it by afterwards. */
        let marker = format!("{}.5", 86_400 + std::process::id());
        let w = Writable {
            dirs: Vec::new(),
            extra: Vec::new(),
            chdir: env!("CARGO_MANIFEST_DIR").into(),
        };
        let script = format!("setsid nohup sleep {marker} >/dev/null 2>&1 & sleep 0.2");
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
        let left = || {
            std::fs::read_dir("/proc")
                .unwrap()
                .filter_map(|e| std::fs::read(e.ok()?.path().join("cmdline")).ok())
                .any(|c| c.split(|&b| b == 0).any(|a| a == marker.as_bytes()))
        };
        /* The namespace goes as its first process exits; give the kernel a moment. */
        for _ in 0..40 {
            if !left() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("`sleep {marker}` outlived its sandbox");
    }
}
