//! `copland-tray`: the daemon running a config in the system tray (COPL-198). It watches the
//! daemon's status socket, shows whether its agents are idle, working or need you, and can hold
//! an agent on this machine or stop a run, and opens the box on the same config (COPL-201). On a
//! workstation it also stops the daemon and itself together, and starts the daemon when none
//! runs (COPL-224); a server's daemon, which starts at login, it leaves running when it quits.
//! One tray per config: it holds the config's tray lock, which `copland-daemon stop` finds it by.
//! Linux (a StatusNotifierItem) only for now.

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
    use copland_daemon_core::service;
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
    /* One tray per config: a second (its autostart entry and its unit both, say) leaves quietly. */
    let _lock = match copland_daemon_core::Lock::take_tray(&config, &default_runtime_dir(), "copland-tray") {
        Ok(lock) => lock,
        Err(e) => match e.downcast_ref::<copland_daemon_core::lock::Held>() {
            Some(held) => {
                tracing::info!(holder = %held.holder, "a tray is already showing {}", config.display());
                return Ok(());
            }
            None => return Err(e),
        },
    };

    let (actions_tx, mut actions) = mpsc::unbounded_channel();
    let tray = Tray::new(actions_tx)
        .spawn()
        .await
        .context("showing the tray icon: is a StatusNotifierItem host (a bar's tray) running?")?;
    let (requests, requests_rx) = mpsc::unbounded_channel();
    let (seen_tx, mut seen) = watch::channel(Seen::default());
    tracing::info!(config = %config.display(), "watching");
    tokio::spawn(follow::run(config.clone(), default_runtime_dir(), requests_rx, seen_tx));
    /* Why opening the box, or starting or stopping the daemon, failed, from the blocking task that tried. */
    let (failed_tx, mut failed) = mpsc::unbounded_channel::<String>();
    /* The daemon stopped from the menu: the tray goes too. */
    let (stopped_tx, mut stopped) = mpsc::unbounded_channel::<()>();
    let mut stopping = false;
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
            Some(()) = stopped.recv() => break,
            Some(why) = failed.recv() => {
                stopping = false;
                tracing::warn!(error = %why, "from the menu");
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
                    Some(Action::StopCopland) => {
                        if stopping {
                            continue;
                        }
                        stopping = true;
                        let (config, failed, stopped) = (config.clone(), failed_tx.clone(), stopped_tx.clone());
                        tokio::task::spawn_blocking(move || match service::stop_daemon(&config) {
                            Ok(_) => drop(stopped.send(())),
                            Err(e) => drop(failed.send(format!("stopping the daemon: {e:#}"))),
                        });
                        continue;
                    }
                    Some(Action::StartCopland) => {
                        let (config, failed) = (config.clone(), failed_tx.clone());
                        tokio::task::spawn_blocking(move || {
                            if let Err(e) = start(&config) {
                                let _ = failed.send(format!("starting the daemon: {e:#}"));
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

/// `copland-daemon start --config <config>`, as the launcher runs it: the service when one is
/// installed (and the tray's unit, which finds this tray holding the lock and leaves), else a
/// daemon for this session. Run as its own process, so a session daemon isn't the tray's child.
#[cfg(target_os = "linux")]
fn start(config: &std::path::Path) -> anyhow::Result<()> {
    use anyhow::Context;
    let program = copland_daemon_core::service::daemon_binary()?;
    let out = std::process::Command::new(&program)
        .arg("start")
        .arg("--config")
        .arg(config)
        .stdin(std::process::Stdio::null())
        .output()
        .with_context(|| format!("running {}", program.display()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!(
            "{} ({})",
            err.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("").trim(),
            out.status
        );
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("copland-tray isn't supported on this platform yet: it is Linux only for now");
    std::process::exit(1);
}
