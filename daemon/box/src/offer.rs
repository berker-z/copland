//! Starting the daemon from the box (COPL-205). The box runs no agents (COPL-204), so while no
//! daemon runs its config it offers one: install the service (core's `service::install`, which
//! starts it), start the installed one when it is stopped, or run one for this session only
//! (`service::spawn_session`). Setup ends here too: it installs the service, or starts the
//! installed one again so it reads the new config. Nothing here makes it start at login
//! (COPL-223): the box installs it started now, and the user starts it again by hand
//! (`copland-daemon start`, its launcher, or here); a server asks for that with
//! `--install-service --autostart` or the module's `autostart`. A box upgraded from 0.4.x, which ran the
//! agents itself, is told so once and offered the install (`State::Migration`); the answer is
//! kept in the box's own state file, so "not now" isn't asked at every start.
//!
//! Under Nix (COPL-218: the box is in the store, `service::nix_managed_here`) the service is the
//! home-manager module's, so nothing here installs one: the status line has no `i`, and `m`, the
//! migration note and setup's end show the module to add instead (`State::Nix`), which `c`
//! copies. `s` still starts a unit the module installed, and `r` still runs a session daemon.
//!
//! The work is core's and blocks (systemctl, launchctl, waiting for a session daemon's
//! socket), so the view runs `perform` on the box's runtime and shows what came back here:
//! `State` is plain data and `panel` says it, as setup's steps do.

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Result;
use copland_daemon_core::autostart;
use copland_daemon_core::service::{self, Installed, Log, Note, Service, Session, Wrote};

use crate::scene::{Line, Role};
use crate::wizard::{Panel, key};

/// What the window is asked to do about the daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ask {
    /// Install the service, which starts it.
    Install,
    /// Start the installed service.
    Start,
    /// Run a daemon for this session only.
    Session,
    /// Setup wrote a config: install the service, or start the installed one again.
    AfterSetup,
}

/// What came of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Installed(Installed),
    Started,
    Restarted,
    Session(Session),
}

/// How a live view opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opening {
    /// As it is: the offer in the status line while no daemon runs.
    Plain,
    /// The 0.4.x note first: a config, no service, and the question never answered.
    Migration,
    /// Straight from setup: install or start the service on the config just written.
    AfterSetup,
}

/// Where the offer stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    /// Nothing asked: while no daemon runs, the status line has the offer's keys.
    Idle,
    /// The 0.4.x note, waiting for an answer.
    Migration,
    /// Doing it.
    Busy(Ask),
    /// Done, and what it said, until a key dismisses it.
    Done(Outcome),
    /// It failed, and why.
    Failed(Ask, String),
    /// Nix's: the module to add, in place of an install.
    Nix,
}

pub struct Offer {
    pub state: State,
    /// The installed service, as last looked at: whether "start" is offered.
    pub service: Option<Service>,
    /// Whether the box (and the daemon beside it) is Nix's: then nothing installs a service.
    pub nix: bool,
    /// The config, for the module's `configFile` when it isn't the default one.
    pub config: Option<PathBuf>,
    pub since: Instant,
}

impl Offer {
    pub fn new(service: Option<Service>, nix: bool, config: &Path) -> Self {
        Self {
            state: State::Idle,
            service,
            nix,
            config: autostart::non_default(config).map(Path::to_path_buf),
            since: Instant::now(),
        }
    }

    /// Where a live view starts, given how it opens: the ask to perform at once, if any. Under
    /// Nix with no service the migration note and setup's end show the module instead.
    pub fn open(&mut self, opening: Opening) -> Option<Ask> {
        let nix = self.nix && self.service.is_none();
        match opening {
            Opening::Plain => None,
            Opening::Migration => {
                self.state = if nix { State::Nix } else { State::Migration };
                None
            }
            Opening::AfterSetup if nix => {
                self.state = State::Nix;
                None
            }
            Opening::AfterSetup => Some(Ask::AfterSetup),
        }
    }

    /// The module's lines, as `c` copies them: the flake input and the import too.
    pub fn snippet(&self) -> String {
        service::module_snippet(self.config.as_deref(), true, false)
    }

    pub fn animating(&self) -> bool {
        matches!(self.state, State::Busy(_))
    }

    /// The keys the status line offers while no daemon runs the config.
    pub fn keys(&self) -> Vec<(Line, Option<String>)> {
        let mut keys = vec![(Line::one("no daemon on this config", Role::Yellow), None::<String>)];
        match &self.service {
            Some(_) => keys.push((key("s", "start the service"), Some("s".into()))),
            None if self.nix => keys.push((key("m", "the nix module"), Some("m".into()))),
            None => keys.push((key("i", "install the service"), Some("i".into()))),
        }
        keys.push((key("r", "this session only"), Some("r".into())));
        keys
    }

    pub fn panel(&self, dots: &str) -> Option<Panel> {
        let head = |s: &str| Line::one(s, Role::Blue);
        let muted = |s: String| Line::one(s, Role::Muted);
        let faint = |s: String| Line::one(s, Role::Faint);
        let ok = vec![key("enter", "ok")];
        let (lines, keys) = match &self.state {
            State::Idle => return None,
            State::Migration => (
                vec![
                    head("the box no longer runs your agents itself"),
                    muted("closing it used to stop them. now copland-daemon runs them, as a service".into()),
                    muted("of your user: once started, whether the box is open or not.".into()),
                    faint("this machine has none yet. installing one starts it now, not at login.".into()),
                ],
                vec![
                    key("i", "install the service"),
                    key("r", "this session only"),
                    key("n", "not now"),
                ],
            ),
            State::Busy(ask) => (
                vec![
                    head(&format!("{}{dots}", busy(*ask))),
                    faint("the box picks the daemon up once it answers".into()),
                ],
                Vec::new(),
            ),
            State::Done(outcome) => (said(outcome, self.nix), ok),
            State::Nix => {
                let mut lines = vec![head("this box is from nix: home-manager runs the daemon")];
                lines.extend(
                    service::module_lines(self.config.as_deref(), true, false)
                        .into_iter()
                        .map(|l| Line::one(l, Role::Ink)),
                );
                lines.push(faint(
                    "add it with the flake's module, then switch · daemon/README.md, installing it".into(),
                ));
                (
                    lines,
                    vec![key("c", "copy it"), key("r", "this session only"), key("enter", "ok")],
                )
            }
            State::Failed(ask, why) => (
                /* A line each: a refusal for an unstable place ends with the command to run. */
                std::iter::once(Line::one(format!("× couldn't {}", failed(*ask)), Role::Red))
                    .chain(
                        why.lines()
                            .filter(|l| !l.trim().is_empty())
                            .map(|l| muted(l.trim().to_string())),
                    )
                    .collect(),
                ok,
            ),
        };
        Some(Panel {
            lines,
            input: None,
            code: None,
            keys,
            clicks: Vec::new(),
        })
    }
}

fn busy(ask: Ask) -> &'static str {
    match ask {
        Ask::Install => "installing the service",
        Ask::Start => "starting the service",
        Ask::Session => "starting a daemon for this session",
        Ask::AfterSetup => "starting the daemon on the new config",
    }
}

fn failed(ask: Ask) -> &'static str {
    match ask {
        Ask::Install => "install the service",
        Ask::Start => "start the service",
        Ask::Session => "start a daemon for this session",
        Ask::AfterSetup => "start the daemon on the new config",
    }
}

/// What a done ask says: what it did, where things went, and install's notes, in words short
/// enough for the panel.
pub fn said(outcome: &Outcome, nix: bool) -> Vec<Line> {
    let done = |s: &str| Line::one(format!("✓ {s}"), Role::Green);
    let faint = |s: String| Line::one(s, Role::Faint);
    match outcome {
        Outcome::Installed(i) => {
            let mut lines = vec![
                done(if i.autostart {
                    "the service is installed and started · it runs at login, box or no box"
                } else {
                    "the service is installed and started · it runs box or no box, until stopped"
                }),
                faint(format!("{}: {}", i.name, i.file.display())),
                faint(match &i.log {
                    Log::Journal => "its log: journalctl --user -u copland-daemon".into(),
                    Log::File(f) => format!("its log: {}", f.display()),
                }),
            ];
            if let Wrote::Replaced { was: Some(was) } = &i.wrote {
                lines.push(faint(format!("it ran {} before", was.display())));
            }
            if !i.autostart {
                lines.push(faint(
                    "not at login: start it again here, or with copland-daemon start or its launcher".into(),
                ));
            }
            lines.extend(i.notes.iter().map(|n| Line::one(note(n), Role::Yellow)));
            lines
        }
        Outcome::Restarted => vec![
            done("the service is started again on the new config"),
            faint("journalctl --user -u copland-daemon has its log".into()),
        ],
        Outcome::Started => vec![
            done("the service is starting"),
            faint("the box picks it up once it answers".into()),
        ],
        Outcome::Session(s) => vec![
            done(&format!("a daemon runs this config for this session (pid {})", s.pid)),
            faint(if nix {
                "it outlives the window, not your login: m shows the nix module that runs it as a service".into()
            } else {
                "it outlives the window, not your login: i installs the service instead".into()
            }),
            faint(format!("its log: {}", s.log.display())),
        ],
    }
}

/// An install note, shorter than core's for the panel.
pub fn note(n: &Note) -> String {
    match n {
        Note::AlreadyRunning { holder, .. } => {
            format!("a daemon already runs this config ({holder}): the service takes over once it stops")
        }
        Note::NoLinger { user } => {
            format!("it stops when you log out · sudo loginctl enable-linger {user} keeps it going")
        }
    }
}

/// Do it, blocking: the view runs this on the box's runtime. Returns what came of it and the
/// service as it is now.
pub fn perform(ask: Ask, config: &Path) -> (Result<Outcome>, Option<Service>) {
    let out = match ask {
        Ask::Install => install(config),
        Ask::Start => service::start().map(|_| Outcome::Started),
        Ask::Session => service::spawn_session(config).map(Outcome::Session),
        Ask::AfterSetup => match service::installed() {
            Some(_) => service::restart().map(|_| Outcome::Restarted),
            None => install(config),
        },
    };
    (out, service::installed())
}

fn install(config: &Path) -> Result<Outcome> {
    let program = service::daemon_binary()?;
    /* Started now, not at login: a workstation's daemon runs when its user starts it (COPL-223). */
    service::install(config, &program, false).map(Outcome::Installed)
}

/// The box's own state file: what it was asked once and shouldn't ask again.
pub fn state_file(state_dir: &Path) -> PathBuf {
    state_dir.join("box.toml")
}

/// Whether the 0.4.x note has been answered on this machine.
pub fn answered(file: &Path) -> bool {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| t.parse::<toml::Table>().ok())
        .and_then(|t| t.get("service_offered")?.as_bool())
        .unwrap_or(false)
}

/// Remember the 0.4.x note was answered, whatever the answer.
pub fn remember(file: &Path) -> Result<()> {
    use anyhow::Context as _;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("making {}", dir.display()))?;
    }
    let mut table = std::fs::read_to_string(file)
        .ok()
        .and_then(|t| t.parse::<toml::Table>().ok())
        .unwrap_or_default();
    table.insert("service_offered".into(), toml::Value::Boolean(true));
    std::fs::write(file, toml::to_string(&table)?).with_context(|| format!("writing {}", file.display()))
}

/// How a box with a config opens: the 0.4.x note when no service is installed and it was never
/// answered, else as it is.
pub fn opening(service: Option<&Service>, file: &Path) -> Opening {
    if service.is_none() && !answered(file) {
        Opening::Migration
    } else {
        Opening::Plain
    }
}

/// The text of a line, for the tests.
#[cfg(test)]
fn text(l: &Line) -> String {
    l.0.iter().map(|s| s.text.as_str()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use copland_daemon_core::lock::Holder;

    fn texts(p: &Panel) -> (Vec<String>, Vec<String>) {
        (p.lines.iter().map(text).collect(), p.keys.iter().map(text).collect())
    }

    fn installed() -> Service {
        Service {
            file: "/home/me/.config/systemd/user/copland-daemon.service".into(),
            enabled: false,
            running: Some(false),
            nix: false,
            program: None,
        }
    }

    #[test]
    fn not_running_offers_install_or_start_and_a_session() {
        let none = Offer::new(None, false, Path::new("/c.toml"));
        assert!(none.panel("").is_none());
        let keys: Vec<_> = none.keys().into_iter().map(|(l, k)| (text(&l), k)).collect();
        assert_eq!(keys[0].0, "no daemon on this config");
        assert_eq!(keys[1], ("i  install the service".into(), Some("i".into())));
        assert_eq!(keys[2], ("r  this session only".into(), Some("r".into())));
        /* An installed service that is stopped is started, not installed again. */
        let stopped = Offer::new(Some(installed()), false, Path::new("/c.toml"));
        let keys: Vec<_> = stopped.keys().into_iter().map(|(l, k)| (text(&l), k)).collect();
        assert_eq!(keys[1], ("s  start the service".into(), Some("s".into())));
    }

    #[test]
    fn the_migration_note_says_what_changed_and_offers_the_install() {
        let mut o = Offer::new(None, false, Path::new("/c.toml"));
        o.state = State::Migration;
        let (lines, keys) = texts(&o.panel("").unwrap());
        assert!(lines[0].contains("no longer runs your agents"), "{lines:?}");
        assert!(lines[1].contains("closing it used to stop them"), "{lines:?}");
        assert_eq!(keys, ["i  install the service", "r  this session only", "n  not now"]);
    }

    #[test]
    fn says_what_install_did_with_its_notes() {
        let i = Installed {
            file: "/home/me/.config/systemd/user/copland-daemon.service".into(),
            wrote: Wrote::Replaced {
                was: Some("/home/me/Downloads/copland-box-0.4.0-linux-x86_64/bin/copland-daemon".into()),
            },
            name: service::UNIT,
            autostart: true,
            log: Log::Journal,
            notes: vec![
                Note::NoLinger { user: "me".into() },
                Note::AlreadyRunning {
                    config: "/c".into(),
                    holder: Holder {
                        pid: Some(42),
                        binary: None,
                        version: None,
                    },
                },
            ],
        };
        let lines: Vec<String> = said(&Outcome::Installed(i.clone()), false).iter().map(text).collect();
        assert!(
            lines[0].starts_with("✓ the service is installed and started"),
            "{lines:?}"
        );
        assert_eq!(
            lines[1],
            "copland-daemon.service: /home/me/.config/systemd/user/copland-daemon.service"
        );
        assert_eq!(lines[2], "its log: journalctl --user -u copland-daemon");
        assert_eq!(
            lines[3],
            "it ran /home/me/Downloads/copland-box-0.4.0-linux-x86_64/bin/copland-daemon before"
        );
        assert!(lines[4].contains("sudo loginctl enable-linger me"), "{lines:?}");
        assert!(lines[5].contains("(pid 42)"), "{lines:?}");
        assert_eq!(lines.len(), 6);

        /* The box's own install, by hand: says it won't start at login. */
        let by_hand = Installed {
            autostart: false,
            wrote: Wrote::New,
            notes: Vec::new(),
            ..i
        };
        let lines: Vec<String> = said(&Outcome::Installed(by_hand), false).iter().map(text).collect();
        assert!(lines[0].ends_with("until stopped"), "{lines:?}");
        assert!(lines[3].starts_with("not at login"), "{lines:?}");
        assert_eq!(lines.len(), 4);
    }

    #[test]
    fn a_session_says_it_ends_with_the_login() {
        let lines: Vec<String> = said(
            &Outcome::Session(Session {
                pid: 7,
                program: "/bin/copland-daemon".into(),
                log: "/home/me/.local/state/copland/daemon.log".into(),
            }),
            false,
        )
        .iter()
        .map(text)
        .collect();
        assert!(lines[0].contains("(pid 7)"), "{lines:?}");
        assert!(lines[1].contains("not your login"), "{lines:?}");
        assert!(lines[2].ends_with("daemon.log"), "{lines:?}");
    }

    #[test]
    fn a_failure_says_what_and_why_and_busy_has_no_keys() {
        let mut o = Offer::new(None, false, Path::new("/c.toml"));
        o.state = State::Failed(Ask::Install, "no copland-daemon beside /x or on PATH".into());
        let (lines, keys) = texts(&o.panel("").unwrap());
        assert_eq!(lines[0], "× couldn't install the service");
        assert!(lines[1].contains("no copland-daemon"));
        assert_eq!(keys, ["enter  ok"]);
        o.state = State::Busy(Ask::AfterSetup);
        assert!(o.animating());
        let (lines, keys) = texts(&o.panel("..").unwrap());
        assert_eq!(lines[0], "starting the daemon on the new config..");
        assert!(keys.is_empty());
    }

    #[test]
    fn under_nix_nothing_offers_an_install_and_the_panel_shows_the_module() {
        let config = copland_daemon_core::config::default_config_path();
        let mut o = Offer::new(None, true, &config);
        let keys: Vec<_> = o.keys().into_iter().map(|(l, k)| (text(&l), k)).collect();
        assert_eq!(keys[1], ("m  the nix module".into(), Some("m".into())));
        assert_eq!(keys[2], ("r  this session only".into(), Some("r".into())));
        assert!(!keys.iter().any(|(_, k)| k.as_deref() == Some("i")), "{keys:?}");
        /* The migration note and setup's end show the module rather than installing. */
        assert_eq!(o.open(Opening::Migration), None);
        assert_eq!(o.state, State::Nix);
        o.state = State::Idle;
        assert_eq!(o.open(Opening::AfterSetup), None);
        assert_eq!(o.state, State::Nix);
        let (lines, keys) = texts(&o.panel("").unwrap());
        assert_eq!(
            lines,
            [
                "this box is from nix: home-manager runs the daemon",
                "services.copland.enable = true;",
                "services.copland.runtimes = [ pkgs.claude-code pkgs.git pkgs.gh ];",
                "services.copland.tray.enable = true;",
                "# services.copland.autostart = true; # on a server; here it starts from its launcher",
                "add it with the flake's module, then switch · daemon/README.md, installing it",
            ]
        );
        assert_eq!(keys, ["c  copy it", "r  this session only", "enter  ok"]);
        assert!(
            o.snippet()
                .contains("imports = [ inputs.copland.homeManagerModules.default ];")
        );
        /* The default config isn't named; another one is. */
        assert!(!o.snippet().contains("configFile"));
        let other = Offer::new(None, true, Path::new("/w/work.toml"));
        assert!(
            other
                .snippet()
                .contains("services.copland.configFile = \"/w/work.toml\";")
        );
        /* A unit the module installed is started, and setup's end starts it again. */
        let hm = Service {
            nix: true,
            ..installed()
        };
        let mut o = Offer::new(Some(hm), true, &config);
        let keys: Vec<_> = o.keys().into_iter().map(|(_, k)| k).collect();
        assert_eq!(keys[1].as_deref(), Some("s"));
        assert_eq!(o.open(Opening::AfterSetup), Some(Ask::AfterSetup));
        assert_eq!(o.open(Opening::Migration), None);
        assert_eq!(
            o.state,
            State::Migration,
            "only asked with no service, as opening() decides"
        );
        /* A session's word points at the module, not at i. */
        let session = Outcome::Session(Session {
            pid: 7,
            program: "/nix/store/x/bin/copland-daemon".into(),
            log: "/l".into(),
        });
        assert!(text(&said(&session, true)[1]).contains("m shows the nix module"));
    }

    #[test]
    fn the_migration_answer_is_remembered() {
        let dir = std::env::temp_dir().join(format!("copland-offer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = state_file(&dir.join("state"));
        assert!(!answered(&file));
        assert_eq!(opening(None, &file), Opening::Migration);
        /* A service installed already: nothing to migrate. */
        assert_eq!(opening(Some(&installed()), &file), Opening::Plain);
        remember(&file).unwrap();
        assert!(answered(&file));
        assert_eq!(opening(None, &file), Opening::Plain);
        /* Whatever else is in the file stays. */
        std::fs::write(&file, "other = 1\n").unwrap();
        remember(&file).unwrap();
        let t: toml::Table = std::fs::read_to_string(&file).unwrap().parse().unwrap();
        assert_eq!(t.get("other").and_then(|v| v.as_integer()), Some(1));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
