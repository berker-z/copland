//! The Linux fallback: bubblewrap, with a process namespace and an empty /tmp of the run's own.
//!
//! It has a process namespace of its own (COPL-120): when the runtime exits,
//! or is stopped, everything it started goes with it. `--new-session` puts
//! the runtime outside the process group the daemon signals, so without that
//! a dev server it backgrounded would outlive the run and keep its port.
//!
//! It needs bubblewrap and unprivileged user namespaces. The Nix package
//! builds in bubblewrap's store path (COPL-137), so it doesn't depend on the
//! PATH it was started with; any other Linux build looks for `bwrap` on PATH.

use std::path::Path;

use super::{Backend, Writable, run_probe};

/// The bubblewrap runs start: `COPLAND_BWRAP` at build time when it was set (the Nix package sets
/// it to bubblewrap's store path), else `bwrap` on PATH.
pub const BWRAP: &str = match option_env!("COPLAND_BWRAP") {
    Some(path) => path,
    None => "bwrap",
};

#[derive(Debug)]
pub struct Bubblewrap;

impl Backend for Bubblewrap {
    fn name(&self) -> &'static str {
        "bubblewrap"
    }

    fn program(&self) -> &'static str {
        BWRAP
    }

    fn wrap(&self, argv: &[String], w: &Writable) -> Vec<String> {
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

    fn probe(&self) -> Result<(), String> {
        let mut command = std::process::Command::new(BWRAP);
        command.args(["--ro-bind", "/", "/", "true"]);
        run_probe(command)
    }

    fn broken(&self, said: &str) -> String {
        format!(
            "bwrap is there but can't make a user namespace ({said}): coding runs can't start. On Ubuntu \
             24.04 and later AppArmor allows that only to the distribution's own bwrap: install the \
             bubblewrap package and put /usr/bin first on PATH"
        )
    }

    fn ends_its_children(&self) -> bool {
        true
    }

    fn needs_tmp(&self) -> bool {
        false
    }
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
            tmp: Some("/t/copland-run".into()),
        };
        let argv = Bubblewrap.wrap(&["claude".into(), "-p".into(), "hi".into()], &w);
        assert_eq!(argv[0], BWRAP);
        let s = argv.join(" ");
        assert!(s.contains("--ro-bind / /"));
        assert!(s.contains("--unshare-pid"));
        assert!(s.contains("--tmpfs /tmp"));
        assert!(!s.contains("/t/copland-run"), "bubblewrap's /tmp is its own");
        assert!(s.contains("--bind /c/work/COPL-1 /c/work/COPL-1"));
        assert!(s.contains("--bind /c/repos/o/r/.git /c/repos/o/r/.git"));
        assert!(s.contains("--bind-try /h/.claude /h/.claude"));
        assert!(s.ends_with("--chdir /c/work/COPL-1 -- claude -p hi"));
    }

    /// Whether this machine can run bubblewrap; the tests that need it skip, saying why, when not.
    #[cfg(target_os = "linux")]
    fn works_here() -> bool {
        match Bubblewrap.probe() {
            Ok(()) => true,
            Err(said) => {
                eprintln!("bwrap doesn't work here; skipping: {said}");
                false
            }
        }
    }

    /// The real thing, when this machine can run bubblewrap.
    #[cfg(target_os = "linux")]
    #[test]
    fn holds_to_what_it_may_write() {
        if works_here() {
            super::super::conformance::check(&Bubblewrap);
        }
    }

    /// What a run starts in the background, detached the way a dev server is, ends with the run
    /// (COPL-120), so it doesn't hold its port after the run is over.
    #[cfg(target_os = "linux")]
    #[test]
    fn what_a_run_leaves_running_ends_with_it() {
        if !works_here() {
            return;
        }
        /* A duration nothing else on the machine sleeps for, to find it by afterwards. */
        let marker = format!("{}.5", 86_400 + std::process::id());
        let w = Writable {
            dirs: Vec::new(),
            extra: Vec::new(),
            chdir: env!("CARGO_MANIFEST_DIR").into(),
            tmp: None,
        };
        let script = format!("setsid nohup sleep {marker} >/dev/null 2>&1 & sleep 0.2");
        let argv = Bubblewrap.wrap(&["sh".into(), "-c".into(), script], &w);
        let out = std::process::Command::new(&argv[0]).args(&argv[1..]).output().unwrap();
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
