//! Factory droid's own sandbox, as the backend for its coding runs (COPL-146).
//!
//! Droid has two sandbox modes. Per-command, its default, puts only shell commands in the OS
//! sandbox and checks its file tools in the app; whole-process (`sandbox.mode`) re-runs droid
//! itself inside it, file tools included, and refuses to start when it can't. Only the second is
//! a sandbox here, so a run gets it: bubblewrap with seccomp and its own network namespace on
//! Linux, Seatbelt on macOS (Anthropic's sandbox-runtime, inside droid).
//!
//! The policy comes from a settings file the daemon writes into the run's temp dir and passes with
//! `--settings`, never the user's: `allowWrite` is `Writable`, the rest of the filesystem is
//! read-only, and settings in the worktree can't widen it (droid takes the launch policy and
//! fails closed on a changed one). Droid always makes its process's working directory writable,
//! so a run that only reads starts in an empty one of the temp dir's and is pointed at its
//! worktree with `--cwd`. Its own state (sessions, logs, its `TMPDIR`) goes in a home of the run's
//! own, `FACTORY_HOME_OVERRIDE`, rather than the user's `~/.factory`, whose skills, plugins and
//! commands would otherwise be open to the run. So a run signs in with `FACTORY_API_KEY`, not the
//! user's login, and reaches Copland through the run's MCP config, which `droid exec` has no flag
//! for and so is copied to that home's `.factory/mcp.json` (the same `mcpServers` shape).
//!
//! The network goes through droid's proxy, with every domain allowed: a domain off the list goes
//! to a permission prompt, which a run with prompts off can't be shown to hold, so a list would
//! not be a limit. Nothing on the machine's loopback is reachable from inside.
//!
//! On Linux droid needs bubblewrap and socat on PATH (it ships its own ripgrep).

use std::path::{Path, PathBuf};

use super::{Backend, Platform, Writable, run_probe};

#[derive(Debug)]
pub struct Droid;

/// Droid's backend: the same on both platforms.
pub fn backend(_platform: Platform) -> Option<&'static dyn Backend> {
    Some(&Droid)
}

/// Where `argv` says `droid exec` (the index of `droid`), which the settings go after.
pub fn exec_at(argv: &[String]) -> Option<usize> {
    argv.windows(2)
        .position(|pair| Path::new(&pair[0]).file_name().is_some_and(|n| n == "droid") && pair[1] == "exec")
}

/// The settings file in the run's temp dir. The run can read it but not write it.
fn settings_path(tmp: &Path) -> PathBuf {
    tmp.join("settings.json")
}

/// Droid's home for the run (`FACTORY_HOME_OVERRIDE`): its `.factory` goes in here.
fn home(tmp: &Path) -> PathBuf {
    tmp.join("home")
}

/// Where a run that only reads starts: droid makes its working directory writable.
fn start(tmp: &Path) -> PathBuf {
    tmp.join("start")
}

/// The run's settings: whole-process, writing only to `Writable` and the run's droid home.
/// Seatbelt matches real paths, so each one is resolved first; an extra that doesn't exist is
/// left out.
pub fn settings(w: &Writable, tmp: &Path) -> String {
    let real = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let p = |path: PathBuf| path.to_string_lossy().to_string();
    let allow: Vec<String> = w
        .dirs
        .iter()
        .map(|d| real(d))
        .chain(w.extra.iter().filter(|e| e.exists()).map(|e| real(e)))
        .chain([real(&home(tmp))])
        .map(p)
        .collect();
    serde_json::json!({
        "sandbox": {
            "enabled": true,
            "mode": "whole-process",
            "filesystem": { "allowWrite": allow },
            "network": { "allowedDomains": ["*"] },
        }
    })
    .to_string()
}

impl Backend for Droid {
    fn name(&self) -> &'static str {
        "droid"
    }

    fn program(&self) -> &'static str {
        "droid"
    }

    /// `env` pointing droid at the run's home, then the command with `--settings` (and, for a run
    /// that only reads, `--cwd`) after its `droid exec`. A command without one, like a script
    /// that runs droid, can't be given them, so it doesn't run.
    fn wrap(&self, argv: &[String], w: &Writable) -> Vec<String> {
        let tmp = w.tmp.as_deref().expect("droid's runs get a temp dir");
        let p = |path: &Path| path.to_string_lossy().to_string();
        let Some(at) = exec_at(argv) else {
            return [
                "/bin/sh",
                "-c",
                "echo 'copland: code_command for droid runs `droid exec`, which takes the sandbox settings' >&2; exit 2",
            ]
            .map(String::from)
            .to_vec();
        };
        let mut out = Vec::new();
        let reads = w.dirs.is_empty();
        if reads {
            out.extend(["/bin/sh", "-c", "cd \"$0\" && exec \"$@\""].map(String::from));
            out.push(p(&start(tmp)));
        }
        out.extend([
            "/usr/bin/env".into(),
            format!("FACTORY_HOME_OVERRIDE={}", p(&home(tmp))),
        ]);
        out.extend(argv[..at + 2].iter().cloned());
        out.extend(["--settings".into(), p(&settings_path(tmp))]);
        if reads {
            out.extend(["--cwd".into(), p(&w.chdir)]);
        }
        out.extend(argv[at + 2..].iter().cloned());
        out
    }

    fn prepare(&self, w: &Writable, mcp_config: &Path) -> std::io::Result<()> {
        let tmp = w.tmp.as_deref().expect("droid's runs get a temp dir");
        let factory = home(tmp).join(".factory");
        std::fs::create_dir_all(&factory)?;
        std::fs::create_dir_all(start(tmp))?;
        std::fs::copy(mcp_config, factory.join("mcp.json"))?;
        std::fs::write(settings_path(tmp), settings(w, tmp))
    }

    /// What droid's sandbox needs: on Linux bubblewrap (from PATH, as droid finds it) able to make
    /// a user namespace, and socat; on macOS sandbox-exec.
    fn probe(&self) -> Result<(), String> {
        match Platform::HERE {
            Platform::MacOs => super::Seatbelt.probe(),
            Platform::Linux => {
                let mut bwrap = std::process::Command::new("bwrap");
                bwrap.args(["--ro-bind", "/", "/", "true"]);
                run_probe(bwrap).map_err(|e| format!("bwrap: {e}"))?;
                let mut socat = std::process::Command::new("socat");
                socat.arg("-V");
                run_probe(socat).map_err(|e| format!("socat: {e}"))
            }
        }
    }

    fn broken(&self, said: &str) -> String {
        match Platform::HERE {
            Platform::MacOs => super::Seatbelt.broken(said),
            Platform::Linux => format!(
                "droid's sandbox can't start ({said}): coding runs can't start. It needs bubblewrap and socat \
                 on PATH, and bwrap able to make a user namespace (on Ubuntu 24.04 and later, the \
                 distribution's own bwrap)"
            ),
        }
    }

    /// Droid's sandbox on Linux has a process namespace, but droid's own first process (its proxy)
    /// runs outside it, and on macOS there is none: the runner kills the group either way.
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

    fn s(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_settings_hold_writable_and_nothing_else() {
        let root = std::env::temp_dir().join(format!("copland-droid-settings-{}", std::process::id()));
        let extra = root.join("state");
        std::fs::create_dir_all(&extra).unwrap();
        let w = Writable {
            dirs: vec!["/c/repos/o/r/.git".into(), "/c/work/COPL-1".into()],
            extra: vec![extra.clone(), "/nowhere/at/all".into()],
            chdir: "/c/work/COPL-1".into(),
            tmp: Some("/t/run".into()),
        };
        let got: serde_json::Value = serde_json::from_str(&settings(&w, Path::new("/t/run"))).unwrap();
        let extra = extra.canonicalize().unwrap().to_string_lossy().to_string();
        assert_eq!(
            got,
            serde_json::json!({ "sandbox": {
                "enabled": true,
                "mode": "whole-process",
                "filesystem": { "allowWrite": ["/c/repos/o/r/.git", "/c/work/COPL-1", extra, "/t/run/home"] },
                "network": { "allowedDomains": ["*"] },
            }})
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_settings_go_in_after_droid_exec() {
        let w = Writable {
            dirs: vec!["/c/repos/o/r/.git".into(), "/c/work/COPL-1".into()],
            extra: Vec::new(),
            chdir: "/c/work/COPL-1".into(),
            tmp: Some("/t/run".into()),
        };
        let argv = Droid.wrap(&s(&["/opt/droid", "exec", "--skip-permissions-unsafe", "hi"]), &w);
        assert_eq!(
            argv,
            s(&[
                "/usr/bin/env",
                "FACTORY_HOME_OVERRIDE=/t/run/home",
                "/opt/droid",
                "exec",
                "--settings",
                "/t/run/settings.json",
                "--skip-permissions-unsafe",
                "hi"
            ])
        );

        /* A lead reads: it starts in the temp dir, pointed at its worktree. */
        let read = Writable {
            dirs: Vec::new(),
            ..w.clone()
        };
        let argv = Droid.wrap(&s(&["droid", "exec", "hi"]), &read);
        assert_eq!(
            argv,
            s(&[
                "/bin/sh",
                "-c",
                "cd \"$0\" && exec \"$@\"",
                "/t/run/start",
                "/usr/bin/env",
                "FACTORY_HOME_OVERRIDE=/t/run/home",
                "droid",
                "exec",
                "--settings",
                "/t/run/settings.json",
                "--cwd",
                "/c/work/COPL-1",
                "hi"
            ])
        );

        /* Without a `droid exec` to put them in, it doesn't run. */
        let argv = Droid.wrap(&s(&["sh", "-c", "droid exec \"$1\"", "x"]), &w);
        assert_eq!(argv[..2], s(&["/bin/sh", "-c"]));
        assert!(argv[2].ends_with("exit 2"));
    }

    #[test]
    fn prepare_writes_the_settings_and_the_runs_mcp_config() {
        let root = std::env::temp_dir().join(format!("copland-droid-prepare-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let mcp = root.join("mcp-run.json");
        std::fs::write(&mcp, r#"{"mcpServers":{"copland":{"type":"http"}}}"#).unwrap();
        let tmp = root.join("run");
        let w = Writable {
            dirs: vec![root.join("work")],
            extra: Vec::new(),
            chdir: root.join("work"),
            tmp: Some(tmp.clone()),
        };
        Droid.prepare(&w, &mcp).unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.join("home/.factory/mcp.json")).unwrap(),
            std::fs::read_to_string(&mcp).unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(tmp.join("settings.json")).unwrap(),
            settings(&w, &tmp)
        );
        assert!(tmp.join("start").is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn droid_runs_get_droids_sandbox_on_both_platforms() {
        use crate::config::Runtime;
        for platform in [Platform::Linux, Platform::MacOs] {
            let b = super::super::backend(&Runtime::Droid, platform);
            assert_eq!(b.name(), "droid");
            assert!(b.needs_tmp() && !b.ends_its_children());
        }
    }

    /// What every probe starts with: stop at the first failure, and `denied` for a write that must fail.
    const PROBE: &str = "set -e\ndenied() { if \"$@\" 2>/dev/null; then echo \"wrote: $*\"; exit 1; fi; }\n";

    /// The real thing: droid itself (from PATH) starts its whole-process sandbox with the settings
    /// and argv `wrap` makes, and a `bash` first on PATH stands in for what droid runs inside it,
    /// so no Factory key is needed. Inside, writes from a shell and from droid's own runtime (Bun's
    /// `fs`, what its Create and Edit tools write with) land in `Writable` and fail outside it.
    /// Skipped without droid, unless `COPLAND_REQUIRE_DROID` is set (CI sets it).
    #[test]
    fn holds_to_what_it_may_write() {
        let Some(droid) = crate::runner::locate("droid") else {
            assert!(
                std::env::var_os("COPLAND_REQUIRE_DROID").is_none(),
                "COPLAND_REQUIRE_DROID is set and droid isn't on PATH"
            );
            eprintln!("droid isn't on PATH; skipping");
            return;
        };
        if let Err(said) = Droid.probe() {
            assert!(
                std::env::var_os("COPLAND_REQUIRE_DROID").is_none(),
                "droid's sandbox doesn't work here: {said}"
            );
            eprintln!("droid's sandbox doesn't work here; skipping: {said}");
            return;
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("core sits in the workspace")
            .join("target")
            .join(format!("copland-droid-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (repo, worktree, extra, outside, shim, tmp) = (
            root.join("repo"),
            root.join("work"),
            root.join("state"),
            root.join("outside"),
            root.join("shim"),
            root.join("tmp"),
        );
        for d in [&repo, &extra, &outside, &shim, &tmp] {
            std::fs::create_dir_all(d).unwrap();
        }
        /* A clone and a task's worktree of it, as the daemon makes them: the commit goes to the clone's .git. */
        let git = |dir: &Path, args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t", "-C"])
                .arg(dir)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "base"]);
        git(
            &repo,
            &["worktree", "add", "-q", "-b", "task", &worktree.to_string_lossy()],
        );
        let git_dir = repo.join(".git");
        let real_bash = crate::runner::locate("bash").expect("bash is on PATH");
        /* The innermost bash droid starts runs the probe; any other is the real one. */
        let stand_in = format!(
            "#!/bin/sh\ncase \"$2\" in *apply-seccomp*|*socat*) ;; *DROID_SANDBOXED*) exec /bin/sh \"$COPLAND_PROBE\" ;; esac\nexec {} \"$@\"\n",
            real_bash.display()
        );
        let mcp = root.join("mcp.json");
        std::fs::write(&mcp, "{}").unwrap();
        let bash = shim.join("bash");
        std::fs::write(&bash, stand_in).unwrap();
        std::fs::set_permissions(&bash, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();

        let run = |w: &Writable, probe: String| {
            let script = root.join("probe.sh");
            std::fs::write(&script, probe).unwrap();
            Droid.prepare(w, &mcp).unwrap();
            let argv = Droid.wrap(&s(&["droid", "exec", "--skip-permissions-unsafe", "probe"]), w);
            let path = format!("{}:{}", shim.display(), std::env::var("PATH").unwrap_or_default());
            let out = std::process::Command::new(&argv[0])
                .args(&argv[1..])
                .current_dir(&w.chdir)
                .env("PATH", path)
                .env("COPLAND_PROBE", &script)
                .env("COPLAND_DROID", &droid)
                .env_remove("FACTORY_API_KEY")
                .output()
                .unwrap();
            let said = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            assert!(out.status.success(), "{said}");
            said
        };
        /* A write from droid's runtime: Bun's fs, as its file tools do. */
        let tool = |path: &Path| {
            format!(
                "env BUN_BE_BUN=1 \"$COPLAND_DROID\" -e 'require(\"fs\").writeFileSync(process.argv[1], \"x\")' {}",
                path.display()
            )
        };
        let w = Writable {
            dirs: vec![git_dir.clone(), worktree.clone()],
            extra: vec![extra.clone(), root.join("missing")],
            chdir: worktree.clone(),
            tmp: Some(tmp.clone()),
        };
        let home = home(&tmp);
        let mut probe = String::from(PROBE);
        for d in [&worktree, &git_dir, &extra, &home] {
            probe += &format!("touch {}/sh\n{}\n", d.display(), tool(&d.join("tool")));
        }
        probe += "git add sh tool && git -c user.name=t -c user.email=t@t commit -q -m probe\n";
        probe += &format!(
            "denied touch {o}/sh\ndenied {t}\ndenied touch \"$HOME/copland-droid-{pid}\"\n\
             denied touch {tmp}/settings.json\necho probed\n",
            o = outside.display(),
            t = tool(&outside.join("tool")),
            pid = std::process::id(),
            tmp = tmp.display(),
        );
        assert!(run(&w, probe).contains("probed"));
        for d in [&worktree, &git_dir, &extra, &home] {
            assert!(
                d.join("sh").exists() && d.join("tool").exists(),
                "{} wasn't written",
                d.display()
            );
        }
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
        let log = std::process::Command::new("git")
            .args(["-C", &worktree.to_string_lossy(), "log", "-1", "--format=%s"])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&log.stdout).trim(),
            "probe",
            "the commit didn't land"
        );

        /* Reading only (a lead): nothing in the worktree may be written, the extras still may. */
        let read = Writable {
            dirs: Vec::new(),
            extra: vec![extra.clone()],
            chdir: worktree.clone(),
            tmp: Some(tmp.clone()),
        };
        let probe = format!(
            "{PROBE}denied touch {w}/read\ndenied {t}\ntouch {e}/read\necho probed\n",
            w = worktree.display(),
            t = tool(&worktree.join("read-tool")),
            e = extra.display(),
        );
        assert!(run(&read, probe).contains("probed"));
        assert!(!worktree.join("read").exists() && !worktree.join("read-tool").exists());
        assert!(extra.join("read").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
