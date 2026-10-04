//! The macOS fallback (COPL-140): Seatbelt through `sandbox-exec`, built in.
//!
//! macOS has no process namespaces: the runtime stays in the process group
//! the daemon made for it, and the runner kills that group once the runtime
//! exits (`ends_its_children` is false), which takes everything it started
//! with it except what left the group itself (`setsid`, a daemonizing
//! server).

use std::path::{Path, PathBuf};

use super::{Backend, Writable, run_probe};

/// macOS's Seatbelt front end. Its man page has called it deprecated since 10.12, and it is still
/// what Chromium, Codex and Claude Code sandbox with there; there is no other way in.
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

#[derive(Debug)]
pub struct Seatbelt;

/// The devices anything writes to in passing: output thrown away, a terminal, a pty, and dtrace's
/// helper, which every process linked with libSystem opens.
const DEVICES: &str = r##"(literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/ptmx") (literal "/dev/dtracehelper") (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/")"##;

/// The Seatbelt profile for `n` writable paths, the parameters `W0`.. `W{n-1}` given with `-D`, so
/// no path is spliced into the profile's text and no quote in one can change it. Everything is
/// allowed (reading, the network, processes) except writing, which only those paths and `DEVICES`
/// may. Seatbelt takes the last rule that matches, so the allow after the deny is what lets them.
pub fn profile(n: usize) -> String {
    let paths: String = (0..n).map(|i| format!(" (subpath (param \"W{i}\"))")).collect();
    format!("(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write*{paths} {DEVICES})\n")
}

impl Backend for Seatbelt {
    fn name(&self) -> &'static str {
        "seatbelt"
    }

    fn program(&self) -> &'static str {
        SANDBOX_EXEC
    }

    /// `sandbox-exec` with `profile`, and `env` setting `TMPDIR` to the run's own. Seatbelt
    /// matches real paths, so each one is resolved first (`/var` is `/private/var` there); one that
    /// doesn't exist yet goes as it is. sandbox-exec execs the command where it was started, which
    /// is `chdir`: the runner starts it there.
    fn wrap(&self, argv: &[String], w: &Writable) -> Vec<String> {
        let real = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let p = |path: &Path| path.to_string_lossy().to_string();
        let paths: Vec<PathBuf> = w.dirs.iter().chain(&w.extra).chain(&w.tmp).map(|d| real(d)).collect();
        let mut out = vec![SANDBOX_EXEC.to_string(), "-p".into(), profile(paths.len())];
        for (i, path) in paths.iter().enumerate() {
            out.extend(["-D".into(), format!("W{i}={}", p(path))]);
        }
        if let Some(tmp) = &w.tmp {
            out.extend(["/usr/bin/env".into(), format!("TMPDIR={}/", p(&real(tmp)))]);
        }
        out.extend(argv.iter().cloned());
        out
    }

    fn probe(&self) -> Result<(), String> {
        let mut command = std::process::Command::new(SANDBOX_EXEC);
        command.args(["-p", "(version 1) (allow default)", "/usr/bin/true"]);
        run_probe(command)
    }

    fn broken(&self, said: &str) -> String {
        format!("sandbox-exec doesn't work here ({said}): coding runs can't start")
    }

    fn ends_its_children(&self) -> bool {
        false
    }

    fn needs_tmp(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Seatbelt profile denies every write but to its parameters and the devices, and names
    /// no path itself.
    #[test]
    fn the_profile_allows_writes_only_to_its_parameters() {
        let none = profile(0);
        assert!(none.starts_with("(version 1)\n(allow default)\n(deny file-write*)\n"));
        assert!(!none.contains("param"));
        let three = profile(3);
        let allow = three
            .lines()
            .find(|l| l.starts_with("(allow file-write*"))
            .expect("an allow");
        for i in 0..3 {
            assert!(allow.contains(&format!("(subpath (param \"W{i}\"))")), "{allow}");
        }
        assert!(!allow.contains("W3"));
        assert!(allow.contains("(literal \"/dev/null\")") && allow.contains("(regex #\"^/dev/ttys[0-9]+$\")"));
        /* The allow comes after the deny: Seatbelt takes the last rule that matches. */
        assert!(three.find("(deny file-write*)") < three.find("(allow file-write*"));
        assert_eq!(three.matches('(').count(), three.matches(')').count());
        assert!(!three.contains("/c/") && !three.contains("/Users"));
    }

    #[test]
    fn seatbelt_passes_the_paths_as_parameters_and_sets_tmpdir() {
        let w = Writable {
            dirs: vec!["/c/repos/o/r/.git".into(), "/c/work/COPL-1".into()],
            extra: vec!["/h/.claude".into()],
            chdir: "/c/work/COPL-1".into(),
            tmp: Some("/t/copland-run \"x\"".into()),
        };
        let argv = Seatbelt.wrap(&["claude".into(), "-p".into(), "hi".into()], &w);
        assert_eq!(argv[..2], [SANDBOX_EXEC, "-p"]);
        assert_eq!(argv[2], profile(4));
        assert_eq!(
            argv[3..],
            [
                "-D",
                "W0=/c/repos/o/r/.git",
                "-D",
                "W1=/c/work/COPL-1",
                "-D",
                "W2=/h/.claude",
                "-D",
                "W3=/t/copland-run \"x\"",
                "/usr/bin/env",
                "TMPDIR=/t/copland-run \"x\"/",
                "claude",
                "-p",
                "hi"
            ]
        );
        /* A lead reads: no dirs, and without a temp dir no env either. */
        let read = Writable {
            dirs: Vec::new(),
            extra: Vec::new(),
            chdir: "/c/repos/o/r".into(),
            tmp: None,
        };
        assert_eq!(
            Seatbelt.wrap(&["claude".into()], &read),
            [SANDBOX_EXEC, "-p", &profile(0), "claude"]
        );
    }

    /// The real thing on a Mac (CI's macos-14 runs it).
    #[cfg(target_os = "macos")]
    #[test]
    fn holds_to_what_it_may_write() {
        Seatbelt.probe().expect("sandbox-exec works");
        super::super::conformance::check(&Seatbelt);
    }
}
