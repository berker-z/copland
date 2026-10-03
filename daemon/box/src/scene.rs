//! The wired scene, ported from the design reference
//! (`docs/research/wired-prototype.html`): its geometry, its default tuning,
//! and its per-frame update, kept as close to the prototype's code as Rust
//! allows so the two can be read side by side. Nothing here knows GPUI: the
//! scene draws into a small RGB raster at one cell per logo pixel and lists
//! its text as spans; `view.rs` puts both on screen.
//!
//! The four poles stand on one ground line: todo, doing, blocked half a span
//! past doing, done a whole span past it. Items move along wires: in from the
//! left to the todo pole, queued on the wire to doing, picked up there by a run
//! (current flows along its wire while it works), and out of doing by one of
//! two spans: the short one to blocked, where they wait, or the long one that
//! sags under blocked's arms to done and runs off the edge. The web widget
//! (`src/features/wired/scene.ts`) is the same scene; keep the two in step.

use crate::theme::{Rgb, Theme};

/// The prototype's sliders, at their defaults. Units are logo pixels ("u") and seconds.
#[derive(Debug, Clone, Copy)]
pub struct Tune {
    /// Screen pixels per logo pixel.
    pub scale: u32,
    pub spacing: f32,
    pub sag: f32,
    pub sway_amp: f32,
    pub sway_speed: f32,
    pub pole_tone: f32,
    /// Wire brightness.
    pub idle: f32,
    /// Stage tint on the in/out wires.
    pub tint: f32,
    pub pulse_speed: f32,
    pub pulse_len: f32,
    pub glow: f32,
    /// Item speed along a wire, u/s.
    pub travel: f32,
    /// Demo only: how long a run works, s.
    pub work: f32,
    /// Demo only: the share of runs that end blocked.
    pub blocked_chance: f32,
    /// Demo only: the gap between arrivals, s.
    pub arrive: f32,
    pub blink: f32,
    pub duty: f32,
    pub soft: f32,
    /// The current's colour.
    pub current: Role,
}

impl Default for Tune {
    fn default() -> Self {
        Self {
            scale: 3,
            spacing: 64.0,
            sag: 0.08,
            sway_amp: 0.12,
            sway_speed: 0.3,
            pole_tone: 0.55,
            idle: 0.45,
            tint: 0.3,
            pulse_speed: 22.0,
            pulse_len: 6.0,
            glow: 0.35,
            travel: 22.0,
            work: 9.0,
            blocked_chance: 0.3,
            arrive: 8.0,
            blink: 1.2,
            duty: 0.35,
            soft: 0.3,
            current: Role::Yellow,
        }
    }
}

/// A theme role, for text and for the current. Resolved against the theme when drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Ink,
    Muted,
    Faint,
    Blue,
    Yellow,
    Red,
    Green,
}

impl Role {
    pub fn of(self, t: &Theme) -> Rgb {
        match self {
            Role::Ink => t.ink,
            Role::Muted => t.muted,
            Role::Faint => t.faint,
            Role::Blue => t.blue,
            Role::Yellow => t.yellow,
            Role::Red => t.red,
            Role::Green => t.green,
        }
    }
}

/* ---------- geometry (units = logo pixels) ---------- */

pub const POLE_H: i32 = 16;
/// Every pole's top: one ground line, with room above for the lamps.
pub const TOP: i32 = 4;
/// Past the done pole: room for its wires to run off the edge.
pub const TAIL: i32 = 22;
/// How much deeper than `sag` the doing-to-done span hangs: under blocked's lower arm, above its foot.
const DEEP: f32 = 1.1;
/// Room right of the canvas for the done list, in screen pixels.
pub const DONE_TAIL: f32 = 16.0;
/// Lines under the todo and doing poles; blocked and done have `SHORT_LINES`.
pub const LINES: usize = 4;
pub const SHORT_LINES: usize = 3;
/// A list line's height, in screen pixels at the natural size.
pub const LINE_H: f32 = 15.0;

/// JS `Math.round`: halves go up.
fn round(x: f32) -> i32 {
    (x + 0.5).floor() as i32
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    /// The four poles' left edges, left to right: todo, doing, blocked (half a span on), done (a whole span on).
    pub x: [f32; 4],
    /// The raster's width and height, in logo pixels.
    pub bw: i32,
    pub bh: i32,
}

impl Layout {
    pub fn new(spacing: f32) -> Self {
        let x = [
            10.0,
            10.0 + spacing,
            10.0 + spacing + spacing / 2.0,
            10.0 + 2.0 * spacing,
        ];
        Self {
            x,
            bw: x[3] as i32 + 10 + TAIL,
            bh: TOP + POLE_H + 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum W {
    In1,
    In2,
    Ab1,
    Ab2,
    /// The long span, doing's lower arm to done's, hanging under blocked.
    Bd,
    /// The short span, doing's upper arm to blocked's.
    Bb,
    Done1,
    Done2,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Wire {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub dip: f32,
    pub len: f32,
}

const K: f32 = 1.3;

/// A catenary's dip along the span, 0 at the ends and 1 in the middle.
pub fn dip_shape(t: f32) -> f32 {
    let ck = K.cosh();
    (ck - (K * (2.0 * t - 1.0)).cosh()) / (ck - 1.0)
}

impl Wire {
    pub fn at(&self, t: f32) -> (f32, f32) {
        (
            self.x0 + (self.x1 - self.x0) * t,
            self.y0 + (self.y1 - self.y0) * t + self.dip * dip_shape(t),
        )
    }
}

/// The eight wires at `clock`, swaying.
pub fn build_wires(l: &Layout, v: &Tune, clock: f32) -> [Wire; 8] {
    /* 6.283, not TAU: the prototype's literal, kept so the sway matches it. */
    #[allow(clippy::approx_constant)]
    let sway = |ph: f32| 1.0 + v.sway_amp * (clock * v.sway_speed * 6.283 + ph).sin();
    let mk = |x0: f32, y0: i32, x1: f32, y1: i32, ph: f32, k: f32| {
        let (y0, y1) = (y0 as f32, y1 as f32);
        Wire {
            x0,
            y0,
            x1,
            y1,
            dip: v.sag * (x1 - x0).abs() * k * sway(ph),
            len: (x1 - x0).hypot(y1 - y0),
        }
    };
    let [a, b, k, c] = l.x;
    let e = (l.bw + 8) as f32;
    [
        mk(-8.0, TOP + 6, a, TOP + 3, 0.4, 1.0),
        mk(-8.0, TOP + 12, a + 2.0, TOP + 8, 1.1, 1.2),
        mk(a + 9.0, TOP + 3, b, TOP + 3, 2.0, 1.0),
        mk(a + 7.0, TOP + 8, b + 2.0, TOP + 8, 2.7, 1.25),
        mk(b + 7.0, TOP + 8, c + 2.0, TOP + 8, 3.3, DEEP),
        mk(b + 9.0, TOP + 3, k, TOP + 3, 4.1, 1.0),
        mk(c + 9.0, TOP + 3, e, TOP + 8, 5.0, 1.0),
        mk(c + 7.0, TOP + 8, e, TOP + 13, 5.4, 1.2),
    ]
}

/* ---------- raster ---------- */

/// The scene at one cell per logo pixel, composited the way the prototype's canvas is.
pub struct Raster {
    pub w: i32,
    pub h: i32,
    pub px: Vec<Rgb>,
}

impl Raster {
    pub fn new(w: i32, h: i32, fill: Rgb) -> Self {
        Self {
            w,
            h,
            px: vec![fill; (w * h) as usize],
        }
    }

    /// One cell, `c` over what is there at alpha `a` (the canvas's `fillRect(x, y, 1, 1)`).
    pub fn plot(&mut self, x: i32, y: i32, c: Rgb, a: f32) {
        if x < 0 || y < 0 || x >= self.w || y >= self.h || a <= 0.0 {
            return;
        }
        let a = a.min(1.0);
        /* The prototype's css() truncates each channel. */
        let c = Rgb(c.0.trunc(), c.1.trunc(), c.2.trunc());
        let p = &mut self.px[(y * self.w + x) as usize];
        *p = p.mix(c, a);
    }

    pub fn rect(&mut self, x: i32, y: i32, w: i32, h: i32, c: Rgb, a: f32) {
        for yy in y..y + h {
            for xx in x..x + w {
                self.plot(xx, yy, c, a);
            }
        }
    }

    pub fn get(&self, x: i32, y: i32) -> Rgb {
        self.px[(y * self.w + x) as usize]
    }

    /// Horizontal runs of one colour, leaving out cells the colour of `skip`
    /// (the background, painted once): what the view paints as quads.
    pub fn runs(&self, skip: Rgb) -> Vec<Run> {
        let q = |c: Rgb| {
            [
                round(c.0).clamp(0, 255) as u8,
                round(c.1).clamp(0, 255) as u8,
                round(c.2).clamp(0, 255) as u8,
            ]
        };
        let skip = q(skip);
        let mut out = Vec::new();
        for y in 0..self.h {
            let mut x = 0;
            while x < self.w {
                let c = q(self.get(x, y));
                let mut end = x + 1;
                while end < self.w && q(self.get(end, y)) == c {
                    end += 1;
                }
                if c != skip {
                    out.push(Run {
                        x,
                        y,
                        len: end - x,
                        rgb: c,
                    });
                }
                x = end;
            }
        }
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Run {
    pub x: i32,
    pub y: i32,
    pub len: i32,
    pub rgb: [u8; 3],
}

/* ---------- items ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Coming in along the in wire to the todo pole.
    Arriving,
    /// On the wire between todo and doing, waiting.
    Queued,
    /// Being carried to the doing pole by a run.
    Picking,
    Working,
    /// Leaving doing by one of the branches.
    Leaving,
    Blocked,
    /// Going back to the queue: an answered blocked item, or one a run let go of.
    Returning,
    /// Leaving the scene where it is (live: nothing lists it any more).
    Fading,
    Gone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Blocked,
}

/// One leg of a journey: along a wire from t=a to t=b.
type Seg = (W, f32, f32);

#[derive(Debug, Clone)]
pub struct Item {
    pub key: String,
    pub state: State,
    route: Vec<Seg>,
    seg: usize,
    p: f32,
    pub wire: W,
    pub t: f32,
    pub agent: Option<String>,
    pub slot: Option<usize>,
    /// When the run started working on it, in scene seconds.
    pub started: f64,
    started_known: bool,
    until: f64,
    pub alpha: f32,
    pub outcome: Option<Outcome>,
    /// Where it rests on its wire, eased towards while it sits there.
    qt: Option<f32>,
    flashed: bool,
    /// Doing, but no run holds it (live: an active stage without a live claim). Drawn dimmer, no timer, no current.
    pub idle: bool,
    /// Its place in its pole's list (live). The demo keeps the order items came in.
    order: usize,
}

impl Item {
    fn new(key: &str, state: State) -> Self {
        Self {
            key: key.to_string(),
            state,
            route: if state == State::Arriving {
                vec![(W::In1, 0.0, 1.0)]
            } else {
                Vec::new()
            },
            seg: 0,
            p: 0.0,
            wire: W::In1,
            t: 0.0,
            agent: None,
            slot: None,
            started: 0.0,
            started_known: false,
            until: 0.0,
            alpha: 1.0,
            outcome: None,
            qt: None,
            flashed: false,
            idle: false,
            order: usize::MAX,
        }
    }

    /// How long its run has gone, "…" while it is still being picked up and that isn't known.
    fn elapsed(&self, now: f64) -> String {
        if self.state == State::Working || self.started_known {
            fmt(now - self.started)
        } else {
            "…".into()
        }
    }

    fn is_todo(&self) -> bool {
        matches!(self.state, State::Queued | State::Arriving)
    }

    fn is_doing(&self) -> bool {
        matches!(self.state, State::Working | State::Picking)
    }

    fn is_blocked(&self) -> bool {
        self.state == State::Blocked || self.leaving_to(Outcome::Blocked)
    }

    fn leaving_to(&self, outcome: Outcome) -> bool {
        self.state == State::Leaving && self.outcome == Some(outcome)
    }

    /// Still on the scene as something a list shows (not fading out, not on its way off).
    fn present(&self) -> bool {
        !matches!(self.state, State::Fading | State::Gone) && !self.leaving_to(Outcome::Done)
    }

    /// Set off along `route`, which must not be empty.
    fn go(&mut self, state: State, route: Vec<Seg>) {
        debug_assert!(!route.is_empty());
        self.state = state;
        self.route = route;
        self.seg = 0;
        self.p = 0.0;
    }

    /// Put it straight where it rests, no journey.
    fn place(&mut self, state: State, wire: W, t: f32) {
        self.state = state;
        self.route.clear();
        self.wire = wire;
        self.t = t;
        self.outcome = None;
        self.alpha = 1.0;
    }

    /// The legs from where it is to the doing pole's end of the wires.
    fn to_doing_pole(&self) -> Vec<Seg> {
        match self.state {
            State::Arriving if self.wire == W::In1 => vec![(W::In1, self.t, 1.0), (W::Ab1, 0.0, 1.0)],
            State::Arriving | State::Queued => vec![(self.wire, self.t, 1.0)],
            State::Blocked => vec![(W::Bb, self.t, 0.0)],
            State::Leaving if self.wire == W::Bb => vec![(W::Bb, self.t, 0.0)],
            _ => Vec::new(),
        }
    }
}

/// An agent in the status line.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentLabel {
    pub name: String,
    /// The last thing that went wrong for it, if the last poll failed.
    pub error: Option<String>,
    pub stopped: bool,
}

/// A task on the doing pole, as the scene is told it.
#[derive(Debug, Clone, PartialEq)]
pub struct Doing {
    pub key: String,
    /// The agent's name.
    pub agent: String,
    /// Scene seconds when its run started, when one holds it.
    pub started: Option<f64>,
    /// A run holds it. Otherwise it is only in an active stage: drawn dimmer, no timer, no current.
    pub live: bool,
}

/// What the scene is told in live mode: where each task is, by key.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Board {
    pub agents: Vec<AgentLabel>,
    /// Task keys waiting, in order.
    pub todo: Vec<String>,
    pub doing: Vec<Doing>,
    /// (task key, agent name).
    pub blocked: Vec<(String, String)>,
    /// (task key, scene seconds when it was done), newest first. None when the box can't know
    /// (no owner token), and then done is never drawn.
    pub done: Option<Vec<(String, f64)>>,
    /// All done within the window, of which `done` may be the newest few.
    pub done_count: Option<u32>,
    /// How long done ones are listed, in seconds; their lines fade over it.
    pub done_window: f64,
    /// A task's page, by key, for clicking its line.
    pub links: Vec<(String, String)>,
    /// Shown instead of the agents when there is nothing to watch.
    pub quiet: Option<String>,
    /// A last word in the status line: how to see more, or why it can't.
    pub note: Option<(String, Role)>,
    /// The data is real (not a placeholder before the first read): from the next change on, moves animate.
    pub ready: bool,
    /// The live sockets (COPL-62): all up (changes arrive at once), or one down (it polls until
    /// it is back). None when there is nothing to say: none tried yet, or the demo.
    pub live: Option<bool>,
}

/// A small xorshift, so the demo needs no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }
}

const DEMO_AGENTS: [&str; 2] = ["dev", "review"];
const DEMO_POOL: [&str; 10] = [
    "COPL-54", "COPL-55", "COPL-56", "COPL-57", "COPL-58", "COPL-59", "COPL-60", "COPL-61", "COPL-62", "COPL-63",
];

/// Beads drawn resting on a pole; the lists say how many more there are.
pub const MAX_BEADS: usize = 4;
/// The done list's header stays lit this long after the newest, in seconds (live).
pub const DONE_LIT: f64 = 15.0 * 60.0;

/// Where the i-th resting item of todo sits on the wire into doing.
fn queue_t(i: usize) -> f32 {
    (0.7 - i as f32 * 0.2).max(0.12)
}

/// Where the i-th blocked item sits on the wire to blocked.
fn blocked_t(i: usize) -> f32 {
    0.85 - 0.18 * i as f32
}

/// Where the i-th item working on a slot's wire sits: at the pole, then stepping back.
fn doing_t(i: usize) -> f32 {
    1.0 - 0.08 * i as f32
}

fn slot_wire(slot: usize) -> W {
    if slot == 0 { W::Ab1 } else { W::Ab2 }
}

struct Demo {
    pool: usize,
    next_arrival: f64,
    /// Not in the prototype, which has a button for it: a blocked item is answered after a while.
    next_answer: f64,
    rng: Rng,
}

pub struct Scene {
    pub tune: Tune,
    pub layout: Layout,
    pub wires: [Wire; 8],
    pub items: Vec<Item>,
    /// Animation time: sway, pulses, blinking.
    pub clock: f64,
    /// Scene time, seconds since the scene began.
    pub now: f64,
    last: f64,
    pub flash_done: f32,
    pub done_log: Vec<(String, f64)>,
    /// Known in the demo, and live with the owner's token.
    pub done_count: Option<u32>,
    /// Live: how long done ones are listed, s (their lines fade over it).
    done_window: Option<f64>,
    /// Live: done keys already seen, so each climbs to done once.
    known_done: std::collections::HashSet<String>,
    /// Live: the board has been real once, so changes from here on animate.
    synced: bool,
    links: Vec<(String, String)>,
    pub agents: Vec<AgentLabel>,
    pub quiet: Option<String>,
    note: Option<(String, Role)>,
    /// Live: whether the live sockets are up, when there is anything to say (see `Board::live`).
    live: Option<bool>,
    /// Sway, current, blinking and travel. Off, it is a still picture redrawn when something changes.
    pub motion: bool,
    demo: Option<Demo>,
}

impl Scene {
    fn empty(tune: Tune) -> Self {
        let layout = Layout::new(tune.spacing);
        Self {
            wires: build_wires(&layout, &tune, 0.0),
            tune,
            layout,
            items: Vec::new(),
            clock: 0.0,
            now: 0.0,
            last: 0.0,
            flash_done: 0.0,
            done_log: Vec::new(),
            done_count: None,
            done_window: None,
            known_done: Default::default(),
            synced: false,
            links: Vec::new(),
            agents: Vec::new(),
            quiet: None,
            note: None,
            live: None,
            motion: true,
            demo: None,
        }
    }

    /// A scene the daemon drives through `sync`.
    pub fn live(tune: Tune) -> Self {
        Self::empty(tune)
    }

    /// The prototype's simulation, seeded as the prototype seeds it.
    pub fn demo(tune: Tune, seed: u64) -> Self {
        let mut s = Self::empty(tune);
        s.agents = DEMO_AGENTS
            .iter()
            .map(|a| AgentLabel {
                name: a.to_string(),
                error: None,
                stopped: false,
            })
            .collect();
        s.done_count = Some(3);
        s.done_log = vec![("COPL-46".into(), -4.0)];
        let mut w = Item::new("COPL-33", State::Working);
        w.agent = Some("dev".into());
        w.slot = Some(0);
        w.wire = W::Ab1;
        w.t = 1.0;
        w.started = -134.0;
        w.started_known = true;
        w.until = 6.0;
        s.items.push(w);
        for (key, t) in [("COPL-31", 0.55), ("COPL-44", 0.3)] {
            let mut q = Item::new(key, State::Queued);
            q.wire = W::Ab1;
            q.t = t;
            s.items.push(q);
        }
        let mut bl = Item::new("COPL-48", State::Blocked);
        bl.wire = W::Bb;
        bl.t = blocked_t(0);
        bl.agent = Some("review".into());
        s.items.push(bl);
        s.demo = Some(Demo {
            pool: 0,
            next_arrival: 0.0,
            next_answer: 20.0,
            rng: Rng(seed | 1),
        });
        s
    }

    fn wire(&self, w: W) -> &Wire {
        &self.wires[w as usize]
    }

    fn spawn(&mut self, key: &str) {
        self.items.push(Item::new(key, State::Arriving));
    }

    /// The demo's "new item" button.
    pub fn add(&mut self) {
        if let Some(d) = &mut self.demo {
            let key = DEMO_POOL[d.pool % DEMO_POOL.len()];
            d.pool += 1;
            self.spawn(key);
        }
    }

    /// The demo's "answer blocked" button: the first blocked item goes back to the queue.
    pub fn answer(&mut self) {
        if let Some(b) = self.items.iter_mut().find(|i| i.state == State::Blocked) {
            let route = vec![(W::Bb, b.t, 0.0), (W::Ab1, 1.0, 0.9)];
            b.go(State::Returning, route);
        }
    }

    /// The demo's "finish one" button.
    pub fn finish_one(&mut self) {
        let chance = self.tune.blocked_chance;
        let Some(d) = &mut self.demo else { return };
        let outcome = if d.rng.next() < chance {
            Outcome::Blocked
        } else {
            Outcome::Done
        };
        if let Some(ix) = self.items.iter().position(|i| i.state == State::Working) {
            self.finish(ix, outcome);
        }
    }

    /// Off the doing pole by one of the branches (or from wherever it is, by way of the doing pole).
    fn finish(&mut self, ix: usize, outcome: Outcome) {
        let blocked = self.items.iter().filter(|i| i.state == State::Blocked).count();
        let it = &mut self.items[ix];
        let mut route = it.to_doing_pole();
        match outcome {
            Outcome::Done => route.extend([(W::Bd, 0.0, 1.0), (W::Done2, 0.0, 1.0)]),
            Outcome::Blocked => route.push((W::Bb, 0.0, blocked_t(blocked))),
        }
        it.go(State::Leaving, route);
        it.outcome = Some(outcome);
        it.qt = None;
        it.idle = false;
    }

    fn queue_targets(&mut self) {
        let mut queued: Vec<&mut Item> = self.items.iter_mut().filter(|i| i.state == State::Queued).collect();
        queued.sort_by_key(|i| i.order);
        for (i, it) in queued.into_iter().enumerate() {
            it.qt = Some(queue_t(i));
        }
        if self.demo.is_none() {
            for slot in [0, 1] {
                let mut on: Vec<&mut Item> = self
                    .items
                    .iter_mut()
                    .filter(|i| i.state == State::Working && i.slot == Some(slot))
                    .collect();
                on.sort_by_key(|i| (i.idle, i.order));
                for (i, it) in on.into_iter().enumerate() {
                    it.qt = Some(doing_t(i));
                }
            }
        }
    }

    /// The slot wire with the fewest items working on it.
    fn free_slot(&self) -> Option<usize> {
        let on = |s: usize| self.items.iter().filter(|i| i.is_doing() && i.slot == Some(s)).count();
        if self.demo.is_some() {
            return [0, 1].into_iter().find(|&s| on(s) == 0);
        }
        Some(if on(1) < on(0) { 1 } else { 0 })
    }

    /// Move along the route; true once at its end.
    fn advance(wires: &[Wire; 8], travel: f32, it: &mut Item, dt: f32) -> bool {
        let (wn, a, b) = it.route[it.seg];
        let len = (wires[wn as usize].len * (b - a).abs()).max(4.0);
        it.p += travel * dt / len;
        if it.p >= 1.0 {
            it.seg += 1;
            it.p = 0.0;
            if it.seg >= it.route.len() {
                let last = it.route[it.route.len() - 1];
                it.wire = last.0;
                it.t = last.2;
                it.route.clear();
                return true;
            }
        }
        let (wn2, a2, b2) = it.route[it.seg];
        it.wire = wn2;
        it.t = a2 + (b2 - a2) * it.p;
        false
    }

    /// Bring the items in line with the board (live mode), diffing by task key: an item that
    /// changed pole travels the wires to its new place; one nothing lists any more fades out.
    /// Called every frame with the same board is a no-op.
    pub fn sync(&mut self, board: &Board) {
        self.agents = board.agents.clone();
        self.quiet = board.quiet.clone();
        self.note = board.note.clone();
        self.live = board.live;
        self.links = board.links.clone();
        let animate = self.motion && self.synced;
        if board.ready {
            self.synced = true;
        }

        let wanted = |key: &str| {
            board.todo.iter().any(|k| k == key)
                || board.doing.iter().any(|d| d.key == key)
                || board.blocked.iter().any(|b| b.0 == key)
        };

        /* Done: each key climbs once, from wherever it was. */
        if let Some(done) = &board.done {
            for (key, _) in done {
                if wanted(key) || self.known_done.contains(key) {
                    continue;
                }
                self.known_done.insert(key.clone());
                let at = self.items.iter().position(|i| &i.key == key && i.present());
                match (animate, at) {
                    (true, Some(ix)) => self.finish(ix, Outcome::Done),
                    (true, None) => {
                        let mut it = Item::new(key, State::Leaving);
                        it.wire = W::Done2;
                        it.go(State::Leaving, vec![(W::Done2, 0.0, 1.0)]);
                        it.outcome = Some(Outcome::Done);
                        self.items.push(it);
                    }
                    (false, Some(ix)) => self.items[ix].state = State::Gone,
                    (false, None) => {}
                }
            }
            self.known_done.retain(|k| done.iter().any(|d| &d.0 == k) && !wanted(k));
            let flying: Vec<&str> = self
                .items
                .iter()
                .filter(|i| i.leaving_to(Outcome::Done))
                .map(|i| i.key.as_str())
                .collect();
            self.done_log = done
                .iter()
                .filter(|(k, _)| !flying.contains(&k.as_str()))
                .cloned()
                .collect();
            self.done_count = board.done_count;
            self.done_window = Some(board.done_window);
        }

        /* Whatever nothing lists any more fades where it is. */
        for it in &mut self.items {
            if it.present() && !wanted(&it.key) {
                it.state = if animate { State::Fading } else { State::Gone };
            }
        }
        self.items.retain(|i| i.state != State::Gone);

        let find = |items: &[Item], key: &str| items.iter().position(|i| i.key == key && i.present());

        for (n, key) in board.todo.iter().enumerate() {
            let qt = queue_t(n);
            let ix = match find(&self.items, key) {
                Some(ix) => ix,
                None => {
                    let mut it = Item::new(key, State::Arriving);
                    if !animate {
                        it.place(State::Queued, W::Ab1, qt);
                    }
                    self.items.push(it);
                    self.items.len() - 1
                }
            };
            let it = &mut self.items[ix];
            it.order = n;
            match it.state {
                State::Arriving | State::Queued | State::Returning => {}
                State::Picking | State::Working if animate => {
                    let from = if it.wire == W::Ab1 { it.t } else { 1.0 };
                    it.go(State::Returning, vec![(W::Ab1, from, qt)]);
                }
                State::Blocked if animate => {
                    let route = vec![(W::Bb, it.t, 0.0), (W::Ab1, 1.0, qt)];
                    it.go(State::Returning, route);
                }
                _ => it.place(State::Queued, W::Ab1, qt),
            }
            it.idle = false;
            it.slot = None;
        }

        for (n, d) in board.doing.iter().enumerate() {
            let ix = match find(&self.items, &d.key) {
                Some(ix) => ix,
                None => {
                    self.items.push(Item::new(&d.key, State::Arriving));
                    if !animate {
                        let last = self.items.len() - 1;
                        self.items[last].state = State::Queued;
                    }
                    self.items.len() - 1
                }
            };
            if !self.items[ix].is_doing() {
                let slot = self.free_slot().unwrap_or(0);
                let ab = slot_wire(slot);
                let it = &mut self.items[ix];
                match it.state {
                    State::Arriving | State::Queued if animate => {
                        let route = if it.state == State::Arriving && it.wire == W::In1 {
                            vec![(W::In1, it.t, 1.0), (ab, 0.0, 1.0)]
                        } else {
                            let from = if it.wire == W::Ab1 || it.wire == W::Ab2 {
                                it.t
                            } else {
                                0.0
                            };
                            vec![(ab, from, 1.0)]
                        };
                        it.go(State::Picking, route);
                    }
                    State::Blocked | State::Leaving if animate => {
                        let mut route = it.to_doing_pole();
                        route.push((ab, 1.0, 1.0));
                        it.go(State::Picking, route);
                        it.outcome = None;
                    }
                    /* Mid-way back to the queue: it gets there first, and the next frame picks it up. */
                    State::Returning if animate => continue,
                    _ => it.place(State::Working, ab, 1.0),
                }
                it.slot = Some(slot);
            }
            let it = &mut self.items[ix];
            it.order = n;
            it.agent = Some(d.agent.clone());
            it.idle = !d.live;
            it.started_known = d.started.is_some();
            if let Some(s) = d.started {
                it.started = s;
            }
        }

        for (n, (key, agent)) in board.blocked.iter().enumerate() {
            let rest = blocked_t(n);
            let ix = match find(&self.items, key) {
                Some(ix) => ix,
                None => {
                    let mut it = Item::new(key, State::Blocked);
                    it.place(State::Blocked, W::Bb, rest);
                    self.items.push(it);
                    self.items.len() - 1
                }
            };
            if !self.items[ix].is_blocked() {
                if animate
                    && matches!(
                        self.items[ix].state,
                        State::Picking | State::Working | State::Queued | State::Arriving
                    )
                {
                    self.finish(ix, Outcome::Blocked);
                } else {
                    self.items[ix].place(State::Blocked, W::Bb, rest);
                }
            }
            let it = &mut self.items[ix];
            it.order = n;
            it.agent = Some(agent.clone());
            it.idle = false;
            if it.state == State::Blocked {
                it.qt = Some(rest);
            }
        }
    }

    /// One frame of the prototype's loop, at `now` seconds.
    pub fn step(&mut self, now: f64) {
        let dt = (now - self.last).clamp(0.0, 0.05);
        self.last = now;
        self.now = now;
        let sdt = dt as f32;
        if self.motion {
            self.clock += dt;
        }
        self.wires = build_wires(&self.layout, &self.tune, self.clock as f32);
        let v = self.tune;

        if let Some(d) = &mut self.demo {
            if now > d.next_arrival {
                d.next_arrival = now + v.arrive as f64 * (0.6 + d.rng.next() as f64 * 0.8);
                if self.items.iter().filter(|i| i.is_todo()).count() < 4 {
                    self.add();
                }
            }
        }
        if let Some(d) = &mut self.demo {
            if now > d.next_answer {
                d.next_answer = now + 14.0 + d.rng.next() as f64 * 12.0;
                self.answer();
            }
        }

        self.queue_targets();
        let ease = |t: &mut f32, qt: Option<f32>, motion: bool| {
            if let Some(qt) = qt {
                if motion {
                    *t += (qt - *t) * (1.0 - (-sdt * v.travel / 12.0).exp());
                } else {
                    *t = qt;
                }
            }
        };
        let mut i = 0;
        while i < self.items.len() {
            let mut ends: Option<Outcome> = None;
            let wires = &self.wires;
            let motion = self.motion;
            let it = &mut self.items[i];
            match it.state {
                State::Arriving => {
                    if Self::advance(wires, v.travel, it, sdt) {
                        it.state = State::Queued;
                        it.wire = W::Ab1;
                        it.t = 0.0;
                    }
                }
                State::Queued => ease(&mut it.t, Some(it.qt.unwrap_or(0.5)), motion),
                State::Picking => {
                    if Self::advance(wires, v.travel, it, sdt) {
                        it.state = State::Working;
                        it.wire = slot_wire(it.slot.unwrap_or(0));
                        if !it.started_known {
                            it.started = now;
                        }
                        if let Some(d) = &mut self.demo {
                            it.until = now + v.work as f64 * (0.6 + d.rng.next() as f64 * 0.8);
                        }
                    }
                }
                State::Working => {
                    if let Some(d) = &mut self.demo {
                        if now > it.until {
                            let blocked = d.rng.next() < v.blocked_chance;
                            ends = Some(if blocked { Outcome::Blocked } else { Outcome::Done });
                        }
                    } else {
                        ease(&mut it.t, it.qt, motion);
                    }
                }
                State::Leaving => {
                    if Self::advance(wires, v.travel, it, sdt) {
                        if it.outcome == Some(Outcome::Done) {
                            it.state = State::Gone;
                            let key = it.key.clone();
                            self.done_log.retain(|d| d.0 != key);
                            self.done_log.insert(0, (key, now));
                            if self.demo.is_some() {
                                if let Some(n) = &mut self.done_count {
                                    *n += 1;
                                }
                                self.done_log.truncate(6);
                            }
                        } else {
                            it.state = State::Blocked;
                        }
                    } else if it.outcome == Some(Outcome::Done) && it.wire == W::Done2 {
                        if !it.flashed {
                            it.flashed = true;
                            self.flash_done = 1.0;
                        }
                        it.alpha = 1.0 - ((it.t - 0.5) / 0.5).max(0.0);
                    }
                }
                State::Returning => {
                    if Self::advance(wires, v.travel, it, sdt) {
                        it.state = State::Queued;
                        it.qt = Some(it.t);
                        if self.demo.is_some() {
                            let it = self.items.remove(i);
                            self.items.insert(0, it);
                            break;
                        }
                    }
                }
                State::Fading => {
                    it.alpha -= sdt / 0.8;
                    if it.alpha <= 0.0 || !motion {
                        it.state = State::Gone;
                    }
                }
                State::Blocked => ease(&mut it.t, it.qt, motion),
                State::Gone => {}
            }
            if let Some(outcome) = ends {
                self.finish(i, outcome);
            }
            i += 1;
        }
        self.items.retain(|i| i.state != State::Gone);

        if self.demo.is_some() {
            self.queue_targets();
            let head = self.items.iter().position(|i| i.state == State::Queued);
            let slot = self.free_slot();
            let busy: Vec<String> = self
                .items
                .iter()
                .filter(|i| i.is_doing())
                .filter_map(|i| i.agent.clone())
                .collect();
            let agent = DEMO_AGENTS.iter().find(|a| !busy.iter().any(|b| b == *a));
            if let (Some(h), Some(slot), Some(agent)) = (head, slot, agent) {
                let it = &mut self.items[h];
                if it.t > it.qt.unwrap_or(0.0) - 0.05 {
                    it.slot = Some(slot);
                    it.agent = Some(agent.to_string());
                    let route = vec![(slot_wire(slot), it.t, 1.0)];
                    it.go(State::Picking, route);
                }
            }
        }
        self.flash_done = (self.flash_done - sdt * 0.8).max(0.0);
    }

    /// Something is travelling, fading or settling: the window should draw every frame.
    pub fn moving(&self) -> bool {
        self.flash_done > 0.0
            || self.items.iter().any(|i| match i.state {
                State::Queued | State::Working | State::Blocked => {
                    self.motion && i.qt.is_some_and(|qt| (qt - i.t).abs() > 0.002)
                }
                State::Gone => false,
                _ => true,
            })
    }

    /// Something only sways, pulses or blinks: worth drawing, but not at full rate.
    pub fn ambient(&self) -> bool {
        self.motion
    }

    /// A run's timer is on screen, so the text changes each second even when nothing moves.
    pub fn ticking(&self) -> bool {
        self.items.iter().any(|i| i.state == State::Working && !i.idle)
    }

    fn blink_level(&self) -> f32 {
        if !self.motion {
            return 1.0;
        }
        let v = &self.tune;
        let clock = self.clock as f32;
        let p = (clock % v.blink) / v.blink;
        let hard = if p < v.duty { 1.0 } else { 0.0 };
        let soft = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * (p / (v.duty * 2.0).max(0.01)).min(1.0)).cos();
        hard * (1.0 - v.soft) + soft * v.soft
    }

    fn draw_wire(&self, r: &mut Raster, w: &Wire, base: Rgb, pulse: f32, cur: Rgb) {
        let v = &self.tune;
        let steps = (w.len * 3.0).ceil() as i32;
        let mut pts: Vec<(i32, i32, f32)> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for s in 0..=steps {
            let t = s as f32 / steps as f32;
            let (x, y) = w.at(t);
            let (px, py) = (round(x), round(y));
            if seen.insert((px, py)) {
                pts.push((px, py, t));
            }
        }
        let lv: Vec<f32> = pts
            .iter()
            .map(|&(_, _, t)| {
                if pulse == 0.0 {
                    return 0.0;
                }
                let d = (t - pulse).abs() / ((v.pulse_len / w.len) / 2.0);
                if d < 1.0 { (1.0 - d).powf(1.6) } else { 0.0 }
            })
            .collect();
        if v.glow > 0.0 {
            for (j, &(x, y, _)) in pts.iter().enumerate() {
                if lv[j] > 0.05 {
                    r.plot(x, y - 1, cur, lv[j] * v.glow * 0.55);
                    r.plot(x, y + 1, cur, lv[j] * v.glow * 0.55);
                }
            }
        }
        for (j, &(x, y, _)) in pts.iter().enumerate() {
            r.plot(x, y, base.mix(cur, lv[j]), 1.0);
        }
    }

    fn draw_pole(&self, r: &mut Raster, th: &Theme, x: f32, top: i32, lamp_col: Rgb, lamp: f32) {
        let v = &self.tune;
        let x = x as i32;
        let pole = th.surface.mix(th.ink, v.pole_tone);
        r.rect(x + 4, top, 2, POLE_H, pole, 1.0);
        r.rect(x, top + 3, 10, 2, pole, 1.0);
        r.rect(x + 2, top + 8, 6, 1, pole, 1.0);
        r.rect(
            x + 4,
            top - 2,
            2,
            2,
            th.surface.mix(th.faint, 0.8).mix(lamp_col, lamp),
            1.0,
        );
        if lamp > 0.6 && v.glow > 0.0 {
            let a = (lamp - 0.6) * v.glow;
            r.rect(x + 3, top - 3, 4, 1, lamp_col, a);
            r.rect(x + 3, top, 1, 1, lamp_col, a);
            r.rect(x + 6, top, 1, 1, lamp_col, a);
        }
    }

    /// Runs on a task right now (a run holds it), the ones still being picked up included.
    pub fn working(&self) -> usize {
        self.items.iter().filter(|i| i.is_doing() && !i.idle).count()
    }

    pub fn queued(&self) -> usize {
        self.items.iter().filter(|i| i.is_todo()).count()
    }

    pub fn blocked(&self) -> usize {
        self.items.iter().filter(|i| i.state == State::Blocked).count()
    }

    /// The pixel scene as it stands.
    pub fn draw(&self, th: &Theme) -> Raster {
        let v = &self.tune;
        let mut r = Raster::new(self.layout.bw, self.layout.bh, th.surface);
        let base = th.surface.mix(th.muted, v.idle);
        let tinted = |c: Rgb| base.mix(c, v.tint);
        let cur = v.current.of(th);
        let clock = self.clock as f32;
        let pulse = |slot: usize| {
            if !self.motion
                || !self
                    .items
                    .iter()
                    .any(|i| i.state == State::Working && !i.idle && i.slot == Some(slot))
            {
                return 0.0;
            }
            let l = self.wire(slot_wire(slot)).len;
            (clock * v.pulse_speed / l) % 1.0
        };
        self.draw_wire(&mut r, self.wire(W::In1), tinted(th.blue), 0.0, cur);
        self.draw_wire(&mut r, self.wire(W::In2), tinted(th.blue), 0.0, cur);
        self.draw_wire(&mut r, self.wire(W::Ab1), base, pulse(0), cur);
        self.draw_wire(&mut r, self.wire(W::Ab2), base, pulse(1), cur);
        self.draw_wire(&mut r, self.wire(W::Bd), tinted(th.green), 0.0, cur);
        self.draw_wire(&mut r, self.wire(W::Bb), tinted(th.red), 0.0, cur);
        self.draw_wire(&mut r, self.wire(W::Done1), tinted(th.green), 0.0, cur);
        self.draw_wire(&mut r, self.wire(W::Done2), tinted(th.green), 0.0, cur);

        let bl = self.blink_level();
        let x = self.layout.x;
        let lit = |b: bool| if b { 1.0 } else { 0.0 };
        self.draw_pole(&mut r, th, x[0], TOP, th.blue, lit(self.queued() > 0));
        let idle = self.items.iter().any(|i| i.state == State::Working && i.idle);
        let doing = if self.working() > 0 {
            if self.motion {
                0.85 + 0.15 * (clock * 7.0).sin()
            } else {
                1.0
            }
        } else if idle {
            0.4
        } else {
            0.0
        };
        self.draw_pole(&mut r, th, x[1], TOP, th.yellow, doing);
        let blocked = if self.blocked() > 0 { bl } else { 0.0 };
        self.draw_pole(&mut r, th, x[2], TOP, th.red, blocked);
        self.draw_pole(&mut r, th, x[3], TOP, th.green, self.flash_done);

        /* Resting beads past MAX_BEADS a pole stay off the wire; the lists say how many more. */
        let mut resting = [0usize; 3];
        for it in &self.items {
            let pole = match it.state {
                State::Queued => Some(0),
                State::Working => Some(1),
                State::Blocked => Some(2),
                _ => None,
            };
            if let Some(p) = pole {
                resting[p] += 1;
                if resting[p] > MAX_BEADS {
                    continue;
                }
            }
            let (bx, by) = self.wire(it.wire).at(it.t);
            let mut a = it.alpha;
            if it.state == State::Blocked {
                a *= 0.45 + 0.55 * bl;
            }
            if it.is_doing() && it.idle {
                a *= 0.45;
            }
            let c = match it.state {
                State::Working | State::Picking | State::Returning => th.yellow,
                _ if it.is_blocked() => th.red,
                State::Leaving => th.green,
                _ => th.blue,
            };
            let (bx, by) = (round(bx), round(by));
            r.rect(bx - 1, by + 1, 2, 2, c, a);
            r.rect(bx - 1, by, 2, 1, c, a * 0.5);
        }
        r
    }

    /* ---------- text ---------- */

    fn link(&self, key: &str) -> Option<String> {
        self.links.iter().find(|(k, _)| k == key).map(|(_, url)| url.clone())
    }

    /// The four lists, one under each pole: todo, doing, blocked, done. `chars` is how many
    /// characters fit each one; a list shows the longest form of its lines that all of them
    /// fit (doing drops the timer, then the agent; blocked the agent, then the mark; done the
    /// mark), the shortest when none does.
    pub fn columns(&self, chars: [usize; 4]) -> [Column; 4] {
        let now = self.now;
        let sorted = |f: &dyn Fn(&Item) -> bool| {
            let mut v: Vec<&Item> = self.items.iter().filter(|i| f(i)).collect();
            v.sort_by_key(|i| i.order);
            v
        };
        let todo: Vec<Vec<Line>> = sorted(&|i: &Item| i.is_todo())
            .into_iter()
            .map(|i| vec![Line::one(i.key.clone(), Role::Blue).to(self.link(&i.key))])
            .collect();
        let mut doing: Vec<&Item> = self.items.iter().filter(|i| i.is_doing()).collect();
        if self.demo.is_some() {
            doing.sort_by_key(|i| i.slot);
        } else {
            doing.sort_by_key(|i| (i.idle, i.order));
        }
        let doing: Vec<Vec<Line>> = doing
            .into_iter()
            .map(|i| {
                let link = self.link(&i.key);
                let agent = i.agent.clone().unwrap_or_default();
                let (key_role, agent_role) = if i.idle {
                    (Role::Muted, Role::Muted)
                } else {
                    (Role::Ink, Role::Yellow)
                };
                let key = Span::new(i.key.clone(), key_role);
                let with_agent = Line(
                    vec![key.clone(), Span::new(format!(" {agent}"), agent_role)],
                    link.clone(),
                );
                let bare = Line(vec![key], link.clone());
                if i.idle {
                    return vec![with_agent, bare];
                }
                let elapsed = i.elapsed(now);
                let mut full = with_agent.clone();
                full.0.push(Span::new(format!(" {elapsed}"), Role::Muted));
                vec![full, with_agent, bare]
            })
            .collect();
        let blocked: Vec<Vec<Line>> = sorted(&|i: &Item| i.is_blocked())
            .into_iter()
            .map(|i| {
                let link = self.link(&i.key);
                let mark = Line(vec![Span::new(format!("▲ {}", i.key), Role::Red)], link.clone());
                let mut full = mark.clone();
                full.0.push(Span::new(
                    format!(" {}", i.agent.clone().unwrap_or_default()),
                    Role::Muted,
                ));
                vec![full, mark, Line(vec![Span::new(i.key.clone(), Role::Red)], link)]
            })
            .collect();
        let done_line = |key: &str, alpha: f32| {
            let link = self.link(key);
            let mut a = Line(vec![Span::new(format!("✓ {key}"), Role::Green)], link.clone());
            let mut b = Line(vec![Span::new(key, Role::Green)], link);
            a.0[0].alpha = alpha;
            b.0[0].alpha = alpha;
            vec![a, b]
        };
        let (done, done_total, done_lit) = match self.done_window {
            /* Live: everything done within the window, fading over it. */
            Some(window) => {
                let lines: Vec<Vec<Line>> = self
                    .done_log
                    .iter()
                    .map(|(key, at)| done_line(key, (1.0 - ((now - at) / window.max(1.0)) as f32).max(0.3)))
                    .collect();
                let total = (self.done_count.unwrap_or(0) as usize).max(lines.len());
                let newest = self.done_log.first().map(|d| now - d.1);
                (lines, total, newest.is_some_and(|age| age < DONE_LIT))
            }
            None => {
                let lines: Vec<Vec<Line>> = self
                    .done_log
                    .iter()
                    .filter(|(_, at)| now - at < 30.0)
                    .map(|(key, at)| done_line(key, (1.0 - (now - at) as f32 / 30.0).max(0.3)))
                    .collect();
                let n = lines.len();
                (lines, n, false)
            }
        };
        let (nt, nd, nb) = (todo.len(), doing.len(), blocked.len());
        [
            Column::new("todo", Role::Blue, self.queued() > 0, fitted(todo, LINES, nt, chars[0])),
            Column::new(
                "doing",
                Role::Yellow,
                self.working() > 0,
                fitted(doing, LINES, nd, chars[1]),
            ),
            Column::new(
                "blocked",
                Role::Red,
                self.blocked() > 0,
                fitted(blocked, SHORT_LINES, nb, chars[2]),
            ),
            Column::new(
                "done",
                Role::Green,
                self.flash_done > 0.2 || done_lit,
                fitted(done, SHORT_LINES, done_total, chars[3]),
            ),
        ]
    }

    /// The status line under the scene.
    pub fn status(&self) -> Vec<Line> {
        if let Some(q) = &self.quiet {
            return vec![Line(
                vec![
                    Span::new("nothing on the wire", Role::Muted),
                    Span::new(format!("  {q}"), Role::Faint),
                ],
                None,
            )];
        }
        let now = self.now;
        let mut parts: Vec<Line> = self
            .agents
            .iter()
            .map(|a| {
                let w = self
                    .items
                    .iter()
                    .find(|i| i.is_doing() && !i.idle && i.agent.as_deref() == Some(&a.name));
                match (w, &a.error) {
                    (Some(w), _) => Line(
                        vec![
                            Span::new(format!("{} ", a.name), Role::Muted),
                            Span::new("●", Role::Yellow),
                            Span::new(format!(" {} {}", w.key, w.elapsed(now)), Role::Muted),
                        ],
                        None,
                    ),
                    (None, Some(e)) => Line(
                        vec![
                            Span::new(format!("{} ", a.name), Role::Muted),
                            Span::new(format!("× {e}"), Role::Red),
                        ],
                        None,
                    ),
                    (None, None) if a.stopped => Line::one(format!("{} stopped", a.name), Role::Faint),
                    (None, None) => Line::one(format!("{} ○", a.name), Role::Muted),
                }
            })
            .collect();
        parts.push(Line(
            vec![
                Span::new(self.queued().to_string(), Role::Blue),
                Span::new(" todo", Role::Muted),
            ],
            None,
        ));
        let blocked: Vec<&str> = self
            .items
            .iter()
            .filter(|i| i.state == State::Blocked)
            .map(|i| i.key.as_str())
            .collect();
        if !blocked.is_empty() {
            parts.push(Line(
                vec![
                    Span::new("▲", Role::Red),
                    Span::new(format!(" {}", blocked.join(" ")), Role::Muted),
                ],
                None,
            ));
        }
        if let Some(n) = self.done_count {
            parts.push(Line(
                vec![Span::new("✓", Role::Green), Span::new(format!(" {n}"), Role::Muted)],
                None,
            ));
        }
        /* A quiet dot while changes arrive as they happen; a word when it has fallen back to polling. */
        match self.live {
            Some(true) => parts.push(Line::one("•", Role::Faint)),
            Some(false) => parts.push(Line::one("◦ polling", Role::Faint)),
            None => {}
        }
        if let Some((note, role)) = &self.note {
            parts.push(Line::one(note.clone(), *role));
        }
        parts
    }

    /// Whether the status line ends with a note (how to see more, or why it can't).
    pub fn has_note(&self) -> bool {
        self.quiet.is_none() && self.note.is_some()
    }

    /// "1 doing · 1 need you", beside the title.
    pub fn count(&self) -> String {
        let need = self.items.iter().filter(|i| i.is_blocked()).count();
        format!("{} doing · {need} need you", self.working())
    }

    /// Where the lists start, in screen pixels from the scene's top: under the poles.
    /// `zoom` scales the screen-pixel parts (text, gaps) with the window: 1 at the natural size.
    pub fn list_top(cell: f32, zoom: f32) -> f32 {
        (TOP + POLE_H) as f32 * cell + 2.0 * zoom
    }

    /// The box's scene area in screen pixels at `cell` pixels per logo pixel.
    pub fn size(&self, cell: f32, zoom: f32) -> (f32, f32) {
        let l = &self.layout;
        let list_top = Self::list_top(cell, zoom);
        (
            l.bw as f32 * cell + DONE_TAIL * zoom,
            (l.bh as f32 * cell + 6.0 * zoom).max(list_top + (20.0 + LINES as f32 * LINE_H) * zoom),
        )
    }
}

/// At most `max` lines of a list of `total`, the last saying how many more when they don't
/// fit, each in the longest of its forms (given longest first) that every shown line fits
/// in `chars`, so the list reads alike; the shortest when none does.
fn fitted(entries: Vec<Vec<Line>>, max: usize, total: usize, chars: usize) -> Vec<Line> {
    let shown = if total > max { max - 1 } else { max };
    let entries: Vec<Vec<Line>> = entries.into_iter().take(shown).collect();
    let forms = entries.iter().map(Vec::len).max().unwrap_or(0);
    let pick = |f: usize, e: &Vec<Line>| e[f.min(e.len() - 1)].clone();
    let form = (0..forms)
        .find(|&f| entries.iter().all(|e| pick(f, e).chars() <= chars))
        .unwrap_or(forms.saturating_sub(1));
    let mut lines: Vec<Line> = entries.iter().map(|e| pick(form, e)).collect();
    if total > lines.len() && total > max {
        lines.push(Line::one(format!("+{} more", total - lines.len()), Role::Muted));
    }
    lines
}

/// Minutes and seconds, "2m14"; hours and minutes from an hour on, "1h05".
pub fn fmt(secs: f64) -> String {
    let s = secs.max(0.0).floor() as u64;
    let m = s / 60;
    if m >= 60 {
        format!("{}h{:02}", m / 60, m % 60)
    } else {
        format!("{}m{:02}", m, s % 60)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    pub text: String,
    pub role: Role,
    pub alpha: f32,
}

impl Span {
    pub fn new(text: impl Into<String>, role: Role) -> Self {
        Self {
            text: text.into(),
            role,
            alpha: 1.0,
        }
    }
}

/// A line of text, and the page it opens when clicked.
#[derive(Debug, Clone, PartialEq)]
pub struct Line(pub Vec<Span>, pub Option<String>);

impl Line {
    pub fn one(text: impl Into<String>, role: Role) -> Self {
        Self(vec![Span::new(text, role)], None)
    }

    /// How many characters it takes.
    pub fn chars(&self) -> usize {
        self.0.iter().map(|s| s.text.chars().count()).sum()
    }

    fn to(mut self, link: Option<String>) -> Self {
        self.1 = link;
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Column {
    pub head: &'static str,
    /// The head's colour: its stage's role when lit, faint otherwise.
    pub head_role: Role,
    pub lines: Vec<Line>,
}

impl Column {
    fn new(head: &'static str, role: Role, lit: bool, lines: Vec<Line>) -> Self {
        Self {
            head,
            head_role: if lit { role } else { Role::Faint },
            lines,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{DEFAULT, Theme};

    const WIDE: [usize; 4] = [40; 4];

    #[test]
    fn layout_matches_the_prototype_defaults() {
        let l = Layout::new(64.0);
        assert_eq!(l.x, [10.0, 74.0, 106.0, 138.0]);
        assert_eq!(l.bw, 170);
        assert_eq!(l.bh, 22);
        let s = Scene::live(Tune::default());
        assert_eq!(s.size(3.0, 1.0), (526.0, 142.0));
        assert_eq!(s.size(6.0, 2.0), (1052.0, 284.0));
    }

    /// The port against `src/features/wired/scene.ts`: every number constant there, the
    /// wires `buildWires` makes (ends, dip and length, at a few clocks) and where `restFor`
    /// rests beads. A change on the web side fails here until the box follows.
    #[test]
    fn matches_the_web_scene() {
        use crate::webts;
        const FILE: &str = "src/features/wired/scene.ts";
        let src = webts::read(FILE);
        let web = webts::consts(&src);
        let (v, l) = (Tune::default(), Layout::new(Tune::default().spacing));
        let near = |a: f64, b: f64| (a - b).abs() < 1e-4;

        for (name, &theirs) in &web {
            let ours: f64 = match name.as_str() {
                "SPACING" => v.spacing.into(),
                "SAG" => v.sag.into(),
                "SWAY_AMP" => v.sway_amp.into(),
                "SWAY_HZ" => v.sway_speed.into(),
                "POLE_TONE" => v.pole_tone.into(),
                "IDLE" => v.idle.into(),
                "TINT" => v.tint.into(),
                "PULSE_SPEED" => v.pulse_speed.into(),
                "PULSE_LEN" => v.pulse_len.into(),
                "GLOW" => v.glow.into(),
                "TRAVEL" => v.travel.into(),
                "BLINK" => v.blink.into(),
                "DUTY" => v.duty.into(),
                "SOFT" => v.soft.into(),
                "MAX_BEADS" => MAX_BEADS as f64,
                "POLE_H" => POLE_H.into(),
                "TOP" => TOP.into(),
                "TAIL" => TAIL.into(),
                "DEEP" => DEEP.into(),
                "K" => K.into(),
                "CK" => K.cosh().into(),
                "BW" => l.bw.into(),
                "BH" => l.bh.into(),
                "X[0]" => l.x[0].into(),
                "X[1]" => l.x[1].into(),
                "X[2]" => l.x[2].into(),
                "X[3]" => l.x[3].into(),
                other => {
                    panic!("{FILE} has `{other} = {theirs}`, which the box doesn't port: add it to scene.rs and here")
                }
            };
            assert!(
                near(ours, theirs),
                "{FILE}: {name} is {theirs} on the web, {ours} in the box"
            );
        }
        for name in [
            "SPACING",
            "SAG",
            "POLE_H",
            "TOP",
            "TAIL",
            "DEEP",
            "X[3]",
            "BW",
            "BH",
            "MAX_BEADS",
        ] {
            assert!(
                web.contains_key(name),
                "{FILE} no longer has a `const {name} = …` the test can read"
            );
        }

        /* buildWires: its own consts, X destructured, then one `name: mk(...)` line per wire. */
        let body = webts::block(&src, "function buildWires(", "}");
        let after = |marker: &str| -> &str {
            let line = body
                .lines()
                .find(|ln| ln.contains(marker))
                .unwrap_or_else(|| panic!("{FILE}: no `{marker}` in buildWires"));
            line.split_once(marker).unwrap().1.trim().trim_end_matches([';', ','])
        };
        let sway_expr = after("const sway = (ph: number) => ");
        let dip_expr = after("dip: ");
        let default_k: f64 = after("const mk = (")
            .split_once("k = ")
            .and_then(|(_, r)| r.split(')').next()?.parse().ok())
            .unwrap_or_else(|| panic!("{FILE}: can't read mk's default k"));
        let destructure = after("const [").trim_end_matches(" = X");
        let mut local = web.clone();
        for (i, n) in destructure.trim_end_matches(']').split(", ").enumerate() {
            local.insert(n.to_string(), web[&format!("X[{i}]")]);
        }
        for ln in body.lines().map(str::trim) {
            if let Some((n, e)) = ln.strip_prefix("const ").and_then(|r| r.split_once(" = ")) {
                if let Some(x) = webts::eval(e.trim_end_matches(';'), &|k| local.get(k).copied()) {
                    local.insert(n.to_string(), x);
                }
            }
        }
        let names = [
            ("in1", W::In1),
            ("in2", W::In2),
            ("ab1", W::Ab1),
            ("ab2", W::Ab2),
            ("bd", W::Bd),
            ("bb", W::Bb),
            ("done1", W::Done1),
            ("done2", W::Done2),
        ];
        let mut wires = 0;
        for ln in body.lines().map(str::trim) {
            let Some((name, args)) = ln.split_once(": mk(") else {
                continue;
            };
            let w = names
                .iter()
                .find(|(n, _)| *n == name)
                .unwrap_or_else(|| panic!("{FILE} has a wire `{name}` the box doesn't"))
                .1;
            let args: Vec<f64> = webts::split_args(args.trim_end_matches("),"))
                .iter()
                .map(|a| {
                    webts::eval(a, &|k| local.get(k).copied())
                        .unwrap_or_else(|| panic!("{FILE}: can't read `{a}` in wire {name}"))
                })
                .collect();
            let (x0, y0, x1, y1, ph) = (args[0], args[1], args[2], args[3], args[4]);
            let k = args.get(5).copied().unwrap_or(default_k);
            for clock in [0.0, 0.7, 2.9] {
                let env = |n: &str| match n {
                    "x0" => Some(x0),
                    "x1" => Some(x1),
                    "k" => Some(k),
                    "ph" => Some(ph),
                    "clock" => Some(clock),
                    _ => local.get(n).copied(),
                };
                let sway = |f: &str, a: &[f64]| {
                    (f == "sway").then(|| webts::eval(sway_expr, &|n| if n == "ph" { Some(a[0]) } else { env(n) }))?
                };
                let dip = webts::eval_with(dip_expr, &env, &sway)
                    .unwrap_or_else(|| panic!("{FILE}: can't read `{dip_expr}`"));
                let ours = build_wires(&l, &v, clock as f32)[w as usize];
                let pairs = [
                    ("x0", ours.x0, x0),
                    ("y0", ours.y0, y0),
                    ("x1", ours.x1, x1),
                    ("y1", ours.y1, y1),
                    ("dip", ours.dip, dip),
                    ("len", ours.len, (x1 - x0).hypot(y1 - y0)),
                ];
                for (what, ours, theirs) in pairs {
                    assert!(
                        near(ours.into(), theirs),
                        "{FILE}: wire {name} {what} at clock {clock} is {theirs} on the web, {ours} in the box"
                    );
                }
            }
            wires += 1;
        }
        assert_eq!(
            wires,
            names.len(),
            "{FILE}: buildWires has {wires} wires, the box {}",
            names.len()
        );

        /* restFor: where the i-th resting bead of a pole sits. Doing alternates its two
        wires, so its i-th bead is the (i/2)-th on its slot's wire in the box. */
        let rest = webts::block(&src, "function restFor(", "}");
        let t_of = |pole: &str| -> &str {
            let ln = rest
                .lines()
                .find(|ln| ln.contains(&format!("pole === \"{pole}\"")))
                .unwrap_or_else(|| panic!("{FILE}: restFor has no line for {pole}"));
            ln.split_once("t: ").unwrap().1.trim_end_matches(" };").trim()
        };
        for i in 0..MAX_BEADS {
            let at = |pole: &str| {
                webts::eval(t_of(pole), &|n| (n == "i").then_some(i as f64))
                    .unwrap_or_else(|| panic!("{FILE}: can't read restFor's {pole} line"))
            };
            for (pole, ours) in [
                ("todo", queue_t(i)),
                ("doing", doing_t(i / 2)),
                ("blocked", blocked_t(i)),
            ] {
                assert!(
                    near(ours.into(), at(pole)),
                    "{FILE}: restFor({pole}, {i}) is {} on the web, {ours} in the box",
                    at(pole)
                );
            }
        }
    }

    #[test]
    fn a_wire_hangs_lowest_in_the_middle() {
        assert!((dip_shape(0.0)).abs() < 1e-6);
        assert!((dip_shape(1.0)).abs() < 1e-6);
        assert!((dip_shape(0.5) - 1.0).abs() < 1e-6);
        let w = build_wires(&Layout::new(64.0), &Tune::default(), 0.0)[W::Ab1 as usize];
        assert_eq!(w.at(0.0), (19.0, 7.0));
        assert!(w.at(0.5).1 > 7.0);
        /* The long span to done hangs under blocked's lower arm, above its foot. */
        let l = Layout::new(64.0);
        let bd = build_wires(&l, &Tune::default(), 0.0)[W::Bd as usize];
        let under = (l.x[2] + 5.0 - bd.x0) / (bd.x1 - bd.x0);
        let y = bd.at(under).1;
        assert!(y > (TOP + 8) as f32 && y < (TOP + POLE_H) as f32, "{y}");
    }

    #[test]
    fn the_demo_moves_items_through() {
        let th = Theme::named(DEFAULT).unwrap();
        let mut s = Scene::demo(Tune::default(), 7);
        assert_eq!(s.working(), 1);
        assert_eq!(s.blocked(), 1);
        let mut finished = false;
        for f in 0..(60 * 60) {
            s.step(f as f64 / 60.0);
            finished |= s.done_count != Some(3) || s.blocked() != 1;
        }
        assert!(finished, "a minute of demo should finish something");
        assert!(!s.draw(th).runs(th.surface).is_empty());
    }

    fn run(s: &mut Scene, board: &Board, from: usize, to: usize) {
        for f in from..to {
            s.sync(board);
            s.step(f as f64 / 60.0);
        }
    }

    fn doing(key: &str, live: bool) -> Doing {
        Doing {
            key: key.into(),
            agent: "dev".into(),
            started: live.then_some(0.5),
            live,
        }
    }

    #[test]
    fn live_items_follow_the_board() {
        let mut s = Scene::live(Tune::default());
        let mut board = Board {
            todo: vec!["A-1".into(), "A-2".into()],
            ready: true,
            ..Default::default()
        };
        run(&mut s, &board, 0, 120);
        assert_eq!(s.queued(), 2);
        board.todo = vec!["A-2".into()];
        board.doing = vec![doing("A-1", true)];
        run(&mut s, &board, 120, 600);
        assert_eq!(s.working(), 1);
        assert_eq!(s.queued(), 1);
        let cols = s.columns(WIDE);
        assert_eq!(cols[1].lines[0].0[0].text, "A-1");
        board.doing.clear();
        run(&mut s, &board, 600, 700);
        assert_eq!(s.working(), 0);
        assert_eq!(s.items.len(), 1);
    }

    #[test]
    fn the_first_board_is_placed_and_later_moves_travel() {
        let mut s = Scene::live(Tune::default());
        let mut board = Board {
            todo: vec!["A-1".into()],
            doing: vec![doing("A-2", true), doing("A-3", false)],
            blocked: vec![("A-4".into(), "dev".into())],
            done: Some(vec![("A-5".into(), -60.0)]),
            done_count: Some(1),
            done_window: 86_400.0,
            ready: true,
            ..Default::default()
        };
        s.sync(&board);
        s.step(0.0);
        /* Nothing travels on the first board: it is how things already were. */
        assert!(
            !s.items
                .iter()
                .any(|i| matches!(i.state, State::Arriving | State::Picking | State::Leaving))
        );
        assert_eq!((s.queued(), s.working(), s.blocked()), (1, 1, 1));
        let cols = s.columns(WIDE);
        assert_eq!(cols[3].lines[0].0[0].text, "✓ A-5");
        /* An idle doing item has no timer and doesn't count as working. */
        assert_eq!(cols[1].lines[1].0.len(), 2);
        assert_eq!(cols[1].lines[1].0[0].role, Role::Muted);

        /* A-2 is done: it climbs, and is listed once it gets there. */
        board.doing.remove(0);
        board.done = Some(vec![("A-2".into(), 1.0), ("A-5".into(), -60.0)]);
        board.done_count = Some(2);
        s.sync(&board);
        assert!(s.items.iter().any(|i| i.key == "A-2" && i.leaving_to(Outcome::Done)));
        assert_eq!(s.columns(WIDE)[3].lines.len(), 1);
        assert!(s.moving());
        run(&mut s, &board, 1, 600);
        assert!(!s.items.iter().any(|i| i.key == "A-2"));
        assert_eq!(s.columns(WIDE)[3].lines[0].0[0].text, "✓ A-2");
        assert_eq!(s.status().last().unwrap().0[1].text, " 2");

        /* The blocked one is answered and goes back to todo. */
        board.blocked.clear();
        board.todo.push("A-4".into());
        s.sync(&board);
        assert!(s.items.iter().any(|i| i.key == "A-4" && i.state == State::Returning));
        run(&mut s, &board, 600, 1200);
        assert_eq!(s.queued(), 2);
        assert!(!s.moving());
    }

    #[test]
    fn a_todo_item_can_go_straight_to_blocked_or_done() {
        let mut s = Scene::live(Tune::default());
        let mut board = Board {
            todo: vec!["A-1".into(), "A-2".into()],
            done: Some(Vec::new()),
            ready: true,
            ..Default::default()
        };
        run(&mut s, &board, 0, 60);
        board.todo.clear();
        board.blocked = vec![("A-1".into(), "dev".into())];
        board.done = Some(vec![("A-2".into(), 1.0)]);
        run(&mut s, &board, 60, 900);
        assert_eq!(s.blocked(), 1);
        assert_eq!(s.queued(), 0);
        assert_eq!(s.done_log.len(), 1);
        assert!(!s.moving());
    }

    #[test]
    fn without_motion_nothing_travels() {
        let mut s = Scene::live(Tune::default());
        s.motion = false;
        let mut board = Board {
            todo: vec!["A-1".into()],
            ready: true,
            ..Default::default()
        };
        run(&mut s, &board, 0, 2);
        board.todo.clear();
        board.doing = vec![doing("A-1", true)];
        s.sync(&board);
        s.step(0.1);
        assert_eq!(s.working(), 1);
        assert!(!s.moving());
        assert!(!s.ambient());
        assert!(s.ticking());
    }

    #[test]
    fn lines_link_to_their_board() {
        let mut s = Scene::live(Tune::default());
        s.sync(&Board {
            todo: vec!["COPL-7".into()],
            links: vec![("COPL-7".into(), "http://x/b/COPL?task=COPL-7".into())],
            ready: true,
            ..Default::default()
        });
        assert_eq!(
            s.columns(WIDE)[0].lines[0].1.as_deref(),
            Some("http://x/b/COPL?task=COPL-7")
        );
    }

    #[test]
    fn narrow_lists_drop_the_timer_then_the_agent() {
        let mut s = Scene::live(Tune::default());
        let b = Board {
            doing: vec![doing("COPL-12", true)],
            blocked: vec![("COPL-13".into(), "reviewer".into())],
            ready: true,
            ..Default::default()
        };
        s.sync(&b);
        s.step(1.0);
        let text = |c: &Column| c.lines[0].0.iter().map(|s| s.text.as_str()).collect::<String>();
        let wide = s.columns(WIDE);
        assert_eq!(text(&wide[1]), "COPL-12 dev 0m00");
        assert_eq!(text(&wide[2]), "▲ COPL-13 reviewer");
        let narrow = s.columns([10, 12, 10, 10]);
        assert_eq!(text(&narrow[1]), "COPL-12 dev");
        assert_eq!(text(&narrow[2]), "▲ COPL-13");
        assert_eq!(text(&s.columns([3; 4])[1]), "COPL-12");
    }

    #[test]
    fn caps_long_lists() {
        let mut s = Scene::live(Tune::default());
        s.sync(&Board {
            todo: (1..=6).map(|n| format!("T-{n}")).collect(),
            ..Default::default()
        });
        let todo = &s.columns(WIDE)[0];
        assert_eq!(todo.lines.len(), LINES);
        assert_eq!(todo.lines[3].0[0].text, "+3 more");
        assert_eq!(todo.head_role, Role::Blue);
    }

    #[test]
    fn quiet_says_so() {
        let mut s = Scene::live(Tune::default());
        s.sync(&Board {
            quiet: Some("no daemon.toml".into()),
            ..Default::default()
        });
        assert_eq!(s.status()[0].0[0].text, "nothing on the wire");
    }

    #[test]
    fn formats_like_the_prototype() {
        assert_eq!(fmt(134.9), "2m14");
        assert_eq!(fmt(5.0), "0m05");
        assert_eq!(fmt(3900.0), "1h05");
    }

    #[test]
    fn the_status_line_says_quietly_whether_changes_arrive_live() {
        let mut s = Scene::live(Tune::default());
        let board = |live| Board {
            ready: true,
            live,
            ..Default::default()
        };
        let texts = |s: &Scene| -> Vec<String> {
            s.status()
                .iter()
                .flat_map(|l| l.0.iter().map(|sp| sp.text.to_string()))
                .collect()
        };
        s.sync(&board(None));
        assert!(!texts(&s).iter().any(|t| t.contains('•') || t.contains("polling")));
        s.sync(&board(Some(true)));
        assert_eq!(texts(&s).last().unwrap(), "•");
        s.sync(&board(Some(false)));
        assert_eq!(texts(&s).last().unwrap(), "◦ polling");
    }
}
