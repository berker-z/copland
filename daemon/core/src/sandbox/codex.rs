//! Codex's own sandbox, as the backend for its coding runs (COPL-143): Seatbelt on macOS, bubblewrap
//! and seccomp on Linux, both Codex's.
//!
//! Codex sandboxes the commands it runs, not itself, so the policy goes to Codex rather than around
//! it: `wrap` appends it to the command as `-c` overrides, a permission profile named `copland`
//! that replaces any earlier one of that name. A command for Codex hands what follows its own
//! arguments on to `codex exec` (the box's template does), and leaves the sandbox to the daemon:
//! `forbidden` is what the config refuses in a Codex `code_command`. The whole filesystem reads;
//! the worktree, the clone's `.git`, the worktree's own git dir (which Codex keeps read-only unless
//! it is named), the run's temp dir and `writable` write. Its file edits (`apply_patch`) are held
//! to the same paths: refused before they start, and applied inside the sandbox.
//!
//! Commands reach the network only through Codex's proxy, which lets through `HOSTS` and nothing
//! else: pushing and `gh` over https, and the package registries a fresh worktree installs from.
//! Codex's own traffic (the model, Copland's MCP over HTTP) is Codex's process, outside the
//! sandbox, and needs none of it. Codex runs each command in a sandbox of its own, and the runner
//! kills the runtime's process group once it exits, as under Seatbelt.

use std::path::{Path, PathBuf};

use super::{Backend, Platform, Writable, run_probe};

/// The program Codex's runs start, looked for on PATH.
pub const CODEX: &str = "codex";

/// The profile `wrap` sets. The box's template sets a read-only one of the same name, for runs
/// outside a sandbox of ours; this one replaces it.
pub const PROFILE: &str = "copland";

/// The hosts a run's commands may reach, through Codex's proxy: GitHub for git and `gh`, and npm's
/// and crates.io's registries for a fresh worktree's first build.
pub const HOSTS: [&str; 6] = [
    "github.com",
    "api.github.com",
    "*.githubusercontent.com",
    "registry.npmjs.org",
    "index.crates.io",
    "static.crates.io",
];

/// What a Codex `code_command` may not say, since each would set Codex's sandbox in place of the
/// daemon's: `--sandbox` makes Codex ignore permission profiles, and the rest widen or skip them.
pub const FORBIDDEN: [&str; 7] = [
    "--sandbox",
    "-s",
    "sandbox_mode",
    "--full-auto",
    "--add-dir",
    "--dangerously-bypass-approvals-and-sandbox",
    "--yolo",
];

#[derive(Debug)]
pub struct Codex;

/// Codex's own backend: the same on both platforms, since Codex picks its sandbox itself.
pub fn backend(_platform: Platform) -> Option<&'static dyn Backend> {
    Some(&Codex)
}

/// The first word of `FORBIDDEN` in `argv`, looked for in every argument word by word, so it is
/// found inside a `sh -c` script too.
pub fn forbidden(argv: &[String]) -> Option<&'static str> {
    argv.iter()
        .flat_map(|arg| arg.split(|c: char| c.is_whitespace() || matches!(c, '\'' | '"' | ';' | '=')))
        .find_map(|word| FORBIDDEN.iter().find(|f| **f == word).copied())
}

/// A TOML string, for a path in an inline table. JSON's escapes are TOML's.
fn toml_str(s: &str) -> String {
    serde_json::to_string(s).expect("a string serializes")
}

/// The `-c` overrides that hold Codex's commands to `w`: no approvals (nothing escalates out of the
/// sandbox), the `copland` profile, and the proxy that enforces its hosts. Paths are resolved, as
/// Codex matches real ones (`/var` is `/private/var` on macOS), and missing ones skipped.
pub fn policy(w: &Writable) -> Vec<String> {
    let real = |path: &Path| path.canonicalize().ok();
    let mut write: Vec<PathBuf> = Vec::new();
    for dir in &w.dirs {
        write.extend(real(dir));
        write.extend(git_dir(dir).as_deref().and_then(real));
    }
    write.extend(w.extra.iter().chain(&w.tmp).filter_map(|p| real(p)));
    write.sort();
    write.dedup();
    let mut fs = vec![r#"":root"="read""#.to_string()];
    fs.extend(
        write
            .iter()
            .map(|p| format!("{}=\"write\"", toml_str(&p.to_string_lossy()))),
    );
    let hosts: Vec<String> = HOSTS.iter().map(|h| format!("{}=\"allow\"", toml_str(h))).collect();
    let profile = format!(
        "permissions.{PROFILE}={{filesystem={{{}}},network={{enabled=true,domains={{{}}}}}}}",
        fs.join(","),
        hosts.join(",")
    );
    [
        "approval_policy=\"never\"".to_string(),
        "features.network_proxy=true".to_string(),
        profile,
        format!("default_permissions=\"{PROFILE}\""),
    ]
    .into_iter()
    .flat_map(|c| ["-c".to_string(), c])
    .collect()
}

/// The git dir of a worktree whose `.git` is a file (`gitdir: …`), which Codex protects unless it
/// is named. None for a clone's own `.git` or anything else.
fn git_dir(dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(dir.join(".git")).ok()?;
    let to = text.strip_prefix("gitdir:")?.trim();
    Some(dir.join(to))
}

impl Codex {
    /// `env TMPDIR=…`, when the run has a temp dir of its own, then whatever comes after it.
    fn env(w: &Writable) -> Vec<String> {
        match &w.tmp {
            Some(tmp) => {
                let tmp = tmp.canonicalize().unwrap_or_else(|_| tmp.clone());
                vec!["/usr/bin/env".into(), format!("TMPDIR={}/", tmp.to_string_lossy())]
            }
            None => Vec::new(),
        }
    }

    /// `argv` run straight inside Codex's sandbox with the policy `wrap` gives Codex: `codex
    /// sandbox`, which is how the tests hold it to `Writable` without a model.
    pub fn sandbox(argv: &[String], w: &Writable) -> Vec<String> {
        let mut out = Self::env(w);
        out.extend([CODEX.to_string(), "sandbox".into()]);
        out.extend(policy(w));
        out.push("--".into());
        out.extend(argv.iter().cloned());
        out
    }
}

impl Backend for Codex {
    fn name(&self) -> &'static str {
        "codex"
    }

    fn program(&self) -> &'static str {
        CODEX
    }

    /// The command as it is, with the policy after it and the run's `TMPDIR` before.
    fn wrap(&self, argv: &[String], w: &Writable) -> Vec<String> {
        let mut out = Self::env(w);
        out.extend(argv.iter().cloned());
        out.extend(policy(w));
        out
    }

    /// `true` inside Codex's sandbox, with a policy like a run's.
    fn probe(&self) -> Result<(), String> {
        let w = Writable {
            dirs: Vec::new(),
            extra: Vec::new(),
            chdir: "/".into(),
            tmp: None,
        };
        let argv = Self::sandbox(&["true".into()], &w);
        let mut command = std::process::Command::new(&argv[0]);
        command.args(&argv[1..]).stdin(std::process::Stdio::null());
        run_probe(command)
    }

    fn broken(&self, said: &str) -> String {
        format!(
            "codex's sandbox doesn't work here ({said}): coding runs can't start. Try `codex sandbox -- true`; \
             on Linux Codex needs bubblewrap and unprivileged user namespaces"
        )
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

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn the_policy_goes_after_the_command_and_names_what_may_be_written() {
        let root = std::env::temp_dir().join(format!("copland-codex-policy-{}", std::process::id()));
        let (git, work, extra, tmp) = (
            root.join("r/.git"),
            root.join("work"),
            root.join("state"),
            root.join("t \"x\""),
        );
        for d in [&git, &work, &extra, &tmp] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::create_dir_all(git.join("worktrees/work")).unwrap();
        std::fs::write(
            work.join(".git"),
            format!("gitdir: {}\n", git.join("worktrees/work").display()),
        )
        .unwrap();
        let w = Writable {
            dirs: vec![git.clone(), work.clone()],
            extra: vec![extra.clone(), root.join("missing")],
            chdir: work.clone(),
            tmp: Some(tmp.clone()),
        };
        let argv = Codex.wrap(&s(&["sh", "-c", "exec codex exec \"$@\"", "copland-codex"]), &w);
        let real = |p: &Path| p.canonicalize().unwrap().to_string_lossy().to_string();
        assert_eq!(
            argv[..2],
            ["/usr/bin/env".to_string(), format!("TMPDIR={}/", real(&tmp))]
        );
        assert_eq!(argv[2..6], s(&["sh", "-c", "exec codex exec \"$@\"", "copland-codex"]));
        let c: Vec<&str> = argv[6..]
            .chunks(2)
            .map(|p| {
                assert_eq!(p[0], "-c");
                p[1].as_str()
            })
            .collect();
        assert_eq!(c[0], "approval_policy=\"never\"");
        assert_eq!(c[1], "features.network_proxy=true");
        /* The profile is chosen last, after it is defined, so nothing earlier can change it. */
        assert_eq!(c[3], "default_permissions=\"copland\"");
        let profile = c[2].strip_prefix("permissions.copland=").expect("the whole profile");
        let table: toml::Table = toml::from_str(&format!("p = {profile}")).unwrap();
        let fs = table["p"]["filesystem"].as_table().unwrap();
        assert_eq!(fs[":root"].as_str(), Some("read"));
        for d in [&git, &git.join("worktrees/work"), &work, &extra, &tmp] {
            assert_eq!(fs[&real(d)].as_str(), Some("write"), "{}", d.display());
        }
        assert_eq!(fs.len(), 6, "{fs:?}");
        let net = table["p"]["network"].as_table().unwrap();
        assert_eq!(net["enabled"].as_bool(), Some(true));
        let hosts: Vec<&str> = net["domains"].as_table().unwrap().keys().map(String::as_str).collect();
        assert_eq!(hosts.len(), HOSTS.len());
        assert!(hosts.contains(&"github.com") && hosts.contains(&"api.github.com"));

        /* A lead: nothing of the repo, and no temp dir means no env. */
        let read = Writable {
            dirs: Vec::new(),
            extra: Vec::new(),
            chdir: work.clone(),
            tmp: None,
        };
        let argv = Codex.wrap(&s(&["codex", "exec", "hi"]), &read);
        assert_eq!(argv[..3], s(&["codex", "exec", "hi"]));
        let profile = argv[8].strip_prefix("permissions.copland=").expect("the whole profile");
        let table: toml::Table = toml::from_str(&format!("p = {profile}")).unwrap();
        assert_eq!(table["p"]["filesystem"].as_table().unwrap().len(), 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// Whether Codex's sandbox works here: the real tests skip, saying why, when it doesn't,
    /// unless `COPLAND_TEST_CODEX` is set (CI sets it), when they fail instead.
    fn works_here() -> bool {
        let required = std::env::var_os("COPLAND_TEST_CODEX").is_some();
        let said = match crate::runner::locate(CODEX) {
            None => "codex isn't on PATH".to_string(),
            Some(_) => match Codex.probe() {
                Ok(()) => return true,
                Err(said) => said,
            },
        };
        assert!(
            !required,
            "COPLAND_TEST_CODEX is set but Codex's sandbox can't run: {said}"
        );
        eprintln!("Codex's sandbox doesn't work here; skipping: {said}");
        false
    }

    /// `Codex::sandbox` with a Codex home of its own, so nothing in the user's config (a
    /// `sandbox_mode`, which turns profiles off) changes the policy under test.
    fn confine(argv: &[String], w: &Writable) -> Vec<String> {
        let home = std::env::temp_dir().join(format!("copland-codex-home-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let mut out = vec!["/usr/bin/env".to_string(), format!("CODEX_HOME={}", home.display())];
        out.extend(Codex::sandbox(argv, w));
        out
    }

    fn run(argv: &[String], w: &Writable) -> std::process::Output {
        let argv = confine(argv, w);
        std::process::Command::new(&argv[0])
            .args(&argv[1..])
            .current_dir(&w.chdir)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap()
    }

    /// A scratch directory under `target/`, outside the shared /tmp.
    fn scratch(name: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("core sits in the workspace")
            .join("target")
            .join(format!("copland-codex-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// Shell writes: the one test every backend runs, inside `codex sandbox` with our policy.
    #[test]
    fn holds_to_what_it_may_write() {
        if works_here() {
            super::super::conformance::check_with(&Codex, &confine);
        }
    }

    /// File edits: Codex's `apply_patch`, run the way Codex runs it inside its sandbox, writes the
    /// worktree and nothing outside, and a lead's not even the worktree.
    #[test]
    fn its_file_edits_hold_to_what_it_may_write_too() {
        if !works_here() {
            return;
        }
        let root = scratch("patch");
        let (work, outside) = (root.join("work"), root.join("outside"));
        for d in [&work, &outside] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(outside.join("kept"), "as it was\n").unwrap();
        let tmp = root.join("tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        let worker = Writable {
            dirs: vec![work.clone()],
            extra: Vec::new(),
            chdir: work.clone(),
            tmp: Some(tmp.clone()),
        };
        let patch = |body: String| {
            let argv = vec![
                CODEX.to_string(),
                "--codex-run-as-apply-patch".into(),
                format!("*** Begin Patch\n{body}*** End Patch\n"),
            ];
            move |w: &Writable| run(&argv, w)
        };
        let add = |path: &Path| patch(format!("*** Add File: {}\n+edited\n", path.display()));

        let inside = add(&work.join("in.txt"))(&worker);
        assert!(inside.status.success(), "{}", String::from_utf8_lossy(&inside.stderr));
        assert_eq!(std::fs::read_to_string(work.join("in.txt")).unwrap(), "edited\n");

        let out = add(&outside.join("new.txt"))(&worker);
        assert!(!out.status.success() && !outside.join("new.txt").exists());
        let kept = outside.join("kept");
        let out = patch(format!(
            "*** Update File: {}\n@@\n-as it was\n+changed\n",
            kept.display()
        ))(&worker);
        assert!(!out.status.success());
        assert_eq!(std::fs::read_to_string(&kept).unwrap(), "as it was\n");

        let lead = Writable {
            dirs: Vec::new(),
            ..worker.clone()
        };
        let out = add(&work.join("lead.txt"))(&lead);
        assert!(!out.status.success() && !work.join("lead.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A worker commits in its worktree: its git dir, which Codex keeps read-only unless it is
    /// named, is writable, and so is the clone's `.git` the commit lands in.
    #[test]
    fn a_worker_commits_in_its_worktree() {
        if !works_here() {
            return;
        }
        let root = scratch("git");
        let (clone, work) = (root.join("clone"), root.join("work"));
        let git = |dir: &Path, args: &[&str]| {
            let out = std::process::Command::new("git")
                .args([
                    "-c",
                    "user.email=t@t",
                    "-c",
                    "user.name=t",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        std::fs::create_dir_all(&clone).unwrap();
        git(&clone, &["init", "-q"]);
        git(&clone, &["commit", "-q", "--allow-empty", "-m", "base"]);
        git(&clone, &["worktree", "add", "-q", work.to_str().unwrap(), "-b", "t"]);
        let w = Writable {
            dirs: vec![clone.join(".git"), work.clone()],
            extra: Vec::new(),
            chdir: work.clone(),
            tmp: None,
        };
        let script =
            "echo x >f && git add f && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm f";
        let out = run(&s(&["sh", "-c", script]), &w);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let log = std::process::Command::new("git")
            .args(["log", "--format=%s", "-1"])
            .current_dir(&work)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&log.stdout).trim(), "f");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Commands reach `HOSTS` through Codex's proxy and nothing else, directly or through it.
    #[test]
    fn its_commands_reach_only_the_hosts_it_allows() {
        if !works_here() || crate::runner::locate("curl").is_none() {
            return;
        }
        let root = scratch("net");
        let w = Writable {
            dirs: vec![root.clone()],
            extra: Vec::new(),
            chdir: root.clone(),
            tmp: None,
        };
        let curl = |args: &str| {
            let script = format!("curl -sS -m 20 -o /dev/null -w '%{{http_code}}' {args}");
            String::from_utf8_lossy(&run(&s(&["sh", "-c", &script]), &w).stdout).to_string()
        };
        assert!(
            curl("https://github.com").starts_with(['2', '3']),
            "github.com through the proxy"
        );
        assert_eq!(curl("https://example.com"), "000", "a host it doesn't allow");
        assert_eq!(curl("--noproxy '*' https://github.com"), "000", "around the proxy");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_command_that_sets_codexs_sandbox_itself_is_found() {
        assert_eq!(
            forbidden(&s(&["codex", "exec", "--sandbox", "read-only", "{prompt}"])),
            Some("--sandbox")
        );
        assert_eq!(
            forbidden(&s(&["codex", "exec", "-s", "danger-full-access"])),
            Some("-s")
        );
        assert_eq!(
            forbidden(&s(&["sh", "-c", "exec codex exec --yolo \"$@\"", "copland-codex"])),
            Some("--yolo")
        );
        assert_eq!(
            forbidden(&s(&["codex", "exec", "-c", "sandbox_mode=\"workspace-write\""])),
            Some("sandbox_mode")
        );
        assert_eq!(forbidden(&s(&["codex", "exec", "--add-dir=/"])), Some("--add-dir"));
        assert_eq!(
            forbidden(&s(&["codex", "exec", "-m", "gpt-5", "--ephemeral", "{prompt}"])),
            None
        );
        /* The prompt is filled in later; a word in a template's own text isn't one of these. */
        assert_eq!(forbidden(&s(&["codex", "exec", "--sandboxed-thing"])), None);
    }
}
