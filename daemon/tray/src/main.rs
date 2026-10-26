//! `copland-tray`: the daemon running a config in the system tray (COPL-198). It watches the
//! daemon's status socket, shows whether its agents are idle, working or need you, and can hold
//! an agent on this machine or stop a run, and opens the box on the same config (COPL-201). It
//! never starts the daemon, and quitting it leaves the daemon (and any box) running. Linux (a
//! StatusNotifierItem) only for now.

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
    use copland_daemon_core::config::{default_config_path, default_runtime_dir};
    use copland_tray::follow::{self, Request, Seen};
    use copland_tray::sni::Tray;
    use copland_tray::view::Action;
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
    tokio::spawn(follow::run(config.clone(), default_runtime_dir(), requests_rx, seen_tx));
    /* Why opening the box failed, from the blocking task that tried. */
    let (failed_tx, mut failed) = mpsc::unbounded_channel::<String>();
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
            Some(why) = failed.recv() => {
                tracing::warn!(error = %why, "opening the box");
                if tray.update(|t| t.fail(why)).await.is_none() {
                    anyhow::bail!("the tray icon went away");
                }
            }
            action = actions.recv() => {
                let request = match action {
                    None | Some(Action::Quit) => break,
                    Some(Action::OpenBox) => {
                        let (config, failed) = (config.clone(), failed_tx.clone());
                        tokio::task::spawn_blocking(move || {
                            if let Err(e) = copland_tray::open::open(&config) {
                                let _ = failed.send(format!("{e:#}"));
                            }
                        });
                        continue;
                    }
                    Some(Action::Hold { slot }) => Request::Hold { slot },
                    Some(Action::Release { slot }) => Request::Release { slot },
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
