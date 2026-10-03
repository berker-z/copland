//! `copland-box`: the Copland daemon with a window. It runs the same agents'
//! loop as `copland-daemon --headless`, in this process, and draws its state
//! as the wired scene (COPL-33). `--demo` draws the prototype's simulation
//! instead, with no config and no server.

mod agents;
mod edit;
mod feed;
mod hyprland;
mod menu;
mod notify;
mod prefs;
mod runtime;
mod scene;
mod setup;
mod theme;
mod view;
#[cfg(test)]
mod webts;
mod wizard;

use std::cell::OnceCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use anyhow::{Context as _, Result};
use clap::Parser;
use copland_daemon_core::config::{default_config_path, default_runtime_dir, default_state_dir};
use copland_daemon_core::{Config, Daemon, DaemonState, Paths, RunStopper};
use gpui::{
    AppContext as _, Application, Bounds, SharedString, WindowBounds, WindowDecorations, WindowKind, WindowOptions, px,
    size,
};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{mpsc, oneshot, watch};

use crate::agents::{Control, Reload, SetupAgain};
use crate::feed::{Feed, Notices};
use crate::menu::Prefs;
use crate::notify::{Desktop, Notifier};
use crate::scene::{Scene, Tune};
use crate::theme::Theme;
use crate::view::{BoxView, Source};
use crate::wizard::Wizard;

/// The Wayland app id and X11 WM class, for compositor rules.
pub const APP_ID: &str = "copland-box";

/// The first of these the system has; else fontconfig's monospace, else a common one.
const PREFERRED_FONTS: [&str; 3] = [
    "JetBrains Mono",
    "JetBrainsMono Nerd Font Mono",
    "JetBrainsMono Nerd Font",
];
const FALLBACK_FONTS: [&str; 4] = ["DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono", "Ubuntu Mono"];

#[derive(Parser)]
#[command(
    version,
    about = "The Copland daemon with a window: runs the agents in daemon.toml and draws them as wires and poles"
)]
struct Args {
    /// The config file [default: $XDG_CONFIG_HOME/copland/daemon.toml]
    #[arg(long, value_name = "FILE")]
    config: Option<PathBuf>,
    /// Draw a simulation instead of the daemon: no config, no server, nothing launched.
    #[arg(long)]
    demo: bool,
    /// Set the box up in its window: your Copland's address, approving this machine there,
    /// the runtimes to use. What a box without a config does by itself; with one, it is kept
    /// as daemon.toml.bak.
    #[arg(long, conflicts_with = "demo")]
    setup: bool,
    /// Your Copland's address, filled in for setup.
    #[arg(long, value_name = "ADDRESS")]
    url: Option<String>,
    /// A Copland theme, over the config's `theme` (nord, tokyo-night, dracula, catppuccin, gruvbox, one-dark, solarized).
    #[arg(long, value_name = "NAME")]
    theme: Option<String>,
    /// Print a Hyprland window rule for the box (floating, pinned, in a corner) and exit.
    /// It floats by itself; the rule is for pinning it and choosing where it goes.
    #[arg(long, conflicts_with_all = ["demo", "setup"])]
    hyprland_rule: bool,
}

/// The config file as a plain table, read leniently, so a config the daemon refuses still sets the box's looks.
fn table_in(path: &Path) -> Option<toml::Table> {
    let text = std::fs::read_to_string(path).ok()?;
    toml::from_str(&text).ok()
}

/// `theme` from the config file.
fn theme_in(path: &Path) -> Option<String> {
    table_in(path)?.get("theme")?.as_str().map(str::to_string)
}

fn pick_theme(args: &Args, path: &Path) -> Result<&'static Theme> {
    if let Some(name) = &args.theme {
        return Theme::named(name).with_context(|| {
            format!(
                "no theme {name}; there are {}",
                Theme::names().collect::<Vec<_>>().join(", ")
            )
        });
    }
    let Some(name) = theme_in(path) else {
        return Ok(Theme::named(theme::DEFAULT).expect("the default theme"));
    };
    Ok(Theme::named(&name).unwrap_or_else(|| {
        tracing::warn!("no theme {name}; using {}", theme::DEFAULT);
        Theme::named(theme::DEFAULT).expect("the default theme")
    }))
}

/// fontconfig's answer for "monospace", if `fc-match` is there.
fn system_monospace() -> Option<String> {
    let out = std::process::Command::new("fc-match")
        .args(["-f", "%{family[0]}", "monospace"])
        .output()
        .ok()?;
    let name = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !name.is_empty()).then_some(name)
}

fn pick_font(available: &[String]) -> String {
    let has = |name: &str| available.iter().any(|f| f == name);
    PREFERRED_FONTS
        .iter()
        .map(|s| s.to_string())
        .chain(system_monospace())
        .chain(FALLBACK_FONTS.iter().map(|s| s.to_string()))
        .find(|f| has(f))
        .unwrap_or_else(|| "monospace".into())
}

/// The daemon on its own thread and Tokio runtime; GPUI has the main thread.
struct Running {
    stop: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

/// A daemon just started: it, what the window watches, and the ways back to it.
struct Started {
    running: Running,
    state: watch::Receiver<DaemonState>,
    /// The owner's view, when the config has an owner token.
    feed: Option<watch::Receiver<Feed>>,
    rt: tokio::runtime::Handle,
    reload: mpsc::UnboundedSender<Reload>,
    stopper: RunStopper,
    /// Links of desktop notifications that were clicked.
    clicks: Option<mpsc::UnboundedReceiver<String>>,
}

impl Running {
    /// Start the daemon, and with an owner token the owner's feed, which also sends desktop
    /// notifications while `notes` says so.
    fn start(config: Config, finished: Arc<AtomicBool>, notes: Arc<AtomicBool>) -> Result<Started> {
        let owner = config.owner.clone();
        let feed = owner.as_ref().map(|o| {
            watch::channel(Feed {
                url: o.url.clone(),
                ..Default::default()
            })
        });
        let feed_tx = feed.as_ref().map(|f| f.0.clone());
        let feed_rx = feed.map(|f| f.1);
        /* The bell's desktop half: only with a feed to say what needs you. */
        let (notices, clicks) = match &owner {
            Some(_) => {
                let (tx, rx) = mpsc::unbounded_channel();
                let notices = Notices {
                    notifier: Notifier::new(notify::memory_path()),
                    desktop: Desktop::start(tx),
                    enabled: notes,
                };
                (Some(notices), Some(rx))
            }
            None => (None, None),
        };
        let (state_tx, state_rx) = std::sync::mpsc::channel();
        let (stop, mut stop_rx) = oneshot::channel::<()>();
        let (reload_tx, mut reload_rx) = mpsc::unbounded_channel::<Reload>();
        let thread = std::thread::Builder::new().name("daemon".into()).spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
                Ok(r) => r,
                Err(e) => {
                    let _ = state_tx.send(Err(anyhow::Error::from(e)));
                    return;
                }
            };
            runtime.block_on(async move {
                let paths = Paths {
                    state_dir: default_state_dir(),
                    runtime_dir: default_runtime_dir(),
                };
                let mut daemon = match Daemon::start(config, paths) {
                    Ok(d) => d,
                    Err(e) => {
                        let _ = state_tx.send(Err(e));
                        return;
                    }
                };
                let _ = state_tx.send(Ok((
                    daemon.subscribe(),
                    tokio::runtime::Handle::current(),
                    daemon.run_stopper(),
                )));
                if let (Some(owner), Some(tx)) = (owner, feed_tx) {
                    tokio::spawn(feed::run(owner, tx, daemon.subscribe(), notices));
                }
                let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt()))
                else {
                    tracing::error!("can't listen for signals");
                    return;
                };
                loop {
                    tokio::select! {
                        _ = term.recv() => { tracing::info!("SIGTERM: stopping"); break }
                        _ = int.recv() => { tracing::info!("SIGINT: stopping"); break }
                        _ = &mut stop_rx => { tracing::info!("window closed: stopping"); break }
                        /* The agents screen changed daemon.toml: run what it says now, here. */
                        Some(req) = reload_rx.recv() => {
                            let done = daemon.reload(req.config);
                            if let Err(e) = &done {
                                tracing::error!("reload: {e:#}");
                            }
                            let _ = req.reply.send(done);
                        }
                        _ = daemon.join() => {
                            tracing::error!("no agent left to watch");
                            finished.store(true, Ordering::Relaxed);
                            return;
                        }
                    }
                }
                daemon.shutdown();
                /* As the headless daemon: a second signal means now. */
                tokio::select! {
                    _ = daemon.join() => {}
                    _ = term.recv() => { tracing::warn!("second signal: exiting without waiting"); std::process::exit(1); }
                    _ = int.recv() => { tracing::warn!("second signal: exiting without waiting"); std::process::exit(130); }
                }
                finished.store(true, Ordering::Relaxed);
            });
        })?;
        let (state, rt, stopper) = state_rx
            .recv()
            .context("the daemon's thread ended before it started")??;
        Ok(Started {
            running: Self {
                stop: Some(stop),
                thread: Some(thread),
            },
            state,
            feed: feed_rx,
            rt,
            reload: reload_tx,
            stopper,
            clicks,
        })
    }

    /// Stop the agents (runs finish as cancelled) and wait for them.
    fn stop(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Starts the daemon on a config: the window's next source.
type Launch = Rc<dyn Fn(Config) -> Result<Source>>;

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        /* GPUI and its renderer log a page at info on every start; the daemon's own lines are what matter here. */
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("COPLAND_LOG")
                .unwrap_or_else(|_| "warn,copland_box=info,copland_daemon_core=info".into()),
        )
        .with_target(false)
        .with_writer(std::io::stderr)
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .init();
    let args = Args::parse();
    if args.hyprland_rule {
        let (w, h) = BoxView::window_size(&Scene::live(Tune::default()), Tune::default().scale as f32, 1.0);
        print!("{}", hyprland::rule(w, h));
        return Ok(());
    }
    let path = args.config.clone().unwrap_or_else(default_config_path);
    let tune = Tune::default();
    /* The box's settings (the menu changes them): as the file says, even one the daemon refuses. */
    let mut prefs = Prefs::from_table(table_in(&path).as_ref());
    if let Some(t) = &args.theme {
        /* --theme for this run only: drawn, not written. */
        pick_theme(&args, &path)?;
        prefs.theme = t.clone();
    } else if prefs.theme != menu::FOLLOW && Theme::named(&prefs.theme).is_none() {
        tracing::warn!("no theme {}; using {}", prefs.theme, theme::DEFAULT);
    }

    /* The daemon, once there is one: started here, or by setup when it has written the config. */
    let running: Arc<Mutex<Option<Running>>> = Arc::default();
    let stop_daemon: Arc<dyn Fn() + Send + Sync> = {
        let running = running.clone();
        let watching = Arc::new(AtomicBool::new(false));
        Arc::new(move || {
            let r = running.lock().expect("one writer").take();
            if let Some(r) = r {
                r.stop();
            }
            /* The daemon's runtime listened for SIGTERM and SIGINT, and its handler outlives it:
            with no daemon (setting up again after signing out), they would do nothing. So
            something answers them while none runs; a daemon started later answers its own. */
            if !watching.swap(true, Ordering::Relaxed) {
                let running = running.clone();
                let _ = std::thread::Builder::new().name("signals".into()).spawn(move || {
                    let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
                        return;
                    };
                    rt.block_on(async {
                        let (Ok(mut term), Ok(mut int)) =
                            (signal(SignalKind::terminate()), signal(SignalKind::interrupt()))
                        else {
                            return;
                        };
                        loop {
                            tokio::select! {
                                _ = term.recv() => {}
                                _ = int.recv() => {}
                            }
                            if running.lock().expect("one writer").is_none() {
                                tracing::info!("signal: exiting");
                                std::process::exit(0);
                            }
                        }
                    });
                });
            }
        })
    };
    /* Setup over the same config, for signing out; it needs the launcher, which needs it. */
    let setup_again: Rc<OnceCell<SetupAgain>> = Rc::default();
    let launch: Launch = {
        let running = running.clone();
        let path = path.clone();
        let notes = prefs.notifications.clone();
        let setup_again = setup_again.clone();
        let stop_daemon = stop_daemon.clone();
        Rc::new(move |config: Config| -> Result<Source> {
            tracing::info!(agents = config.agents.len(), "starting");
            if config.owner.is_none() {
                tracing::info!("no owner_token_file: drawing what the daemon knows (todo and doing)");
            }
            let finished = Arc::new(AtomicBool::new(false));
            let s = Running::start(config, finished.clone(), notes.clone())?;
            *running.lock().expect("one writer") = Some(s.running);
            let setup_again = setup_again.clone();
            let control = Control {
                config: path.clone(),
                rt: s.rt,
                reload: s.reload,
                stopper: s.stopper,
                stop_daemon: stop_daemon.clone(),
                setup: Rc::new(move |url, note| {
                    let again = setup_again.get().expect("set before any window");
                    let mut w = again(url, note.clone())?;
                    if let Some(n) = note {
                        w.note(n);
                    }
                    Ok(w)
                }),
            };
            Ok(Source::Live {
                state: s.state,
                feed: s.feed,
                finished,
                control: Some(control),
                clicks: s.clicks,
            })
        })
    };
    {
        let launch = launch.clone();
        let path = path.clone();
        let _ = setup_again.set(Rc::new(move |url: Option<&str>, _note: Option<String>| {
            let l = launch.clone();
            Wizard::new(path.clone(), url, Box::new(move |c| l(c)))
        }));
    }
    /* No config (or one setup left half done) sets the box up; a broken one is shown, not replaced. */
    let wants_setup = !args.demo && (args.setup || !path.exists());
    let (scene, source) = if args.demo {
        (Scene::demo(tune, 0x5eed_c0b1), Source::Demo)
    } else if wants_setup {
        tracing::info!(config = %path.display(), "setting up");
        let l = launch.clone();
        let wizard = Wizard::new(path.clone(), args.url.as_deref(), Box::new(move |c| l(c)))?;
        (Scene::live(tune), Source::Setup(Box::new(wizard)))
    } else {
        match Config::load(&path) {
            Ok(config) => {
                tracing::info!(config = %path.display(), "read");
                (Scene::live(tune), launch(config)?)
            }
            Err(e) => {
                tracing::warn!("{e:#}; copland-box --setup sets it up again, keeping it as a backup");
                /* The status line is short: the cause, not the path it was found in. */
                let why = format!("copland-box --setup redoes it · {}", e.root_cause());
                (Scene::live(tune), Source::Quiet(why))
            }
        }
    };
    let mut scene = scene;
    scene.motion = prefs.motion;
    /* Compact only once there is a daemon to show: setup and the demo need the whole box. */
    let compact = prefs.compact && matches!(source, Source::Live { .. });
    let (w, h) = BoxView::size_for(&scene, compact);
    /* The least the window may be is the compact box, so it can shrink to that later. */
    let (min_w, min_h) = BoxView::size_for(&scene, true);
    let mut scene = Some(scene);
    let mut source = Some(source);
    let mut prefs = Some(prefs);
    Application::new().run(move |cx| {
        let font: SharedString = pick_font(&cx.text_system().all_font_names()).into();
        tracing::debug!(%font, "drawing");
        let bounds = Bounds::centered(None, size(px(w), px(h)), cx);
        let opened = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: None,
                kind: WindowKind::Normal,
                /* GPUI 0.2.2 sends only the min size on Wayland (is_resizable does nothing on
                Linux), so on Hyprland the box floats and sizes itself over IPC below. The min is
                the compact box's, so switching to compact can make the window that small. */
                is_resizable: false,
                is_minimizable: false,
                app_id: Some(APP_ID.into()),
                window_decorations: Some(WindowDecorations::Client),
                window_min_size: Some(size(px(min_w), px(min_h))),
                ..Default::default()
            },
            |window, cx| {
                let view = cx.new(|cx| {
                    BoxView::new(
                        scene.take().expect("one window"),
                        prefs.take().expect("one window"),
                        font,
                        source.take().expect("one window"),
                        cx,
                    )
                });
                window.focus(view.read(cx).focus_handle());
                view
            },
        );
        if let Err(e) = opened {
            tracing::error!("opening the window: {e:#}");
            cx.quit();
            return;
        }
        hyprland::float_when_mapped(w, h, compact);
        cx.on_window_closed(|cx| cx.quit()).detach();
    });
    if let Some(r) = running.lock().expect("one writer").take() {
        r.stop();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_jetbrains_mono_then_falls_back() {
        let fonts = |names: &[&str]| names.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            pick_font(&fonts(&["DejaVu Sans Mono", "JetBrains Mono"])),
            "JetBrains Mono"
        );
        assert_eq!(pick_font(&fonts(&[])), "monospace");
    }

    #[test]
    fn reads_the_theme_from_a_config_it_cannot_otherwise_use() {
        let dir = std::env::temp_dir().join(format!("copland-box-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("daemon.toml");
        std::fs::write(&file, "theme = \"dracula\"\n").unwrap();
        assert_eq!(theme_in(&file).as_deref(), Some("dracula"));
        let args = Args {
            config: None,
            demo: false,
            setup: false,
            url: None,
            theme: None,
            hyprland_rule: false,
        };
        assert_eq!(pick_theme(&args, &file).unwrap().name, "dracula");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_an_unknown_theme_flag() {
        let args = Args {
            config: None,
            demo: false,
            setup: false,
            url: None,
            theme: Some("nope".into()),
            hyprland_rule: false,
        };
        assert!(pick_theme(&args, Path::new("/nonexistent")).is_err());
    }
}
