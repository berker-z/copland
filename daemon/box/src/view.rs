//! The window: the scene's raster painted as quads at an integer cell size, the
//! lists and the status line as text, laid out as the prototype's `.box`.
//!
//! It draws only when something changes: every frame while an item travels,
//! about twenty times a second while the wires only sway, once a second while
//! a run's timer shows, and otherwise when the daemon or the owner's feed says
//! something new.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use copland_daemon_core::{DaemonState, Phase};
use gpui::{
    Bounds, Context, FocusHandle, Hsla, KeyDownEvent, MouseButton, Rgba, SharedString, StyledText, Task, Window,
    canvas, div, fill, point, prelude::*, px, size,
};
use tokio::sync::watch;

use crate::feed::Feed;
use crate::scene::{AgentLabel, Board, DONE_TAIL, Doing, Layout, Line, Role, Scene};
use crate::theme::{Rgb, Theme};

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

/// While the wires only sway: about 20 frames a second.
const AMBIENT: Duration = Duration::from_millis(50);
/// While a run's timer shows and nothing moves.
const TICK: Duration = Duration::from_secs(1);
/// Otherwise, now and then, for the done list's slow fade.
const IDLE: Duration = Duration::from_secs(30);

/// Where the box's data comes from.
pub enum Source {
    /// The prototype's simulation.
    Demo,
    /// The daemon running in this process.
    Live {
        state: watch::Receiver<DaemonState>,
        /// The owner's view from `/api/wired`, when the config has an owner token.
        feed: Option<watch::Receiver<Feed>>,
        /// Set once the daemon has stopped by itself (a signal, or no agent left).
        finished: Arc<AtomicBool>,
    },
    /// Nothing to watch, and why.
    Quiet(String),
}

pub struct BoxView {
    scene: Scene,
    theme: &'static Theme,
    font: SharedString,
    source: Source,
    began: Instant,
    focus: FocusHandle,
    /// The next timed redraw, and when it is due.
    timer: Option<(Instant, Task<()>)>,
    /// Redraw when the daemon's state or the feed changes.
    _watchers: Vec<Task<()>>,
}

impl BoxView {
    pub fn new(
        scene: Scene,
        theme: &'static Theme,
        font: SharedString,
        source: Source,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut watchers = Vec::new();
        if let Source::Live { state, feed, .. } = &source {
            watchers.push(redraw_on(state.clone(), cx));
            if let Some(feed) = feed {
                watchers.push(redraw_on(feed.clone(), cx));
            }
        }
        Self {
            scene,
            theme,
            font,
            source,
            began: Instant::now(),
            focus: cx.focus_handle(),
            timer: None,
            _watchers: watchers,
        }
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    /// The whole window at `cell` pixels per logo pixel.
    pub fn window_size(scene: &Scene, cell: f32) -> (f32, f32) {
        let (w, h) = scene.size(cell);
        (w + 2.0 * SIDE + 2.0, TITLE_H + 2.0 + h + 4.0 + STATUS_H + 2.0)
    }

    fn board(&self, now: f64) -> Option<Board> {
        match &self.source {
            Source::Demo => None,
            Source::Quiet(why) => Some(Board {
                quiet: Some(why.clone()),
                ..Default::default()
            }),
            Source::Live { state, feed, .. } => {
                let feed = feed.as_ref().map(|f| f.borrow().clone());
                Some(board_from(&state.borrow(), feed.as_ref(), now, SystemTime::now()))
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

    fn line(&self, line: &Line) -> StyledText {
        let th = self.theme;
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
    fn row(&self, line: &Line) -> gpui::Div {
        let row = div().child(self.line(line));
        match &line.1 {
            Some(url) => {
                let url = url.clone();
                row.cursor_pointer()
                    .on_mouse_down(MouseButton::Left, move |_, _, cx| cx.open_url(&url))
            }
            None => row,
        }
    }
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
/// to the window's margin.
pub fn budgets(l: &Layout, spacing: f32, cell: f32) -> [f32; 4] {
    [
        2.0 * TODO_HALF.min((l.x[0] + 5.0) * cell + SIDE - 2.0),
        (spacing + 5.0) * cell - TODO_HALF - GAP,
        (spacing - 10.0) * cell - 2.0 * GAP,
        (l.bw as f32 - l.x[3]) * cell + DONE_TAIL - 2.0,
    ]
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

/// `<url>/b/<BOARD>` for a task key "BOARD-12": the board's page, where the task is.
pub fn board_link(url: &str, key: &str) -> Option<String> {
    let (board, number) = key.rsplit_once('-')?;
    (!board.is_empty() && number.chars().all(|c| c.is_ascii_digit())).then(|| format!("{url}/b/{board}"))
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
        if let Some(l) = board_link(url, key) {
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
    for a in &st.agents {
        let Phase::Running { task, since, .. } = &a.phase else {
            continue;
        };
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
        if let Source::Live { finished, .. } = &self.source {
            if finished.load(Ordering::Relaxed) {
                cx.quit();
            }
        }
        let now = self.began.elapsed().as_secs_f64();
        if let Some(board) = self.board(now) {
            self.scene.sync(&board);
        }
        self.scene.step(now);
        if self.scene.moving() {
            window.request_animation_frame();
        } else if self.scene.ambient() {
            self.redraw_in(AMBIENT, cx);
        } else if self.scene.ticking() {
            self.redraw_in(TICK, cx);
        } else {
            self.redraw_in(IDLE, cx);
        }

        let th = self.theme;
        /* Whole device pixels per logo pixel, so every cell is the same size on any output scale. */
        let sf = window.scale_factor();
        let cell = (self.scene.tune.scale as f32 * sf).round().max(1.0) / sf;
        let (scene_w, scene_h) = self.scene.size(cell);
        let raster = self.scene.draw(th);
        let runs = raster.runs(th.surface);
        let (bw, bh) = (raster.w as f32 * cell, raster.h as f32 * cell);
        let pixels = canvas(
            |_, _, _| (),
            move |bounds: Bounds<gpui::Pixels>, _, window: &mut Window, _| {
                let o = bounds.origin;
                for r in &runs {
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
        let list_top = Scene::list_top(cell);
        let room = budgets(&self.scene.layout, self.scene.tune.spacing, cell);
        let cols = self.scene.columns(room.map(|w| (w / CH).floor().max(1.0) as usize));
        /* Where each list hangs: todo centred under its pole, doing flush right with its pole,
        blocked centred under its own, done flush left with its pole; as the web widget. */
        let list = |i: usize| {
            let c = &cols[i];
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
                .gap(px(1.));
            let d = match align {
                0 => d.items_center(),
                1 => d.items_end(),
                _ => d.items_start(),
            };
            d.child(
                div()
                    .mb(px(2.))
                    .text_color(color(c.head_role.of(th), 1.0))
                    .child(c.head),
            )
            .children(c.lines.iter().map(|l| self.row(l)))
        };

        let title = div()
            .id("title")
            .h(px(TITLE_H))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .px(px(10.))
            .pt(px(4.))
            .text_size(px(12.))
            .child(div().text_color(color(th.faint, 1.0)).child("—"))
            .child(div().text_color(color(th.blue, 1.0)).child("wired"))
            .child(div().flex_1().h(px(1.)).bg(color(th.faint, 0.55)))
            .child(div().text_color(color(th.muted, 1.0)).child(self.scene.count()))
            .child(
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
            .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move());

        let status = self.scene.status();
        let mut bar = div()
            .h(px(STATUS_H))
            .mt(px(4.))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .px(px(10.))
            .bg(color(th.bar, 1.0))
            .text_color(color(th.muted, 1.0))
            .whitespace_nowrap()
            .overflow_hidden();
        for (n, part) in status.iter().enumerate() {
            if n > 0 {
                bar = bar.child(div().text_color(color(th.faint, 1.0)).child("│"));
            }
            bar = bar.child(div().flex_none().child(self.line(part)));
        }

        div()
            .id("box")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this: &mut Self, e: &KeyDownEvent, _, cx| {
                match e.keystroke.key.as_str() {
                    "n" => this.scene.add(),
                    "a" => this.scene.answer(),
                    "f" => this.scene.finish_one(),
                    "q" | "escape" => cx.quit(),
                    _ => return,
                }
                cx.notify();
            }))
            .size_full()
            .flex()
            .flex_col()
            .bg(color(th.surface, 1.0))
            .border_1()
            .border_color(color(th.faint, 0.7))
            .font_family(self.font.clone())
            .text_size(px(11.))
            .line_height(px(11.0 * 1.35))
            .child(title)
            .child(
                div()
                    .relative()
                    .mt(px(2.))
                    .mx(px(SIDE))
                    .w(px(scene_w))
                    .h(px(scene_h))
                    .whitespace_nowrap()
                    .child(pixels)
                    .child(list(0))
                    .child(list(1))
                    .child(list(2))
                    .child(list(3)),
            )
            .child(bar)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use copland_daemon_core::AgentState;
    use copland_daemon_core::api::{Wired, WiredAgent, WiredTask};

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
    fn links_a_key_to_its_board() {
        assert_eq!(board_link("http://x", "COPL-12").as_deref(), Some("http://x/b/COPL"));
        assert_eq!(
            board_link("http://x", "MY-BOARD-3").as_deref(),
            Some("http://x/b/MY-BOARD")
        );
        assert_eq!(board_link("http://x", "nope"), None);
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
        assert!(b.links.iter().any(|(k, u)| k == "T-5" && u == "http://x/b/T"));
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
