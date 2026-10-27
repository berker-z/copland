//! `copland-daemon --headless`: run the agents in daemon.toml until stopped.
//! `--setup` writes daemon.toml on a terminal, `--check` checks this machine,
//! `--install-service` runs it as a systemd or launchd service, `status` asks the one running,
//! `hold` and `release` hold one of its agents on this machine and let it go, `reload` has it read
//! its config again (as SIGHUP does).

mod setup;

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use copland_daemon_core::client;
use copland_daemon_core::config::{default_config_path, default_runtime_dir, default_state_dir};
use copland_daemon_core::search_path;
use copland_daemon_core::service::{self, Log, NixManaged, Note, Uninstalled};
use copland_daemon_core::socket::Serve;
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
    /// on Linux, a launchd agent on macOS. Written, enabled and started; it starts again at login
    /// (or boot, with lingering) and after a failure. Needs the config, so --setup first.
    #[arg(long, conflicts_with_all = ["check", "setup", "uninstall_service"])]
    install_service: bool,
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
        return install_service(&path);
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
        println!(
            "{}",
            service::describe(service::installed().as_ref(), service::nix_managed_here())
        );
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
fn install_service(config: &std::path::Path) -> Result<()> {
    let program = std::env::current_exe().context("finding this binary")?;
    /* Nix's: home-manager runs the service, so nothing is written (COPL-218). */
    let done = match service::install(config, &program) {
        Err(e) if e.is::<NixManaged>() => {
            print!("{e}");
            std::process::exit(1);
        }
        done => done?,
    };
    let (linger, early): (Vec<_>, Vec<_>) = done.notes.iter().partition(|n| matches!(n, Note::NoLinger { .. }));
    for note in early {
        println!("{note}");
    }
    println!("Wrote {}.", done.file.display());
    match &done.log {
        Log::File(log) => println!(
            "Started {}; it starts again at every login. Its log is {}.",
            done.name,
            log.display()
        ),
        Log::Journal => {
            println!("Started {}; it starts again with your user's session.", done.name);
            println!("Its log: journalctl --user -u copland-daemon -f");
        }
    }
    for note in linger {
        println!("{note}");
    }
    println!("Stop and remove it with `copland-daemon --uninstall-service`.");
    Ok(())
}
