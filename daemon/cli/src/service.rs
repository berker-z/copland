//! `copland-daemon --install-service` and `--uninstall-service` (COPL-180): the headless daemon
//! as a service of the user's, so it runs on a machine nobody sits at. A systemd user unit on
//! Linux, a launchd agent on macOS, pointing at the running binary and the config it was given.
//! Rendering them is pure (`systemd_unit`, `launchd_plist`); the files in `release/` are what
//! they render for a release's layout, and a test holds the two together.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context as _, Result, bail};
use copland_daemon_core::config::{default_runtime_dir, expand_home};
use copland_daemon_core::{Config, lock};

/// The systemd user unit's name.
pub const UNIT: &str = "copland-daemon.service";
/// The launchd agent's label, beside the app's `dev.berkerz.copland.box`.
pub const LABEL: &str = "dev.berkerz.copland.daemon";
/// Seconds between a failed start and the next, for both.
const RESTART_SEC: u32 = 10;

/// The arguments the service runs the daemon with.
fn arguments(config: Option<&str>) -> Vec<String> {
    let mut args = vec!["--headless".to_string()];
    if let Some(c) = config {
        args.push("--config".into());
        args.push(c.into());
    }
    args
}

/// One word of a systemd `ExecStart=`: `$` doubled so systemd doesn't expand it, then as `word`.
fn exec_word(s: &str) -> String {
    word(&s.replace('$', "$$"))
}

/// A systemd value word: `%` doubled so it isn't a specifier, quoted when it has to be.
fn word(s: &str) -> String {
    let s = s.replace('%', "%%");
    if s.is_empty()
        || s.chars()
            .any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '\\' | ';'))
    {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s
    }
}

/// The systemd user unit running `program --headless [--config FILE]`, with `PATH` when given
/// (the runtimes are looked up on it, and the user manager's is not your shell's). Logs go to the
/// journal: the daemon writes them to stderr, without colour when that isn't a terminal.
pub fn systemd_unit(program: &str, config: Option<&str>, path: Option<&str>) -> String {
    let mut exec = vec![exec_word(program)];
    exec.extend(arguments(config).iter().map(|a| exec_word(a)));
    let mut out = String::from(
        "[Unit]\n\
         Description=Copland daemon: runs your Copland agents on this machine\n\
         Documentation=https://github.com/berker-z/copland/blob/main/daemon/README.md\n\
         \n\
         [Service]\n",
    );
    out.push_str(&format!("ExecStart={}\n", exec.join(" ")));
    if let Some(p) = path {
        out.push_str(&format!("Environment={}\n", word(&format!("PATH={p}"))));
    }
    out.push_str(&format!("Restart=on-failure\nRestartSec={RESTART_SEC}\n"));
    out.push_str(
        "# SIGTERM to the daemon alone: it stops its runtimes and finishes their runs as\n\
         # interrupted, so their tasks go back to todo. Whatever is left after the timeout is killed.\n\
         KillMode=mixed\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
    );
    out
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The launchd agent running `program --headless [--config FILE]` at login, again after it
/// fails (not after a clean stop), with its output appended to `log`.
pub fn launchd_plist(program: &str, config: Option<&str>, path: Option<&str>, log: &str) -> String {
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n",
    );
    out.push_str(&format!("\t<key>Label</key>\n\t<string>{LABEL}</string>\n"));
    out.push_str("\t<key>ProgramArguments</key>\n\t<array>\n");
    for a in std::iter::once(program.to_string()).chain(arguments(config)) {
        out.push_str(&format!("\t\t<string>{}</string>\n", xml(&a)));
    }
    out.push_str("\t</array>\n");
    if let Some(p) = path {
        out.push_str(&format!(
            "\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>PATH</key>\n\t\t<string>{}</string>\n\t</dict>\n",
            xml(p)
        ));
    }
    out.push_str(&format!(
        "\t<key>RunAtLoad</key>\n\t<true/>\n\
         \t<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>\n\
         \t<key>ThrottleInterval</key>\n\t<integer>{RESTART_SEC}</integer>\n\
         \t<key>ProcessType</key>\n\t<string>Background</string>\n\
         \t<key>StandardOutPath</key>\n\t<string>{log}</string>\n\
         \t<key>StandardErrorPath</key>\n\t<string>{log}</string>\n",
        log = xml(log)
    ));
    out.push_str("</dict>\n</plist>\n");
    out
}

/// `$XDG_CONFIG_HOME/systemd/user/copland-daemon.service`, where `systemctl --user` looks.
fn unit_path() -> PathBuf {
    let base = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => expand_home("~/.config"),
    };
    base.join("systemd/user").join(UNIT)
}

fn plist_path() -> PathBuf {
    expand_home("~/Library/LaunchAgents").join(format!("{LABEL}.plist"))
}

fn log_path() -> PathBuf {
    expand_home("~/Library/Logs/copland-daemon.log")
}

/// Run a command, failing with its stderr when it fails.
fn run(program: &str, args: &[&str]) -> Result<()> {
    let out = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("running {program}"))?;
    if !out.status.success() {
        bail!(
            "`{program} {}` failed ({}): {}",
            args.join(" "),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

fn uid() -> Result<String> {
    let out = Command::new("id").arg("-u").output().context("running id -u")?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn display(p: &Path) -> Result<String> {
    p.to_str()
        .map(str::to_string)
        .with_context(|| format!("{} isn't UTF-8", p.display()))
}

/// Write the platform's service for this binary and `config`, then enable and start it.
pub fn install(config: &Path) -> Result<()> {
    if !config.exists() {
        bail!(
            "no config at {} yet: run `copland-daemon --setup` first (with the same --config, if you gave one), \
             then --install-service",
            config.display()
        );
    }
    Config::load(config).context("loading the config, which the service would run")?;
    let config = fs::canonicalize(config).with_context(|| format!("resolving {}", config.display()))?;
    let program = std::env::current_exe().context("finding this binary")?;
    let (program, config) = (display(&program)?, display(&config)?);
    let path = std::env::var("PATH").ok().filter(|p| !p.is_empty());

    if program.starts_with("/nix/store/") {
        println!(
            "Note: {program} is in the Nix store, so the service runs this build until you install it again. \
             The package has a unit of its own in share/systemd/user to use from your Nix config instead."
        );
    }
    if let Ok(Some(holder)) = lock::running(Path::new(&config), &default_runtime_dir()) {
        println!(
            "Note: a daemon is already running {config} ({holder}). The service retries every {RESTART_SEC}s \
             and takes over once that one stops."
        );
    }

    if cfg!(target_os = "macos") {
        let plist = plist_path();
        let log = log_path();
        for dir in [plist.parent(), log.parent()].into_iter().flatten() {
            fs::create_dir_all(dir).with_context(|| format!("making {}", dir.display()))?;
        }
        fs::write(
            &plist,
            launchd_plist(&program, Some(&config), path.as_deref(), &display(&log)?),
        )
        .with_context(|| format!("writing {}", plist.display()))?;
        println!("Wrote {}.", plist.display());
        let domain = format!("gui/{}", uid()?);
        /* Loaded already (installed before): out first, so the new file is the one that runs. */
        let _ = run("launchctl", &["bootout", &format!("{domain}/{LABEL}")]);
        run("launchctl", &["bootstrap", &domain, &display(&plist)?])?;
        println!(
            "Started {LABEL}; it starts again at every login. Its log is {}.",
            log.display()
        );
        println!("Stop and remove it with `copland-daemon --uninstall-service`.");
    } else {
        let unit = unit_path();
        if let Some(dir) = unit.parent() {
            fs::create_dir_all(dir).with_context(|| format!("making {}", dir.display()))?;
        }
        fs::write(&unit, systemd_unit(&program, Some(&config), path.as_deref()))
            .with_context(|| format!("writing {}", unit.display()))?;
        println!("Wrote {}.", unit.display());
        run("systemctl", &["--user", "daemon-reload"])?;
        run("systemctl", &["--user", "enable", UNIT])?;
        /* restart, not start: a reinstall's new unit replaces the one running. */
        run("systemctl", &["--user", "restart", UNIT])?;
        println!("Started {UNIT}; it starts again with your user's session.");
        println!("Its log: journalctl --user -u copland-daemon -f");
        let user = std::env::var("USER").unwrap_or_else(|_| "$USER".into());
        let linger = Command::new("loginctl")
            .args(["show-user", &user, "--property=Linger", "--value"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        if !matches!(linger.as_deref(), Ok("yes")) {
            println!(
                "Your user's services stop when you log out. On a server, keep them running with \
                 `sudo loginctl enable-linger {user}`."
            );
        }
        println!("Stop and remove it with `copland-daemon --uninstall-service`.");
    }
    Ok(())
}

/// Stop, disable and remove the service `install` wrote.
pub fn uninstall() -> Result<()> {
    if cfg!(target_os = "macos") {
        let plist = plist_path();
        if !plist.exists() {
            println!("No service installed ({} isn't there).", plist.display());
            return Ok(());
        }
        let _ = run("launchctl", &["bootout", &format!("gui/{}/{LABEL}", uid()?)]);
        fs::remove_file(&plist).with_context(|| format!("removing {}", plist.display()))?;
        println!("Stopped {LABEL} and removed {}.", plist.display());
    } else {
        let unit = unit_path();
        if !unit.exists() {
            println!("No service installed ({} isn't there).", unit.display());
            return Ok(());
        }
        run("systemctl", &["--user", "disable", "--now", UNIT])?;
        fs::remove_file(&unit).with_context(|| format!("removing {}", unit.display()))?;
        run("systemctl", &["--user", "daemon-reload"])?;
        println!("Stopped {UNIT} and removed {}.", unit.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(name: &str) -> String {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../release").join(name);
        fs::read_to_string(&p).unwrap_or_else(|e| panic!("reading {}: {e}", p.display()))
    }

    #[test]
    fn renders_a_systemd_unit_for_this_binary_and_config() {
        let unit = systemd_unit(
            "/home/me/.local/bin/copland-daemon",
            Some("/home/me/my configs/daemon.toml"),
            Some("/home/me/.local/bin:/usr/bin"),
        );
        assert!(unit.contains(
            "\nExecStart=/home/me/.local/bin/copland-daemon --headless --config \"/home/me/my configs/daemon.toml\"\n"
        ));
        assert!(unit.contains("\nEnvironment=PATH=/home/me/.local/bin:/usr/bin\n"));
        assert!(unit.contains("\nRestart=on-failure\nRestartSec=10\n"));
        assert!(unit.contains("\nKillMode=mixed\n"));
        assert!(unit.ends_with("[Install]\nWantedBy=default.target\n"));
        /* No --config, no PATH: the daemon's defaults and the user manager's. */
        let bare = systemd_unit("/bin/copland-daemon", None, None);
        assert!(bare.contains("\nExecStart=/bin/copland-daemon --headless\n"));
        assert!(!bare.contains("Environment="));
    }

    #[test]
    fn escapes_what_systemd_would_read_as_its_own() {
        assert_eq!(exec_word("/a/b"), "/a/b");
        assert_eq!(exec_word("/a b"), "\"/a b\"");
        assert_eq!(exec_word("/100%/$HOME"), "/100%%/$$HOME");
        assert_eq!(exec_word("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(exec_word(""), "\"\"");
        /* Environment= expands specifiers but not variables. */
        assert_eq!(word("PATH=/x y:/$z%"), "\"PATH=/x y:/$z%%\"");
    }

    #[test]
    fn renders_a_launchd_agent() {
        let plist = launchd_plist(
            "/Applications/Copland.app/Contents/MacOS/copland-daemon",
            Some("/Users/me/a&b/daemon.toml"),
            Some("/opt/homebrew/bin:/usr/bin"),
            "/Users/me/Library/Logs/copland-daemon.log",
        );
        assert!(plist.contains(&format!("<string>{LABEL}</string>")));
        assert!(plist.contains(
            "\t<array>\n\t\t<string>/Applications/Copland.app/Contents/MacOS/copland-daemon</string>\n\
             \t\t<string>--headless</string>\n\t\t<string>--config</string>\n\
             \t\t<string>/Users/me/a&amp;b/daemon.toml</string>\n\t</array>\n"
        ));
        assert!(plist.contains("<key>PATH</key>\n\t\t<string>/opt/homebrew/bin:/usr/bin</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n\t<true/>"));
        assert!(plist.contains("<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>"));
        assert!(
            plist
                .contains("<key>StandardErrorPath</key>\n\t<string>/Users/me/Library/Logs/copland-daemon.log</string>")
        );
        assert!(!launchd_plist("/x", None, None, "/l").contains("EnvironmentVariables"));
    }

    /// The release's files are these renderings: the tarball's unit for its ~/.local layout (the
    /// flake swaps in its store path), the plist with placeholders for the two absolute paths
    /// launchd needs.
    #[test]
    fn release_files_are_what_install_writes() {
        assert_eq!(
            release("copland-daemon.service"),
            systemd_unit("/PROGRAM", None, None).replace("/PROGRAM", "%h/.local/bin/copland-daemon")
        );
        assert_eq!(
            release(&format!("{LABEL}.plist")),
            launchd_plist("@DAEMON@", None, None, "@LOG@")
        );
    }
}
