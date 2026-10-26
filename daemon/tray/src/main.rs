//! `copland-tray`: the daemon running a config in the system tray (COPL-198). It watches the
//! daemon's status socket, shows whether its agents are idle, working or need you, and can hold
//! an agent on this machine or stop a run. It never starts the daemon, and quitting it leaves the
//! daemon running. Linux (a StatusNotifierItem) only for now.

#[cfg(target_os = "linux")]
use std::path::PathBuf;

#[cfg(target_os = "linux")]
#[derive(clap::Parser)]
#[command(
    version,
    about = "The Copland daemon in the system tray: what its agents are doing, from its status socket"
)]
struct Args {
    /// The config of the daemon to watch [default: $XDG_CONFIG_HOME/copland/daemon.toml]
    #[arg(long, value_name = "FILE")]
    config: Option<PathBuf>,
}

#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use anyhow::Context;
    use clap::Parser;
    use copland_daemon_core::client::Request;
    use copland_daemon_core::config::{default_config_path, default_runtime_dir};
    use copland_tray::sni::Tray;
    use copland_tray::view::Action;
    use copland_tray::watcher::{self, Seen};
    use ksni::TrayMethods;
    use tokio::sync::{mpsc, watch};

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "copland_tray=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let args = Args::parse();
    let config = args.config.unwrap_or_else(default_config_path);

    let (actions_tx, mut actions) = mpsc::unbounded_channel();
    let tray = Tray::new(actions_tx)
        .spawn()
        .await
        .context("showing the tray icon: is a StatusNotifierItem host (a bar's tray) running?")?;
    let (requests, requests_rx) = mpsc::unbounded_channel();
    let (seen_tx, mut seen) = watch::channel(Seen::default());
    tracing::info!(config = %config.display(), "watching");
    tokio::spawn(watcher::run(
        config,
        default_runtime_dir(),
        watcher::RETRY,
        requests_rx,
        seen_tx,
    ));
    loop {
        tokio::select! {
            changed = seen.changed() => {
                if changed.is_err() {
                    break;
                }
                let now = seen.borrow_and_update().clone();
                if tray.update(|t| t.show(&now)).await.is_none() {
                    anyhow::bail!("the tray icon went away");
                }
            }
            action = actions.recv() => {
                let request = match action {
                    None | Some(Action::Quit) => break,
                    Some(Action::Hold { slot }) => Request::Hold { slot, held: true },
                    Some(Action::Release { slot }) => Request::Hold { slot, held: false },
                    Some(Action::StopRun { slot, run }) => Request::StopRun { slot, run },
                };
                let _ = requests.send(request);
            }
        }
    }
    tray.shutdown().await;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("copland-tray isn't supported on this platform yet: it is Linux only for now");
    std::process::exit(1);
}
