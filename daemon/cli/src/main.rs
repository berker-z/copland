//! `copland-daemon --headless`: run the agents in daemon.toml until stopped.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use copland_daemon_core::config::{default_config_path, default_runtime_dir, default_state_dir};
use copland_daemon_core::{Config, Daemon, Paths, preflight};
use tokio::signal::unix::{SignalKind, signal};

#[derive(Parser)]
#[command(
    version,
    about = "Runs Copland agents on this machine: wakes on their inbox and launches their runtime"
)]
struct Args {
    /// Run without a window. The only mode there is for now, so it is also the default.
    #[arg(long)]
    headless: bool,
    /// The config file [default: $XDG_CONFIG_HOME/copland/daemon.toml]
    #[arg(long, value_name = "FILE")]
    config: Option<PathBuf>,
    /// Read the config, check it, run the preflight checks (runtimes logged in, git, GitHub,
    /// code_dir, each token with its instance), and exit non-zero when one fails.
    #[arg(long)]
    check: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("COPLAND_LOG").unwrap_or_else(|_| "info".into()))
        .with_target(false)
        .with_writer(std::io::stderr)
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .init();
    let args = Args::parse();
    let _ = args.headless;
    let path = args.config.unwrap_or_else(default_config_path);
    if !path.exists() {
        anyhow::bail!(
            "no config at {}: `copland-box --setup` makes one (approve this machine in Copland, pick runtimes), \
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
        println!();
        let checks = preflight::run(&config).await;
        print!("{}", preflight::render(&checks));
        let failed = preflight::failures(&checks);
        if failed > 0 {
            anyhow::bail!("{failed} check(s) failed; `copland-box --check --fix` offers the fixes it can run");
        }
        return Ok(());
    }
    tracing::info!(config = %path.display(), agents = config.agents.len(), poll = ?config.poll_interval, "starting");

    let mut daemon = Daemon::start(
        config,
        Paths {
            state_dir: default_state_dir(),
            runtime_dir: default_runtime_dir(),
        },
    )?;
    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = term.recv() => tracing::info!("SIGTERM: stopping"),
        _ = int.recv() => tracing::info!("SIGINT: stopping"),
        /* Every agent's loop ended by itself: each had a token it can't use (read-only, or a run's secret). */
        _ = daemon.join() => anyhow::bail!("no agent left to watch"),
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
