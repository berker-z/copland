//! The window: the scene's raster painted as quads at an integer cell size, the
//! lists and the status line as text, laid out as the prototype's `.box`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime};

use copland_daemon_core::{DaemonState, Phase};
use gpui::{
    Bounds, Context, FocusHandle, Hsla, KeyDownEvent, MouseButton, Rgba, SharedString, StyledText, Window, canvas, div,
    fill, point, prelude::*, px, size,
};
use tokio::sync::watch;

use crate::scene::{AgentLabel, Board, Line, POLE_H, Scene, TEXT_W, TOPB, TOPD, TOPM};
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

/// Where the box's data comes from.
pub enum Source {
    /// The prototype's simulation.
    Demo,
    /// The daemon running in this process.
    Live {
        state: watch::Receiver<DaemonState>,
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
}

impl BoxView {
    pub fn new(
        scene: Scene,
        theme: &'static Theme,
        font: SharedString,
        source: Source,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            scene,
            theme,
            font,
            source,
            began: Instant::now(),
            focus: cx.focus_handle(),
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
            Source::Live { state, .. } => Some(board_from(&state.borrow(), now, SystemTime::now())),
        }
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
}

/// The daemon's state as the scene wants it. `now` is scene seconds at `wall`.
pub fn board_from(st: &DaemonState, now: f64, wall: SystemTime) -> Board {
    let name = |handle: &str| handle.rsplit('/').next().unwrap_or(handle).to_string();
    let mut board = Board::default();
    for a in &st.agents {
        board.agents.push(AgentLabel {
            name: name(&a.handle),
            error: a.last_error.clone(),
            stopped: a.phase == Phase::Stopped,
        });
        if let Phase::Running { task, since, .. } = &a.phase {
            let ago = wall.duration_since(*since).map(|d| d.as_secs_f64()).unwrap_or(0.0);
            board.doing.push((task.clone(), name(&a.handle), now - ago));
        }
    }
    for a in &st.agents {
        for key in &a.waiting {
            if !board.todo.contains(key) && !board.doing.iter().any(|d| &d.0 == key) {
                board.todo.push(key.clone());
            }
        }
    }
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
        window.request_animation_frame();

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
        let list_top = (TOPM + POLE_H) as f32 * cell + 2.0;
        let cols = self.scene.columns();
        let col = |i: usize| {
            let c = &cols[i];
            div()
                .flex()
                .flex_col()
                .gap(px(1.))
                .child(
                    div()
                        .mb(px(2.))
                        .text_color(color(c.head_role.of(th), 1.0))
                        .child(c.head),
                )
                .children(c.lines.iter().map(|l| div().child(self.line(l))))
        };
        let under = |i: usize| {
            col(i)
                .absolute()
                .items_center()
                .left(px((x[i] + 5.0) * cell - 100.0))
                .w(px(200.))
                .top(px(list_top))
        };
        let beside = |i: usize, top: i32| {
            col(i)
                .absolute()
                .left(px(bw + 8.0))
                .top(px(top as f32 * cell - 2.0))
                .w(px(TEXT_W))
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
            .on_key_down(cx.listener(
                |this: &mut Self, e: &KeyDownEvent, _, cx| match e.keystroke.key.as_str() {
                    "n" => this.scene.add(),
                    "a" => this.scene.answer(),
                    "f" => this.scene.finish_one(),
                    "q" | "escape" => cx.quit(),
                    _ => {}
                },
            ))
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
                    .child(under(0))
                    .child(under(1))
                    .child(beside(2, TOPD))
                    .child(beside(3, TOPB)),
            )
            .child(bar)
    }
}
