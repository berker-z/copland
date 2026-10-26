//! Starting the daemon from the box (COPL-205). The box runs no agents (COPL-204), so while no
//! daemon runs its config it offers one: install the service (core's `service::install`, which
//! starts it), start the installed one when it is stopped, or run one for this session only
//! (`service::spawn_session`). Setup ends here too: it installs the service, or starts the
//! installed one again so it reads the new config. A box upgraded from 0.4.x, which ran the
//! agents itself, is told so once and offered the install (`State::Migration`); the answer is
//! kept in the box's own state file, so "not now" isn't asked at every start.
//!
//! The work is core's and blocks (systemctl, launchctl, waiting for a session daemon's
//! socket), so the view runs `perform` on the box's runtime and shows what came back here:
//! `State` is plain data and `panel` says it, as setup's steps do.

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Result;
use copland_daemon_core::service::{self, Installed, Log, Note, Service, Session};

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
}

pub struct Offer {
    pub state: State,
    /// The installed service, as last looked at: whether "start" is offered.
    pub service: Option<Service>,
    pub since: Instant,
}

impl Offer {
    pub fn new(service: Option<Service>) -> Self {
        Self {
            state: State::Idle,
            service,
            since: Instant::now(),
        }
    }

    pub fn animating(&self) -> bool {
        matches!(self.state, State::Busy(_))
    }

    /// The keys the status line offers while no daemon runs the config.
    pub fn keys(&self) -> Vec<(Line, Option<String>)> {
        let mut keys = vec![(Line::one("no daemon on this config", Role::Yellow), None::<String>)];
        match &self.service {
            Some(_) => keys.push((key("s", "start the service"), Some("s".into()))),
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
                    muted("of your user: from login on, whether the box is open or not.".into()),
                    faint("this machine has none yet. installing one starts it now.".into()),
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
            State::Done(outcome) => (said(outcome), ok),
            State::Failed(ask, why) => (
                vec![
                    Line::one(format!("× couldn't {}", failed(*ask)), Role::Red),
                    muted(why.clone()),
                ],
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
pub fn said(outcome: &Outcome) -> Vec<Line> {
    let done = |s: &str| Line::one(format!("✓ {s}"), Role::Green);
    let faint = |s: String| Line::one(s, Role::Faint);
    match outcome {
        Outcome::Installed(i) => {
            let mut lines = vec![
                done("the service is installed and started · it runs at login, box or no box"),
                faint(format!("{}: {}", i.name, i.file.display())),
                faint(match &i.log {
                    Log::Journal => "its log: journalctl --user -u copland-daemon".into(),
                    Log::File(f) => format!("its log: {}", f.display()),
                }),
            ];
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
            faint("it outlives the window, not your login: i installs the service instead".into()),
            faint(format!("its log: {}", s.log.display())),
        ],
    }
}

/// An install note, shorter than core's for the panel.
pub fn note(n: &Note) -> String {
    match n {
        Note::NixStore { .. } => "it runs this build from the Nix store until you install it again".into(),
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
    service::install(config, &program).map(Outcome::Installed)
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
        }
    }

    #[test]
    fn not_running_offers_install_or_start_and_a_session() {
        let none = Offer::new(None);
        assert!(none.panel("").is_none());
        let keys: Vec<_> = none.keys().into_iter().map(|(l, k)| (text(&l), k)).collect();
        assert_eq!(keys[0].0, "no daemon on this config");
        assert_eq!(keys[1], ("i  install the service".into(), Some("i".into())));
        assert_eq!(keys[2], ("r  this session only".into(), Some("r".into())));
        /* An installed service that is stopped is started, not installed again. */
        let stopped = Offer::new(Some(installed()));
        let keys: Vec<_> = stopped.keys().into_iter().map(|(l, k)| (text(&l), k)).collect();
        assert_eq!(keys[1], ("s  start the service".into(), Some("s".into())));
    }

    #[test]
    fn the_migration_note_says_what_changed_and_offers_the_install() {
        let mut o = Offer::new(None);
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
            name: service::UNIT,
            log: Log::Journal,
            notes: vec![
                Note::NixStore {
                    program: "/nix/store/x-copland/bin/copland-daemon".into(),
                },
                Note::NoLinger { user: "me".into() },
                Note::AlreadyRunning {
                    config: "/c".into(),
                    holder: Holder {
                        pid: Some(42),
                        binary: None,
                    },
                },
            ],
        };
        let lines: Vec<String> = said(&Outcome::Installed(i)).iter().map(text).collect();
        assert!(
            lines[0].starts_with("✓ the service is installed and started"),
            "{lines:?}"
        );
        assert_eq!(
            lines[1],
            "copland-daemon.service: /home/me/.config/systemd/user/copland-daemon.service"
        );
        assert_eq!(lines[2], "its log: journalctl --user -u copland-daemon");
        assert!(lines[3].contains("Nix store"), "{lines:?}");
        assert!(lines[4].contains("sudo loginctl enable-linger me"), "{lines:?}");
        assert!(lines[5].contains("(pid 42)"), "{lines:?}");
        /* The panel has room for six lines: the most install can say. */
        assert_eq!(lines.len(), 6);
    }

    #[test]
    fn a_session_says_it_ends_with_the_login() {
        let lines: Vec<String> = said(&Outcome::Session(Session {
            pid: 7,
            program: "/bin/copland-daemon".into(),
            log: "/home/me/.local/state/copland/daemon.log".into(),
        }))
        .iter()
        .map(text)
        .collect();
        assert!(lines[0].contains("(pid 7)"), "{lines:?}");
        assert!(lines[1].contains("not your login"), "{lines:?}");
        assert!(lines[2].ends_with("daemon.log"), "{lines:?}");
    }

    #[test]
    fn a_failure_says_what_and_why_and_busy_has_no_keys() {
        let mut o = Offer::new(None);
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
