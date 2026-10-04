//! The sandbox a coding run works in (COPL-79), around whatever runtime the agent's command
//! starts, so it doesn't matter which one it is: bubblewrap on Linux, Seatbelt (`sandbox-exec`) on
//! macOS (COPL-140). `wrap` is the same call on both.
//!
//! The whole filesystem is visible but read-only. Writable: the task's
//! worktree, the clone's `.git` (where the worktree's commits land), a temp
//! dir of the run's own (a fresh empty /tmp on Linux, `TMPDIR` on macOS), and
//! the paths the agent's config lists under `writable` (a runtime's own
//! state, like `~/.claude`, and caches). Anything it edits, with a shell or
//! its own tools, lands in one of those or fails. The network is the
//! machine's: neither sandbox limits hosts here, so a run can reach what the
//! machine can. A runtime's own sandbox can still go on top, in its command.
//!
//! On Linux it has a process namespace of its own (COPL-120): when the
//! runtime exits, or is stopped, everything it started goes with it.
//! `--new-session` puts the runtime outside the process group the daemon
//! signals, so without that a dev server it backgrounded would outlive the
//! run and keep its port. macOS has no process namespaces: the runtime stays
//! in the process group the daemon made for it, and the runner kills that
//! group once the runtime exits (`ENDS_ITS_CHILDREN` is false), which takes
//! everything it started with it except what left the group itself
//! (`setsid`, a daemonizing server).
//!
//! Linux needs bubblewrap and unprivileged user namespaces; macOS has
//! `sandbox-exec` built in. Without a working one a coding run doesn't start,
//! rather than starting unsandboxed: the daemon looks for `PROGRAM` every
//! poll, and runs `probe` once to see that it works. The Nix package builds
//! in bubblewrap's store path (COPL-137), so it doesn't depend on the PATH it
//! was started with; any other Linux build looks for `bwrap` on PATH.

use std::path::{Path, PathBuf};

/// The bubblewrap runs start: `COPLAND_BWRAP` at build time when it was set (the Nix package sets
/// it to bubblewrap's store path), else `bwrap` on PATH.
pub const BWRAP: &str = match option_env!("COPLAND_BWRAP") {
    Some(path) => path,
    None => "bwrap",
};

/// macOS's Seatbelt front end. Its man page has called it deprecated since 10.12, and it is still
/// what Chromium, Codex and Claude Code sandbox with there; there is no other way in.
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// The program a coding run starts with on this platform.
pub const PROGRAM: &str = if cfg!(target_os = "macos") { SANDBOX_EXEC } else { BWRAP };

/// Whether everything a run started ends with its runtime by itself (Linux's process namespace).
/// When not, the runner kills the runtime's process group once it exits.
pub const ENDS_ITS_CHILDREN: bool = !cfg!(target_os = "macos");

/// Whether a run needs a temp dir made for it (`Writable::tmp`). bubblewrap gives it an empty /tmp
/// instead.
pub const NEEDS_TMP: bool = cfg!(target_os = "macos");

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
    /// The run's own temp dir when `NEEDS_TMP`, made and removed by the runner: writable, and the
    /// run's `TMPDIR`. bubblewrap ignores it.
    pub tmp: Option<PathBuf>,
}

/// `argv`, run inside this platform's sandbox in `chdir`.
pub fn wrap(argv: &[String], w: &Writable) -> Vec<String> {
    if cfg!(target_os = "macos") {
        seatbelt(argv, w)
    } else {
        bubblewrap(argv, w)
    }
}

/// Whether the sandbox works on this machine, or what it said when it doesn't. Run once `PROGRAM`
/// is found, so a machine that has it but can't use it says so before a run fails on it.
pub fn probe() -> Result<(), String> {
    let mut command = std::process::Command::new(PROGRAM);
    if cfg!(target_os = "macos") {
        command.args(["-p", "(version 1) (allow default)", "/usr/bin/true"]);
    } else {
        command.args(["--ro-bind", "/", "/", "true"]);
    }
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

/// What the agent's line says when `probe` failed: what the sandbox said, and on Linux the likely
/// way out.
pub fn broken(said: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("sandbox-exec doesn't work here ({said}): coding runs can't start")
    } else {
        format!(
            "bwrap is there but can't make a user namespace ({said}): coding runs can't start. On Ubuntu \
             24.04 and later AppArmor allows that only to the distribution's own bwrap: install the \
             bubblewrap package and put /usr/bin first on PATH"
        )
    }
}

/// Linux: bubblewrap, with a process namespace and an empty /tmp of the run's own.
fn bubblewrap(argv: &[String], w: &Writable) -> Vec<String> {
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

/// macOS: `sandbox-exec` with `profile`, and `env` setting `TMPDIR` to the run's own. Seatbelt
/// matches real paths, so each one is resolved first (`/var` is `/private/var` there); one that
/// doesn't exist yet goes as it is. sandbox-exec execs the command where it was started, which is
/// `chdir`: the runner starts it there.
fn seatbelt(argv: &[String], w: &Writable) -> Vec<String> {
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
        let argv = bubblewrap(&["claude".into(), "-p".into(), "hi".into()], &w);
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
        let argv = seatbelt(&["claude".into(), "-p".into(), "hi".into()], &w);
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
            seatbelt(&["claude".into()], &read),
            [SANDBOX_EXEC, "-p", &profile(0), "claude"]
        );
    }

    /// The real thing on a Mac (CI's macos-14 runs it): writes inside the worktree, the extras and
    /// TMPDIR land, writes outside fail, and a lead's worktree can't be written.
    #[cfg(target_os = "macos")]
    #[test]
    fn on_macos_writes_outside_fail_and_inside_land() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("core sits in the workspace")
            .join("target")
            .join(format!("copland-seatbelt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (worktree, git_dir, extra, tmp, outside) = (
            root.join("work"),
            root.join("git"),
            root.join("state"),
            root.join("tmp"),
            root.join("outside"),
        );
        for d in [&worktree, &git_dir, &extra, &tmp, &outside] {
            std::fs::create_dir_all(d).unwrap();
        }
        probe().expect("sandbox-exec works");
        let w = Writable {
            dirs: vec![git_dir.clone(), worktree.clone()],
            extra: vec![extra.clone(), root.join("missing")],
            chdir: worktree.clone(),
            tmp: Some(tmp.clone()),
        };
        let script = format!(
            "touch in && touch {g}/in && touch {e}/in && touch \"$TMPDIR/in\" && echo hi >/dev/null \
             && ! touch {o}/out 2>/dev/null && ! touch \"$HOME/copland-seatbelt-{pid}\" 2>/dev/null && pwd -P",
            g = git_dir.display(),
            e = extra.display(),
            o = outside.display(),
            pid = std::process::id(),
        );
        let run = |w: &Writable, script: String| {
            let argv = wrap(&["sh".into(), "-c".into(), script], w);
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
        for d in [&worktree, &git_dir, &extra, &tmp] {
            assert!(d.join("in").exists(), "{} wasn't written", d.display());
        }
        assert!(!outside.join("out").exists());

        let read = Writable {
            dirs: Vec::new(),
            extra: vec![extra.clone()],
            chdir: worktree.clone(),
            tmp: Some(tmp.clone()),
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

    /// The real thing, when this machine can run bubblewrap: writes inside land, writes outside fail.
    #[cfg(target_os = "linux")]
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
            tmp: None,
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
        assert_eq!(probe(), Ok(()), "bwrap ran, so the startup check says it works");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), worktree.to_string_lossy());
        assert!(worktree.join("in").exists() && git_dir.join("in").exists() && extra.join("in").exists());
        assert!(!outside.join("out").exists());

        /* Reading only (a lead): nothing in the worktree may be written, the extras still may. */
        let read = Writable {
            dirs: Vec::new(),
            extra: vec![extra.clone()],
            chdir: worktree.clone(),
            tmp: None,
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
    #[cfg(target_os = "linux")]
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
            tmp: None,
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
