//! `copland-daemon --headless`: run the agents in daemon.toml until stopped.
//! `--setup` writes daemon.toml on a terminal, `--check` checks this machine,
//! `--install-service` runs it as a systemd or launchd service (`--autostart`: at login too),
//! `start` and `stop` start and stop it by hand (the launcher's), `status` asks the one running,
//! `hold` and `release` hold one of its agents on this machine and let it go, `reload` has it read
//! its config again (as SIGHUP does).

mod setup;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use copland_daemon_core::client;
use copland_daemon_core::config::{default_config_path, default_runtime_dir, default_state_dir};
use copland_daemon_core::search_path;
use copland_daemon_core::service::{self, Installed, Log, NixManaged, Note, Uninstalled};
use copland_daemon_core::socket::Serve;
use copland_daemon_core::stable::Unstable;
use copland_daemon_core::{Config, Daemon, Lock, Paths};
use tokio::signal::unix::{SignalKind, signal};

#[derive(Parser)]
#[command(
    version,
    about = "Runs Copland agents on this machine: wakes on their inbox and launches their runtime"
)]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
    /// Run without a window. The only mode there is for now, so it is also the default.
    #[arg(long)]
    headless: bool,
    /// The config file [default: $XDG_CONFIG_HOME/copland/daemon.toml]
    #[arg(long, value_name = "FILE", global = true)]
    config: Option<PathBuf>,
    /// Read the config, check it, run the preflight checks (runtimes logged in, git, GitHub,
    /// code_dir, each token with its instance), and exit non-zero when one fails.
    #[arg(long, conflicts_with = "setup")]
    check: bool,
    /// With --check: offer each failing check's fix on the terminal (y/N), run the ones you say
    /// yes to, then check again.
    #[arg(long, requires = "check")]
    fix: bool,
    /// Set this machine up on the terminal: approve it in Copland, pick a runtime and workdir per
    /// agent, write the config (keeping one already there as a backup) and check it.
    #[arg(long)]
    setup: bool,
    /// With --setup: your Copland's address, instead of being asked for it.
    #[arg(long, value_name = "ADDRESS", requires = "setup")]
    url: Option<String>,
    /// Run the daemon as a service of yours, on this binary and this config: a systemd user unit
    /// on Linux, a launchd agent on macOS. Written and started now; it starts again after a
    /// failure, and by hand (`copland-daemon start`, the "Copland Daemon" launcher), not at login
    /// unless --autostart. Needs the config, so --setup first.
    #[arg(long, conflicts_with_all = ["check", "setup", "uninstall_service"])]
    install_service: bool,
    /// With --install-service: start it at login too (or at boot, with lingering), for a server or
    /// a headless machine. Without it, an earlier install's start at login is turned off.
    #[arg(long, visible_alias = "enable", requires = "install_service")]
    autostart: bool,
    /// Stop, disable and remove the service --install-service wrote. When this binary is from the
    /// Nix store, both write and remove nothing: they print the home-manager module to add.
    #[arg(long, conflicts_with_all = ["check", "setup"])]
    uninstall_service: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Show what the daemon running this config is doing, from its status socket. Exits 3 when
    /// no daemon is running it.
    Status {
        /// The status as JSON (daemon/README.md's "Status"), one snapshot per line.
        #[arg(long)]
        json: bool,
        /// Show it again on every change, until interrupted.
        #[arg(long)]
        watch: bool,
    },
    /// Hold an agent of the daemon running this config on this machine: it starts no run and
    /// claims nothing until released; runs going finish. Not Copland's pause, and forgotten when
    /// the daemon restarts. Exits 3 when no daemon is running the config.
    Hold {
        /// The agent's handle, as Copland or daemon.toml has it (me/dev or @me/dev).
        handle: String,
    },
    /// Release an agent held with `hold`: it polls at once and starts what waits.
    Release {
        /// The agent's handle, as Copland or daemon.toml has it.
        handle: String,
    },
    /// Have the daemon running this config read it again and run what it says now, as SIGHUP
    /// does: new agents start, removed ones stop and changed ones start again with what changed,
    /// each after its runs. Prints what changed. A config that doesn't load changes nothing and
    /// exits 1. Exits 3 when no daemon is running the config.
    Reload,
    /// Start the daemon by hand, as the "Copland Daemon" launcher does: the installed service
    /// (and the tray's unit, when the home-manager module made one), else a daemon on this config
    /// until you log out.
    Start,
    /// Stop the daemon running this config (the service, or one started otherwise) and the tray
    /// showing it (its unit, or one started otherwise), as the tray's Stop Copland does. Runs
    /// going finish as interrupted, their tasks back in todo. Neither starts again until started.
    Stop,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("COPLAND_LOG").unwrap_or_else(|_| "info".into()))
        .with_target(false)
        .with_writer(std::io::stderr)
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .init();
    let args = Args::parse();
    let _ = args.headless;
    /* Running the agents, or checking that they can run: the PATH runtimes are found on is built
    now (COPL-216), before the runtime's threads, since setting it isn't thread safe. */
    let runs = args.command.is_none() && !(args.setup || args.install_service || args.uninstall_service);
    if runs {
        let path = search_path::set();
        if !args.check {
            tracing::info!(path = %path.to_string_lossy(), "runtimes are looked up on");
        }
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("starting the async runtime")?
        .block_on(run(args))
}

async fn run(args: Args) -> Result<()> {
    let named = args.config.is_some();
    let path = args.config.unwrap_or_else(default_config_path);
    if let Some(Command::Start | Command::Stop) = args.command {
        return by_hand(matches!(args.command, Some(Command::Start)), &path);
    }
    if let Some(command) = args.command {
        /* COPL-185: the client lives in core's `client`. */
        let (runtime_dir, out) = (default_runtime_dir(), &mut std::io::stdout());
        let shown = match command {
            Command::Status { json, watch } => {
                let clear = watch && !json && std::io::IsTerminal::is_terminal(&std::io::stdout());
                let mode = client::Mode { json, watch, clear };
                client::status(&path, &runtime_dir, mode, out).await?
            }
            Command::Hold { handle } => client::hold(&path, &runtime_dir, &handle, true, out).await?,
            Command::Release { handle } => client::hold(&path, &runtime_dir, &handle, false, out).await?,
            Command::Reload => client::reload(&path, &runtime_dir, out).await?,
            Command::Start | Command::Stop => unreachable!("handled above"),
        };
        if let Some(says) = shown.says(&path, named) {
            eprintln!("{says}");
            std::process::exit(client::NOT_RUNNING);
        }
        return Ok(());
    }
    if args.setup {
        return setup::run(&path, args.url.as_deref()).await;
    }
    if args.install_service {
        return install_service(&path, args.autostart);
    }
    if args.uninstall_service {
        match service::uninstall()? {
            Uninstalled::NotInstalled { file } => println!("No service installed ({} isn't there).", file.display()),
            Uninstalled::Removed { name, file } => println!("Stopped {name} and removed {}.", file.display()),
            Uninstalled::Nix(nix) => {
                print!("{}", nix.uninstall_says());
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if !path.exists() {
        anyhow::bail!(
            "no config at {}: `copland-daemon --setup` makes one (approve this machine in Copland, pick runtimes), \
             or write it by hand as daemon/README.md says",
            path.display()
        );
    }
    let config = Config::load(&path).with_context(|| "loading the config")?;
    if args.check {
        /* What each agent runs, then the preflight (COPL-161): runtimes logged in, git, GitHub,
        code_dir, and each token asked who it is, so a bad or read-only one shows now, not at the
        first poll. */
        for a in &config.agents {
            println!("@{} at {}: {:?} in {}", a.handle, a.url, a.command, a.workdir.display());
        }
        let installed = service::installed();
        println!("{}", service::describe(installed.as_ref(), service::nix_managed_here()));
        if let Some(says) = installed.as_ref().and_then(|s| service::program_says(s, &path)) {
            println!("{says}");
        }
        println!();
        let failed = setup::check(&config, args.fix).await?;
        if failed > 0 {
            anyhow::bail!(
                "{failed} check(s) failed{}",
                if args.fix {
                    ""
                } else {
                    "; `copland-daemon --check --fix` offers the fixes it can run"
                }
            );
        }
        return Ok(());
    }
    /* One daemon per config (COPL-175): held until the process ends. */
    let lock = Lock::take(&path, &default_runtime_dir(), "copland-daemon")?;
    tracing::info!(config = %path.display(), agents = config.agents.len(), poll = ?config.poll_interval, "starting");

    let mut daemon = Daemon::start(
        config,
        Paths {
            state_dir: default_state_dir(),
            runtime_dir: default_runtime_dir(),
        },
        Some(Serve {
            socket: lock.socket(),
            config: path.clone(),
        }),
    )?;
    /* A server's daemon outlives the tray, a workstation's is stopped from it (COPL-224). */
    daemon.set_autostart(service::autostarts(std::process::id()));
    let mut reloads = daemon.reloads().expect("taken once, here");
    let reloader = daemon.reloader(path.clone());
    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    let mut hup = signal(SignalKind::hangup())?;
    loop {
        tokio::select! {
            _ = term.recv() => { tracing::info!("SIGTERM: stopping"); break }
            _ = int.recv() => { tracing::info!("SIGINT: stopping"); break }
            /* COPL-197: the config again, as the socket's reload. Answered below, by this loop. */
            _ = hup.recv() => {
                tracing::info!("SIGHUP: reloading {}", path.display());
                let reloader = reloader.clone();
                tokio::spawn(async move {
                    if let Err(e) = reloader.reload().await {
                        tracing::error!("reload: {e:#}");
                    }
                });
            }
            Some(req) = reloads.recv() => req.answer(&mut daemon),
            /* Every agent's loop ended by itself: each had a token it can't use (read-only, or a run's secret). */
            _ = daemon.join() => anyhow::bail!("no agent left to watch"),
        }
    }
    daemon.shutdown();
    /* A second signal means now: runs left behind go stale and their claims lapse within the lease. */
    tokio::select! {
        _ = daemon.join() => {}
        _ = term.recv() => { tracing::warn!("second signal: exiting without waiting"); std::process::exit(1); }
        _ = int.recv() => { tracing::warn!("second signal: exiting without waiting"); std::process::exit(130); }
    }
    Ok(())
}

/// `--install-service` on this binary, saying what it did (COPL-199: the work is core's).
fn install_service(config: &Path, autostart: bool) -> Result<()> {
    let program = std::env::current_exe().context("finding this binary")?;
    /* Nix's: home-manager runs the service, so nothing is written (COPL-218). */
    /* Somewhere it won't stay: nothing is written, and it says how to install it (COPL-219). */
    let done = match service::install(config, &program, autostart) {
        Err(e) if e.is::<NixManaged>() || e.is::<Unstable>() => {
            print!("{e}");
            std::process::exit(1);
        }
        done => done?,
    };
    print!("{}", installed_says(&done));
    Ok(())
}

/// What an install did, as `--install-service` and `--setup` print it.
fn installed_says(done: &Installed) -> String {
    let mut out = String::new();
    let (linger, early): (Vec<_>, Vec<_>) = done.notes.iter().partition(|n| matches!(n, Note::NoLinger { .. }));
    for note in early {
        out += &format!("{note}\n");
    }
    out += &format!("{}.\n", done.wrote.says(&done.file));
    let when = match (done.autostart, &done.log) {
        (true, Log::File(_)) => "it starts again at every login",
        (true, Log::Journal) => "it starts again with your user's session",
        (false, _) => {
            "it doesn't start at login: start it again with `copland-daemon start` or the Copland Daemon \
             launcher (`--install-service --autostart` starts it at login, for a server)"
        }
    };
    out += &format!("Started {}; {when}.\n", done.name);
    out += &match &done.log {
        Log::File(log) => format!("Its log is {}.\n", log.display()),
        Log::Journal => "Its log: journalctl --user -u copland-daemon -f\n".into(),
    };
    for note in linger {
        out += &format!("{note}\n");
    }
    out += "Stop it with `copland-daemon stop`, and remove it with `copland-daemon --uninstall-service`.\n";
    out
}

/// `start` and `stop`: the daemon by hand, as the launcher and its Stop action run it (COPL-223).
fn by_hand(start: bool, config: &Path) -> Result<()> {
    if !start {
        let stopped = service::stop_daemon(config)?;
        let tray = service::stop_tray(config)?;
        println!(
            "{}{}",
            if stopped {
                "Stopped the daemon"
            } else {
                "No daemon was running"
            },
            if tray { ", and the tray." } else { "." }
        );
        return Ok(());
    }
    match service::installed() {
        Some(s) => {
            service::start()?;
            let tray = service::tray(true)?;
            println!(
                "Started the service ({}){}.",
                s.file.display(),
                if tray { " and the tray" } else { "" }
            );
        }
        None => {
            let session = service::spawn_session(config)?;
            println!(
                "No service installed, so this daemon (pid {}) runs {} until you log out. Its log is {}.",
                session.pid,
                config.display(),
                session.log.display()
            );
        }
    }
    Ok(())
}
