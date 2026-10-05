//! The agents screen (COPL-55), `a` from the live view: every agent in your
//! Copland, and for each what this machine does with it. One it runs shows
//! its runtime (which can be changed), its working folder and what it is
//! doing; one it doesn't can be brought here through a device login that
//! asks for that agent alone; one can be stopped here. Changes are written
//! to `daemon.toml` in place (`edit.rs`, the old file kept as a backup) and
//! handed to the running daemon, which applies them without a restart
//! (`Daemon::reload`): an agent in a run finishes it first.
//!
//! Your agents come from `/api/wired` (the owner's feed), which lists them
//! all, paused ones too, with your read-only token. Without an owner token
//! the screen shows only the agents this machine runs.
//!
//! `m` messages the selected agent (COPL-109): one line, sent with
//! `POST /api/messages` as you. That needs your read-and-write token
//! (`write.rs`), so the first `m` asks for it through a device login of its
//! own, then opens the line. A message to an agent with a run going here
//! waits for its next run, and the line says so. Stopping and pausing stay
//! what they are (`s` on the live view, the pause in Copland), not messages.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::Result;
use copland_daemon_core::api::{Api, DeviceIdentity, DevicePoll, DeviceStart, WiredAgent};
use copland_daemon_core::config::AgentConfig;
use copland_daemon_core::{AgentState, Config, DaemonState, Phase, Reloaded};
use gpui::{Context, KeyDownEvent, Task};
use tokio::sync::{mpsc, oneshot};

use crate::edit;
use crate::feed::Feed;
use crate::runtime::{self, Found, Runtime};
use crate::scene::{Line, Role, Span};
use crate::setup::{self, Choice, LineInput};
use crate::view::BoxView;
use crate::wizard::{Panel, Typed, Wait, key, type_into};
use crate::write;

/// Agents listed at once; the rest scroll with the selection.
const ROWS: usize = 3;
/// RFC 8628's step when the server says to slow down.
const SLOW_DOWN: u64 = 5;
/// The most a message holds (`MESSAGE_MAX` in `src/domain/messages.ts`).
const MESSAGE_MAX: usize = 1000;

/// A changed config for the daemon to run, and its answer.
pub struct Reload {
    pub config: Config,
    pub reply: oneshot::Sender<Result<Reloaded>>,
}

/// Setup over the same config, the address filled in and a note to show (after signing out).
pub type SetupAgain = std::rc::Rc<dyn Fn(Option<&str>, Option<String>) -> Result<crate::wizard::Wizard>>;

/// How the window reaches the running daemon: its config file, its Tokio runtime (for the
/// screen's network calls), the way to hand it a changed config, to stop one of its runs, and
/// for signing out, to stop it altogether and set the box up again.
#[derive(Clone)]
pub struct Control {
    pub config: PathBuf,
    pub rt: tokio::runtime::Handle,
    pub reload: mpsc::UnboundedSender<Reload>,
    pub stopper: copland_daemon_core::RunStopper,
    /// Stops the daemon (its runs finish as cancelled) and waits for it. Blocking.
    pub stop_daemon: std::sync::Arc<dyn Fn() + Send + Sync>,
    /// Setup over the same config, the address filled in and a note to show.
    pub setup: SetupAgain,
}

/// What an agent this machine runs is launched with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bound {
    /// One of setup's templates, as written.
    Runtime(Runtime),
    /// A command of the person's own (widened by hand, or another program): the program.
    Own(String),
}

impl Bound {
    pub fn of(a: &AgentConfig) -> Self {
        Runtime::ALL
            .into_iter()
            .find(|r| r.command() == a.command)
            .map(Bound::Runtime)
            .unwrap_or_else(|| {
                let program = a.command.first().map(String::as_str).unwrap_or("?");
                Bound::Own(
                    Path::new(program)
                        .file_name()
                        .map_or(program.into(), |f| f.to_string_lossy().into()),
                )
            })
    }

    fn label(&self) -> String {
        match self {
            Bound::Runtime(r) => r.name().to_lowercase(),
            Bound::Own(p) => format!("{p} (own)"),
        }
    }
}

/// What a row says the agent is doing here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Doing {
    Starting,
    Watching,
    Running(String),
    /// A reload changed it during a run: the change applies when the run ends.
    AfterRun,
    Error(String),
    /// Watching, after a run that went wrong (COPL-136): said until the next run.
    Failed(Failed),
    Stopped,
}

/// How the agent's last run went wrong, from the daemon's summary of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failed {
    pub run: String,
    pub task: String,
    /// "exit 1 after 3.8s", or the run's own outcome when its runtime never launched.
    pub how: String,
    /// The plain word for a runtime that died at once with nothing to say.
    pub hint: Option<String>,
    pub log: Option<PathBuf>,
}

impl Failed {
    fn of(s: &AgentState) -> Option<Self> {
        let r = s.last_run.as_ref().filter(|r| r.failed)?;
        Some(Self {
            run: r.run.clone(),
            task: r.task.clone(),
            how: r.how.clone().unwrap_or_else(|| r.outcome.clone()),
            hint: r.hint.clone(),
            log: r.log.clone(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    /// In daemon.toml.
    Here {
        handle: String,
        url: String,
        bound: Bound,
        workdir: String,
        doing: Doing,
        paused: bool,
    },
    /// One of yours this machine doesn't run.
    Away {
        handle: String,
        paused: bool,
        /// Removed here, and still finishing a run.
        leaving: bool,
    },
}

impl Row {
    pub fn handle(&self) -> &str {
        match self {
            Row::Here { handle, .. } | Row::Away { handle, .. } => handle,
        }
    }
}

/// "owner/name" → "name".
fn name(handle: &str) -> &str {
    handle.rsplit('/').next().unwrap_or(handle)
}

fn same_handle(a: &str, b: &str) -> bool {
    a.trim_start_matches('@')
        .eq_ignore_ascii_case(b.trim_start_matches('@'))
}

/// The rows: the agents in daemon.toml in its order, then the rest of yours from `/api/wired`.
/// A configured agent is matched to yours by the id the daemon learned from its token, else
/// by handle.
pub fn rows(configured: &[AgentConfig], st: &DaemonState, wired: Option<&[WiredAgent]>) -> Vec<Row> {
    let mut out = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for a in configured {
        let live = st
            .agents
            .iter()
            .find(|s| edit::same_agent(&s.url, &s.configured, &a.url, &a.handle) && !s.retiring)
            .or_else(|| {
                st.agents
                    .iter()
                    .find(|s| edit::same_agent(&s.url, &s.configured, &a.url, &a.handle))
            });
        let theirs = wired.and_then(|w| {
            w.iter().find(|x| {
                live.and_then(|s| s.user_id.as_deref()) == Some(x.id.as_str()) || same_handle(&x.handle, &a.handle)
            })
        });
        if let Some(t) = theirs {
            seen.push(&t.id);
        }
        let doing = match live {
            None => Doing::Starting,
            Some(s) => match (&s.phase, s.retiring) {
                /* Copland down (COPL-148): said over a run going too, which waits on it for its finish. */
                (Phase::Running { .. } | Phase::Idle, _) if s.unavailable.is_some() => {
                    Doing::Error(s.unavailable_line().unwrap_or_default())
                }
                (Phase::Running { .. }, true) => Doing::AfterRun,
                (Phase::Running { .. }, false) => {
                    Doing::Running(s.runs.iter().map(|r| r.task.as_str()).collect::<Vec<_>>().join(", "))
                }
                (_, true) => Doing::Starting,
                (Phase::Stopped, _) => match &s.last_error {
                    Some(e) => Doing::Error(e.clone()),
                    None => Doing::Stopped,
                },
                (_, _) if s.last_error.is_some() => Doing::Error(s.last_error.clone().unwrap_or_default()),
                (Phase::Starting, _) => Doing::Starting,
                (Phase::Idle, _) => Failed::of(s).map_or(Doing::Watching, Doing::Failed),
            },
        };
        out.push(Row::Here {
            handle: theirs.map_or(a.handle.clone(), |t| t.handle.clone()),
            url: a.url.clone(),
            bound: Bound::of(a),
            workdir: setup::tilde(&a.workdir),
            doing,
            paused: theirs.is_some_and(|t| t.paused),
        });
    }
    for w in wired.unwrap_or_default() {
        if seen.contains(&w.id.as_str()) {
            continue;
        }
        let leaving = st
            .agents
            .iter()
            .any(|s| s.retiring && (s.user_id.as_deref() == Some(&w.id) || same_handle(&s.handle, &w.handle)));
        out.push(Row::Away {
            handle: w.handle.clone(),
            paused: w.paused,
            leaving,
        });
    }
    out
}

/// The line under a failed run's agent: the plain word when its runtime died at once, else which
/// run it was.
fn failed_detail(f: &Failed) -> (String, Role) {
    let log = if f.log.is_some() { " · o opens its log" } else { "" };
    match &f.hint {
        Some(h) => (format!("{h}{log}"), Role::Red),
        None => (format!("run {} on {} {}{log}", f.run, f.task, f.how), Role::Muted),
    }
}

/// What the screen is doing.
enum Mode {
    List,
    /// x was pressed on this agent: x again stops running it here.
    Confirm(String),
    /// Getting a token through a device login: the agent's, to run it here, or with `write`
    /// your read-and-write one, to message the agent next.
    Approve {
        handle: String,
        url: String,
        write: bool,
        start: Option<DeviceStart>,
        wait: Wait,
    },
    /// Typing a message to the agent; `note` is what to say under the line.
    Compose {
        handle: String,
        input: LineInput,
        sending: bool,
        note: Option<(String, Role)>,
    },
}

pub struct Agents {
    control: Control,
    /// daemon.toml's agents, as last read.
    configured: Vec<AgentConfig>,
    /// What was wrong reading it, if it couldn't be.
    unreadable: Option<String>,
    found: Option<Vec<Found>>,
    /// Runtime changes not saved yet, by handle as configured.
    pending: Vec<(String, Runtime)>,
    selected: usize,
    mode: Mode,
    /// The last thing done or refused.
    message: Option<(String, Role)>,
    /// Saving and reloading: keys wait.
    busy: bool,
    job: Option<Task<()>>,
    since: Instant,
    host: String,
}

/// What a key did to the screen.
pub enum Key {
    Handled,
    Ignored,
    Close,
}

impl Agents {
    pub fn open(control: Control, cx: &mut Context<BoxView>) -> Self {
        let mut a = Self {
            control,
            configured: Vec::new(),
            unreadable: None,
            found: None,
            pending: Vec::new(),
            selected: 0,
            mode: Mode::List,
            message: None,
            busy: false,
            job: None,
            since: Instant::now(),
            host: setup::hostname(),
        };
        a.read();
        a.detect(cx);
        a
    }

    fn read(&mut self) {
        match Config::load(&self.control.config) {
            Ok(c) => {
                self.configured = c.agents;
                self.unreadable = None;
            }
            Err(e) => self.unreadable = Some(format!("{}", e.root_cause())),
        }
    }

    /// Run `fut` on the daemon's runtime and hand its result to `then`, on the view.
    fn job<T: Send + 'static>(
        &mut self,
        fut: impl std::future::Future<Output = T> + Send + 'static,
        then: impl FnOnce(&mut Agents, T, &mut Context<BoxView>) + 'static,
        cx: &mut Context<BoxView>,
    ) {
        let handle = self.control.rt.spawn(fut);
        self.job = Some(cx.spawn(async move |this, cx| {
            let Ok(out) = handle.await else { return };
            let _ = this.update(cx, |view, cx| {
                if let Some(a) = view.agents() {
                    then(a, out, cx);
                }
                cx.notify();
            });
        }));
    }

    fn detect(&mut self, cx: &mut Context<BoxView>) {
        let handle = self.control.rt.spawn(runtime::detect());
        /* Its own task, apart from `job`, so a save or a device login started meanwhile doesn't cancel it. */
        cx.spawn(async move |this, cx| {
            let Ok(found) = handle.await else { return };
            let _ = this.update(cx, |view, cx| {
                if let Some(a) = view.agents() {
                    a.found = Some(found);
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// The runtimes to cycle through: the ones found on PATH, or all of them before that's known.
    fn choices(&self) -> Vec<Runtime> {
        match &self.found {
            Some(f) if !f.is_empty() => f.iter().map(|f| f.runtime).collect(),
            _ => Runtime::ALL.to_vec(),
        }
    }

    fn pending_for(&self, handle: &str) -> Option<Runtime> {
        self.pending
            .iter()
            .find(|(h, _)| same_handle(h, handle))
            .map(|(_, r)| *r)
    }

    /// The configured entry a row is, by its url and either handle.
    fn entry(&self, row: &Row) -> Option<&AgentConfig> {
        let Row::Here { url, handle, .. } = row else {
            return None;
        };
        self.configured
            .iter()
            .find(|a| edit::same_agent(&a.url, &a.handle, url, handle))
            .or_else(|| {
                self.configured
                    .iter()
                    .find(|a| &a.url == url && same_handle(name(&a.handle), name(handle)))
            })
    }

    /// Another runtime for the selected agent, not saved yet.
    fn cycle(&mut self, row: &Row, by: isize) {
        let Some(entry) = self.entry(row).cloned() else { return };
        let options = self.choices();
        let now = self.pending_for(&entry.handle).or(match Bound::of(&entry) {
            Bound::Runtime(r) => Some(r),
            Bound::Own(_) => None,
        });
        let at = now.and_then(|r| options.iter().position(|o| *o == r));
        let n = options.len() as isize;
        let next = options[match at {
            Some(i) => (i as isize + by).rem_euclid(n) as usize,
            None => 0,
        }];
        self.pending.retain(|(h, _)| !same_handle(h, &entry.handle));
        if Bound::of(&entry) != Bound::Runtime(next) {
            self.pending.push((entry.handle.clone(), next));
        }
        self.message = None;
    }

    /// Write `text` as the config and have the daemon run it. `said` is what to say once it does.
    fn apply(&mut self, text: String, said: String, cx: &mut Context<BoxView>) {
        let (config, backup) = match edit::save(&self.control.config, &text) {
            Ok(c) => c,
            Err(e) => {
                self.message = Some((format!("× {e:#}"), Role::Red));
                return;
            }
        };
        tracing::info!(
            "agents screen: wrote {}, kept the old one as {}",
            self.control.config.display(),
            backup.display()
        );
        let (reply, answer) = oneshot::channel();
        if self.control.reload.send(Reload { config, reply }).is_err() {
            self.message = Some(("× saved, but the daemon has stopped: restart the box".into(), Role::Red));
            return;
        }
        self.busy = true;
        let kept = backup
            .file_name()
            .map_or_else(String::new, |f| f.to_string_lossy().into_owned());
        self.job(
            answer,
            move |a, out, _| {
                a.busy = false;
                a.pending.clear();
                a.read();
                a.message = Some(match out {
                    /* The backup is named when there is room on the line; the log always names it. */
                    Ok(Ok(_)) if said.chars().count() + kept.len() < 72 => {
                        (format!("{said} · kept {kept}"), Role::Green)
                    }
                    Ok(Ok(_)) => (said, Role::Green),
                    Ok(Err(e)) => (format!("× saved, but not applied: {e:#}; restart the box"), Role::Red),
                    Err(_) => ("× saved, but the daemon has stopped: restart the box".into(), Role::Red),
                });
            },
            cx,
        );
    }

    /// The pending runtime changes, saved and applied.
    fn save(&mut self, cx: &mut Context<BoxView>) {
        let Ok(mut text) = std::fs::read_to_string(&self.control.config) else {
            self.message = Some(("× can't read daemon.toml".into(), Role::Red));
            return;
        };
        let mut said = Vec::new();
        for (handle, runtime) in self.pending.clone() {
            let Some(entry) = self.configured.iter().find(|a| same_handle(&a.handle, &handle)) else {
                continue;
            };
            match edit::set_runtime(&text, &entry.url, &entry.handle, runtime) {
                Ok(t) => text = t,
                Err(e) => {
                    self.message = Some((format!("× {e:#}"), Role::Red));
                    return;
                }
            }
            said.push(format!("{} → {}", name(&handle), runtime.name().to_lowercase()));
        }
        self.apply(text, format!("{}, after a run in progress", said.join(", ")), cx);
    }

    /// Stop running an agent here.
    fn remove(&mut self, handle: &str, cx: &mut Context<BoxView>) {
        let Some(entry) = self.configured.iter().find(|a| same_handle(&a.handle, handle)).cloned() else {
            return;
        };
        if self.configured.len() == 1 {
            self.message = Some((
                "× the last agent stays: copland-box --setup sets the box up again".into(),
                Role::Red,
            ));
            return;
        }
        let text = std::fs::read_to_string(&self.control.config)
            .map_err(anyhow::Error::from)
            .and_then(|t| edit::remove_agent(&t, &entry.url, &entry.handle));
        match text {
            Ok(t) => {
                self.pending.retain(|(h, _)| !same_handle(h, handle));
                self.apply(
                    t,
                    format!("{} stopped here · revoke its token in settings › agents", name(handle)),
                    cx,
                );
            }
            Err(e) => self.message = Some((format!("× {e:#}"), Role::Red)),
        }
    }

    /// Ask Copland for a token through a device code approved in the browser: one agent's, naming
    /// it, or with `write` your read-and-write one, so as to message `handle` once it comes.
    fn ask(&mut self, handle: String, url: String, write: bool, cx: &mut Context<BoxView>) {
        self.mode = Mode::Approve {
            handle: handle.clone(),
            url: url.clone(),
            write,
            start: None,
            wait: Wait::Waiting,
        };
        self.since = Instant::now();
        let host = self.host.clone();
        let at = url.clone();
        self.job(
            async move {
                let api = Api::new(&at).map_err(|e| format!("{e:#}"))?;
                let agents = if write { Vec::new() } else { vec![handle] };
                let start = api
                    .device_start(setup::CLIENT, &host, &agents, write)
                    .await
                    .map_err(|e| format!("{at}: {e}"))?;
                Ok::<_, String>((api, start))
            },
            move |a, out, cx| match out {
                Ok((api, start)) => {
                    cx.open_url(&start.verify_url);
                    let (code, interval, expires) = (start.device_code.clone(), start.interval, start.expires_in);
                    if let Mode::Approve { start: s, .. } = &mut a.mode {
                        *s = Some(start);
                    }
                    a.job(poll(api, code, interval, expires), |a, out, cx| a.approved(out, cx), cx);
                }
                Err(e) => a.set_wait(Wait::Failed(e)),
            },
            cx,
        );
    }

    fn set_wait(&mut self, to: Wait) {
        if let Mode::Approve { wait, .. } = &mut self.mode {
            *wait = to;
        }
    }

    /// The device login's answer: on approval, each agent it brought that isn't here yet gets
    /// its token file and its table (the first runtime found, `~/agents/<name>`), then the
    /// daemon starts it.
    fn approved(&mut self, out: Result<Approved, Wait>, cx: &mut Context<BoxView>) {
        let Approved { url, owner, agents } = match out {
            Ok(x) => x,
            Err(w) => return self.set_wait(w),
        };
        if let Mode::Approve {
            write: true, handle, ..
        } = &self.mode
        {
            let handle = handle.clone();
            return self.write_approved(handle, owner);
        }
        let runtime = self.choices()[0];
        let mut text = match std::fs::read_to_string(&self.control.config) {
            Ok(t) => t,
            Err(e) => return self.set_wait(Wait::Failed(format!("reading daemon.toml: {e}"))),
        };
        let mut added = Vec::new();
        for a in &agents {
            let handle = a.handle.trim_start_matches('@').to_string();
            if self
                .configured
                .iter()
                .any(|c| edit::same_agent(&c.url, &c.handle, &url, &handle))
            {
                continue;
            }
            let workdir = setup::default_workdir(&setup::agent_name(&handle));
            let made = edit::save_agent_token(&self.control.config, &handle, a.token.expose()).and_then(|file| {
                let dir = copland_daemon_core::config::expand_home(&workdir);
                std::fs::create_dir_all(&dir)?;
                Ok(file)
            });
            let file = match made {
                Ok(f) => f,
                Err(e) => return self.set_wait(Wait::Failed(format!("saving @{handle}'s token: {e:#}"))),
            };
            text = edit::add_agent(
                &text,
                &setup::render_agent(&url, &handle, &file, &Choice { runtime, workdir }),
            );
            added.push(name(&handle).to_string());
        }
        self.mode = Mode::List;
        if added.is_empty() {
            self.message = Some((
                "× nothing new was approved; revoke what it made in settings".into(),
                Role::Red,
            ));
            return;
        }
        self.apply(
            text,
            format!("{} runs here on {}", added.join(", "), runtime.name().to_lowercase()),
            cx,
        );
    }

    /// Your write token came: kept beside the config and named in it, then the message line opens.
    fn write_approved(&mut self, handle: String, owner: Option<DeviceIdentity>) {
        let Some(owner) = owner.filter(|o| o.scope.as_deref() == Some("write")) else {
            return self.set_wait(Wait::Failed(
                "copland sent no write token (is it older than this box?); revoke what it made in settings › access"
                    .into(),
            ));
        };
        match write::save(&self.control.config, &owner.token) {
            Ok(file) => {
                tracing::info!("agents screen: saved your write token in {}", file.display());
                self.compose(handle);
                if let Mode::Compose { note, .. } = &mut self.mode {
                    *note = Some((
                        format!("the box can message your agents now · {}", setup::tilde(&file)),
                        Role::Green,
                    ));
                }
            }
            Err(e) => self.set_wait(Wait::Failed(format!("saving your write token: {e:#}"))),
        }
    }

    /// `m` on an agent: the message line, or first the device login for your write token.
    fn message(&mut self, handle: String, url: String, cx: &mut Context<BoxView>) {
        self.message = None;
        match write::token(&self.control.config) {
            Some(_) => self.compose(handle),
            None => self.ask(handle, url, true, cx),
        }
    }

    fn compose(&mut self, handle: String) {
        self.mode = Mode::Compose {
            handle,
            input: LineInput::default(),
            sending: false,
            note: None,
        };
    }

    /// Whether a message is being typed: the screen then takes every key itself (`type_key`).
    pub fn composing(&self) -> bool {
        matches!(self.mode, Mode::Compose { .. })
    }

    /// A key while a message is typed: the line edits, enter sends, escape goes back to the list.
    pub fn type_key(&mut self, e: &KeyDownEvent, st: &DaemonState, cx: &mut Context<BoxView>) {
        let Mode::Compose {
            input, sending, note, ..
        } = &mut self.mode
        else {
            return;
        };
        if *sending {
            return;
        }
        if e.keystroke.key == "escape" {
            self.mode = Mode::List;
            return;
        }
        match type_into(input, e, cx) {
            Typed::Changed => *note = None,
            Typed::Ignored => {}
            Typed::Enter => self.submit(st, cx),
        }
    }

    /// Enter on the message line: sent, unless it is empty or too long.
    fn submit(&mut self, st: &DaemonState, cx: &mut Context<BoxView>) {
        let Mode::Compose {
            handle,
            input,
            sending: false,
            note,
        } = &mut self.mode
        else {
            return;
        };
        let text = input.text().trim().to_string();
        let n = text.chars().count();
        if n == 0 {
            *note = Some(("type the message first".into(), Role::Faint));
        } else if n > MESSAGE_MAX {
            *note = Some((format!("× at most {MESSAGE_MAX} characters; this is {n}"), Role::Red));
        } else {
            let (handle, busy) = (handle.clone(), running(st, handle));
            self.send(handle, text, busy, cx);
        }
    }

    /// Send the message with your write token. A refused token is forgotten, so the next `m` asks
    /// for a new one; any other refusal stays on the line, the text kept.
    fn send(&mut self, handle: String, text: String, busy: bool, cx: &mut Context<BoxView>) {
        let Some((url, token)) = write::token(&self.control.config) else {
            self.mode = Mode::List;
            self.message = Some((
                "× the write token is gone from daemon.toml: m asks for a new one".into(),
                Role::Red,
            ));
            return;
        };
        if let Mode::Compose { sending, note, .. } = &mut self.mode {
            *sending = true;
            *note = None;
        }
        let config = self.control.config.clone();
        let to = handle.clone();
        self.job(
            async move {
                let api = Api::new(&url).map_err(|e| (format!("{e:#}"), false))?;
                api.send_message(&token, &to, &text)
                    .await
                    .map_err(|e| write::failed(&e))
            },
            move |a, out, _| match out {
                Ok(_) => {
                    a.mode = Mode::List;
                    a.message = Some((sent(&handle, busy), Role::Green));
                }
                Err((e, true)) => {
                    if let Err(f) = write::forget(&config) {
                        tracing::warn!("forgetting the write token: {f:#}");
                    }
                    a.mode = Mode::List;
                    a.message = Some((format!("× {e}"), Role::Red));
                }
                Err((e, false)) => {
                    if let Mode::Compose { sending, note, .. } = &mut a.mode {
                        *sending = false;
                        *note = Some((format!("× {e}"), Role::Red));
                    }
                }
            },
            cx,
        );
    }

    /// A key by name (or a click as one), given the daemon's state and the owner's feed as the screen shows them.
    pub fn press(&mut self, name_: &str, st: &DaemonState, feed: Option<&Feed>, cx: &mut Context<BoxView>) -> Key {
        if self.busy {
            return Key::Ignored;
        }
        match &self.mode {
            Mode::Approve {
                handle,
                url,
                write,
                wait,
                start,
            } => {
                match (name_, *wait != Wait::Waiting) {
                    ("escape", _) => {
                        self.job = None;
                        self.mode = Mode::List;
                    }
                    ("o", _) => {
                        if let Some(s) = start {
                            cx.open_url(&s.verify_url);
                        }
                    }
                    ("r", true) => {
                        let (h, u, w) = (handle.clone(), url.clone(), *write);
                        self.ask(h, u, w, cx);
                    }
                    _ => return Key::Ignored,
                }
                return Key::Handled;
            }
            Mode::Confirm(handle) => {
                let handle = handle.clone();
                self.mode = Mode::List;
                if name_ == "x" {
                    self.remove(&handle, cx);
                }
                return Key::Handled;
            }
            /* Typed keys come through type_key; these are the status line's, clicked. */
            Mode::Compose { .. } => {
                match name_ {
                    "escape" => self.mode = Mode::List,
                    "enter" => self.submit(st, cx),
                    _ => return Key::Ignored,
                }
                return Key::Handled;
            }
            Mode::List => {}
        }
        let list = rows(&self.configured, st, wired(feed));
        let n = list.len();
        /* A click on a row picks it; on the picked row, it does what space or enter would. */
        let mut name_ = name_;
        if let Some(i) = name_.strip_prefix("row:").and_then(|i| i.parse::<usize>().ok()) {
            if i >= n {
                return Key::Ignored;
            }
            if i != self.selected {
                self.selected = i;
                return Key::Handled;
            }
            name_ = match &list[i] {
                Row::Here { .. } => "space",
                Row::Away { .. } => "enter",
            };
        }
        self.selected = self.selected.min(n.saturating_sub(1));
        let row = list.get(self.selected).cloned();
        match (name_, &row) {
            ("escape" | "a", _) => return Key::Close,
            ("up" | "k", _) if n > 0 => self.selected = (self.selected + n - 1) % n,
            ("down" | "j", _) if n > 0 => self.selected = (self.selected + 1) % n,
            ("space" | "right" | "tab", Some(r @ Row::Here { .. })) => self.cycle(r, 1),
            ("left", Some(r @ Row::Here { .. })) => self.cycle(r, -1),
            ("enter", Some(Row::Here { .. })) if !self.pending.is_empty() => self.save(cx),
            ("enter" | "h", Some(Row::Away { handle, .. })) => match feed {
                Some(f) => self.ask(handle.clone(), f.url.clone(), false, cx),
                None => return Key::Ignored,
            },
            ("m", Some(r)) => match feed {
                Some(f) => self.message(r.handle().to_string(), f.url.clone(), cx),
                None => return Key::Ignored,
            },
            ("x", Some(Row::Here { handle, .. })) => {
                if let Some(entry) = self.entry(row.as_ref().expect("a row")) {
                    let configured = entry.handle.clone();
                    self.message = None;
                    if self.configured.len() == 1 {
                        self.message = Some((
                            "× the last agent stays: copland-box --setup sets the box up again".into(),
                            Role::Red,
                        ));
                    } else {
                        let _ = handle;
                        self.mode = Mode::Confirm(configured);
                    }
                }
            }
            (
                "o",
                Some(Row::Here {
                    doing: Doing::Failed(Failed { log: Some(log), .. }),
                    ..
                }),
            ) => cx.open_url(&format!("file://{}", log.display())),
            ("r", _) => {
                self.found = None;
                self.detect(cx);
            }
            _ => return Key::Ignored,
        }
        Key::Handled
    }

    fn dots(&self) -> &'static str {
        ["   ", ".  ", ".. ", "..."][(self.since.elapsed().as_millis() / 500 % 4) as usize]
    }

    /// Whether something on screen moves by itself (the waiting dots).
    pub fn animating(&self) -> bool {
        self.busy
            || matches!(
                self.mode,
                Mode::Approve {
                    wait: Wait::Waiting,
                    ..
                }
            )
    }

    pub fn panel(&self, st: &DaemonState, feed: Option<&Feed>) -> Panel {
        match &self.mode {
            Mode::Approve {
                handle,
                write,
                start,
                wait,
                ..
            } => self.approve_panel(handle, *write, start.as_ref(), wait),
            Mode::Compose {
                handle,
                input,
                sending,
                note,
            } => compose_panel(handle, input, *sending, note.as_ref(), running(st, handle)),
            _ => self.list_panel(st, feed),
        }
    }

    fn approve_panel(&self, handle: &str, write: bool, start: Option<&DeviceStart>, wait: &Wait) -> Panel {
        let mut lines = if write {
            vec![
                Line::one(
                    format!("to message @{handle}, let the box write as you · approve it in copland"),
                    Role::Blue,
                ),
                Line::one(
                    format!(
                        "{} on {} asks for a read and write token for you, kept in {}",
                        setup::CLIENT,
                        self.host,
                        write::FILE
                    ),
                    Role::Faint,
                ),
            ]
        } else {
            vec![
                Line::one(format!("run @{handle} here · approve it in copland"), Role::Blue),
                Line::one(
                    format!("{} on {} asks for @{handle} only", setup::CLIENT, self.host),
                    Role::Faint,
                ),
            ]
        };
        if let Some(s) = start {
            lines.push(Line(
                vec![Span::new(s.verify_url.clone(), Role::Muted)],
                Some(s.verify_url.clone()),
            ));
        }
        let mut keys = Vec::new();
        match wait {
            Wait::Waiting if start.is_none() => {
                lines.push(Line::one(format!("asking for a code{}", self.dots()), Role::Faint))
            }
            Wait::Waiting => {
                lines.push(Line::one(
                    format!("waiting for you to approve{}", self.dots()),
                    Role::Muted,
                ));
                keys.push(key("o", "open in browser"));
            }
            other => {
                lines.push(Line::one(
                    match other {
                        Wait::Denied => "× denied in copland. nothing was saved".to_string(),
                        Wait::Expired => "× the code expired before it was approved".to_string(),
                        Wait::Failed(e) => format!("× {e}"),
                        Wait::Waiting => unreachable!(),
                    },
                    Role::Red,
                ));
                keys.push(key("r", "try again"));
            }
        }
        keys.push(key("esc", "back"));
        Panel {
            lines,
            input: None,
            code: start.map(|s| s.user_code.clone()),
            keys,
            clicks: Vec::new(),
        }
    }

    fn list_panel(&self, st: &DaemonState, feed: Option<&Feed>) -> Panel {
        let wired = wired(feed);
        let list = rows(&self.configured, st, wired);
        let n = list.len();
        let here = list.iter().filter(|r| matches!(r, Row::Here { .. })).count();
        let selected = self.selected.min(n.saturating_sub(1));
        let mut head = vec![Span::new("agents", Role::Blue)];
        head.push(Span::new(
            match (wired, feed) {
                (Some(w), _) => format!(" · {} in copland · {here} run here", w.len()),
                (None, Some(_)) => format!(" · {here} run here · reading the rest from copland…"),
                (None, None) => format!(" · {here} run here · owner_token_file shows the rest"),
            },
            Role::Muted,
        ));
        let mut lines = vec![Line(head, None)];
        let mut clicks: Vec<Option<String>> = vec![None];
        if let Some(e) = &self.unreadable {
            lines.push(Line::one(format!("× daemon.toml: {e}"), Role::Red));
            clicks.push(None);
        }

        let width = list
            .iter()
            .map(|r| name(r.handle()).chars().count())
            .max()
            .unwrap_or(0)
            .min(14);
        let first = selected.saturating_sub(ROWS - 1).min(n.saturating_sub(ROWS));
        for (i, r) in list.iter().enumerate().skip(first).take(ROWS) {
            let on = i == selected;
            let mut spans = vec![
                Span::new(if on { "› " } else { "  " }, Role::Blue),
                Span::new(
                    format!("{:<width$}  ", clip(name(r.handle()), width)),
                    if on { Role::Ink } else { Role::Muted },
                ),
            ];
            match r {
                Row::Here {
                    handle,
                    bound,
                    workdir,
                    doing,
                    paused,
                    ..
                } => {
                    let (label, role) = match self.pending_for_row(handle) {
                        Some(p) => (format!("→ {}", p.name().to_lowercase()), Role::Yellow),
                        None => (bound.label(), if on { Role::Ink } else { Role::Muted }),
                    };
                    spans.push(Span::new(format!("{:<13}", clip(&label, 13)), role));
                    spans.push(Span::new(format!("{:<20} ", clip_left(workdir, 20)), Role::Faint));
                    let (what, role) = match doing {
                        Doing::Starting => ("starting".to_string(), Role::Faint),
                        Doing::Watching => ("○ watching".to_string(), Role::Muted),
                        Doing::Running(k) => (format!("● {k}"), Role::Yellow),
                        Doing::AfterRun => ("● changes after this run".to_string(), Role::Yellow),
                        Doing::Error(e) => (format!("× {e}"), Role::Red),
                        Doing::Failed(f) => (format!("× {} {}", f.task, f.how), Role::Red),
                        Doing::Stopped => ("stopped".to_string(), Role::Faint),
                    };
                    spans.push(Span::new(what, role));
                    if *paused {
                        spans.push(Span::new(" · paused", Role::Yellow));
                    }
                }
                Row::Away { paused, leaving, .. } => {
                    spans.push(Span::new(
                        if *leaving {
                            "stopping here after its run"
                        } else {
                            "not on this machine"
                        },
                        Role::Faint,
                    ));
                    if *paused {
                        spans.push(Span::new(" · paused", Role::Yellow));
                    }
                }
            }
            lines.push(Line(spans, None));
            clicks.push(Some(format!("row:{i}")));
        }

        let row = list.get(selected);
        let detail = if self.busy {
            Some((format!("saving and applying{}", self.dots()), Role::Muted))
        } else if let Mode::Confirm(h) = &self.mode {
            Some((
                format!("x again stops running {} here, after a run in progress", name(h)),
                Role::Yellow,
            ))
        } else if let Some(m) = &self.message {
            Some(m.clone())
        } else if !self.pending.is_empty() {
            Some((
                format!(
                    "{} change{} · enter saves and applies, after a run in progress",
                    self.pending.len(),
                    if self.pending.len() == 1 { "" } else { "s" }
                ),
                Role::Yellow,
            ))
        } else {
            match row {
                Some(Row::Away { handle, paused, .. }) => Some((
                    format!(
                        "enter asks copland for @{handle}'s token{}",
                        if *paused { " · it runs once you resume it" } else { "" }
                    ),
                    Role::Faint,
                )),
                Some(Row::Here {
                    doing: Doing::Failed(f),
                    ..
                }) => Some(failed_detail(f)),
                Some(Row::Here {
                    bound: Bound::Own(_), ..
                }) => Some((
                    "its command is your own: space replaces it with a template".into(),
                    Role::Faint,
                )),
                _ => None,
            }
        };
        /* A failed run's line opens its log when clicked, as o does. */
        let log = match row {
            Some(Row::Here {
                doing: Doing::Failed(Failed { log: Some(_), .. }),
                ..
            }) => Some("o".to_string()),
            _ => None,
        };
        if let Some((text, role)) = detail {
            lines.push(Line::one(text, role));
            clicks.push(log.clone());
        }

        let mut keys = Vec::new();
        match (&self.mode, row) {
            (Mode::Confirm(_), _) => {
                keys.push(key("x", "stop it here"));
                keys.push(key("any key", "keep it"));
            }
            (_, Some(Row::Here { .. })) => {
                if !self.pending.is_empty() {
                    keys.push(key("enter", "save"));
                }
                keys.push(key("space", "runtime"));
                keys.push(key("x", "stop here"));
                if log.is_some() {
                    keys.push(key("o", "its log"));
                }
            }
            (_, Some(Row::Away { leaving: false, .. })) if feed.is_some() => keys.push(key("enter", "run it here")),
            _ => {}
        }
        if feed.is_some() && row.is_some() && !matches!(self.mode, Mode::Confirm(_)) {
            keys.push(key("m", "message"));
        }
        if n > 1 {
            keys.push(key("↑↓", "agent"));
        }
        keys.push(key("esc", "back"));
        Panel {
            lines,
            input: None,
            code: None,
            keys,
            clicks,
        }
    }

    fn pending_for_row(&self, handle: &str) -> Option<Runtime> {
        self.pending_for(handle).or_else(|| {
            self.pending
                .iter()
                .find(|(h, _)| same_handle(name(h), name(handle)))
                .map(|(_, r)| *r)
        })
    }
}

/// Whether the agent has a run going here: a message to it then waits for its next run.
fn running(st: &DaemonState, handle: &str) -> bool {
    st.agents
        .iter()
        .any(|s| !s.runs.is_empty() && (same_handle(&s.handle, handle) || same_handle(&s.configured, handle)))
}

/// What sending says once it is done.
fn sent(handle: &str, busy: bool) -> String {
    if busy {
        format!(
            "sent to {} · it reads it in its next run, after the one going",
            name(handle)
        )
    } else {
        format!("sent to {}", name(handle))
    }
}

/// Characters of the line shown either side of the cursor; the rest is clipped with an ellipsis.
const BEFORE: usize = 56;
const AFTER: usize = 20;

/// The message line: who it goes to, the text being typed, and what to know before sending.
fn compose_panel(handle: &str, input: &LineInput, sending: bool, note: Option<&(String, Role)>, busy: bool) -> Panel {
    let mut head = vec![Span::new(format!("message @{handle}"), Role::Blue)];
    if busy {
        head.push(Span::new(
            format!(" · {} has a run going: this waits for its next one", name(handle)),
            Role::Yellow,
        ));
    }
    let (before, after) = input.split();
    let count = input.text().trim().chars().count();
    let under = match (sending, note) {
        (true, _) => ("sending…".to_string(), Role::Muted),
        (false, Some(n)) => n.clone(),
        (false, None) => (
            format!("{count}/{MESSAGE_MAX} · as you, with your write token"),
            if count > MESSAGE_MAX { Role::Red } else { Role::Faint },
        ),
    };
    Panel {
        lines: vec![Line(head, None), Line::one("", Role::Ink), Line::one(under.0, under.1)],
        input: Some((1, clip_left(before, BEFORE), clip(after, AFTER))),
        code: None,
        keys: vec![key("enter", "send"), key("ctrl+v", "paste"), key("esc", "back")],
        clicks: Vec::new(),
    }
}

fn wired(feed: Option<&Feed>) -> Option<&[WiredAgent]> {
    feed.and_then(|f| f.wired.as_ref()).map(|(w, _)| w.agents.as_slice())
}

/// At most `n` characters, an ellipsis for the rest.
fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n.saturating_sub(1)).chain(['…']).collect()
    }
}

/// At most `n` characters, keeping the end (a path's last parts).
fn clip_left(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n {
        s.to_string()
    } else {
        std::iter::once('…').chain(s.chars().skip(count + 1 - n)).collect()
    }
}

/// What an approved device code brought.
struct Approved {
    url: String,
    /// Yours: only for a write token here, since the box already holds your read-only one.
    owner: Option<DeviceIdentity>,
    agents: Vec<DeviceIdentity>,
}

/// Poll a device code until it is answered or lapses: what it brought when approved, else how
/// it ended. A failure that may pass (the network) is tried again.
async fn poll(api: Api, code: String, interval: u64, expires_in: u64) -> Result<Approved, Wait> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(expires_in.max(1));
    let mut every = Duration::from_secs(interval.clamp(1, 60));
    loop {
        tokio::time::sleep(every).await;
        if tokio::time::Instant::now() >= deadline {
            return Err(Wait::Expired);
        }
        match api.device_poll(&code).await {
            Ok(DevicePoll::Pending { slow_down }) => {
                if slow_down {
                    every += Duration::from_secs(SLOW_DOWN);
                }
            }
            Ok(DevicePoll::Denied) => return Err(Wait::Denied),
            Ok(DevicePoll::Expired) => return Err(Wait::Expired),
            Ok(DevicePoll::Approved { url, owner, agents }) => return Ok(Approved { url, owner, agents }),
            Err(e) if e.is_refusal() => return Err(Wait::Failed(e.to_string())),
            Err(e) => tracing::warn!("polling the device code: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use copland_daemon_core::config::Secret;

    fn agent(handle: &str, runtime: Option<Runtime>) -> AgentConfig {
        AgentConfig {
            url: "http://x".into(),
            handle: handle.into(),
            token: Secret::new("cpl_t"),
            command: runtime.map_or_else(|| vec!["/usr/bin/my-agent".into()], Runtime::command),
            workdir: "/srv/agents/dev".into(),
            client: "Claude Code".into(),
            code_command: None,
            writable: Vec::new(),
            runtime: copland_daemon_core::config::Runtime::ClaudeCode,
            code_dir: "/tmp/copland-code".into(),
            max_runs: 10,
        }
    }

    fn wired_agent(id: &str, handle: &str, paused: bool) -> WiredAgent {
        WiredAgent {
            id: id.into(),
            handle: handle.into(),
            name: name(handle).into(),
            paused,
        }
    }

    #[test]
    fn names_the_runtime_or_says_the_command_is_ones_own() {
        assert_eq!(
            Bound::of(&agent("me/a", Some(Runtime::Codex))),
            Bound::Runtime(Runtime::Codex)
        );
        assert_eq!(Bound::of(&agent("me/a", None)), Bound::Own("my-agent".into()));
        assert_eq!(Bound::Own("claude".into()).label(), "claude (own)");
    }

    #[test]
    fn lists_what_runs_here_then_the_rest_of_yours() {
        let configured = [agent("me/dev", Some(Runtime::ClaudeCode)), agent("me/old-name", None)];
        let mut dev = AgentState::new("me/dev", "http://x");
        dev.user_id = Some("u1".into());
        dev.run_started("8f31", "T-1");
        /* Renamed in copland: found by the id its token answers to. */
        let mut renamed = AgentState::new("me/old-name", "http://x");
        renamed.user_id = Some("u2".into());
        renamed.phase = Phase::Idle;
        let st = DaemonState {
            agents: vec![dev, renamed],
            stopping: false,
        };
        let wired = [
            wired_agent("u1", "me/dev", false),
            wired_agent("u2", "me/new-name", true),
            wired_agent("u3", "me/review", true),
        ];
        let r = rows(&configured, &st, Some(&wired));
        assert_eq!(r.len(), 3);
        assert!(
            matches!(&r[0], Row::Here { doing: Doing::Running(k), paused: false, bound: Bound::Runtime(Runtime::ClaudeCode), .. } if k == "T-1")
        );
        assert!(
            matches!(&r[1], Row::Here { handle, doing: Doing::Watching, paused: true, .. } if handle == "me/new-name")
        );
        assert_eq!(
            r[2],
            Row::Away {
                handle: "me/review".into(),
                paused: true,
                leaving: false
            }
        );

        /* Without the owner's feed: what runs here, and nothing else. */
        let r = rows(&configured, &st, None);
        assert_eq!(r.len(), 2);
    }

    /// A run that went wrong is said on its agent's line, how it ended and where its log is,
    /// until the next run; one that ended well isn't.
    #[test]
    fn a_failed_run_says_how_it_ended_until_the_next() {
        let configured = [agent("me/dev", Some(Runtime::ClaudeCode))];
        let mut dev = AgentState::new("me/dev", "http://x");
        dev.phase = Phase::Idle;
        dev.last_run = Some(copland_daemon_core::state::RunSummary {
            run: "dab0".into(),
            task: "COPL-132".into(),
            outcome: "failed".into(),
            failed: true,
            how: Some("exit 1 after 3.8s".into()),
            hint: Some("claude exited at once with no output: check the runtime outside the box".into()),
            log: Some("/s/runs/dab0.log".into()),
            ended: std::time::SystemTime::now(),
        });
        let mut st = DaemonState {
            agents: vec![dev],
            stopping: false,
        };
        let Row::Here {
            doing: Doing::Failed(f),
            ..
        } = &rows(&configured, &st, None)[0]
        else {
            panic!("not failed");
        };
        assert_eq!((f.task.as_str(), f.how.as_str()), ("COPL-132", "exit 1 after 3.8s"));
        assert_eq!(
            failed_detail(f),
            (
                "claude exited at once with no output: check the runtime outside the box · o opens its log".into(),
                Role::Red
            )
        );
        let quiet = Failed {
            hint: None,
            log: None,
            ..f.clone()
        };
        assert_eq!(failed_detail(&quiet).0, "run dab0 on COPL-132 exit 1 after 3.8s");

        /* The next run is what the line says while it goes, and once it ends well, watching. */
        st.agents[0].run_started("8f31", "COPL-132");
        assert!(matches!(
            &rows(&configured, &st, None)[0],
            Row::Here {
                doing: Doing::Running(_),
                ..
            }
        ));
        st.agents[0].run_ended("8f31");
        if let Some(r) = &mut st.agents[0].last_run {
            r.failed = false;
        }
        assert!(matches!(
            &rows(&configured, &st, None)[0],
            Row::Here {
                doing: Doing::Watching,
                ..
            }
        ));
        /* What the machine lacks says more than a run that went wrong. */
        st.agents[0].last_error = Some("bwrap not found on PATH: coding runs can't start".into());
        assert!(matches!(
            &rows(&configured, &st, None)[0],
            Row::Here {
                doing: Doing::Error(_),
                ..
            }
        ));
        /* Copland down (COPL-148) says more than a run going, which waits on it to finish. */
        st.agents[0].last_error = None;
        st.agents[0].run_started("8f32", "COPL-133");
        st.agents[0].unavailable =
            Some(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_791_156_041));
        assert!(matches!(
            &rows(&configured, &st, None)[0],
            Row::Here {
                doing: Doing::Error(e),
                ..
            } if e == "Copland unavailable since 23:20 UTC"
        ));
    }

    #[test]
    fn a_changed_agent_in_a_run_says_its_change_waits() {
        let configured = [agent("me/dev", Some(Runtime::Codex))];
        let mut dev = AgentState::new("me/dev", "http://x");
        dev.retiring = true;
        dev.run_started("8f31", "T-1");
        let st = DaemonState {
            agents: vec![dev],
            stopping: false,
        };
        assert!(matches!(
            &rows(&configured, &st, None)[0],
            Row::Here {
                doing: Doing::AfterRun,
                ..
            }
        ));

        /* Removed while in a run: listed as yours, finishing here. */
        let mut st = st;
        st.agents[0].user_id = Some("u1".into());
        let wired = [wired_agent("u1", "me/dev", false)];
        let r = rows(&[], &st, Some(&wired));
        assert_eq!(
            r,
            [Row::Away {
                handle: "me/dev".into(),
                paused: false,
                leaving: true
            }]
        );
    }

    #[test]
    fn clips_names_and_paths() {
        assert_eq!(clip("reviewer", 5), "revi…");
        assert_eq!(clip("dev", 5), "dev");
        assert_eq!(clip_left("~/agents/a-very-long-folder", 10), "…ng-folder");
        assert_eq!(clip_left("~/a", 10), "~/a");
    }

    #[test]
    fn a_message_to_an_agent_in_a_run_says_it_waits_for_the_next() {
        let mut dev = AgentState::new("me/dev", "http://x");
        dev.handle = "me/dev".into();
        let idle = DaemonState {
            agents: vec![dev.clone()],
            stopping: false,
        };
        assert!(!running(&idle, "me/dev"));
        dev.run_started("8f31", "T-1");
        let st = DaemonState {
            agents: vec![dev],
            stopping: false,
        };
        assert!(running(&st, "@me/dev") && !running(&st, "me/review"));
        assert_eq!(sent("me/dev", false), "sent to dev");
        assert!(sent("me/dev", true).contains("next run"));

        let p = compose_panel("me/dev", &LineInput::new("look at T-2"), false, None, true);
        assert!(p.lines[0].0.iter().any(|s| s.text.contains("waits for its next one")));
        assert_eq!(p.input, Some((1, "look at T-2".into(), String::new())));
        assert_eq!(p.lines[2].0[0].text, "11/1000 · as you, with your write token");
        /* A long line shows the end before the cursor. */
        let long = "x".repeat(200);
        let p = compose_panel("me/dev", &LineInput::new(&long), false, None, false);
        let (_, before, _) = p.input.unwrap();
        assert_eq!(before.chars().count(), BEFORE);
        assert!(before.starts_with('…'));
        assert!(p.lines[0].0.len() == 1);
        let p = compose_panel("me/dev", &LineInput::new("hi"), true, None, false);
        assert_eq!(p.lines[2].0[0].text, "sending…");
    }
}
