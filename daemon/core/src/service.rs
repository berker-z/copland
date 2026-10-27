//! The headless daemon as a service of the user's (COPL-180), and started from another program
//! (COPL-199). `copland-daemon --install-service` and `--uninstall-service` are `install` and
//! `uninstall`: a systemd user unit on Linux, a launchd agent on macOS, running the program given
//! with the config given. They say what they did as values (`Installed`, `Uninstalled`), which
//! the CLI prints and the box can draw. Rendering is pure (`systemd_unit`, `launchd_plist`); the
//! files in `release/` are what they render for a release's layout, and a test holds the two
//! together.
//!
//! Under Nix (COPL-218) the service is the flake's home-manager module's: when the program is in
//! the Nix store (`nix_managed`), `install` and `uninstall` write and remove nothing and say what
//! to add instead (`NixManaged`, `module_lines`).
//!
//! For a program that isn't the daemon (the box): `installed` says whether a service is there,
//! `start` starts an installed one (`restart` again, on a new config), `daemon_binary` finds the
//! `copland-daemon` shipped with it, `spawn_session` starts one for this session only, detached
//! from its caller, and `stop_daemon` stops whichever runs a config (signing out, COPL-205).

use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead as _, BufReader, Read as _, Seek as _, SeekFrom, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};

use crate::config::{Config, default_runtime_dir, default_state_dir, expand_home};
use crate::lock::{self, Holder};

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

/// The systemd user unit running `program --headless [--config FILE]`. No PATH: the daemon builds
/// the one it looks runtimes up on when it starts (`search_path`). Logs go to the journal: the
/// daemon writes them to stderr, without colour when that isn't a terminal.
pub fn systemd_unit(program: &str, config: Option<&str>) -> String {
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
    /* `systemctl reload`: the daemon reads its config again, and a config that doesn't load fails the reload. */
    let mut reload = vec![exec_word(program), "reload".to_string()];
    if let Some(c) = config {
        reload.extend(["--config".to_string(), exec_word(c)]);
    }
    out.push_str(&format!("ExecReload={}\n", reload.join(" ")));
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
/// fails (not after a clean stop), with its output appended to `log`. No PATH, as for the unit.
pub fn launchd_plist(program: &str, config: Option<&str>, log: &str) -> String {
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

/// Something `install` noticed on the way, worth telling whoever installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Note {
    /// A daemon already runs the config; the service retries until it stops.
    AlreadyRunning { config: String, holder: Holder },
    /// systemd's lingering is off for the user, so the service stops at logout.
    NoLinger { user: String },
}

impl std::fmt::Display for Note {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Note::AlreadyRunning { config, holder } => write!(
                f,
                "Note: a daemon is already running {config} ({holder}). The service retries every {RESTART_SEC}s \
                 and takes over once that one stops."
            ),
            Note::NoLinger { user } => write!(
                f,
                "Your user's services stop when you log out. On a server, keep them running with \
                 `sudo loginctl enable-linger {user}`."
            ),
        }
    }
}

/* ---------- under Nix (COPL-218) ---------- */

/// Where the home-manager module and its options are explained.
pub const MODULE_DOCS: &str = "https://github.com/berker-z/copland/blob/main/daemon/README.md#installing-it";

/// The Nix stores a program can be in: /nix/store, and `$NIX_STORE` when that names another.
pub fn nix_stores() -> Vec<PathBuf> {
    let mut stores = vec![PathBuf::from("/nix/store")];
    if let Some(s) = std::env::var_os("NIX_STORE").map(PathBuf::from)
        && s.is_absolute()
        && !stores.contains(&s)
    {
        stores.push(s);
    }
    stores
}

/// Whether `path` is inside one of `stores`.
pub fn in_store(path: &Path, stores: &[PathBuf]) -> bool {
    stores.iter().any(|s| path.starts_with(s) && path != s)
}

/// Whether `exe` is a build of Nix's: it, or what its links resolve to (a profile's
/// `bin/copland-daemon` is a link into the store), is in one of `stores`. Its service and its
/// tray at login are then the home-manager module's (`services.copland`): nothing here writes
/// or removes a unit or an autostart entry for it.
pub fn nix_managed_in(exe: &Path, stores: &[PathBuf]) -> bool {
    in_store(exe, stores) || fs::canonicalize(exe).is_ok_and(|r| in_store(&r, stores))
}

/// `nix_managed_in` the stores there are (`nix_stores`).
pub fn nix_managed(exe: &Path) -> bool {
    nix_managed_in(exe, &nix_stores())
}

/// Whether the running binary is Nix's (`nix_managed`): the box and the daemon ship together, so
/// this says it for the daemon beside it too.
pub fn nix_managed_here() -> bool {
    std::env::current_exe().is_ok_and(|e| nix_managed(&e))
}

/// The module's lines to add to a home-manager configuration, with the option names
/// `nix/hm-module.nix` has: `configFile` only when the config isn't the default one, the tray's
/// line when it is wanted.
pub fn module_lines(config: Option<&Path>, tray: bool) -> Vec<String> {
    let mut lines = vec![
        "services.copland.enable = true;".to_string(),
        "services.copland.runtimes = [ pkgs.claude-code pkgs.git pkgs.gh ];".to_string(),
    ];
    if let Some(c) = config {
        let c = c
            .display()
            .to_string()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace("${", "\\${");
        lines.push(format!("services.copland.configFile = \"{c}\";"));
    }
    if tray {
        lines.push("services.copland.tray.enable = true;".to_string());
    }
    lines
}

/// All of it: the flake input, the import and `module_lines`, to paste.
pub fn module_snippet(config: Option<&Path>, tray: bool) -> String {
    let mut out = String::from(
        "# flake.nix\n\
         inputs.copland.url = \"github:berker-z/copland?dir=daemon\";\n\
         \n\
         # your home-manager configuration\n\
         imports = [ inputs.copland.homeManagerModules.default ];\n",
    );
    for l in module_lines(config, tray) {
        out.push_str(&l);
        out.push('\n');
    }
    out
}

/// A unit at `unit` that is a file of its own rather than a link: one an earlier
/// `--install-service` wrote, which home-manager won't replace with its link.
pub fn leftover(unit: &Path) -> Option<PathBuf> {
    fs::symlink_metadata(unit)
        .is_ok_and(|m| m.file_type().is_file())
        .then(|| unit.to_path_buf())
}

/// `leftover` where `install` writes its unit (Linux only: launchd has no module).
pub fn leftover_unit() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        None
    } else {
        leftover(&unit_path())
    }
}

/// Whether this session has a display, so the tray's line is worth suggesting.
fn graphical_here() -> bool {
    crate::autostart::graphical(
        std::env::var("DISPLAY").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
    )
}

/// Why `install` and `uninstall` did nothing: the daemon is Nix's, so home-manager runs its
/// service. Says what to add instead, and what an earlier install left in the way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NixManaged {
    pub program: PathBuf,
    /// The config, for `configFile`, when it isn't the default one.
    pub config: Option<PathBuf>,
    /// Whether to add the tray's line.
    pub tray: bool,
    /// A unit an earlier `--install-service` wrote (`leftover`).
    pub leftover: Option<PathBuf>,
}

impl NixManaged {
    /// For `program` on `config` (the default one is left out), looking for a leftover unit.
    pub fn here(program: &Path, config: Option<&Path>, tray: bool) -> Self {
        let resolved = |c: &Path| fs::canonicalize(c).unwrap_or_else(|_| c.to_path_buf());
        /* Both resolved: on macOS the temp dir and the like are behind a link (/var, /private/var). */
        let default = resolved(&crate::config::default_config_path());
        let config = config.map(resolved).filter(|c| *c != default);
        Self {
            program: program.to_path_buf(),
            config,
            tray,
            leftover: leftover_unit(),
        }
    }

    /// What an earlier install left, and how to clear it: home-manager's switch stops at it.
    fn leftover_says(&self) -> String {
        match &self.leftover {
            Some(f) => format!(
                "\n{f} was written by an earlier --install-service, and home-manager won't replace it. \
                 Remove it before you switch: `systemctl --user disable --now {UNIT} && rm {f}`.\n",
                f = f.display()
            ),
            None => String::new(),
        }
    }

    /// What `--uninstall-service` says: nothing removed, the module is where it goes.
    pub fn uninstall_says(&self) -> String {
        format!(
            "{} is from the Nix store, so its service is home-manager's: nothing was stopped or removed. \
             Take services.copland out of your home-manager configuration and switch.\n{}",
            self.program.display(),
            self.leftover_says()
        )
    }

    /// The module to add, indented to print, then what an earlier install left in the way.
    pub fn add_module(&self) -> String {
        let mut out = format!("Add the flake's module to your configuration and switch ({MODULE_DOCS}):\n\n");
        for l in module_snippet(self.config.as_deref(), self.tray).lines() {
            if !l.is_empty() {
                out.push_str("  ");
                out.push_str(l);
            }
            out.push('\n');
        }
        out + &self.leftover_says()
    }
}

impl std::fmt::Display for NixManaged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} is from the Nix store, so its service is home-manager's: nothing was written. {}",
            self.program.display(),
            self.add_module()
        )
    }
}

impl std::error::Error for NixManaged {}

/// Where the service's log goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Log {
    /// systemd's journal, read with `journalctl --user -u copland-daemon`.
    Journal,
    /// A file (launchd's `StandardErrorPath`).
    File(PathBuf),
}

/// What `install` did: wrote `file`, then enabled and started `name` (`UNIT` or `LABEL`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub file: PathBuf,
    pub name: &'static str,
    pub log: Log,
    pub notes: Vec<Note>,
}

/// Write the platform's service running `program` on `config`, then enable and start it.
/// `copland-daemon --install-service` passes itself; another program passes `daemon_binary()`.
/// Refused, writing nothing, when `program` is Nix's (`nix_managed`): its service is the
/// home-manager module's then, and the error says how to add it (`NixManaged`).
pub fn install(config: &Path, program: &Path) -> Result<Installed> {
    if nix_managed(program) {
        return Err(NixManaged::here(program, Some(config), graphical_here()).into());
    }
    if !config.exists() {
        bail!(
            "no config at {} yet: run `copland-daemon --setup` first (with the same --config, if you gave one), \
             then --install-service",
            config.display()
        );
    }
    Config::load(config).context("loading the config, which the service would run")?;
    let config = fs::canonicalize(config).with_context(|| format!("resolving {}", config.display()))?;
    let (program, config) = (display(program)?, display(&config)?);

    let mut notes = Vec::new();
    if let Ok(Some(holder)) = lock::running(Path::new(&config), &default_runtime_dir()) {
        notes.push(Note::AlreadyRunning {
            config: config.clone(),
            holder,
        });
    }

    if cfg!(target_os = "macos") {
        let plist = plist_path();
        let log = log_path();
        for dir in [plist.parent(), log.parent()].into_iter().flatten() {
            fs::create_dir_all(dir).with_context(|| format!("making {}", dir.display()))?;
        }
        fs::write(&plist, launchd_plist(&program, Some(&config), &display(&log)?))
            .with_context(|| format!("writing {}", plist.display()))?;
        let domain = format!("gui/{}", uid()?);
        /* Loaded already (installed before): out first, so the new file is the one that runs. */
        let _ = run("launchctl", &["bootout", &format!("{domain}/{LABEL}")]);
        run("launchctl", &["bootstrap", &domain, &display(&plist)?])?;
        Ok(Installed {
            file: plist,
            name: LABEL,
            log: Log::File(log),
            notes,
        })
    } else {
        let unit = unit_path();
        if let Some(dir) = unit.parent() {
            fs::create_dir_all(dir).with_context(|| format!("making {}", dir.display()))?;
        }
        fs::write(&unit, systemd_unit(&program, Some(&config)))
            .with_context(|| format!("writing {}", unit.display()))?;
        run("systemctl", &["--user", "daemon-reload"])?;
        run("systemctl", &["--user", "enable", UNIT])?;
        /* restart, not start: a reinstall's new unit replaces the one running. */
        run("systemctl", &["--user", "restart", UNIT])?;
        let user = std::env::var("USER").unwrap_or_else(|_| "$USER".into());
        let linger = Command::new("loginctl")
            .args(["show-user", &user, "--property=Linger", "--value"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        if !matches!(linger.as_deref(), Ok("yes")) {
            notes.push(Note::NoLinger { user });
        }
        Ok(Installed {
            file: unit,
            name: UNIT,
            log: Log::Journal,
            notes,
        })
    }
}

/// What `uninstall` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Uninstalled {
    /// Stopped `name` and removed `file`.
    Removed { name: &'static str, file: PathBuf },
    /// Nothing to do: `file` isn't there.
    NotInstalled { file: PathBuf },
    /// Nothing done: the daemon is Nix's, and so is its service.
    Nix(NixManaged),
}

/// Stop, disable and remove the service `install` wrote. Nothing is stopped or removed when this
/// binary is Nix's: `--uninstall-service` says to take the module out instead (`NixManaged`).
pub fn uninstall() -> Result<Uninstalled> {
    if let Ok(exe) = std::env::current_exe()
        && nix_managed(&exe)
    {
        return Ok(Uninstalled::Nix(NixManaged::here(&exe, None, false)));
    }
    if cfg!(target_os = "macos") {
        let plist = plist_path();
        if !plist.exists() {
            return Ok(Uninstalled::NotInstalled { file: plist });
        }
        let _ = run("launchctl", &["bootout", &format!("gui/{}/{LABEL}", uid()?)]);
        fs::remove_file(&plist).with_context(|| format!("removing {}", plist.display()))?;
        Ok(Uninstalled::Removed {
            name: LABEL,
            file: plist,
        })
    } else {
        let unit = unit_path();
        if !unit.exists() {
            return Ok(Uninstalled::NotInstalled { file: unit });
        }
        run("systemctl", &["--user", "disable", "--now", UNIT])?;
        fs::remove_file(&unit).with_context(|| format!("removing {}", unit.display()))?;
        run("systemctl", &["--user", "daemon-reload"])?;
        Ok(Uninstalled::Removed { name: UNIT, file: unit })
    }
}

/// An installed service, as `installed` finds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Service {
    /// The unit or plist: on Linux wherever systemd loaded it from (`FragmentPath`), so
    /// home-manager's link in ~/.config/systemd/user, or a unit under /etc, counts too.
    pub file: PathBuf,
    /// Whether it starts by itself: on Linux, `systemctl --user is-enabled` says enabled; on
    /// macOS always, since launchd loads every agent in ~/Library/LaunchAgents at login.
    pub enabled: bool,
    /// Whether systemd says it is running (`ActiveState`). None where that isn't asked (macOS,
    /// or no user manager to ask): the status socket says then (`lock::running`).
    pub running: Option<bool>,
    /// Whether its ExecStart is in the Nix store: Nix's, the home-manager module's.
    pub nix: bool,
}

/// The `copland-daemon` service when there is one, wherever its unit lives: so a setup with a
/// config and no service (0.4.x, or a box-only one) can be told from a service that is
/// stopped. On Linux it asks `systemctl --user show`, which finds the unit `install` writes and
/// home-manager's alike; without a user manager to ask, it looks for `install`'s file.
pub fn installed() -> Option<Service> {
    if cfg!(target_os = "macos") {
        let file = plist_path();
        return file.exists().then_some(Service {
            file,
            enabled: true,
            running: None,
            nix: false,
        });
    }
    let shown = Command::new("systemctl")
        .args([
            "--user",
            "show",
            UNIT,
            "--property=LoadState,FragmentPath,UnitFileState,ActiveState,ExecStart",
        ])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| shown(&String::from_utf8_lossy(&o.stdout), &nix_stores()));
    match shown {
        Some(found) => found,
        None => {
            let file = unit_path();
            file.exists().then(|| Service {
                nix: fs::read_to_string(&file).is_ok_and(|t| exec_in_store(&t, &nix_stores())),
                file,
                enabled: false,
                running: None,
            })
        }
    }
}

/// The service in what `systemctl show` printed for it: `Some(None)` when systemd has no such
/// unit, None when what it printed isn't an answer (no LoadState).
fn shown(text: &str, stores: &[PathBuf]) -> Option<Option<Service>> {
    let get = |key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(key)?.strip_prefix('='))
            .map(str::trim)
    };
    let load = get("LoadState")?;
    if load != "loaded" {
        return Some(None);
    }
    let file = get("FragmentPath").filter(|f| !f.is_empty()).map(PathBuf::from)?;
    Some(Some(Service {
        file,
        enabled: is_enabled(get("UnitFileState").unwrap_or("")),
        running: Some(matches!(get("ActiveState"), Some("active" | "reloading"))),
        nix: exec_in_store(&format!("ExecStart={}", get("ExecStart").unwrap_or("")), stores),
    }))
}

/// Whether the program a unit starts is in the Nix store: `ExecStart=/nix/store/…` in a unit
/// file, or `ExecStart={ path=/nix/store/… ; argv[]=… }` as `systemctl show` says it.
fn exec_in_store(unit: &str, stores: &[PathBuf]) -> bool {
    unit.lines()
        .filter_map(|l| l.trim().strip_prefix("ExecStart="))
        .any(|v| {
            let v = v.trim().trim_start_matches('{').trim();
            let v = v.strip_prefix("path=").unwrap_or(v);
            /* systemd's prefixes: `-`, `@`, `+`, `!`, `:`. */
            let program = v.trim_start_matches(['-', '@', '+', '!', ':']).split([' ', ';']).next();
            program.is_some_and(|p| in_store(Path::new(p), stores))
        })
}

/// What `--check` says about the service: whether there is one, where, whether it is Nix's,
/// enabled and running. Without one, how to get one: the module when this daemon is Nix's
/// (`nix_here`), `--install-service` otherwise.
pub fn describe(service: Option<&Service>, nix_here: bool) -> String {
    let Some(s) = service else {
        return if nix_here {
            format!(
                "service: none. This copland-daemon is from the Nix store, so add the flake's home-manager module \
                 (services.copland.enable = true; {MODULE_DOCS}) and switch."
            )
        } else {
            "service: none (`copland-daemon --install-service` installs one).".into()
        };
    };
    let mut says = vec![if s.nix { "managed by Nix" } else { "installed" }.to_string()];
    says.push(if s.enabled { "enabled" } else { "not enabled" }.into());
    match s.running {
        Some(true) => says.push("running".into()),
        Some(false) => says.push(format!("not running: `systemctl --user start {UNIT}` starts it")),
        None => {}
    }
    format!("service: {} ({}).", says.join(", "), s.file.display())
}

/// What `systemctl is-enabled` prints for a unit that starts by itself.
fn is_enabled(says: &str) -> bool {
    matches!(says.trim(), "enabled" | "enabled-runtime")
}

/// Start the installed service (`systemctl --user start`, `launchctl kickstart`), without
/// waiting for it to come up: the status socket says when it has.
pub fn start() -> Result<()> {
    if installed().is_none() {
        bail!("no service installed: `copland-daemon --install-service` installs one");
    }
    if cfg!(target_os = "macos") {
        let domain = format!("gui/{}", uid()?);
        /* Booted out since login (`launchctl bootout`): load it again, which starts it (RunAtLoad). */
        if run("launchctl", &["kickstart", &format!("{domain}/{LABEL}")]).is_err() {
            run("launchctl", &["bootstrap", &domain, &display(&plist_path())?])?;
        }
        Ok(())
    } else {
        run("systemctl", &["--user", "start", UNIT])
    }
}

/// Start the installed service again, so it reads its config anew (setup has just written
/// one): `systemctl --user restart`, `launchctl kickstart -k`. Starts it when it is stopped.
pub fn restart() -> Result<()> {
    if installed().is_none() {
        bail!("no service installed: `copland-daemon --install-service` installs one");
    }
    if cfg!(target_os = "macos") {
        let domain = format!("gui/{}", uid()?);
        if run("launchctl", &["kickstart", "-k", &format!("{domain}/{LABEL}")]).is_err() {
            run("launchctl", &["bootstrap", &domain, &display(&plist_path())?])?;
        }
        Ok(())
    } else {
        run("systemctl", &["--user", "restart", UNIT])
    }
}

/// Stop the installed service without removing it (`systemctl --user stop`, `launchctl
/// bootout`): it starts again at the next login, or with `start`. Nothing to do without one.
pub fn stop() -> Result<()> {
    if installed().is_none() {
        return Ok(());
    }
    if cfg!(target_os = "macos") {
        /* Not loaded (booted out already) is stopped too. */
        let _ = run("launchctl", &["bootout", &format!("gui/{}/{LABEL}", uid()?)]);
        Ok(())
    } else {
        run("systemctl", &["--user", "stop", UNIT])
    }
}

/// How long `stop_daemon` waits for a daemon it sent SIGTERM to: its runs get ten seconds
/// before they are killed, then it finishes them.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(20);

/// Stop whatever daemon runs `config` (signing out, before its tokens go): the service when
/// one is installed, then any other daemon still holding the config's lock (one started for the
/// session, or on a terminal) with SIGTERM, waiting until it lets go. Says whether one ran.
pub fn stop_daemon(config: &Path) -> Result<bool> {
    let was = installed().is_some() && running_now(config)?;
    stop()?;
    Ok(stop_holder(config, &default_runtime_dir(), STOP_TIMEOUT)? || was)
}

fn running_now(config: &Path) -> Result<bool> {
    let config = fs::canonicalize(config).unwrap_or_else(|_| config.to_path_buf());
    Ok(lock::running(&config, &default_runtime_dir())?.is_some())
}

/// SIGTERM to the daemon holding `config`'s lock, then wait up to `timeout` for the lock to go.
fn stop_holder(config: &Path, runtime_dir: &Path, timeout: Duration) -> Result<bool> {
    let config = fs::canonicalize(config).unwrap_or_else(|_| config.to_path_buf());
    let Some(holder) = lock::running(&config, runtime_dir)? else {
        return Ok(false);
    };
    let Some(pid) = holder.pid else {
        bail!(
            "a daemon is running {} but its pid is unknown: stop it yourself",
            config.display()
        );
    };
    if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } == -1 {
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::ESRCH) {
            return Err(e).with_context(|| format!("stopping the daemon ({holder})"));
        }
    }
    let started = Instant::now();
    while lock::running(&config, runtime_dir)?.is_some() {
        if started.elapsed() >= timeout {
            bail!(
                "the daemon running {} ({holder}) didn't stop within {}s",
                config.display(),
                timeout.as_secs()
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(true)
}

/// The daemon's binary name.
pub const DAEMON: &str = "copland-daemon";

/// The `copland-daemon` to start from another program: the one beside the running executable
/// (they ship together: the release tarballs, the macOS app's Contents/MacOS, the Nix package's
/// bin), else the first on `PATH`.
pub fn daemon_binary() -> Result<PathBuf> {
    let exe = std::env::current_exe().ok();
    find_daemon(
        exe.as_deref().and_then(Path::parent),
        std::env::var_os("PATH").as_deref(),
    )
}

fn executable(p: &Path) -> bool {
    fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn find_daemon(beside: Option<&Path>, path: Option<&OsStr>) -> Result<PathBuf> {
    let found = beside
        .map(|d| d.join(DAEMON))
        .into_iter()
        .chain(path.into_iter().flat_map(std::env::split_paths).map(|d| d.join(DAEMON)))
        .find(|p| p.is_absolute() && executable(p));
    found.with_context(|| match beside {
        Some(d) => format!(
            "no {DAEMON} beside {} or on PATH: it ships with the box, so install the two together",
            d.display()
        ),
        None => format!("no {DAEMON} on PATH: it ships with the box, so install the two together"),
    })
}

/// Where a session daemon's output goes: `<state dir>/daemon.log`, appended to.
pub fn session_log() -> PathBuf {
    default_state_dir().join("daemon.log")
}

/// How long `spawn_session` waits for the daemon's socket to answer.
pub const SESSION_TIMEOUT: Duration = Duration::from_secs(15);

/// A daemon `spawn_session` started and saw answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub pid: u32,
    pub program: PathBuf,
    pub log: PathBuf,
}

/// Start `copland-daemon --headless --config <config>` for this session only: detached from the
/// caller (a session of its own, stdin from /dev/null, output appended to `session_log()`), so
/// the caller closing doesn't stop it. Blocks until its status socket answers, or it exits, or
/// `SESSION_TIMEOUT` passes; the error then says which, with what it logged meanwhile. Refuses
/// when a daemon runs the config already. It isn't a service: it doesn't start at login, and
/// stops with the user's session (or SIGTERM, as any daemon).
pub fn spawn_session(config: &Path) -> Result<Session> {
    spawn(
        &daemon_binary()?,
        config,
        &default_runtime_dir(),
        &session_log(),
        SESSION_TIMEOUT,
    )
}

fn spawn(program: &Path, config: &Path, runtime_dir: &Path, log: &Path, timeout: Duration) -> Result<Session> {
    if !config.exists() {
        bail!("no config at {}: set this machine up first", config.display());
    }
    let config = fs::canonicalize(config).with_context(|| format!("resolving {}", config.display()))?;
    if let Some(holder) = lock::running(&config, runtime_dir)? {
        bail!("a daemon is already running {} ({holder})", config.display());
    }
    if let Some(dir) = log.parent() {
        fs::create_dir_all(dir).with_context(|| format!("making {}", dir.display()))?;
    }
    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .with_context(|| format!("opening {}", log.display()))?;
    let from = out.metadata().map(|m| m.len()).unwrap_or(0);
    let err = out.try_clone().with_context(|| format!("opening {}", log.display()))?;
    let args: [OsString; 3] = ["--headless".into(), "--config".into(), config.clone().into()];
    let mut command = Command::new(program);
    command
        .args(args)
        /* The socket is looked for under this runtime dir, so the daemon puts it there. */
        .env("XDG_RUNTIME_DIR", runtime_dir)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .current_dir("/");
    /* Its own session: no controlling terminal, and out of the caller's process group, so a
    terminal's ctrl+c or hangup for the caller doesn't reach it. setsid is async-signal-safe. */
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("starting {}", program.display()))?;
    let socket = lock::socket_for(&config, runtime_dir);
    let started = Instant::now();
    loop {
        if answers(&socket) {
            let pid = child.id();
            reap(child);
            return Ok(Session {
                pid,
                program: program.into(),
                log: log.into(),
            });
        }
        if let Some(status) = child.try_wait().context("waiting for the daemon")? {
            bail!(
                "{} exited ({status}) before it came up{}",
                program.display(),
                logged(log, from)
            );
        }
        if started.elapsed() >= timeout {
            /* Not left half up: a daemon nobody can see would hold the config's lock. */
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "{} didn't answer on {} within {}s, so it was stopped{}",
                program.display(),
                socket.display(),
                timeout.as_secs(),
                logged(log, from)
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Whether a daemon answers a status request on `socket`.
fn answers(socket: &Path) -> bool {
    let Ok(mut stream) = UnixStream::connect(socket) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(b"{\"op\":\"status\"}\n").is_err() {
        return false;
    }
    let mut line = String::new();
    matches!(BufReader::new(stream).read_line(&mut line), Ok(n) if n > 0 && line.ends_with('\n'))
}

/// Wait for the child in the background, so it isn't left a zombie of the caller when it exits.
fn reap(mut child: Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

/// What the log got after `from`, its last lines, as `: …` for an error, or nothing.
fn logged(log: &Path, from: u64) -> String {
    let mut text = String::new();
    if let Ok(mut f) = File::open(log) {
        let _ = f.seek(SeekFrom::Start(from)).and_then(|_| f.read_to_string(&mut text));
    }
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return format!(" (nothing in {})", log.display());
    }
    format!(": {}", lines[lines.len().saturating_sub(5)..].join("\n"))
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
        );
        assert!(unit.contains(
            "\nExecStart=/home/me/.local/bin/copland-daemon --headless --config \"/home/me/my configs/daemon.toml\"\n"
        ));
        assert!(unit.contains(
            "\nExecReload=/home/me/.local/bin/copland-daemon reload --config \"/home/me/my configs/daemon.toml\"\n"
        ));
        /* No PATH: the daemon finds its runtimes when it starts (COPL-216). */
        assert!(!unit.contains("Environment="));
        assert!(unit.contains("\nRestart=on-failure\nRestartSec=10\n"));
        assert!(unit.contains("\nKillMode=mixed\n"));
        assert!(unit.ends_with("[Install]\nWantedBy=default.target\n"));
        /* No --config: the daemon's default. */
        let bare = systemd_unit("/bin/copland-daemon", None);
        assert!(bare.contains("\nExecStart=/bin/copland-daemon --headless\nExecReload=/bin/copland-daemon reload\n"));
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
            "/Users/me/Library/Logs/copland-daemon.log",
        );
        assert!(plist.contains(&format!("<string>{LABEL}</string>")));
        assert!(plist.contains(
            "\t<array>\n\t\t<string>/Applications/Copland.app/Contents/MacOS/copland-daemon</string>\n\
             \t\t<string>--headless</string>\n\t\t<string>--config</string>\n\
             \t\t<string>/Users/me/a&amp;b/daemon.toml</string>\n\t</array>\n"
        ));
        assert!(plist.contains("<key>RunAtLoad</key>\n\t<true/>"));
        assert!(plist.contains("<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>"));
        assert!(
            plist
                .contains("<key>StandardErrorPath</key>\n\t<string>/Users/me/Library/Logs/copland-daemon.log</string>")
        );
        assert!(!plist.contains("EnvironmentVariables"));
    }

    /// The release's files are these renderings: the tarball's unit for its ~/.local layout (the
    /// flake swaps in its store path), the plist with placeholders for the two absolute paths
    /// launchd needs.
    #[test]
    fn release_files_are_what_install_writes() {
        assert_eq!(
            release("copland-daemon.service"),
            systemd_unit("/PROGRAM", None).replace("/PROGRAM", "%h/.local/bin/copland-daemon")
        );
        assert_eq!(
            release(&format!("{LABEL}.plist")),
            launchd_plist("@DAEMON@", None, "@LOG@")
        );
    }

    fn scratch(name: &str) -> PathBuf {
        /* /tmp, not $TMPDIR: macOS's is long enough to push the socket past SUN_LEN. */
        let dir = PathBuf::from("/tmp").join(format!("copland-service-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn script(path: &Path, text: &str) {
        fs::write(path, text).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn finds_the_daemon_beside_the_program_then_on_path() {
        let dir = scratch("find");
        let (app, bin, other) = (dir.join("app"), dir.join("bin"), dir.join("other"));
        for d in [&app, &bin, &other] {
            fs::create_dir_all(d).unwrap();
        }
        script(&bin.join(DAEMON), "#!/bin/sh\n");
        let path = std::env::join_paths([&other, &bin]).unwrap();
        /* Nothing beside it: PATH's. */
        assert_eq!(find_daemon(Some(&app), Some(&path)).unwrap(), bin.join(DAEMON));
        /* Beside it wins over PATH. */
        script(&app.join(DAEMON), "#!/bin/sh\n");
        assert_eq!(find_daemon(Some(&app), Some(&path)).unwrap(), app.join(DAEMON));
        /* Not executable, or a directory, doesn't count. */
        fs::set_permissions(app.join(DAEMON), fs::Permissions::from_mode(0o644)).unwrap();
        fs::create_dir_all(other.join(DAEMON)).unwrap();
        assert_eq!(find_daemon(Some(&app), Some(&path)).unwrap(), bin.join(DAEMON));
        /* None anywhere: says where it looked. A relative PATH entry is never taken. */
        let err = find_daemon(Some(&app), Some(OsStr::new("relative:")))
            .unwrap_err()
            .to_string();
        assert!(err.contains(&format!("no {DAEMON} beside {}", app.display())), "{err}");
        assert!(find_daemon(None, None).unwrap_err().to_string().contains("on PATH"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_systemctl_is_enabled() {
        assert!(is_enabled("enabled\n"));
        assert!(is_enabled("enabled-runtime\n"));
        for no in ["disabled\n", "linked\n", "masked\n", "static\n", ""] {
            assert!(!is_enabled(no), "{no:?}");
        }
    }

    #[test]
    fn notes_read_as_the_cli_printed_them() {
        assert_eq!(
            Note::NoLinger { user: "me".into() }.to_string(),
            "Your user's services stop when you log out. On a server, keep them running with \
             `sudo loginctl enable-linger me`."
        );
        let holder = Holder {
            pid: Some(7),
            binary: Some("copland-box".into()),
        };
        assert_eq!(
            Note::AlreadyRunning {
                config: "/c.toml".into(),
                holder
            }
            .to_string(),
            "Note: a daemon is already running /c.toml (pid 7, copland-box). The service retries every 10s \
             and takes over once that one stops."
        );
    }

    #[test]
    fn a_program_in_the_store_or_linked_into_it_is_nix_managed() {
        let dir = scratch("nix");
        let store = dir.join("store");
        let program = store.join("abc-copland-0.5.0/bin").join(DAEMON);
        fs::create_dir_all(program.parent().unwrap()).unwrap();
        script(&program, "#!/bin/sh\n");
        let stores = [store.clone()];
        assert!(nix_managed_in(&program, &stores));
        /* A profile's bin is a link into the store: it counts. */
        let profile = dir.join("profile/bin");
        fs::create_dir_all(&profile).unwrap();
        std::os::unix::fs::symlink(&program, profile.join(DAEMON)).unwrap();
        assert!(nix_managed_in(&profile.join(DAEMON), &stores));
        /* A copy outside doesn't, nor does the store itself. */
        fs::copy(&program, dir.join(DAEMON)).unwrap();
        assert!(!nix_managed_in(&dir.join(DAEMON), &stores));
        assert!(!nix_managed_in(&store, &stores));
        /* A store path that isn't there (gone after a collection) still counts, by its name. */
        assert!(nix_managed_in(
            Path::new("/nix/store/gone/bin/copland-daemon"),
            &nix_stores()
        ));
        assert!(!nix_managed_in(
            Path::new("/nix/storefront/bin/copland-daemon"),
            &nix_stores()
        ));
        assert!(!nix_managed_in(
            Path::new("/home/me/.local/bin/copland-daemon"),
            &nix_stores()
        ));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn install_under_nix_writes_nothing_and_says_what_to_add() {
        /* Refused before anything else: before the missing config, so before any file. */
        let err = install(
            Path::new("/nonexistent/daemon.toml"),
            Path::new("/nix/store/abc-copland/bin/copland-daemon"),
        )
        .unwrap_err();
        let nix = err.downcast_ref::<NixManaged>().expect("refused as Nix's");
        assert_eq!(nix.program, Path::new("/nix/store/abc-copland/bin/copland-daemon"));
        assert_eq!(nix.config.as_deref(), Some(Path::new("/nonexistent/daemon.toml")));
        let says = err.to_string();
        assert!(
            says.starts_with(
                "/nix/store/abc-copland/bin/copland-daemon is from the Nix store, so its service is home-manager's: \
                 nothing was written."
            ),
            "{says}"
        );
        for line in [
            "  inputs.copland.url = \"github:berker-z/copland?dir=daemon\";\n",
            "  imports = [ inputs.copland.homeManagerModules.default ];\n",
            "  services.copland.enable = true;\n",
            "  services.copland.configFile = \"/nonexistent/daemon.toml\";\n",
        ] {
            assert!(says.contains(line), "{line} in {says}");
        }
        assert!(says.contains(MODULE_DOCS), "{says}");
    }

    #[test]
    fn the_module_lines_use_the_modules_option_names() {
        assert_eq!(
            module_lines(None, true),
            [
                "services.copland.enable = true;",
                "services.copland.runtimes = [ pkgs.claude-code pkgs.git pkgs.gh ];",
                "services.copland.tray.enable = true;",
            ]
        );
        assert_eq!(
            module_lines(Some(Path::new("/w/my \"x\" ${y}.toml")), false)[2],
            "services.copland.configFile = \"/w/my \\\"x\\\" \\${y}.toml\";"
        );
        /* Every option named here is one the module has. */
        let module = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../nix/hm-module.nix")).unwrap();
        for option in ["enable", "runtimes", "configFile", "tray.enable"] {
            assert!(
                module.contains(&format!("\n    {option} = ")),
                "{option} in hm-module.nix"
            );
        }
        assert!(module_snippet(None, false).contains("homeManagerModules.default"));
    }

    #[test]
    fn a_unit_of_its_own_is_left_over_and_a_link_is_not() {
        let dir = scratch("leftover");
        let unit = dir.join(UNIT);
        assert_eq!(leftover(&unit), None);
        fs::write(&unit, "[Service]\n").unwrap();
        assert_eq!(leftover(&unit), Some(unit.clone()));
        let linked = dir.join("linked.service");
        std::os::unix::fs::symlink(&unit, &linked).unwrap();
        assert_eq!(leftover(&linked), None);
        let nix = NixManaged {
            program: "/nix/store/x/bin/copland-daemon".into(),
            config: None,
            tray: false,
            leftover: Some(unit.clone()),
        };
        let says = nix.to_string();
        assert!(says.contains("was written by an earlier --install-service"), "{says}");
        assert!(says.contains(&format!(
            "systemctl --user disable --now {UNIT} && rm {}",
            unit.display()
        )));
        assert!(!says.contains("configFile") && !says.contains("tray.enable"), "{says}");
        assert!(nix.uninstall_says().contains("nothing was stopped or removed"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_the_unit_systemctl_shows() {
        let stores = [PathBuf::from("/nix/store")];
        let hm = "LoadState=loaded\nFragmentPath=/home/me/.config/systemd/user/copland-daemon.service\n\
                  UnitFileState=enabled\nActiveState=active\n\
                  ExecStart={ path=/nix/store/abc-copland/bin/copland-daemon ; argv[]=/nix/store/abc-copland/bin/copland-daemon --headless ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n";
        assert_eq!(
            shown(hm, &stores),
            Some(Some(Service {
                file: "/home/me/.config/systemd/user/copland-daemon.service".into(),
                enabled: true,
                running: Some(true),
                nix: true,
            }))
        );
        let ours = "LoadState=loaded\nFragmentPath=/home/me/.config/systemd/user/copland-daemon.service\n\
                    UnitFileState=disabled\nActiveState=failed\n\
                    ExecStart={ path=/home/me/.local/bin/copland-daemon ; argv[]=/home/me/.local/bin/copland-daemon --headless }\n";
        let s = shown(ours, &stores).unwrap().unwrap();
        assert_eq!((s.enabled, s.running, s.nix), (false, Some(false), false));
        assert_eq!(
            shown("LoadState=not-found\nFragmentPath=\nActiveState=inactive\n", &stores),
            Some(None)
        );
        assert_eq!(shown("", &stores), None, "no answer: look for the file instead");
        /* A unit file's own ExecStart. */
        assert!(exec_in_store(
            "[Service]\nExecStart=/nix/store/x/bin/copland-daemon --headless\n",
            &stores
        ));
        assert!(exec_in_store("ExecStart=-/nix/store/x/bin/copland-daemon\n", &stores));
        assert!(!exec_in_store(
            "ExecStart=/usr/bin/copland-daemon --headless\n",
            &stores
        ));
    }

    #[test]
    fn check_says_where_the_service_is_and_how_to_get_one() {
        assert!(describe(None, false).contains("--install-service"));
        let nix = describe(None, true);
        assert!(
            nix.contains("services.copland.enable = true") && nix.contains(MODULE_DOCS),
            "{nix}"
        );
        let mut s = Service {
            file: "/home/me/.config/systemd/user/copland-daemon.service".into(),
            enabled: true,
            running: Some(true),
            nix: true,
        };
        assert_eq!(
            describe(Some(&s), true),
            "service: managed by Nix, enabled, running (/home/me/.config/systemd/user/copland-daemon.service)."
        );
        (s.nix, s.enabled, s.running) = (false, false, Some(false));
        assert_eq!(
            describe(Some(&s), false),
            "service: installed, not enabled, not running: `systemctl --user start copland-daemon.service` starts it \
             (/home/me/.config/systemd/user/copland-daemon.service)."
        );
    }

    /// The stand-in daemon `spawn` starts in the tests below: this test binary again, running
    /// `stub_daemon` with what the script hands it. Without COPLAND_STUB it is an ordinary
    /// (empty) test.
    #[test]
    fn stub_daemon() {
        let Ok(mode) = std::env::var("COPLAND_STUB") else {
            return;
        };
        let config = PathBuf::from(std::env::var("COPLAND_STUB_CONFIG").unwrap());
        match mode.as_str() {
            "serve" => {
                let socket = lock::socket_for(&config, &default_runtime_dir());
                fs::create_dir_all(socket.parent().unwrap()).unwrap();
                let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
                eprintln!("serving {}", socket.display());
                for stream in listener.incoming() {
                    let mut stream = stream.unwrap();
                    let mut line = String::new();
                    let _ = BufReader::new(&stream).read_line(&mut line);
                    let _ = stream.write_all(b"{}\n");
                }
            }
            "hold" => {
                let _held = lock::Lock::take(&config, &default_runtime_dir(), "stub").unwrap();
                eprintln!("holding");
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            "fail" => {
                eprintln!("starting");
                eprintln!("Error: agent @me/dev: the token is read-only");
                std::process::exit(2);
            }
            _ => loop {
                std::thread::sleep(Duration::from_secs(1));
            },
        }
    }

    /// A `copland-daemon` that runs `stub_daemon` in `mode`, passing on the config it is given.
    fn stub(dir: &Path, mode: &str) -> PathBuf {
        let program = dir.join(DAEMON);
        let me = std::env::current_exe().unwrap();
        script(
            &program,
            &format!(
                "#!/bin/sh\n[ \"$1 $2\" = \"--headless --config\" ] || exit 9\n\
                 COPLAND_STUB={mode} COPLAND_STUB_CONFIG=\"$3\" exec '{}' --exact service::tests::stub_daemon --nocapture\n",
                me.display()
            ),
        );
        program
    }

    #[test]
    fn a_session_daemon_comes_up_on_its_own_and_outlives_the_wait() {
        let dir = scratch("spawn");
        let (config, runtime, log) = (dir.join("daemon.toml"), dir.join("run"), dir.join("state/daemon.log"));
        fs::write(&config, "").unwrap();
        fs::create_dir_all(&runtime).unwrap();
        let program = stub(&dir, "serve");
        let session = spawn(&program, &config, &runtime, &log, Duration::from_secs(20)).unwrap();
        assert_eq!(session.log, log);
        let pid = session.pid as libc::pid_t;
        /* A session of its own, still running once spawn returned. */
        assert_eq!(unsafe { libc::getsid(pid) }, pid);
        assert!(answers(&lock::socket_for(&config, &runtime)));
        /* Its output went to the log, not ours. */
        assert!(fs::read_to_string(&log).unwrap().contains("serving "));
        unsafe { libc::kill(pid, libc::SIGTERM) };
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_session_daemon_that_exits_says_why() {
        let dir = scratch("exits");
        let (config, runtime, log) = (dir.join("daemon.toml"), dir.join("run"), dir.join("daemon.log"));
        fs::write(&config, "").unwrap();
        fs::create_dir_all(&runtime).unwrap();
        /* What an earlier run logged isn't this one's reason. */
        fs::write(&log, "an older run's line\n").unwrap();
        let program = stub(&dir, "fail");
        let err = spawn(&program, &config, &runtime, &log, Duration::from_secs(20))
            .unwrap_err()
            .to_string();
        assert!(err.contains("exited (exit status: 2) before it came up"), "{err}");
        assert!(err.contains("the token is read-only"), "{err}");
        assert!(!err.contains("older run"), "{err}");
        /* No config: refused before anything starts. */
        let err = spawn(&program, &dir.join("none.toml"), &runtime, &log, Duration::from_secs(1)).unwrap_err();
        assert!(err.to_string().contains("no config at"), "{err}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_session_daemon_that_never_answers_is_stopped() {
        let dir = scratch("silent");
        let (config, runtime, log) = (dir.join("daemon.toml"), dir.join("run"), dir.join("daemon.log"));
        fs::write(&config, "").unwrap();
        fs::create_dir_all(&runtime).unwrap();
        let program = stub(&dir, "silent");
        let err = spawn(&program, &config, &runtime, &log, Duration::from_secs(1))
            .unwrap_err()
            .to_string();
        assert!(err.contains("didn't answer on"), "{err}");
        assert!(err.contains("within 1s, so it was stopped"), "{err}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_config_already_running_is_refused() {
        let dir = scratch("held");
        let (config, runtime) = (dir.join("daemon.toml"), dir.join("run"));
        fs::write(&config, "").unwrap();
        let _held = lock::Lock::take(&config, &runtime, "copland-box").unwrap();
        let program = stub(&dir, "serve");
        let err = spawn(
            &program,
            &config,
            &runtime,
            &dir.join("daemon.log"),
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(err.to_string().contains("a daemon is already running"), "{err}");
        assert!(!dir.join("daemon.log").exists(), "nothing started");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_daemon_holding_the_config_is_stopped() {
        let dir = scratch("stop");
        let (config, runtime) = (dir.join("daemon.toml"), dir.join("run"));
        fs::write(&config, "").unwrap();
        fs::create_dir_all(&runtime).unwrap();
        /* Nothing running: nothing stopped. */
        assert!(!stop_holder(&config, &runtime, Duration::from_secs(1)).unwrap());
        let program = stub(&dir, "hold");
        let config = fs::canonicalize(&config).unwrap();
        let mut child = Command::new(&program)
            .args(["--headless", "--config"])
            .arg(&config)
            .env("XDG_RUNTIME_DIR", &runtime)
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while lock::running(&config, &runtime).unwrap().is_none() {
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "the stub never took the lock"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(stop_holder(&config, &runtime, Duration::from_secs(20)).unwrap());
        assert!(lock::running(&config, &runtime).unwrap().is_none());
        assert!(!child.wait().unwrap().success(), "ended by the signal");
        fs::remove_dir_all(&dir).unwrap();
    }
}
