//! Setup in the window (COPL-47), for a box started without a usable config or
//! with `--setup`: the Copland address, approving this machine in the browser
//! (a device code), the runtimes found on PATH, then daemon.toml written and the
//! daemon started in place, without a restart.
//!
//! The steps are plain state here; `Panel` is what one of them says, which the
//! view draws under the idle poles. Network calls and runtime detection run on
//! a small Tokio runtime of setup's own and come back through GPUI tasks.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use copland_daemon_core::Config;
use copland_daemon_core::api::{Api, ApiError, DevicePoll, DeviceStart};
use gpui::{Context, KeyDownEvent, Task};

use crate::runtime::{self, Found};
use crate::scene::{Line, Role, Span};
use crate::setup::{self, Choice, LineInput, Saved};
use crate::view::BoxView;

/// Agents shown at once on the runtimes step; the rest scroll with the selection.
const AGENT_ROWS: usize = 3;
/// RFC 8628's step when the server says to slow down.
const SLOW_DOWN: u64 = 5;

/// What a key did to a line being typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Typed {
    Changed,
    /// Enter: what it does is the caller's.
    Enter,
    Ignored,
}

/// A key on a line being typed (setup's address, a message to an agent): characters, moving
/// and deleting, ctrl+a/e/u/w as in a shell, ctrl+v or shift+insert to paste.
pub fn type_into(input: &mut LineInput, e: &KeyDownEvent, cx: &mut Context<BoxView>) -> Typed {
    let k = &e.keystroke;
    let m = k.modifiers;
    let name = k.key.as_str();
    if (m.control && name == "v") || (m.shift && name == "insert") {
        if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
            input.insert(&text);
        }
    } else if m.control {
        match name {
            "a" => input.home(),
            "e" => input.end(),
            "u" => input.clear(),
            "w" | "backspace" => input.delete_word(),
            _ => return Typed::Ignored,
        }
    } else {
        match name {
            "enter" => return Typed::Enter,
            "backspace" => input.backspace(),
            "delete" => input.delete(),
            "left" => input.left(),
            "right" => input.right(),
            "home" => input.home(),
            "end" => input.end(),
            _ => match &k.key_char {
                Some(c) if !m.alt && !m.platform => input.insert(c),
                _ => return Typed::Ignored,
            },
        }
    }
    Typed::Changed
}

/// Where the approval stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wait {
    Waiting,
    Denied,
    Expired,
    Failed(String),
}

pub enum Step {
    /// Typing the address; `busy` while the code is being asked for.
    Address {
        input: LineInput,
        error: Option<String>,
        busy: bool,
    },
    Approve {
        url: String,
        start: DeviceStart,
        wait: Wait,
        /// A poll that failed for a reason that may pass (the network); polling goes on.
        note: Option<String>,
    },
    /// The tokens are saved; picking a runtime per agent. `found` is None while looking.
    Runtimes {
        saved: Saved,
        found: Option<Vec<Found>>,
        /// Per agent, an index into `found`.
        picks: Vec<usize>,
        selected: usize,
        error: Option<String>,
    },
}

/// What a step says: lines under the poles, maybe a code drawn large beside them, and the
/// keys in the status line. `input` is the line that is the text field, drawn with a cursor.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Panel {
    pub lines: Vec<Line>,
    pub input: Option<(usize, String, String)>,
    pub code: Option<String>,
    pub keys: Vec<Line>,
    /// What clicking a line does, by line: a key name the panel's own key handler takes, so
    /// the mouse does what the keyboard does ("row:2" picks that row). A key in the status
    /// line is clicked as the key it names.
    pub clicks: Vec<Option<String>>,
}

/// The key a status-line hint names, for clicking it: "esc" is escape, "↑↓" moves down.
pub fn hint_key(hint: &Line) -> Option<String> {
    let k = hint.0.first()?.text.trim();
    Some(
        match k {
            "esc" => "escape",
            "↑↓" => "down",
            "←→" => "right",
            "any key" => "escape",
            other => other,
        }
        .to_string(),
    )
}

pub struct Wizard {
    pub step: Step,
    config: PathBuf,
    host: String,
    rt: Arc<tokio::runtime::Runtime>,
    /// The config this would replace (kept as a backup), when there is one.
    replaces: Option<PathBuf>,
    /// Starts the daemon on a config once it is written: the view's next source.
    launch: Option<Box<dyn FnOnce(Config) -> anyhow::Result<crate::view::Source>>>,
    /// The step's network call or detection; replacing it cancels the old one.
    job: Option<Task<()>>,
    /// When the approval wait began, for the dots.
    since: Instant,
}

pub(crate) fn key(k: &str, what: &str) -> Line {
    Line(
        vec![Span::new(k, Role::Ink), Span::new(format!("  {what}"), Role::Muted)],
        None,
    )
}

impl Wizard {
    pub fn new(
        config: PathBuf,
        url: Option<&str>,
        launch: Box<dyn FnOnce(Config) -> anyhow::Result<crate::view::Source>>,
    ) -> anyhow::Result<Self> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("setup")
            .enable_all()
            .build()?;
        let replaces = config.exists().then(|| config.clone());
        let step = match setup::load_pending(&config) {
            Some(Ok(saved)) => Self::runtimes(saved),
            Some(Err(e)) => Step::Address {
                input: LineInput::new(url.unwrap_or("")),
                error: Some(format!("{e:#}")),
                busy: false,
            },
            None => Step::Address {
                input: LineInput::new(url.unwrap_or("")),
                error: None,
                busy: false,
            },
        };
        Ok(Self {
            step,
            config,
            host: setup::hostname(),
            rt: Arc::new(rt),
            replaces,
            launch: Some(launch),
            job: None,
            since: Instant::now(),
        })
    }

    /// Say `note` on the address step (what signing out couldn't do, say).
    pub fn note(&mut self, note: String) {
        if let Step::Address { error, .. } = &mut self.step {
            *error = Some(note);
        }
    }

    fn runtimes(saved: Saved) -> Step {
        let n = saved.agents.len();
        Step::Runtimes {
            saved,
            found: None,
            picks: vec![0; n],
            selected: 0,
            error: None,
        }
    }

    /// Whatever the first step needs started (picking up at the runtimes step looks for them).
    pub fn begin(&mut self, cx: &mut Context<BoxView>) {
        if matches!(self.step, Step::Runtimes { .. }) {
            self.detect(cx);
        }
    }

    /// Run `fut` on setup's Tokio runtime and hand its result to `then`, on the view.
    fn job<T: Send + 'static>(
        &mut self,
        fut: impl std::future::Future<Output = T> + Send + 'static,
        then: impl FnOnce(&mut Wizard, T, &mut Context<BoxView>) + 'static,
        cx: &mut Context<BoxView>,
    ) {
        let handle = self.rt.spawn(fut);
        self.job = Some(cx.spawn(async move |this, cx| {
            let Ok(out) = handle.await else { return };
            let _ = this.update(cx, |view, cx| {
                if let Some(w) = view.wizard() {
                    then(w, out, cx);
                }
                cx.notify();
            });
        }));
    }

    fn submit(&mut self, cx: &mut Context<BoxView>) {
        let Step::Address { input, error, busy } = &mut self.step else {
            return;
        };
        if *busy {
            return;
        }
        match setup::normalize_url(input.text()) {
            Ok(url) => {
                *input = LineInput::new(&url);
                *error = None;
                *busy = true;
                self.start(url, cx);
            }
            Err(e) => *error = Some(e.to_string()),
        }
    }

    /// Ask the instance for a device code.
    fn start(&mut self, url: String, cx: &mut Context<BoxView>) {
        let host = self.host.clone();
        let at = url.clone();
        self.job(
            async move {
                let api = Api::new(&at).map_err(|e| format!("{e:#}"))?;
                api.device_start(setup::CLIENT, &host, &[], false)
                    .await
                    .map_err(|e| match &e {
                        ApiError::Status { status: 404 | 405, .. } => {
                            format!("{at} has no device setup: not a Copland, or one older than this box")
                        }
                        _ => format!("{at}: {e}"),
                    })
            },
            move |w, out, cx| match out {
                Ok(start) => {
                    cx.open_url(&start.verify_url);
                    w.since = Instant::now();
                    let (interval, expires) = (start.interval, start.expires_in);
                    let code = start.device_code.clone();
                    w.step = Step::Approve {
                        url: url.clone(),
                        start,
                        wait: Wait::Waiting,
                        note: None,
                    };
                    w.poll(url, code, interval, expires, cx);
                }
                Err(e) => {
                    w.step = Step::Address {
                        input: LineInput::new(&url),
                        error: Some(e),
                        busy: false,
                    };
                }
            },
            cx,
        );
    }

    /// Poll every `interval` seconds until the code is answered or lapses.
    fn poll(&mut self, url: String, code: String, interval: u64, expires_in: u64, cx: &mut Context<BoxView>) {
        let rt = self.rt.clone();
        let deadline = Instant::now() + Duration::from_secs(expires_in.max(1));
        self.job = Some(cx.spawn(async move |this, cx| {
            let mut every = Duration::from_secs(interval.clamp(1, 60));
            let api = match Api::new(&url) {
                Ok(a) => a,
                Err(e) => {
                    let _ = this.update(cx, |v, cx| {
                        if let Some(w) = v.wizard() {
                            w.set_wait(Wait::Failed(format!("{e:#}")));
                        }
                        cx.notify();
                    });
                    return;
                }
            };
            loop {
                cx.background_executor().timer(every).await;
                if Instant::now() >= deadline {
                    let _ = this.update(cx, |v, cx| {
                        if let Some(w) = v.wizard() {
                            w.set_wait(Wait::Expired);
                        }
                        cx.notify();
                    });
                    return;
                }
                let (api2, code2) = (api.clone(), code.clone());
                let Ok(answer) = rt.spawn(async move { api2.device_poll(&code2).await }).await else {
                    return;
                };
                let mut done = true;
                let _ = this.update(cx, |v, cx| {
                    let Some(w) = v.wizard() else { return };
                    match answer {
                        Ok(DevicePoll::Pending { slow_down }) => {
                            if slow_down {
                                every += Duration::from_secs(SLOW_DOWN);
                            }
                            w.set_note(None);
                            done = false;
                        }
                        Ok(DevicePoll::Denied) => w.set_wait(Wait::Denied),
                        Ok(DevicePoll::Expired) => w.set_wait(Wait::Expired),
                        Ok(DevicePoll::Approved {
                            url,
                            owner: Some(owner),
                            agents,
                        }) => w.approved(&url, &owner, &agents, cx),
                        /* Setup never names agents, so the server always sends the owner's token here. */
                        Ok(DevicePoll::Approved { owner: None, .. }) => w.set_wait(Wait::Failed(
                            "the approval came without a token for you; try again".into(),
                        )),
                        Err(e) if e.is_refusal() => w.set_wait(Wait::Failed(e.to_string())),
                        Err(e) => {
                            w.set_note(Some(e.to_string()));
                            done = false;
                        }
                    }
                    cx.notify();
                });
                if done {
                    return;
                }
            }
        }));
    }

    fn set_wait(&mut self, to: Wait) {
        if let Step::Approve { wait, .. } = &mut self.step {
            *wait = to;
        }
    }

    fn set_note(&mut self, to: Option<String>) {
        if let Step::Approve { note, .. } = &mut self.step {
            *note = to;
        }
    }

    /// The tokens are here, once: on disk before anything else.
    fn approved(
        &mut self,
        url: &str,
        owner: &copland_daemon_core::api::DeviceIdentity,
        agents: &[copland_daemon_core::api::DeviceIdentity],
        cx: &mut Context<BoxView>,
    ) {
        match setup::save_tokens(&self.config, url, owner, agents) {
            Ok(saved) => {
                tracing::info!(
                    agents = saved.agents.len(),
                    "approved as @{}; tokens saved",
                    saved.owner
                );
                self.step = Self::runtimes(saved);
                self.detect(cx);
            }
            Err(e) => self.set_wait(Wait::Failed(format!("saving the tokens: {e:#}"))),
        }
    }

    fn detect(&mut self, cx: &mut Context<BoxView>) {
        if let Step::Runtimes { found, .. } = &mut self.step {
            *found = None;
        }
        self.job(
            runtime::detect(),
            |w, list, _| {
                if let Step::Runtimes { found, picks, .. } = &mut w.step {
                    tracing::info!(
                        "runtimes: {}",
                        list.iter().map(|f| f.runtime.name()).collect::<Vec<_>>().join(", ")
                    );
                    for p in picks.iter_mut() {
                        *p = 0;
                    }
                    *found = Some(list);
                }
            },
            cx,
        );
    }

    /// Write daemon.toml and hand the view its running daemon.
    fn save(&mut self) -> Option<crate::view::Source> {
        let Step::Runtimes {
            saved,
            found: Some(found),
            picks,
            error,
            ..
        } = &mut self.step
        else {
            return None;
        };
        if found.is_empty() {
            return None;
        }
        let choices: Vec<Choice> = saved
            .agents
            .iter()
            .zip(picks.iter())
            .map(|(a, &p)| Choice {
                runtime: found[p.min(found.len() - 1)].runtime,
                workdir: setup::default_workdir(&setup::agent_name(&a.handle)),
            })
            .collect();
        let result = setup::write_config(&self.config, saved, &choices).and_then(|backup| {
            if let Some(b) = backup {
                tracing::info!("kept the old config as {}", b.display());
            }
            tracing::info!("wrote {}", self.config.display());
            Config::load(&self.config)
        });
        let config = match result {
            Ok(c) => c,
            Err(e) => {
                *error = Some(format!("{e:#}"));
                return None;
            }
        };
        let launch = self.launch.take()?;
        match launch(config) {
            Ok(source) => Some(source),
            Err(e) => {
                *error = Some(format!("starting the daemon: {e:#}"));
                None
            }
        }
    }

    /// A key on the window. Some source when setup is over and the daemon runs.
    pub fn key(&mut self, e: &KeyDownEvent, cx: &mut Context<BoxView>) -> Option<crate::view::Source> {
        let k = &e.keystroke;
        let m = k.modifiers;
        let name = k.key.as_str();
        if name == "escape" || (m.control && name == "q") {
            cx.quit();
            return None;
        }
        match &mut self.step {
            Step::Address { input, busy, error } => {
                if *busy {
                    return None;
                }
                match type_into(input, e, cx) {
                    Typed::Enter => {
                        self.submit(cx);
                        return None;
                    }
                    Typed::Changed => *error = None,
                    Typed::Ignored => return None,
                }
            }
            Step::Approve { url, start, wait, .. } => match (name, *wait != Wait::Waiting) {
                ("o", _) => cx.open_url(&start.verify_url),
                ("r", true) => {
                    let url = url.clone();
                    self.step = Step::Address {
                        input: LineInput::new(&url),
                        error: None,
                        busy: true,
                    };
                    self.start(url, cx);
                }
                ("b", true) => {
                    let url = url.clone();
                    self.job = None;
                    self.step = Step::Address {
                        input: LineInput::new(&url),
                        error: None,
                        busy: false,
                    };
                }
                _ => return None,
            },
            Step::Runtimes {
                saved,
                found,
                picks,
                selected,
                ..
            } => {
                let n = saved.agents.len();
                let kinds = found.as_ref().map_or(0, Vec::len);
                match name {
                    "up" | "k" if n > 0 => *selected = (*selected + n - 1) % n,
                    "down" | "j" if n > 0 => *selected = (*selected + 1) % n,
                    "space" | "tab" | "right" if kinds > 1 => picks[*selected] = (picks[*selected] + 1) % kinds,
                    "left" if kinds > 1 => picks[*selected] = (picks[*selected] + kinds - 1) % kinds,
                    "r" => self.detect(cx),
                    "enter" if kinds > 0 && n > 0 => return self.save(),
                    _ => return None,
                }
            }
        }
        cx.notify();
        None
    }

    /// The dots after "waiting": one more every half second.
    fn dots(&self) -> &'static str {
        ["   ", ".  ", ".. ", "..."][(self.since.elapsed().as_millis() / 500 % 4) as usize]
    }

    /// Whether something on screen moves by itself (the waiting dots).
    pub fn animating(&self) -> bool {
        matches!(
            self.step,
            Step::Approve {
                wait: Wait::Waiting,
                ..
            } | Step::Address { busy: true, .. }
                | Step::Runtimes { found: None, .. }
        )
    }

    pub fn panel(&self) -> Panel {
        let head = |s: &str| Line::one(s, Role::Blue);
        let faint = |s: String| Line::one(s, Role::Faint);
        let quit = key("esc", "quit");
        match &self.step {
            Step::Address { input, error, busy } => {
                let (before, after) = input.split();
                let mut lines = vec![
                    head("set up this box · your copland's address"),
                    Line::one("", Role::Ink),
                ];
                lines.push(match (error, busy) {
                    (Some(e), _) => Line::one(format!("× {e}"), Role::Red),
                    (None, true) => faint(format!("asking for a code{}", self.dots())),
                    (None, false) => faint("e.g. copland.example.com · https:// is added".into()),
                });
                if let Some(old) = &self.replaces {
                    lines.push(faint(format!(
                        "replaces {} (the old one is kept as .bak)",
                        setup::tilde(old)
                    )));
                }
                Panel {
                    lines,
                    input: Some((1, before.to_string(), after.to_string())),
                    code: None,
                    keys: vec![key("enter", "connect"), key("ctrl+v", "paste"), quit],
                    clicks: Vec::new(),
                }
            }
            Step::Approve { url, start, wait, note } => {
                let verify = Line(
                    vec![Span::new(start.verify_url.clone(), Role::Muted)],
                    Some(start.verify_url.clone()),
                );
                let mut lines = vec![
                    head("approve this box in copland"),
                    faint(format!("{} on {} wants your agents", setup::CLIENT, self.host)),
                    verify,
                ];
                let mut keys = vec![key("o", "open in browser")];
                match wait {
                    Wait::Waiting => lines.push(match note {
                        Some(n) => Line::one(format!("× {n} · still trying"), Role::Red),
                        None => Line::one(format!("waiting for you to approve{}", self.dots()), Role::Muted),
                    }),
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
                        keys = vec![key("r", "try again"), key("b", "change address")];
                    }
                }
                let _ = url;
                keys.push(quit);
                Panel {
                    lines,
                    input: None,
                    code: Some(start.user_code.clone()),
                    keys,
                    clicks: Vec::new(),
                }
            }
            Step::Runtimes {
                saved,
                found,
                picks,
                selected,
                error,
            } => {
                let n = saved.agents.len();
                let mut lines = vec![Line(
                    vec![
                        Span::new("approved", Role::Green),
                        Span::new(
                            format!(
                                " · @{} · {n} agent{} · tokens saved",
                                saved.owner,
                                if n == 1 { "" } else { "s" }
                            ),
                            Role::Muted,
                        ),
                    ],
                    None,
                )];
                let mut keys = Vec::new();
                match found {
                    None => lines.push(faint(format!("looking for runtimes{}", self.dots()))),
                    Some(found) if found.is_empty() => {
                        lines.push(Line::one(
                            "no runtime on PATH. install one, then press r:",
                            Role::Yellow,
                        ));
                        for r in runtime::Runtime::ALL {
                            lines.push(Line(
                                vec![
                                    Span::new(format!("  {:<12}", r.name().to_lowercase()), Role::Ink),
                                    Span::new(r.install_hint(), Role::Muted),
                                ],
                                None,
                            ));
                        }
                        keys.push(key("r", "look again"));
                        keys.push(key("esc", "quit · setup picks up here next time"));
                    }
                    Some(found) => {
                        let mut have: Vec<Span> = Vec::new();
                        for r in runtime::Runtime::ALL {
                            if !have.is_empty() {
                                have.push(Span::new("  ·  ", Role::Faint));
                            }
                            match found.iter().find(|f| f.runtime == r) {
                                Some(f) => {
                                    have.push(Span::new("✓ ", Role::Green));
                                    have.push(Span::new(
                                        format!(
                                            "{} {}",
                                            r.name().to_lowercase(),
                                            f.version.as_deref().unwrap_or("(no version)")
                                        ),
                                        Role::Ink,
                                    ));
                                }
                                None => {
                                    have.push(Span::new(format!("{} not found", r.name().to_lowercase()), Role::Faint))
                                }
                            }
                        }
                        lines.push(Line(have, None));
                        if n == 0 {
                            lines.push(Line::one(
                                "× no agents yet: make one in copland (settings › agents), then copland-box --setup",
                                Role::Red,
                            ));
                        }
                        /* A window of rows around the selection. */
                        let first = selected
                            .saturating_sub(AGENT_ROWS - 1)
                            .min(n.saturating_sub(AGENT_ROWS));
                        let width = saved
                            .agents
                            .iter()
                            .map(|a| setup::agent_name(&a.handle).chars().count())
                            .max()
                            .unwrap_or(0);
                        for (i, a) in saved.agents.iter().enumerate().skip(first).take(AGENT_ROWS) {
                            let name = setup::agent_name(&a.handle);
                            let r = found[picks[i].min(found.len() - 1)].runtime;
                            let on = i == *selected;
                            lines.push(Line(
                                vec![
                                    Span::new(if on { "› " } else { "  " }, Role::Blue),
                                    Span::new(format!("{name:<width$}  "), if on { Role::Ink } else { Role::Muted }),
                                    Span::new(
                                        format!("{:<12}", r.name().to_lowercase()),
                                        if on { Role::Yellow } else { Role::Muted },
                                    ),
                                    Span::new(setup::default_workdir(&name), Role::Faint),
                                ],
                                None,
                            ));
                        }
                        if n > 0 {
                            keys.push(key("enter", "save and start"));
                            if n > 1 {
                                keys.push(key("↑↓", "agent"));
                            }
                            if found.len() > 1 {
                                keys.push(key("space", "runtime"));
                            }
                        }
                        keys.push(quit);
                    }
                }
                if let Some(e) = error {
                    lines.insert(1, Line::one(format!("× {e}"), Role::Red));
                }
                if keys.is_empty() {
                    keys.push(key("esc", "quit"));
                }
                Panel {
                    lines,
                    input: None,
                    code: None,
                    keys,
                    clicks: Vec::new(),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::setup::SavedAgent;

    fn wizard(step: Step) -> Wizard {
        let mut w = Wizard::new(
            std::env::temp_dir().join("copland-wizard-test-none/daemon.toml"),
            None,
            Box::new(|_| anyhow::bail!("not in a test")),
        )
        .unwrap();
        w.step = step;
        w
    }

    fn text(l: &Line) -> String {
        l.0.iter().map(|s| s.text.as_str()).collect()
    }

    #[test]
    fn the_address_step_shows_the_field_and_its_error() {
        let w = wizard(Step::Address {
            input: LineInput::new("copland.dev"),
            error: Some("nope".into()),
            busy: false,
        });
        let p = w.panel();
        assert_eq!(p.input, Some((1, "copland.dev".into(), String::new())));
        assert_eq!(text(&p.lines[2]), "× nope");
        assert_eq!(text(&p.keys[0]), "enter  connect");
    }

    #[test]
    fn the_runtimes_step_lists_agents_with_their_pick() {
        let saved = Saved {
            url: "http://x".into(),
            owner: "me".into(),
            owner_token_file: "/c/me.token".into(),
            agents: ["me/dev", "me/review"]
                .iter()
                .map(|h| SavedAgent {
                    handle: h.to_string(),
                    token_file: "/c/x.token".into(),
                })
                .collect(),
        };
        let found = vec![
            Found {
                runtime: runtime::Runtime::ClaudeCode,
                path: "/bin/claude".into(),
                version: Some("2.1.283".into()),
            },
            Found {
                runtime: runtime::Runtime::Codex,
                path: "/bin/codex".into(),
                version: None,
            },
        ];
        let w = wizard(Step::Runtimes {
            saved: saved.clone(),
            found: Some(found),
            picks: vec![0, 1],
            selected: 1,
            error: None,
        });
        let p = w.panel();
        let all: Vec<String> = p.lines.iter().map(text).collect();
        assert!(all[0].starts_with("approved · @me · 2 agents"), "{all:?}");
        assert!(all[1].contains("claude code 2.1.283") && all[1].contains("codex (no version)"));
        assert_eq!(all[2], "  dev     claude code ~/agents/dev");
        assert_eq!(all[3], "› review  codex       ~/agents/review");

        let none = wizard(Step::Runtimes {
            saved,
            found: Some(vec![]),
            picks: vec![0, 0],
            selected: 0,
            error: None,
        });
        let all: Vec<String> = none.panel().lines.iter().map(text).collect();
        assert!(all[1].starts_with("no runtime on PATH"));
        assert!(all[2].contains("npm i -g @anthropic-ai/claude-code"));
    }
}
