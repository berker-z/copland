//! The window: the scene's raster painted as quads at an integer cell size, the
//! lists and the status line as text, laid out as the prototype's `.box`.
//!
//! It draws only when something changes: every frame while an item travels,
//! about twenty times a second while a run's current flows, twelve while the wires
//! only sway, once a second while a run's timer shows, and otherwise when the daemon
//! or the owner's feed says something new.
//!
//! The title bar has the bell (what needs you, COPL-64) and ≡ (the menu, COPL-65).
//! In compact mode the window is the status line alone, the bell and ≡ at its end.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use copland_daemon_core::{DaemonState, Phase};
use gpui::{
    Bounds, Context, FocusHandle, Hsla, KeyDownEvent, MouseButton, MouseDownEvent, Rgba, SharedString, StyledText,
    Task, Window, canvas, div, fill, point, prelude::*, px, size,
};
use tokio::sync::{mpsc, watch};

use crate::agents::{Agents, Control};
use crate::feed::Feed;
use crate::menu::{Act, Menu, Prefs, Tab};
use crate::scene::{AgentLabel, Board, DONE_TAIL, Doing, Layout, Line, Role, Scene, Span};
use crate::theme::{Rgb, Theme};
use crate::wizard::{Panel, Wizard, hint_key, key};

pub fn color(c: Rgb, a: f32) -> Hsla {
    Rgba {
        r: c.0 / 255.0,
        g: c.1 / 255.0,
        b: c.2 / 255.0,
        a,
    }
    .into()
}

/// Fixed rows around the scene, so the window's size is known before it opens.
pub const TITLE_H: f32 = 22.0;
pub const STATUS_H: f32 = 24.0;
/// The scene's margin: 2px on top, 10px either side, and the 4px gap above the status line.
const SIDE: f32 = 10.0;

/// While a run's current flows along its wire (22 logo pixels a second): about 20 frames a second.
const CURRENT: Duration = Duration::from_millis(50);
/// While the wires only sway and blocked lamps blink: about 12 frames a second. A swaying wire
/// moves about a cell a second at most, so this looks the same as 20 and costs less.
const SWAY: Duration = Duration::from_millis(83);
/// While a run's timer shows and nothing moves.
const TICK: Duration = Duration::from_secs(1);
/// Otherwise, now and then, for the done list's slow fade.
const IDLE: Duration = Duration::from_secs(30);
/// While setup waits on something: the dots after "waiting".
const DOTS: Duration = Duration::from_millis(250);
/// A first press of "stop this run" waits this long for the second.
const ARMED: Duration = Duration::from_secs(6);
/// How long a word in the status line about something just done stays.
const FLASH: Duration = Duration::from_secs(5);

/// The bell, a pixel at a time, as the scene is drawn.
const BELL: [&str; 7] = [
    "...#...", "..###..", ".#####.", ".#####.", ".#####.", "#######", "...#...",
];

/// Where the box's data comes from.
pub enum Source {
    /// The prototype's simulation.
    Demo,
    /// The daemon running in this process.
    Live {
        state: watch::Receiver<DaemonState>,
        /// The owner's view from `/api/wired`, when the config has an owner token.
        feed: Option<watch::Receiver<Feed>>,
        /// True once the daemon has stopped by itself (a signal, or no agent left).
        finished: watch::Receiver<bool>,
        /// For the menu and the agents screen: the config file and the way to the running daemon.
        control: Option<Control>,
        /// Links of desktop notifications that were clicked, to open.
        clicks: Option<mpsc::UnboundedReceiver<String>>,
    },
    /// Nothing to watch, and why.
    Quiet(String),
    /// Setting the box up: no usable config yet, or `--setup`. Becomes `Live` once it is written.
    Setup(Box<Wizard>),
}

/// A run of this box's that "stop this run" has been pressed for once.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Armed {
    slot: u64,
    run: String,
    key: String,
    agent: String,
    at: Instant,
}

/// A run this box is running: its agent's slot, the run, the task and the agent's name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunHere {
    pub slot: u64,
    pub run: String,
    pub key: String,
    pub agent: String,
}

/// The runs this box has going now, in the daemon's order.
pub fn runs_here(st: &DaemonState) -> Vec<RunHere> {
    st.agents
        .iter()
        .flat_map(|a| {
            a.runs.iter().map(|r| RunHere {
                slot: a.slot,
                run: r.run.clone(),
                key: r.task.clone(),
                agent: a.handle.rsplit('/').next().unwrap_or(&a.handle).to_string(),
            })
        })
        .collect()
}

pub struct BoxView {
    scene: Scene,
    prefs: Prefs,
    font: SharedString,
    source: Source,
    began: Instant,
    focus: FocusHandle,
    /// The next timed redraw, and when it is due.
    timer: Option<(Instant, Task<()>)>,
    /// Redraw when the daemon's state or the feed changes.
    _watchers: Vec<Task<()>>,
    /// The menu, while it is open over the live view.
    menu: Option<Menu>,
    /// "stop this run", pressed once.
    armed: Option<Armed>,
    /// A word for the status line, and when it was said.
    flash: Option<(String, Role, Instant)>,
    /// Whether the window is the compact one now.
    shown_compact: bool,
}

impl BoxView {
    pub fn new(scene: Scene, prefs: Prefs, font: SharedString, mut source: Source, cx: &mut Context<Self>) -> Self {
        let watchers = watch_source(&mut source, cx);
        let shown_compact = prefs.compact && matches!(source, Source::Live { .. });
        let mut view = Self {
            scene,
            prefs,
            font,
            source,
            began: Instant::now(),
            focus: cx.focus_handle(),
            timer: None,
            _watchers: watchers,
            menu: None,
            armed: None,
            flash: None,
            shown_compact,
        };
        if let Some(w) = view.wizard() {
            w.begin(cx);
        }
        view
    }

    /// The setup in progress, if that is what the window shows.
    pub fn wizard(&mut self) -> Option<&mut Wizard> {
        match &mut self.source {
            Source::Setup(w) => Some(w),
            _ => None,
        }
    }

    /// The agents screen, when the menu has it open.
    pub fn agents(&mut self) -> Option<&mut Agents> {
        self.menu.as_mut().and_then(Menu::agents)
    }

    /// The menu, when it is open.
    pub fn menu(&mut self) -> Option<&mut Menu> {
        self.menu.as_mut()
    }

    /// The daemon's state and the owner's feed as they are now, in live mode.
    fn live(&self) -> Option<(DaemonState, Option<Feed>)> {
        match &self.source {
            Source::Live { state, feed, .. } => {
                Some((state.borrow().clone(), feed.as_ref().map(|f| f.borrow().clone())))
            }
            _ => None,
        }
    }

    fn feed_now(&self) -> Option<Feed> {
        match &self.source {
            Source::Live { feed: Some(f), .. } => Some(f.borrow().clone()),
            _ => None,
        }
    }

    fn control(&self) -> Option<Control> {
        match &self.source {
            Source::Live { control, .. } => control.clone(),
            _ => None,
        }
    }

    /// Setup is done and the daemon runs: draw it from here on.
    fn go_live(&mut self, mut source: Source, cx: &mut Context<Self>) {
        self._watchers = watch_source(&mut source, cx);
        self.source = source;
        cx.notify();
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    /// The whole window at `cell` pixels per logo pixel, everything else `zoom` times its
    /// natural size. The 1px border stays 1px.
    pub fn window_size(scene: &Scene, cell: f32, zoom: f32) -> (f32, f32) {
        let (w, h) = scene.size(cell, zoom);
        (
            w + 2.0 * SIDE * zoom + 2.0,
            (TITLE_H + 2.0 + 4.0 + STATUS_H) * zoom + h + 2.0,
        )
    }

    /// The window at its natural size: the whole box, or compact, the status line alone.
    pub fn size_for(scene: &Scene, compact: bool) -> (f32, f32) {
        let (w, h) = Self::window_size(scene, scene.tune.scale as f32, 1.0);
        if compact { (w, STATUS_H + 2.0) } else { (w, h) }
    }

    fn board(&self, now: f64) -> Option<Board> {
        match &self.source {
            Source::Demo => None,
            Source::Setup(_) => Some(Board {
                ready: true,
                ..Default::default()
            }),
            Source::Quiet(why) => Some(Board {
                quiet: Some(why.clone()),
                ..Default::default()
            }),
            Source::Live { state, feed, .. } => {
                let feed = feed.as_ref().map(|f| f.borrow().clone());
                let mut b = board_from(&state.borrow(), feed.as_ref(), now, SystemTime::now());
                filter_board(&mut b, &self.prefs);
                Some(b)
            }
        }
    }

    /// Draw again in `after`, unless a redraw is already due sooner.
    fn redraw_in(&mut self, after: Duration, cx: &mut Context<Self>) {
        let due = Instant::now() + after;
        if let Some((at, _)) = &self.timer {
            if *at <= due && *at > Instant::now() {
                return;
            }
        }
        let task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(after).await;
            let _ = this.update(cx, |this, cx| {
                this.timer = None;
                cx.notify();
            });
        });
        self.timer = Some((due, task));
    }

    fn line(&self, line: &Line, th: &Theme) -> StyledText {
        let mut text = String::new();
        let mut highlights = Vec::new();
        for span in &line.0 {
            let start = text.len();
            text.push_str(&span.text);
            highlights.push((
                start..text.len(),
                gpui::HighlightStyle {
                    color: Some(color(span.role.of(th), span.alpha)),
                    ..Default::default()
                },
            ));
        }
        StyledText::new(text).with_highlights(highlights)
    }

    /// A line, opening its task's board in the browser when it has one.
    fn row(&self, line: &Line, th: &Theme) -> gpui::Div {
        let row = div().child(self.line(line, th));
        match &line.1 {
            Some(url) => {
                let url = url.clone();
                row.cursor_pointer()
                    .on_mouse_down(MouseButton::Left, move |_, _, cx| cx.open_url(&url))
            }
            None => row,
        }
    }

    /// Setup's step or a menu panel under the poles: its lines on the left, each clickable as
    /// the key the panel says, the text field with its cursor, and a code to approve drawn
    /// large on the right.
    fn panel(&self, p: &Panel, top: f32, width: f32, z: f32, th: &Theme, cx: &mut Context<Self>) -> gpui::Div {
        let lines: Vec<gpui::AnyElement> = p
            .lines
            .iter()
            .enumerate()
            .map(|(i, l)| match &p.input {
                Some((at, before, after)) if *at == i => div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .child(div().text_color(color(th.blue, 1.0)).child("› "))
                    .child(div().text_color(color(th.ink, 1.0)).child(before.clone()))
                    .child(div().w(px(1.5 * z)).h(px(13. * z)).bg(color(th.ink, 0.9)))
                    .child(div().text_color(color(th.ink, 1.0)).child(after.clone()))
                    .into_any_element(),
                _ => match p.clicks.get(i).cloned().flatten() {
                    Some(k) => div()
                        .cursor_pointer()
                        .child(self.line(l, th))
                        .on_mouse_down(MouseButton::Left, press_on(k, cx))
                        .into_any_element(),
                    None => self.row(l, th).into_any_element(),
                },
            })
            .collect();
        let mut d = div()
            .absolute()
            .left(px(0.))
            .top(px(top))
            .w(px(width))
            .overflow_hidden()
            .flex()
            .flex_row()
            .child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .gap(px(z))
                    .children(lines),
            );
        if let Some(code) = &p.code {
            d = d.child(
                div()
                    .flex_none()
                    .pl(px(16. * z))
                    .pt(px(10. * z))
                    .text_size(px(26. * z))
                    .line_height(px(30. * z))
                    .text_color(color(th.yellow, 1.0))
                    .child(code.clone()),
            );
        }
        d
    }

    /// The bell, drawn in pixels like the scene, with the count beside it when something needs you.
    fn bell(&self, count: usize, z: f32, sf: f32, th: &Theme, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        let u = ((1.5 * z * sf).round().max(1.0)) / sf;
        let lit = count > 0;
        let c = if lit {
            color(th.yellow, 1.0)
        } else {
            color(th.faint, 1.0)
        };
        let pixels = canvas(
            |_, _, _| (),
            move |bounds: Bounds<gpui::Pixels>, _, window: &mut Window, _| {
                for (y, row) in BELL.iter().enumerate() {
                    for (x, ch) in row.chars().enumerate() {
                        if ch == '#' {
                            let at = point(bounds.origin.x + px(x as f32 * u), bounds.origin.y + px(y as f32 * u));
                            window.paint_quad(fill(Bounds::new(at, size(px(u), px(u))), c));
                        }
                    }
                }
            },
        )
        .w(px(7.0 * u))
        .h(px(7.0 * u));
        let mut b = div()
            .id("bell")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(3. * z))
            .cursor_pointer()
            .child(pixels)
            .on_mouse_down(MouseButton::Left, press_on("b".into(), cx));
        if lit {
            b = b.child(div().text_color(color(th.yellow, 1.0)).child(count.to_string()));
        }
        b
    }

    /// A key while a message to an agent is typed: the agents screen's, every one of them.
    fn compose_key(&mut self, e: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        let Some((st, _)) = self.live() else { return false };
        let Some(a) = self.menu.as_mut().and_then(Menu::composing) else {
            return false;
        };
        a.type_key(e, &st, cx);
        cx.notify();
        true
    }

    /// A key by name, or a click as one: the menu's when it is open, else the live view's.
    fn press(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        let live = self.live();
        if let Some(m) = self.menu.as_mut() {
            let Some((st, feed)) = live else { return };
            let compact_was = self.prefs.compact;
            match m.press(name, &mut self.prefs, &st, feed.as_ref(), cx) {
                Act::Close => self.close_menu(),
                Act::SignOut => self.sign_out(cx),
                Act::Resize | Act::Handled => {}
                Act::Ignored => return,
            }
            if self.prefs.compact != compact_was {
                self.flash = Some((
                    format!(
                        "compact {} · when the menu closes",
                        if self.prefs.compact { "on" } else { "off" }
                    ),
                    Role::Muted,
                    Instant::now(),
                ));
            }
            let _ = window;
            cx.notify();
            return;
        }
        let control = self.control();
        let runs = live.as_ref().map(|(st, _)| runs_here(st)).unwrap_or_default();
        /* Anything but s (or tab among runs) after a first press of s keeps the run going. */
        if self.armed.is_some() && !matches!(name, "s" | "tab") && !name.starts_with("stop:") {
            self.armed = None;
            if name == "escape" {
                cx.notify();
                return;
            }
        }
        match name {
            "m" | "≡" if control.is_some() => self.open_menu(Tab::Agents, cx),
            "b" if control.is_some() => self.open_menu(Tab::Needs, cx),
            "a" if control.is_some() => self.open_menu(Tab::Agents, cx),
            "s" | "tab" if !runs.is_empty() => self.arm(name, None, &runs),
            n if n.starts_with("stop:") && !runs.is_empty() => {
                let key = n.trim_start_matches("stop:").to_string();
                self.arm("s", Some(key), &runs);
            }
            "n" => self.scene.add(),
            "a" => self.scene.answer(),
            "f" => self.scene.finish_one(),
            "q" | "escape" => cx.quit(),
            _ => return,
        }
        cx.notify();
    }

    /// "stop this run": the first press picks a run (`key`'s, or the first; tab the next), the
    /// second, within a few seconds, stops it.
    fn arm(&mut self, name: &str, key: Option<String>, runs: &[RunHere]) {
        let pick = |i: usize| {
            let r = &runs[i % runs.len()];
            Armed {
                slot: r.slot,
                run: r.run.clone(),
                key: r.key.clone(),
                agent: r.agent.clone(),
                at: Instant::now(),
            }
        };
        let at = |a: &Armed| runs.iter().position(|r| r.slot == a.slot && r.run == a.run);
        let wanted = key.as_ref().and_then(|k| runs.iter().position(|r| &r.key == k));
        match (&self.armed, name) {
            (Some(a), "tab") => self.armed = Some(pick(at(a).map_or(0, |i| i + 1))),
            (None, "tab") => self.armed = Some(pick(0)),
            (Some(a), _) if a.at.elapsed() < ARMED && (wanted.is_none() || wanted == at(a)) && at(a).is_some() => {
                let a = a.clone();
                if let Some(c) = self.control() {
                    c.stopper.stop(a.slot, &a.run);
                    tracing::info!(task = %a.key, run = %a.run, "stopping the run from the box");
                    self.flash = Some((
                        format!("stopping {}'s run · it finishes as cancelled", a.key),
                        Role::Yellow,
                        Instant::now(),
                    ));
                }
                self.armed = None;
            }
            _ => self.armed = Some(pick(wanted.unwrap_or(0))),
        }
    }

    fn open_menu(&mut self, tab: Tab, cx: &mut Context<Self>) {
        let Some(control) = self.control() else { return };
        self.armed = None;
        match self.menu.as_mut() {
            Some(m) => m.go(tab, cx),
            None => self.menu = Some(Menu::open(control, tab, cx)),
        }
    }

    /// Close the menu, writing what it changed to daemon.toml.
    fn close_menu(&mut self) {
        if self.menu.as_ref().is_some_and(|m| m.signing_out) {
            return;
        }
        self.menu = None;
        let Some(c) = self.control() else { return };
        match self.prefs.write(&c.config) {
            Ok(Some(backup)) => {
                tracing::info!(
                    "menu: wrote {}, kept the old one as {}",
                    c.config.display(),
                    backup.display()
                );
                self.flash = Some(("settings saved in daemon.toml".into(), Role::Green, Instant::now()));
            }
            Ok(None) => {}
            Err(e) => {
                tracing::error!("menu: writing daemon.toml: {e:#}");
                self.flash = Some((format!("× daemon.toml: {}", e.root_cause()), Role::Red, Instant::now()));
            }
        }
    }

    /// Sign out: stop the daemon, revoke the box's tokens, delete them and the config, and set
    /// the box up again in this window.
    fn sign_out(&mut self, cx: &mut Context<Self>) {
        let Some(control) = self.control() else { return };
        if let Some(m) = self.menu.as_mut() {
            m.signing_out = true;
        }
        let url = self.feed_now().map(|f| f.url);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let (stop, config) = (control.stop_daemon.clone(), control.config.clone());
        let spawned = std::thread::Builder::new().name("sign-out".into()).spawn(move || {
            stop();
            let _ = tx.send(crate::menu::sign_out(&config, &crate::notify::memory_path()));
        });
        if let Err(e) = spawned {
            tracing::error!("sign out: {e}");
            return;
        }
        cx.spawn(async move |this, cx| {
            let failed = rx
                .await
                .unwrap_or_else(|_| vec!["the sign-out thread ended early".into()]);
            let _ = this.update(cx, |view, cx| {
                let note = (!failed.is_empty()).then(|| {
                    format!(
                        "signed out, but couldn't revoke {}; revoke it in settings › tokens",
                        failed.join("; ")
                    )
                });
                if failed.is_empty() {
                    tracing::info!("signed out");
                }
                match (control.setup)(url.as_deref(), note) {
                    Ok(w) => {
                        view.menu = None;
                        view.prefs.dirty.clear();
                        view.go_live(Source::Setup(Box::new(w)), cx);
                        if let Some(w) = view.wizard() {
                            w.begin(cx);
                        }
                    }
                    Err(e) => {
                        tracing::error!("signed out, but setup can't start: {e:#}");
                        cx.quit();
                    }
                }
            });
        })
        .detach();
    }
}

/// A click that presses `key` on the view.
fn press_on(key: String, cx: &mut Context<BoxView>) -> impl Fn(&MouseDownEvent, &mut Window, &mut gpui::App) + 'static {
    cx.listener(move |this: &mut BoxView, _: &MouseDownEvent, window, cx| {
        cx.stop_propagation();
        this.press(&key, window, cx);
    })
}

/// The most a window much larger than the box blows it up.
const MAX_ZOOM: u32 = 16;

/// The box in a window of `viewport` (logical px) at `sf` device px per logical px: the
/// largest whole multiple of its natural size that fits (1 when none does), as `(cell, zoom)`,
/// the cell rounded to whole device pixels so every cell is the same size.
pub fn fit(scene: &Scene, viewport: (f32, f32), sf: f32) -> (f32, f32) {
    let base = scene.tune.scale as f32;
    let zoom = (1..=MAX_ZOOM)
        .rev()
        .map(|k| k as f32)
        .find(|&k| {
            let (w, h) = BoxView::window_size(scene, base * k, k);
            /* Half a pixel of slack for a compositor that rounds the size it gives. */
            w <= viewport.0 + 0.5 && h <= viewport.1 + 0.5
        })
        .unwrap_or(1.0);
    ((base * zoom * sf).round().max(1.0) / sf, zoom)
}

/// One character of the lists (11px JetBrains Mono is about 6.6px), rounded up.
const CH: f32 = 7.0;
/// Space kept between two lists, in px.
const GAP: f32 = 8.0;
/// Half the todo list's width at most: room for "+12 more" and keys like COPL-123.
const TODO_HALF: f32 = 28.0;

/// Each list's width in px at `cell` px per logo pixel, from where the poles stand, by the
/// web widget's rule (`budgets` in WiredPane.tsx; S is the span, a pole's centre is 5 in):
/// todo centred on its pole, doing from its pole's right edge back to clear of todo, blocked
/// centred between doing's right edge and done's left edge, done from its pole's left edge
/// to the window's margin. The px constants are `zoom` times theirs, as the text is.
pub fn budgets(l: &Layout, spacing: f32, cell: f32, zoom: f32) -> [f32; 4] {
    let (half, gap) = (TODO_HALF * zoom, GAP * zoom);
    [
        2.0 * half.min((l.x[0] + 5.0) * cell + (SIDE - 2.0) * zoom),
        (spacing + 5.0) * cell - half - gap,
        (spacing - 10.0) * cell - 2.0 * gap,
        (l.bw as f32 - l.x[3]) * cell + (DONE_TAIL - 2.0) * zoom,
    ]
}

/// Redraw on whatever the source publishes, and open what a clicked notification links to.
fn watch_source(source: &mut Source, cx: &mut Context<BoxView>) -> Vec<Task<()>> {
    let mut watchers = Vec::new();
    if let Source::Live {
        state,
        feed,
        finished,
        clicks,
        ..
    } = source
    {
        watchers.push(quit_when_finished(finished.clone(), cx));
        watchers.push(redraw_on(state.clone(), cx));
        if let Some(feed) = feed {
            watchers.push(redraw_on(feed.clone(), cx));
        }
        if let Some(mut rx) = clicks.take() {
            watchers.push(cx.spawn(async move |_, cx| {
                while let Some(link) = rx.recv().await {
                    tracing::info!("a notification was clicked: opening {link}");
                    if cx.update(|cx| cx.open_url(&link)).is_err() {
                        break;
                    }
                }
            }));
        }
    }
    watchers
}

/// Whether the daemon stopped by itself: true once it says so, false if its thread ended without.
async fn stopped_by_itself(mut finished: watch::Receiver<bool>) -> bool {
    finished.wait_for(|f| *f).await.is_ok()
}

/// Quit once the daemon has stopped by itself, unless it was stopped to sign out. Not from
/// render: a window the compositor isn't showing (another workspace) gets no frames, and
/// SIGTERM would stop the daemon and leave the process up (COPL-101).
fn quit_when_finished(finished: watch::Receiver<bool>, cx: &mut Context<BoxView>) -> Task<()> {
    cx.spawn(async move |this, cx| {
        if !stopped_by_itself(finished).await {
            return;
        }
        let _ = this.update(cx, |view, cx| {
            if !view.menu.as_ref().is_some_and(|m| m.signing_out) {
                cx.quit();
            }
        });
    })
}

/// Notify the view whenever `rx` changes, until its sender is gone.
fn redraw_on<T: 'static>(mut rx: watch::Receiver<T>, cx: &mut Context<BoxView>) -> Task<()> {
    cx.spawn(async move |this, cx| {
        loop {
            let ended = rx.changed().await.is_err();
            if this.update(cx, |_, cx| cx.notify()).is_err() || ended {
                break;
            }
        }
    })
}

/// "2026-10-02T17:03:11.123Z" (what the API sends), or with a space for the T.
pub fn parse_utc(s: &str) -> Option<SystemTime> {
    let s = s.trim().trim_end_matches('Z').trim_end_matches("+00:00");
    let (date, time) = s.split_once(['T', ' '])?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut t = time.splitn(3, ':');
    let (h, mi) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let sec: f64 = t.next().unwrap_or("0").parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) || h > 23 || mi > 59 || !(0.0..61.0).contains(&sec) {
        return None;
    }
    /* Days since 1970-01-01 (Howard Hinnant's days_from_civil). */
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = (days * 86_400 + h * 3600 + mi * 60) as f64 + sec;
    if secs < 0.0 {
        return None;
    }
    Some(UNIX_EPOCH + Duration::from_secs_f64(secs))
}

/// `<url>/b/<BOARD>?task=<KEY>` for a task key "BOARD-12": the task's own link, its board
/// with the task open (the web app's `taskPath`).
pub fn task_link(url: &str, key: &str) -> Option<String> {
    let (board, number) = key.rsplit_once('-')?;
    (!board.is_empty() && !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()))
        .then(|| format!("{url}/b/{board}?task={key}"))
}

/// The boards filter (COPL-65) over what the scene is told: tickets of boards the box doesn't
/// show are left out, the done count then being what is left of the listed ones. Display only;
/// the daemon runs what it runs.
pub fn filter_board(b: &mut Board, prefs: &Prefs) {
    if prefs.boards.is_none() {
        return;
    }
    b.todo.retain(|k| prefs.shows(k));
    b.doing.retain(|d| prefs.shows(&d.key));
    b.blocked.retain(|(k, _)| prefs.shows(k));
    if let Some(done) = &mut b.done {
        done.retain(|(k, _)| prefs.shows(k));
        b.done_count = Some(done.len() as u32);
    }
}

/// What the scene is told: the owner's view from `/api/wired` when there is one, with the
/// daemon's own runs over it (a run it just started shows before the next read), else what
/// the daemon alone knows. `now` is scene seconds at `wall`.
pub fn board_from(st: &DaemonState, feed: Option<&Feed>, now: f64, wall: SystemTime) -> Board {
    let name = |handle: &str| handle.rsplit('/').next().unwrap_or(handle).to_string();
    let at = |t: SystemTime| match wall.duration_since(t) {
        Ok(ago) => now - ago.as_secs_f64(),
        Err(e) => now + e.duration().as_secs_f64(),
    };
    let mut board = Board {
        ready: true,
        ..Default::default()
    };
    let mut links: Vec<(String, String)> = Vec::new();
    let mut link = |url: &str, key: &str| {
        if let Some(l) = task_link(url, key) {
            if !links.iter().any(|(k, _)| k == key) {
                links.push((key.to_string(), l));
            }
        }
    };
    for a in &st.agents {
        board.agents.push(AgentLabel {
            name: name(&a.handle),
            error: a.last_error.clone(),
            stopped: a.phase == Phase::Stopped,
        });
    }
    board.live = crate::feed::links_up(st, feed);

    match feed.and_then(|f| f.wired.as_ref().map(|w| (f, &w.0))) {
        Some((f, w)) => {
            let agent = |id: &str| {
                w.agents
                    .iter()
                    .find(|a| a.id == id)
                    .map(|a| a.name.clone())
                    .unwrap_or_else(|| "?".into())
            };
            let since = |s: &Option<String>| s.as_deref().and_then(parse_utc).map(at);
            for t in w.todo.iter().chain(&w.doing).chain(&w.blocked).chain(&w.done) {
                link(&f.url, &t.key);
            }
            board.todo = w.todo.iter().map(|t| t.key.clone()).collect();
            board.doing = w
                .doing
                .iter()
                .map(|t| Doing {
                    key: t.key.clone(),
                    agent: agent(&t.agent_id),
                    started: if t.live { since(&t.since) } else { None },
                    live: t.live,
                })
                .collect();
            board.blocked = w.blocked.iter().map(|t| (t.key.clone(), agent(&t.agent_id))).collect();
            board.done = Some(
                w.done
                    .iter()
                    .map(|t| (t.key.clone(), since(&t.since).unwrap_or(now)))
                    .collect(),
            );
            board.done_count = Some(w.done_count);
            board.done_window = w.done_window_hours as f64 * 3600.0;
            if let Some(e) = &f.error {
                board.note = Some((format!("× {e}"), Role::Red));
            }
        }
        None => {
            for a in &st.agents {
                for key in &a.waiting {
                    if !board.todo.contains(key) {
                        board.todo.push(key.clone());
                        link(&a.url, key);
                    }
                }
            }
            board.note = Some(match feed {
                None => (
                    "owner_token_file in daemon.toml shows done and blocked".into(),
                    Role::Faint,
                ),
                Some(f) => match &f.error {
                    Some(e) => (format!("× {e}"), Role::Red),
                    None => {
                        /* The first read hasn't come back: place everything once it has. */
                        board.ready = false;
                        ("reading your agents' work…".into(), Role::Faint)
                    }
                },
            });
        }
    }

    /* The daemon's own runs: shown at once, before the server says so. */
    for (a, r) in st.agents.iter().flat_map(|a| a.runs.iter().map(move |r| (a, r))) {
        let (task, since) = (&r.task, &r.since);
        board.todo.retain(|k| k != task);
        board.blocked.retain(|b| &b.0 != task);
        if let Some(done) = &mut board.done {
            done.retain(|d| &d.0 != task);
        }
        match board.doing.iter_mut().find(|d| &d.key == task) {
            Some(d) if d.live => {}
            Some(d) => {
                d.live = true;
                d.started = Some(at(*since));
            }
            None => board.doing.push(Doing {
                key: task.clone(),
                agent: name(&a.handle),
                started: Some(at(*since)),
                live: true,
            }),
        }
        link(&a.url, task);
    }
    board.links = links;
    if st.agents.is_empty() {
        board.quiet = Some("no agents configured".into());
    }
    board
}

impl Render for BoxView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let feed = self.feed_now();
        let th = self.prefs.theme_now(feed.as_ref());
        self.scene.motion = self.prefs.motion;
        let now = self.began.elapsed().as_secs_f64();
        if let Some(board) = self.board(now) {
            self.scene.sync(&board);
        }
        self.scene.step(now);
        if self.scene.moving() {
            window.request_animation_frame();
        } else if self.scene.ambient() {
            self.redraw_in(if self.scene.ticking() { CURRENT } else { SWAY }, cx);
        } else if self.scene.ticking() {
            self.redraw_in(TICK, cx);
        } else {
            self.redraw_in(IDLE, cx);
        }
        if self.menu.is_some() && !matches!(self.source, Source::Live { .. }) {
            self.menu = None;
        }
        if self.armed.as_ref().is_some_and(|a| a.at.elapsed() >= ARMED) {
            self.armed = None;
        }
        if self.flash.as_ref().is_some_and(|f| f.2.elapsed() >= FLASH) {
            self.flash = None;
        }
        if self.armed.is_some() || self.flash.is_some() {
            self.redraw_in(TICK, cx);
        }
        let live = self.live();
        let runs = live.as_ref().map(|(st, _)| runs_here(st)).unwrap_or_default();
        if self
            .armed
            .as_ref()
            .is_some_and(|a| !runs.iter().any(|r| r.slot == a.slot && r.run == a.run))
        {
            self.armed = None;
        }
        let dots = ["   ", ".  ", ".. ", "..."][(self.began.elapsed().as_millis() / 500 % 4) as usize];
        let panel = match (&self.menu, &live) {
            (Some(m), Some((st, feed))) => Some((m.animating(), m.panel(&self.prefs, st, feed.as_ref(), dots), "menu")),
            _ => self.wizard().map(|w| (w.animating(), w.panel(), "setup")),
        };
        if let Some((true, _, _)) = &panel {
            self.redraw_in(DOTS, cx);
        }
        let has_menu = matches!(self.source, Source::Live { control: Some(_), .. });
        let needs = crate::notify::needs_shown(feed.as_ref()).len();
        let bell_shown = feed.is_some();

        /* Compact: the status line alone, while no panel is open. */
        let compact = self.prefs.compact && panel.is_none() && matches!(self.source, Source::Live { .. });
        if compact != self.shown_compact {
            self.shown_compact = compact;
            let (w, h) = Self::size_for(&self.scene, compact);
            window.resize(size(px(w), px(h)));
            crate::hyprland::resize(w, h);
        }

        /* The largest whole multiple of the natural size the window has room for, in whole device
        pixels per logo pixel, so every cell is the same size on any output scale. A window the
        compositor made larger than the box gets it bigger and centred, not in a corner. */
        let sf = window.scale_factor();
        let vp = window.viewport_size();
        let (cell, z) = if compact {
            (self.scene.tune.scale as f32, 1.0)
        } else {
            fit(&self.scene, (vp.width.into(), vp.height.into()), sf)
        };
        let (scene_w, scene_h) = self.scene.size(cell, z);

        /* The right end of the title bar (or of the compact status line): bell, ≡, ×. */
        let ends = |this: &Self, cx: &mut Context<Self>| {
            let mut row = div().flex().flex_row().items_center().gap(px(8. * z)).flex_none();
            if bell_shown {
                row = row.child(this.bell(needs, z, sf, th, cx));
            }
            if has_menu {
                row = row.child(
                    div()
                        .id("menu")
                        .text_color(color(if this.menu.is_some() { th.blue } else { th.muted }, 1.0))
                        .hover(|s| s.text_color(color(th.ink, 1.0)))
                        .cursor_pointer()
                        .child("≡")
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this: &mut Self, _: &MouseDownEvent, window, cx| {
                                cx.stop_propagation();
                                if this.menu.is_some() {
                                    this.close_menu();
                                    cx.notify();
                                } else {
                                    this.press("m", window, cx);
                                }
                            }),
                        ),
                );
            }
            row.child(
                div()
                    .id("close")
                    .text_color(color(th.faint, 1.0))
                    .hover(|s| s.text_color(color(th.red, 1.0)))
                    .cursor_pointer()
                    .child("×")
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                        cx.quit();
                    }),
            )
        };

        let status: Vec<(Line, Option<String>)> = match &panel {
            Some((_, p, _)) => p.keys.iter().map(|k| (k.clone(), hint_key(k))).collect(),
            None => match &self.armed {
                Some(a) => {
                    let mut s = vec![
                        (
                            Line(
                                vec![
                                    Span::new("stop ", Role::Yellow),
                                    Span::new(a.key.clone(), Role::Ink),
                                    Span::new(format!("'s run ({})?", a.agent), Role::Yellow),
                                ],
                                None,
                            ),
                            None,
                        ),
                        (key("s", "stop it"), Some("s".to_string())),
                    ];
                    if runs.len() > 1 {
                        s.push((key("tab", "next run"), Some("tab".to_string())));
                    }
                    s.push((key("esc", "keep it running"), Some("escape".to_string())));
                    s
                }
                None => {
                    let mut parts: Vec<(Line, Option<String>)> =
                        self.scene.status().into_iter().map(|l| (l, None)).collect();
                    /* The way to the menu, before the last word (which can be long and get cut off). */
                    if has_menu && !compact {
                        let at = if self.scene.has_note() {
                            parts.len().saturating_sub(1)
                        } else {
                            parts.len()
                        };
                        parts.insert(at, (key("m", "menu"), Some("m".into())));
                        if !runs.is_empty() {
                            parts.insert(at, (key("s", "stop a run"), Some("s".into())));
                        }
                    }
                    if let Some((text, role, _)) = &self.flash {
                        parts.push((Line::one(text.clone(), *role), None));
                    }
                    parts
                }
            },
        };
        let mut bar = div()
            .id("bar")
            .flex_none()
            .h(px(STATUS_H * z))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10. * z))
            .px(px(10. * z))
            .bg(color(th.bar, 1.0))
            .text_color(color(th.muted, 1.0))
            .whitespace_nowrap()
            .overflow_hidden();
        let mut items = div()
            .flex_1()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10. * z))
            .overflow_hidden();
        for (n, (part, press)) in status.iter().enumerate() {
            if n > 0 {
                items = items.child(div().text_color(color(th.faint, 1.0)).child("│"));
            }
            let el = div().flex_none().child(self.line(part, th));
            items = items.child(match press {
                Some(k) => el
                    .cursor_pointer()
                    .on_mouse_down(MouseButton::Left, press_on(k.clone(), cx)),
                None => el,
            });
        }
        bar = bar.child(items);
        if compact {
            bar = bar
                .child(ends(self, cx))
                .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move());
        }

        let root = div()
            .id("box")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this: &mut Self, e: &KeyDownEvent, window, cx| {
                if let Some(w) = this.wizard() {
                    if let Some(source) = w.key(e, cx) {
                        this.go_live(source, cx);
                    }
                    return;
                }
                let k = &e.keystroke;
                if k.modifiers.control && k.key == "q" {
                    cx.quit();
                    return;
                }
                if this.compose_key(e, cx) {
                    return;
                }
                this.press(&k.key, window, cx);
            }))
            .size_full()
            .flex()
            .flex_col()
            .bg(color(th.surface, 1.0))
            .border_1()
            .border_color(color(th.faint, 0.7))
            .font_family(self.font.clone())
            .text_size(px(11. * z))
            .line_height(px(11. * 1.35 * z));
        if compact {
            return root.child(bar);
        }

        let raster = self.scene.draw(th);
        let runs_px = raster.runs(th.surface);
        let (bw, bh) = (raster.w as f32 * cell, raster.h as f32 * cell);
        let pixels = canvas(
            |_, _, _| (),
            move |bounds: Bounds<gpui::Pixels>, _, window: &mut Window, _| {
                let o = bounds.origin;
                for r in &runs_px {
                    let at = point(o.x + px(r.x as f32 * cell), o.y + px(r.y as f32 * cell));
                    let rgb = Rgb(r.rgb[0] as f32, r.rgb[1] as f32, r.rgb[2] as f32);
                    window.paint_quad(fill(
                        Bounds::new(at, size(px(r.len as f32 * cell), px(cell))),
                        color(rgb, 1.0),
                    ));
                }
            },
        )
        .absolute()
        .left(px(0.))
        .top(px(0.))
        .w(px(bw))
        .h(px(bh));

        let x = self.scene.layout.x;
        let list_top = Scene::list_top(cell, z);
        let room = budgets(&self.scene.layout, self.scene.tune.spacing, cell, z);
        let cols = self
            .scene
            .columns(room.map(|w| (w / (CH * z)).floor().max(1.0) as usize));
        /* The doing tickets this box runs, by the link their line opens: each gets a stop mark. */
        let feed_url = feed.as_ref().map(|f| f.url.clone());
        let here: Vec<(String, String)> = match &live {
            Some((st, _)) => runs
                .iter()
                .filter_map(|r| {
                    let url = feed_url
                        .clone()
                        .or_else(|| st.agents.iter().find(|a| a.slot == r.slot).map(|a| a.url.clone()))?;
                    task_link(&url, &r.key).map(|l| (l, r.key.clone()))
                })
                .collect(),
            None => Vec::new(),
        };
        let armed_key = self.armed.as_ref().map(|a| a.key.clone());
        let mut lists: Vec<gpui::AnyElement> = Vec::new();
        /* Where each list hangs: todo centred under its pole, doing flush right with its pole,
        blocked centred under its own, done flush left with its pole; as the web widget. */
        for (i, c) in cols.iter().enumerate() {
            let w = room[i];
            let (left, align) = match i {
                0 => ((x[0] + 5.0) * cell - w / 2.0, 0),
                1 => ((x[1] + 10.0) * cell - w, 1),
                2 => ((x[2] + 5.0) * cell - w / 2.0, 0),
                _ => (x[3] * cell, 2),
            };
            let d = div()
                .absolute()
                .left(px(left))
                .top(px(list_top))
                .w(px(w))
                .overflow_hidden()
                .flex()
                .flex_col()
                .gap(px(z));
            let d = match align {
                0 => d.items_center(),
                1 => d.items_end(),
                _ => d.items_start(),
            };
            let mut d = d.child(
                div()
                    .mb(px(2. * z))
                    .text_color(color(c.head_role.of(th), 1.0))
                    .child(c.head),
            );
            for l in &c.lines {
                let mine = (i == 1)
                    .then(|| l.1.as_ref().and_then(|u| here.iter().find(|(h, _)| h == u)))
                    .flatten();
                d = d.child(match mine {
                    Some((_, k)) => {
                        let armed = armed_key.as_deref() == Some(k.as_str());
                        div()
                            .flex()
                            .flex_row()
                            .child(
                                div()
                                    .id(SharedString::from(format!("stop-{k}")))
                                    .cursor_pointer()
                                    .text_color(color(if armed { th.red } else { th.faint }, 1.0))
                                    .hover(|s| s.text_color(color(th.red, 1.0)))
                                    .child(if armed { "stop? ■ " } else { "■ " })
                                    .on_mouse_down(MouseButton::Left, press_on(format!("stop:{k}"), cx)),
                            )
                            .child(self.row(l, th))
                    }
                    None => self.row(l, th),
                });
            }
            lists.push(d.into_any_element());
        }

        /* The menu's panels by name across the title bar, the open one lit; else the count. */
        let middle: gpui::AnyElement = match (&self.menu, &panel) {
            (Some(m), _) => {
                let mut row = div().flex().flex_row().gap(px(7. * z));
                for (n, t) in Tab::ALL.iter().enumerate() {
                    let on = *t == m.tab;
                    let label = if *t == Tab::Needs && needs > 0 {
                        format!("{} {needs}", t.label())
                    } else {
                        t.label().to_string()
                    };
                    row = row.child(
                        div()
                            .id(SharedString::from(format!("tab-{n}")))
                            .cursor_pointer()
                            .text_color(color(if on { th.blue } else { th.muted }, 1.0))
                            .hover(|s| s.text_color(color(th.ink, 1.0)))
                            .child(label)
                            .on_mouse_down(MouseButton::Left, press_on(format!("tab:{n}"), cx)),
                    );
                }
                row.into_any_element()
            }
            (None, Some((_, _, title))) => div()
                .text_color(color(th.muted, 1.0))
                .child(title.to_string())
                .into_any_element(),
            (None, None) => div()
                .text_color(color(th.muted, 1.0))
                .child(self.scene.count())
                .into_any_element(),
        };
        let title = div()
            .id("title")
            .flex_none()
            .h(px(TITLE_H * z))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8. * z))
            .px(px(10. * z))
            .pt(px(4. * z))
            .text_size(px(12. * z))
            .child(div().text_color(color(th.faint, 1.0)).child("—"))
            .child(div().text_color(color(th.blue, 1.0)).child("wired"))
            .child(div().flex_1().h(px(1.)).bg(color(th.faint, 0.55)))
            .child(middle)
            .child(ends(self, cx))
            .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move());

        let body: Vec<gpui::AnyElement> = match &panel {
            Some((_, p, _)) => vec![self.panel(p, list_top, scene_w, z, th, cx).into_any_element()],
            None => lists,
        };
        root.child(title)
            .child(
                /* Whatever the window has beyond the box's size, around the scene: it is centred. */
                div()
                    .flex_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .overflow_hidden()
                    .child(
                        div()
                            .relative()
                            .flex_none()
                            .mt(px(2. * z))
                            .mb(px(4. * z))
                            .mx(px(SIDE * z))
                            .w(px(scene_w))
                            .h(px(scene_h))
                            .whitespace_nowrap()
                            .child(pixels)
                            .children(body),
                    ),
            )
            .child(bar)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use copland_daemon_core::AgentState;
    use copland_daemon_core::api::{Wired, WiredAgent, WiredTask};

    /// The window's quit waits on the daemon's word alone, with no redraw to notice it
    /// (COPL-101), and a daemon thread that ends without saying so doesn't quit it.
    #[test]
    fn quits_on_the_daemons_word_not_on_a_frame() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (tx, rx) = watch::channel(false);
        let waiting = std::thread::spawn(move || rt.block_on(stopped_by_itself(rx)));
        std::thread::sleep(Duration::from_millis(20));
        tx.send_replace(true);
        assert!(waiting.join().unwrap());

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (tx, rx) = watch::channel(false);
        drop(tx);
        assert!(!rt.block_on(stopped_by_itself(rx)));
    }

    /// The lists against `src/features/wired/WiredPane.tsx`: its number constants and its
    /// `budgets` rule at the web's scales. The padding is the box's own (the window's margin
    /// beside todo, `DONE_TAIL` past done) and so is the zoom, which has no web cap.
    #[test]
    fn matches_the_web_lists() {
        use crate::scene::{DONE_LIT, LINE_H, LINES, SHORT_LINES, Tune};
        use crate::webts;
        const FILE: &str = "src/features/wired/WiredPane.tsx";
        let src = webts::read(FILE);
        let web = webts::consts(&src);
        for (name, &theirs) in &web {
            let ours: f64 = match name.as_str() {
                "MAX_SCALE" | "PAD" => continue,
                "LINES" => LINES as f64,
                "SHORT_LINES" => SHORT_LINES as f64,
                "LINE_H" => LINE_H.into(),
                "CH" => CH.into(),
                "GAP" => GAP.into(),
                "TODO_HALF" => TODO_HALF.into(),
                "DONE_LIT_MS" => DONE_LIT * 1000.0,
                other => {
                    panic!("{FILE} has `{other} = {theirs}`, which the box doesn't port: add it to view.rs and here")
                }
            };
            assert_eq!(ours, theirs, "{FILE}: {name} is {theirs} on the web, {ours} in the box");
        }

        let mut env = webts::consts(&webts::read("src/features/wired/scene.ts"));
        env.extend(web);
        let body = webts::block(&src, "function budgets(", "}");
        let tune = Tune::default();
        let l = Layout::new(tune.spacing);
        for (i, (list, pad)) in [("todo", SIDE), ("doing", 0.0), ("blocked", 0.0), ("done", DONE_TAIL)]
            .into_iter()
            .enumerate()
        {
            let expr = body
                .lines()
                .find_map(|ln| ln.trim().strip_prefix(&format!("{list}: ")))
                .unwrap_or_else(|| panic!("{FILE}: budgets has no {list}"))
                .trim_end_matches(',');
            for s in [2.0, 3.0, 4.0] {
                let theirs = webts::eval(expr, &|n| match n {
                    "s" => Some(s),
                    "PAD" => Some(pad.into()),
                    _ => env.get(n).copied(),
                })
                .unwrap_or_else(|| panic!("{FILE}: can't read budgets' `{expr}`"));
                let ours = budgets(&l, tune.spacing, s as f32, 1.0)[i];
                assert_eq!(
                    f64::from(ours),
                    theirs,
                    "{FILE}: the {list} budget at scale {s} is {theirs} on the web, {ours} in the box"
                );
            }
        }
    }

    #[test]
    fn reads_the_api_timestamps() {
        let t = parse_utc("2026-10-02T17:03:11.500Z").unwrap();
        assert_eq!(t.duration_since(UNIX_EPOCH).unwrap().as_millis(), 1_790_960_591_500);
        assert_eq!(parse_utc("1970-01-01 00:00:00"), Some(UNIX_EPOCH));
        assert_eq!(
            parse_utc("2024-02-29T00:00:00Z").map(|t| t.duration_since(UNIX_EPOCH).unwrap().as_secs()),
            Some(1_709_164_800)
        );
        assert!(parse_utc("yesterday").is_none());
        assert!(parse_utc("2026-13-02T00:00:00Z").is_none());
    }

    #[test]
    fn grows_by_whole_multiples_to_fill_a_larger_window() {
        let s = Scene::live(crate::scene::Tune::default());
        assert_eq!(BoxView::window_size(&s, 3.0, 1.0), (548.0, 196.0));
        assert_eq!(BoxView::window_size(&s, 6.0, 2.0), (1094.0, 390.0));
        assert_eq!(fit(&s, (548.0, 196.0), 1.0), (3.0, 1.0));
        assert_eq!(fit(&s, (548.0, 196.0), 2.0), (3.0, 1.0));
        /* Hyprland tiling it into half a 1440p screen. */
        assert_eq!(fit(&s, (1402.0, 1396.0), 1.0), (6.0, 2.0));
        assert_eq!(fit(&s, (1700.0, 1000.0), 1.0), (9.0, 3.0));
        /* Smaller than the box: the natural size, cut off, rather than nothing. */
        assert_eq!(fit(&s, (300.0, 100.0), 1.0), (3.0, 1.0));
    }

    #[test]
    fn links_a_key_to_its_task() {
        assert_eq!(
            task_link("http://x", "COPL-12").as_deref(),
            Some("http://x/b/COPL?task=COPL-12")
        );
        assert_eq!(
            task_link("http://x", "MY-BOARD-3").as_deref(),
            Some("http://x/b/MY-BOARD?task=MY-BOARD-3")
        );
        assert_eq!(task_link("http://x", "nope"), None);
        assert_eq!(task_link("http://x", "COPL-"), None);
    }

    fn task(key: &str, since: Option<&str>, live: bool) -> WiredTask {
        WiredTask {
            id: key.to_lowercase(),
            board_id: "b".into(),
            key: key.into(),
            title: key.into(),
            agent_id: "a1".into(),
            since: since.map(str::to_string),
            live,
        }
    }

    fn daemon(phase: Phase, waiting: &[&str]) -> DaemonState {
        let mut a = AgentState::new("me/dev", "http://x");
        /* A running phase is one run going, as the daemon records it. */
        if let Phase::Running { run, task, since } = &phase {
            a.runs.push(copland_daemon_core::state::ActiveRun {
                run: run.clone(),
                task: task.clone(),
                since: *since,
            });
        }
        a.phase = phase;
        a.waiting = waiting.iter().map(|s| s.to_string()).collect();
        DaemonState {
            agents: vec![a],
            stopping: false,
        }
    }

    #[test]
    fn the_owners_view_with_the_daemons_runs_over_it() {
        let wall = parse_utc("2026-10-02T12:00:00Z").unwrap();
        let wired = Wired {
            agents: vec![WiredAgent {
                id: "a1".into(),
                handle: "me/dev".into(),
                name: "dev".into(),
                paused: false,
            }],
            todo: vec![task("T-1", None, false), task("T-2", None, false)],
            doing: vec![
                task("T-3", Some("2026-10-02T11:58:00Z"), true),
                task("T-4", None, false),
            ],
            blocked: vec![task("T-5", None, false)],
            done: vec![task("T-6", Some("2026-10-02T11:00:00Z"), false)],
            done_count: 7,
            done_window_hours: 24,
        };
        let feed = Feed {
            url: "http://x".into(),
            wired: Some((wired, wall)),
            error: None,
            refused: false,
            live: Default::default(),
            ..Default::default()
        };
        /* The daemon has just started a run on T-1, which the server still has in todo. */
        let st = daemon(
            Phase::Running {
                run: "8f31".into(),
                task: "T-1".into(),
                since: wall - Duration::from_secs(5),
            },
            &["T-9"],
        );
        let b = board_from(&st, Some(&feed), 100.0, wall);
        assert!(b.ready);
        assert_eq!(b.todo, ["T-2"]);
        assert_eq!(
            b.doing.iter().map(|d| d.key.as_str()).collect::<Vec<_>>(),
            ["T-3", "T-4", "T-1"]
        );
        assert_eq!(b.doing[0].started, Some(-20.0));
        assert_eq!(b.doing[0].agent, "dev");
        assert!(!b.doing[1].live && b.doing[1].started.is_none());
        assert_eq!(b.doing[2].started, Some(95.0));
        assert_eq!(b.blocked, [("T-5".to_string(), "dev".to_string())]);
        assert_eq!(b.done, Some(vec![("T-6".to_string(), 100.0 - 3600.0)]));
        assert_eq!(b.done_count, Some(7));
        assert!(b.note.is_none());
        assert!(b.links.iter().any(|(k, u)| k == "T-5" && u == "http://x/b/T?task=T-5"));
    }

    #[test]
    fn without_an_owner_token_it_is_the_daemon_alone_and_says_how_to_see_more() {
        let wall = SystemTime::now();
        let st = daemon(Phase::Idle, &["T-9", "T-8"]);
        let b = board_from(&st, None, 0.0, wall);
        assert_eq!(b.todo, ["T-9", "T-8"]);
        assert!(b.done.is_none());
        assert!(b.note.unwrap().0.contains("owner_token_file"));

        /* Configured, but the first read hasn't come back: nothing animates yet. */
        let feed = Feed {
            url: "http://x".into(),
            ..Default::default()
        };
        let b = board_from(&st, Some(&feed), 0.0, wall);
        assert!(!b.ready);
    }
}
