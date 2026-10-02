//! The wired scene, ported from the design reference
//! (`docs/research/wired-prototype.html`): its geometry, its default tuning,
//! and its per-frame update, kept as close to the prototype's code as Rust
//! allows so the two can be read side by side. Nothing here knows GPUI: the
//! scene draws into a small RGB raster at one cell per logo pixel and lists
//! its text as spans; `view.rs` puts both on screen.
//!
//! Items move along wires: in from the left to the todo pole, queued on the
//! wire to doing, picked up there by a run (current flows along its wire while
//! it works), and out by one of two branches from the doing pole: the upper
//! climbs to done and runs off the edge, the lower drops to blocked and waits.

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
            spacing: 54.0,
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
pub const TOPD: i32 = 4;
pub const TOPM: i32 = 21;
pub const TOPB: i32 = 38;
pub const BH: i32 = TOPB + POLE_H + 2;
/// Room right of the poles for the done and blocked lists, in screen pixels.
pub const TEXT_W: f32 = 150.0;
/// Lines under the todo and doing poles.
pub const LINES: usize = 4;

/// JS `Math.round`: halves go up.
fn round(x: f32) -> i32 {
    (x + 0.5).floor() as i32
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    /// The three pole columns: todo, doing, done/blocked.
    pub x: [f32; 3],
    /// The raster's width and height, in logo pixels.
    pub bw: i32,
    pub bh: i32,
}

impl Layout {
    pub fn new(spacing: f32) -> Self {
        let x = [10.0, 10.0 + spacing, 10.0 + 2.0 * spacing];
        Self {
            x,
            bw: x[2] as i32 + 10 + round(spacing * 0.45),
            bh: BH,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum W {
    In1,
    In2,
    Ab1,
    Ab2,
    Bd,
    Bb,
    Done1,
    Done2,
    Blk1,
    Blk2,
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

/// The ten wires at `clock`, swaying.
pub fn build_wires(l: &Layout, v: &Tune, clock: f32) -> [Wire; 10] {
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
    let [a, b, c] = l.x;
    let e = (l.bw + 8) as f32;
    [
        mk(-8.0, TOPM + 6, a, TOPM + 3, 0.4, 1.0),
        mk(-8.0, TOPM + 12, a + 2.0, TOPM + 8, 1.1, 1.2),
        mk(a + 9.0, TOPM + 3, b, TOPM + 3, 2.0, 1.0),
        mk(a + 7.0, TOPM + 8, b + 2.0, TOPM + 8, 2.7, 1.25),
        mk(b + 9.0, TOPM + 3, c, TOPD + 3, 3.3, 0.8),
        mk(b + 7.0, TOPM + 8, c, TOPB + 3, 4.1, 0.8),
        mk(c + 9.0, TOPD + 3, e, TOPD + 8, 5.0, 1.0),
        mk(c + 7.0, TOPD + 8, e, TOPD + 13, 5.4, 1.2),
        mk(c + 9.0, TOPB + 3, e, TOPB + 8, 5.7, 1.0),
        mk(c + 7.0, TOPB + 8, e, TOPB + 12, 6.1, 1.2),
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
    /// An answered blocked item, going back to the queue.
    Returning,
    /// Leaving the scene where it is (live: the daemon no longer lists it).
    Fading,
    Gone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Blocked,
}

#[derive(Debug, Clone)]
pub struct Item {
    pub key: String,
    pub state: State,
    route: Vec<(W, f32, f32)>,
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
    qt: Option<f32>,
    flashed: bool,
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
        }
    }

    fn is_todo(&self) -> bool {
        matches!(self.state, State::Queued | State::Arriving)
    }

    fn is_doing(&self) -> bool {
        matches!(self.state, State::Working | State::Picking)
    }

    fn is_blocked(&self) -> bool {
        self.state == State::Blocked || (self.state == State::Leaving && self.outcome == Some(Outcome::Blocked))
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

/// What the scene is told, each frame, in live mode: the daemon's view of the wire.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Board {
    pub agents: Vec<AgentLabel>,
    /// Task keys waiting, oldest first.
    pub todo: Vec<String>,
    /// (task key, agent name, scene seconds when the run started).
    pub doing: Vec<(String, String, f64)>,
    /// (task key, agent name). Empty until the box reads stages from Copland.
    pub blocked: Vec<(String, String)>,
    /// Shown instead of the agents when there is nothing to watch.
    pub quiet: Option<String>,
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
    pub wires: [Wire; 10],
    pub items: Vec<Item>,
    /// Animation time: sway, pulses, blinking.
    pub clock: f64,
    /// Scene time, seconds since the scene began.
    pub now: f64,
    last: f64,
    pub flash_done: f32,
    pub done_log: Vec<(String, f64)>,
    /// Known only in the demo.
    pub done_count: Option<u32>,
    pub agents: Vec<AgentLabel>,
    pub quiet: Option<String>,
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
            agents: Vec::new(),
            quiet: None,
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
        bl.wire = W::Blk1;
        bl.t = 0.35;
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
            b.state = State::Returning;
            b.route = vec![(W::Blk1, b.t, 0.0), (W::Bb, 1.0, 0.0)];
            b.seg = 0;
            b.p = 0.0;
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

    fn finish(&mut self, ix: usize, outcome: Outcome) {
        let blocked = self.items.iter().filter(|i| i.state == State::Blocked).count() as f32;
        let it = &mut self.items[ix];
        it.state = State::Leaving;
        it.outcome = Some(outcome);
        it.route = match outcome {
            Outcome::Done => vec![(W::Bd, 0.0, 1.0), (W::Done1, 0.0, 1.0)],
            Outcome::Blocked => vec![(W::Bb, 0.0, 1.0), (W::Blk1, 0.0, (0.35 + 0.17 * blocked).min(0.85))],
        };
        it.seg = 0;
        it.p = 0.0;
    }

    fn queue_targets(&mut self) {
        for (i, it) in self.items.iter_mut().filter(|i| i.state == State::Queued).enumerate() {
            it.qt = Some((0.7 - i as f32 * 0.2).max(0.12));
        }
    }

    fn free_slot(&self) -> Option<usize> {
        let used: Vec<usize> = self
            .items
            .iter()
            .filter(|i| i.is_doing())
            .filter_map(|i| i.slot)
            .collect();
        [0, 1].into_iter().find(|s| !used.contains(s))
    }

    /// Move along the route; true once at its end.
    fn advance(wires: &[Wire; 10], travel: f32, it: &mut Item, dt: f32) -> bool {
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
                return true;
            }
        }
        let (wn2, a2, b2) = it.route[it.seg];
        it.wire = wn2;
        it.t = a2 + (b2 - a2) * it.p;
        false
    }

    /// Bring the items in line with what the daemon says (live mode).
    pub fn sync(&mut self, board: &Board) {
        self.agents = board.agents.clone();
        self.quiet = board.quiet.clone();
        let doing_keys: Vec<&str> = board.doing.iter().map(|d| d.0.as_str()).collect();
        let todo: Vec<&str> = board
            .todo
            .iter()
            .map(String::as_str)
            .filter(|k| !doing_keys.contains(k))
            .collect();
        let blocked: Vec<&str> = board.blocked.iter().map(|b| b.0.as_str()).collect();

        for key in &todo {
            if !self.items.iter().any(|i| i.key == *key && i.state != State::Fading) {
                self.spawn(key);
            }
        }
        for (key, agent, started) in &board.doing {
            let free = self.free_slot();
            let existing = self
                .items
                .iter()
                .position(|i| i.key == *key && i.state != State::Fading);
            let ix = match existing {
                Some(ix) => ix,
                None => {
                    let mut it = Item::new(key, State::Queued);
                    it.wire = W::Ab1;
                    it.t = 0.12;
                    self.items.push(it);
                    self.items.len() - 1
                }
            };
            let it = &mut self.items[ix];
            if !it.is_doing() {
                let slot = free.unwrap_or(0);
                let ab = if slot == 0 { W::Ab1 } else { W::Ab2 };
                it.route = if it.state == State::Arriving {
                    vec![(W::In1, it.t, 1.0), (ab, 0.0, 1.0)]
                } else {
                    vec![(
                        ab,
                        if it.wire == W::Ab1 || it.wire == W::Ab2 {
                            it.t
                        } else {
                            0.0
                        },
                        1.0,
                    )]
                };
                it.state = State::Picking;
                it.seg = 0;
                it.p = 0.0;
                it.slot = Some(slot);
            }
            it.agent = Some(agent.clone());
            it.started = *started;
            it.started_known = true;
        }
        for key in &blocked {
            if !self.items.iter().any(|i| i.key == *key && i.is_blocked()) {
                if let Some(ix) = self.items.iter().position(|i| i.key == *key && i.is_doing()) {
                    self.finish(ix, Outcome::Blocked);
                } else {
                    let mut it = Item::new(key, State::Blocked);
                    it.wire = W::Blk1;
                    it.t = 0.35;
                    it.agent = board.blocked.iter().find(|b| b.0 == *key).map(|b| b.1.clone());
                    self.items.push(it);
                }
            }
        }
        for it in &mut self.items {
            let listed = match it.state {
                State::Arriving | State::Queued => todo.contains(&it.key.as_str()),
                State::Picking | State::Working => doing_keys.contains(&it.key.as_str()),
                State::Blocked => blocked.contains(&it.key.as_str()),
                _ => true,
            };
            if !listed {
                it.state = State::Fading;
            }
        }
    }

    /// One frame of the prototype's loop, at `now` seconds.
    pub fn step(&mut self, now: f64) {
        let dt = (now - self.last).clamp(0.0, 0.05);
        self.last = now;
        self.now = now;
        let sdt = dt as f32;
        self.clock += dt;
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
        let mut i = 0;
        while i < self.items.len() {
            let mut ends: Option<Outcome> = None;
            let wires = &self.wires;
            let it = &mut self.items[i];
            match it.state {
                State::Arriving => {
                    if Self::advance(wires, v.travel, it, sdt) {
                        it.state = State::Queued;
                        it.wire = W::Ab1;
                        it.t = 0.0;
                    }
                }
                State::Queued => {
                    let qt = it.qt.unwrap_or(0.5);
                    it.t += (qt - it.t) * (1.0 - (-sdt * v.travel / 12.0).exp());
                }
                State::Picking => {
                    if Self::advance(wires, v.travel, it, sdt) {
                        it.state = State::Working;
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
                    }
                }
                State::Leaving => {
                    if Self::advance(wires, v.travel, it, sdt) {
                        if it.outcome == Some(Outcome::Done) {
                            it.state = State::Gone;
                            let key = it.key.clone();
                            if let Some(n) = &mut self.done_count {
                                *n += 1;
                            }
                            self.done_log.insert(0, (key, now));
                            self.done_log.truncate(6);
                        } else {
                            it.state = State::Blocked;
                        }
                    } else if it.outcome == Some(Outcome::Done) && it.wire == W::Done1 {
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
                        it.wire = W::Ab1;
                        it.t = 0.9;
                        it.qt = Some(0.9);
                        let it = self.items.remove(i);
                        self.items.insert(0, it);
                        break;
                    }
                }
                State::Fading => {
                    it.alpha -= sdt / 0.8;
                    if it.alpha <= 0.0 {
                        it.state = State::Gone;
                    }
                }
                State::Blocked | State::Gone => {}
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
                    it.state = State::Picking;
                    it.slot = Some(slot);
                    it.agent = Some(agent.to_string());
                    it.route = vec![(if slot == 0 { W::Ab1 } else { W::Ab2 }, it.t, 1.0)];
                    it.seg = 0;
                    it.p = 0.0;
                }
            }
        }
        self.flash_done = (self.flash_done - sdt * 0.8).max(0.0);
    }

    fn blink_level(&self) -> f32 {
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

    pub fn working(&self) -> usize {
        self.items.iter().filter(|i| i.state == State::Working).count()
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
            if !self
                .items
                .iter()
                .any(|i| i.state == State::Working && i.slot == Some(slot))
            {
                return 0.0;
            }
            let l = self.wire(if slot == 0 { W::Ab1 } else { W::Ab2 }).len;
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
        self.draw_wire(&mut r, self.wire(W::Blk1), tinted(th.red), 0.0, cur);
        self.draw_wire(&mut r, self.wire(W::Blk2), tinted(th.red), 0.0, cur);

        let bl = self.blink_level();
        let x = self.layout.x;
        let lit = |b: bool| if b { 1.0 } else { 0.0 };
        self.draw_pole(&mut r, th, x[0], TOPM, th.blue, lit(self.queued() > 0));
        let doing = if self.working() > 0 {
            0.85 + 0.15 * (clock * 7.0).sin()
        } else {
            0.0
        };
        self.draw_pole(&mut r, th, x[1], TOPM, th.yellow, doing);
        self.draw_pole(&mut r, th, x[2], TOPD, th.green, self.flash_done);
        self.draw_pole(
            &mut r,
            th,
            x[2],
            TOPB,
            th.red,
            if self.blocked() > 0 { bl } else { 0.0 },
        );

        for it in &self.items {
            let (bx, by) = self.wire(it.wire).at(it.t);
            let mut a = it.alpha;
            if it.state == State::Blocked {
                a *= 0.45 + 0.55 * bl;
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

    /// The four lists: todo and doing under their poles, done and blocked beside theirs.
    pub fn columns(&self) -> [Column; 4] {
        let now = self.now;
        let cap = |mut lines: Vec<Line>, max: usize| {
            if lines.len() > max {
                let more = lines.len() - max + 1;
                lines.truncate(max - 1);
                lines.push(Line::one(format!("+{more} more"), Role::Muted));
            }
            lines
        };
        let todo = self
            .items
            .iter()
            .filter(|i| i.is_todo())
            .map(|i| Line::one(i.key.clone(), Role::Blue))
            .collect();
        let mut doing: Vec<&Item> = self.items.iter().filter(|i| i.is_doing()).collect();
        doing.sort_by_key(|i| i.slot);
        let doing = doing
            .into_iter()
            .map(|i| {
                let elapsed = if i.state == State::Working || i.started_known {
                    fmt(now - i.started)
                } else {
                    "…".into()
                };
                Line(vec![
                    Span::new(format!("{} ", i.key), Role::Ink),
                    Span::new(format!("{} ", i.agent.as_deref().unwrap_or("")), Role::Yellow),
                    Span::new(elapsed, Role::Muted),
                ])
            })
            .collect();
        let blocked = self
            .items
            .iter()
            .filter(|i| i.is_blocked())
            .map(|i| {
                Line(vec![
                    Span::new(format!("▲ {} ", i.key), Role::Red),
                    Span::new(i.agent.clone().unwrap_or_default(), Role::Muted),
                ])
            })
            .collect();
        let done = self
            .done_log
            .iter()
            .filter(|(_, at)| now - at < 30.0)
            .map(|(key, at)| {
                let mut l = Line::one(format!("✓ {key}"), Role::Green);
                l.0[0].alpha = (1.0 - (now - at) as f32 / 30.0).max(0.3);
                l
            })
            .collect();
        [
            Column::new("todo", Role::Blue, self.queued() > 0, cap(todo, LINES)),
            Column::new("doing", Role::Yellow, self.working() > 0, cap(doing, LINES)),
            Column::new("done", Role::Green, self.flash_done > 0.2, cap(done, 3)),
            Column::new("blocked", Role::Red, self.blocked() > 0, cap(blocked, 3)),
        ]
    }

    /// The status line under the scene.
    pub fn status(&self) -> Vec<Line> {
        if let Some(q) = &self.quiet {
            return vec![Line(vec![
                Span::new("nothing on the wire", Role::Muted),
                Span::new(format!("  {q}"), Role::Faint),
            ])];
        }
        let now = self.now;
        let mut parts: Vec<Line> = self
            .agents
            .iter()
            .map(|a| {
                let w = self
                    .items
                    .iter()
                    .find(|i| i.state == State::Working && i.agent.as_deref() == Some(&a.name));
                match (w, &a.error) {
                    (Some(w), _) => Line(vec![
                        Span::new(format!("{} ", a.name), Role::Muted),
                        Span::new("●", Role::Yellow),
                        Span::new(format!(" {} {}", w.key, fmt(now - w.started)), Role::Muted),
                    ]),
                    (None, Some(e)) => Line(vec![
                        Span::new(format!("{} ", a.name), Role::Muted),
                        Span::new(format!("× {e}"), Role::Red),
                    ]),
                    (None, None) if a.stopped => Line::one(format!("{} stopped", a.name), Role::Faint),
                    (None, None) => Line::one(format!("{} ○", a.name), Role::Muted),
                }
            })
            .collect();
        parts.push(Line(vec![
            Span::new(self.queued().to_string(), Role::Blue),
            Span::new(" todo", Role::Muted),
        ]));
        let blocked: Vec<&str> = self
            .items
            .iter()
            .filter(|i| i.state == State::Blocked)
            .map(|i| i.key.as_str())
            .collect();
        if !blocked.is_empty() {
            parts.push(Line(vec![
                Span::new("▲", Role::Red),
                Span::new(format!(" {}", blocked.join(" ")), Role::Muted),
            ]));
        }
        if let Some(n) = self.done_count {
            parts.push(Line(vec![
                Span::new("✓", Role::Green),
                Span::new(format!(" {n}"), Role::Muted),
            ]));
        }
        parts
    }

    /// "1 doing · 1 need you", beside the title.
    pub fn count(&self) -> String {
        format!("{} doing · {} need you", self.working(), self.blocked())
    }

    /// The box's scene area in screen pixels at `cell` pixels per logo pixel.
    pub fn size(&self, cell: f32) -> (f32, f32) {
        let l = &self.layout;
        let list_top = (TOPM + POLE_H) as f32 * cell + 2.0;
        (
            l.bw as f32 * cell + TEXT_W,
            (l.bh as f32 * cell + 6.0).max(list_top + 20.0 + LINES as f32 * 15.0),
        )
    }
}

/// Minutes and seconds, "2m14".
pub fn fmt(secs: f64) -> String {
    let s = secs.max(0.0).floor() as u64;
    format!("{}m{:02}", s / 60, s % 60)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    pub text: String,
    pub role: Role,
    pub alpha: f32,
}

impl Span {
    fn new(text: impl Into<String>, role: Role) -> Self {
        Self {
            text: text.into(),
            role,
            alpha: 1.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Line(pub Vec<Span>);

impl Line {
    fn one(text: impl Into<String>, role: Role) -> Self {
        Self(vec![Span::new(text, role)])
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

    #[test]
    fn layout_matches_the_prototype_defaults() {
        let l = Layout::new(54.0);
        assert_eq!(l.x, [10.0, 64.0, 118.0]);
        assert_eq!(l.bw, 152);
        assert_eq!(l.bh, 56);
        let s = Scene::live(Tune::default());
        assert_eq!(s.size(3.0), (606.0, 193.0));
    }

    #[test]
    fn a_wire_hangs_lowest_in_the_middle() {
        assert!((dip_shape(0.0)).abs() < 1e-6);
        assert!((dip_shape(1.0)).abs() < 1e-6);
        assert!((dip_shape(0.5) - 1.0).abs() < 1e-6);
        let w = build_wires(&Layout::new(54.0), &Tune::default(), 0.0)[W::Ab1 as usize];
        assert_eq!(w.at(0.0), (19.0, 24.0));
        assert!(w.at(0.5).1 > 24.0);
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

    #[test]
    fn live_items_follow_the_board() {
        let mut s = Scene::live(Tune::default());
        let mut board = Board {
            todo: vec!["A-1".into(), "A-2".into()],
            ..Default::default()
        };
        s.sync(&board);
        for f in 0..120 {
            s.step(f as f64 / 60.0);
        }
        assert_eq!(s.queued(), 2);
        board.todo = vec!["A-1".into(), "A-2".into()];
        board.doing = vec![("A-1".into(), "dev".into(), 0.5)];
        s.sync(&board);
        for f in 120..600 {
            s.step(f as f64 / 60.0);
        }
        assert_eq!(s.working(), 1);
        assert_eq!(s.queued(), 1);
        let cols = s.columns();
        assert_eq!(cols[1].lines[0].0[0].text, "A-1 ");
        board.doing.clear();
        board.todo = vec!["A-2".into()];
        s.sync(&board);
        for f in 600..700 {
            s.step(f as f64 / 60.0);
        }
        assert_eq!(s.working(), 0);
        assert_eq!(s.items.len(), 1);
    }

    #[test]
    fn caps_long_lists() {
        let mut s = Scene::live(Tune::default());
        s.sync(&Board {
            todo: (1..=6).map(|n| format!("T-{n}")).collect(),
            ..Default::default()
        });
        let todo = &s.columns()[0];
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
    }
}
