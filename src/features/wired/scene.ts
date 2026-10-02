/* ============================================================================
   The /wired scene: four utility poles on a canvas, drawn in logo pixels
   (the 16-unit grid of src/ui/LogoMark.tsx) and scaled up whole, so every
   pixel stays square. The design is docs/research/wired-prototype.html,
   with its tuned values fixed below.

     todo ──── doing ── blocked    done ──  (off the edge)
                    ╲_____________╱
                     (deep span, under blocked's arms)

   All four poles stand on one ground line, blocked half a span past doing
   and done a whole span past it. Doing forks by span, not by height: a
   short wire from its upper arm to blocked, and a long one from its lower
   arm that sags deep, passes under blocked's arms and rises to done.

   Work is a bead on the wires, in its stage hue. Waiting ones queue on the
   wire into doing; a live run's sits at the doing pole while current pulses
   along its wire; finished ones ride the deep span to done and fade off the
   edge; blocked ones take the short wire and wait by the blocked pole,
   blinking. When the data changes,
   setData diffs it by task id and slides each bead that changed pole along
   the wires to its new place. Anything it has no route for is simply put
   where it now belongs.

   Colours are the theme's role variables, read at runtime (readColors), so
   the scene follows the theme like everything else. Without motion
   (prefers-reduced-motion) it is a still picture: no sway, no current, no
   travel, and it is drawn only when something changes.
   ========================================================================== */

/* ---------------------------------------------------------------- tuning -- */

/** The prototype's defaults, kept as they were chosen. */
export const SPACING = 64;
const SAG = 0.08;
const SWAY_AMP = 0.12;
const SWAY_HZ = 0.3;
const POLE_TONE = 0.55;
const IDLE = 0.45;
const TINT = 0.3;
const PULSE_SPEED = 22;
const PULSE_LEN = 6;
const GLOW = 0.35;
const TRAVEL = 22;
const BLINK = 1.2;
const DUTY = 0.35;
const SOFT = 0.3;

/** Beads drawn per pole; the lists say how many more there are. */
const MAX_BEADS = 4;

/* -------------------------------------------------------------- geometry -- */

export const POLE_H = 16;
/** Every pole's top: one ground line, with room above for the lamps. */
export const TOP = 4;
/** Pole left edges, left to right: todo, doing, blocked (half a span on), done (a whole span on). */
export const X = [10, 10 + SPACING, 10 + SPACING + SPACING / 2, 10 + 2 * SPACING] as const;
/** Past the done pole: room for its wires to run off the edge. */
export const TAIL = 22;
/** The scene's size in logo pixels. */
export const BW = X[3] + 10 + TAIL;
export const BH = TOP + POLE_H + 2;
/** How much deeper than SAG the doing-to-done span hangs: under blocked's lower arm, above its foot. */
const DEEP = 1.1;

/* ---------------------------------------------------------------- colour -- */

type RGB = [number, number, number];
const ROLES = ["surface", "ink", "muted", "faint", "blue", "yellow", "red", "green"] as const;
type Role = (typeof ROLES)[number];
export type Colors = Record<Role, RGB>;

/** The theme's role colours as they apply at `el` (the triplets in themes.css). */
export function readColors(el: Element): Colors {
  const style = getComputedStyle(el);
  const out = {} as Colors;
  for (const role of ROLES) {
    const parts = style.getPropertyValue(`--${role}`).trim().split(/[\s,]+/).map(Number);
    out[role] = parts.length === 3 && parts.every(Number.isFinite) ? (parts as RGB) : [128, 128, 128];
  }
  return out;
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

/* ----------------------------------------------------------------- wires -- */

type WireName = "in1" | "in2" | "ab1" | "ab2" | "bd" | "bb" | "done1" | "done2";
interface Wire {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dip: number;
  len: number;
}

/* A catenary's shape, 0 at the ends and 1 in the middle. */
const K = 1.3;
const CK = Math.cosh(K);
const dipShape = (t: number) => (CK - Math.cosh(K * (2 * t - 1))) / (CK - 1);

function buildWires(clock: number): Record<WireName, Wire> {
  const sway = (ph: number) => 1 + SWAY_AMP * Math.sin(clock * SWAY_HZ * 6.283 + ph);
  const mk = (x0: number, y0: number, x1: number, y1: number, ph: number, k = 1): Wire => ({
    x0,
    y0,
    x1,
    y1,
    dip: SAG * Math.abs(x1 - x0) * k * sway(ph),
    len: Math.hypot(x1 - x0, y1 - y0),
  });
  const [a, b, k, c] = X;
  const E = BW + 8;
  return {
    in1: mk(-8, TOP + 6, a, TOP + 3, 0.4),
    in2: mk(-8, TOP + 12, a + 2, TOP + 8, 1.1, 1.2),
    ab1: mk(a + 9, TOP + 3, b, TOP + 3, 2.0),
    ab2: mk(a + 7, TOP + 8, b + 2, TOP + 8, 2.7, 1.25),
    /* The short span, upper arm to upper arm: doing to blocked. */
    bb: mk(b + 9, TOP + 3, k, TOP + 3, 4.1),
    /* The long span, lower arm to lower arm, hanging under blocked: doing to done. */
    bd: mk(b + 7, TOP + 8, c + 2, TOP + 8, 3.3, DEEP),
    done1: mk(c + 9, TOP + 3, E, TOP + 8, 5.0),
    done2: mk(c + 7, TOP + 8, E, TOP + 13, 5.4, 1.2),
  };
}

const at = (w: Wire, t: number): [number, number] => [w.x0 + (w.x1 - w.x0) * t, w.y0 + (w.y1 - w.y0) * t + w.dip * dipShape(t)];

/* ----------------------------------------------------------------- beads -- */

export type Pole = "todo" | "doing" | "blocked" | "done";

/** What the scene is told: each pole's task ids in list order. */
export interface SceneData {
  todo: string[];
  /** Live ones (a run holds them) and the rest, which are drawn dimmer. */
  doing: { id: string; live: boolean }[];
  blocked: string[];
  done: string[];
}

/** One leg of a journey: along `wire` from t=a to t=b. */
type Seg = [WireName, number, number];

interface Bead {
  id: string;
  pole: Pole;
  wire: WireName;
  t: number;
  /** Where it rests on its pole, eased towards when not travelling. */
  rest: { wire: WireName; t: number } | null;
  route: Seg[];
  seg: number;
  p: number;
  alpha: number;
  /** A doing bead no run holds. */
  idle: boolean;
  /** Fading out: gone from the data, or riding off past done. */
  leaving: boolean;
  /** Lights the done lamp when it reaches the done pole. */
  flashes: boolean;
}

const HUE: Record<Pole, Role> = { todo: "blue", doing: "yellow", blocked: "red", done: "green" };

const slotWire = (slot: number): WireName => (slot % 2 === 0 ? "ab1" : "ab2");

/** Where the i-th bead of a pole sits, or null for done (it leaves) and for beads past MAX_BEADS. */
function restFor(pole: Pole, i: number): { wire: WireName; t: number } | null {
  if (i >= MAX_BEADS) return null;
  if (pole === "todo") return { wire: "ab1", t: Math.max(0.12, 0.7 - i * 0.2) };
  if (pole === "doing") return { wire: slotWire(i), t: 1 - 0.08 * Math.floor(i / 2) };
  /* Queued back along the short span from the blocked pole. */
  if (pole === "blocked") return { wire: "bb", t: 0.85 - 0.18 * i };
  return null;
}

/* ----------------------------------------------------------------- scene -- */

export class WiredScene {
  private ctx: CanvasRenderingContext2D;
  private colors: Colors;
  private beads = new Map<string, Bead>();
  private knownDone = new Set<string>();
  private first = true;
  private clock = 0;
  private last = 0;
  private frame = 0;
  private flashDone = 0;
  private running = false;
  private visible = true;
  private wires = buildWires(0);

  private motion: boolean;

  constructor(canvas: HTMLCanvasElement, colors: Colors, motion: boolean) {
    this.motion = motion;
    canvas.width = BW;
    canvas.height = BH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2d canvas");
    this.ctx = ctx;
    this.colors = colors;
    this.sync();
  }

  setColors(colors: Colors) {
    this.colors = colors;
    this.redraw();
  }

  setMotion(motion: boolean) {
    this.motion = motion;
    if (!motion) {
      this.clock = 0;
      this.wires = buildWires(0);
      for (const b of [...this.beads.values()]) this.settle(b);
    }
    this.sync();
  }

  /** Paused while scrolled out of view; there is nothing to watch. */
  setVisible(visible: boolean) {
    this.visible = visible;
    this.sync();
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  /* ---------------------------------------------------------- data ---- */

  setData(data: SceneData) {
    const animate = this.motion && !this.first;
    const want = new Map<string, { pole: Pole; i: number; idle: boolean }>();
    data.todo.forEach((id, i) => want.set(id, { pole: "todo", i, idle: false }));
    data.doing.forEach(({ id, live }, i) => want.set(id, { pole: "doing", i, idle: !live }));
    data.blocked.forEach((id, i) => want.set(id, { pole: "blocked", i, idle: false }));

    for (const id of data.done) {
      if (this.knownDone.has(id)) continue;
      this.knownDone.add(id);
      const bead = this.beads.get(id);
      if (!animate) {
        if (bead) this.beads.delete(id);
        continue;
      }
      if (bead && !bead.leaving) this.depart(bead, "done");
      else if (!bead) this.beads.set(id, this.fresh(id, "done", [["done2", 0, 1]]));
    }
    for (const id of [...this.knownDone]) if (!data.done.includes(id) && !want.has(id)) this.knownDone.delete(id);

    for (const [id, bead] of this.beads) {
      if (want.has(id) || bead.pole === "done") continue;
      if (animate) {
        bead.leaving = true;
        bead.rest = null;
      } else this.beads.delete(id);
    }

    for (const [id, { pole, i, idle }] of want) {
      this.knownDone.delete(id);
      const rest = restFor(pole, i);
      let bead = this.beads.get(id);
      if (!bead) {
        if (!rest) continue;
        bead = this.fresh(id, pole, []);
        bead.wire = rest.wire;
        bead.t = rest.t;
        if (animate && pole === "todo") bead.route = [["in1", 0, 1], ["ab1", 0, rest.t]];
        else if (animate && pole === "doing") bead.route = [["in1", 0, 1], [rest.wire, 0, rest.t]];
        if (bead.route.length) [bead.wire, bead.t] = [bead.route[0][0], 0];
        this.beads.set(id, bead);
      }
      bead.idle = idle;
      bead.leaving = false;
      bead.alpha = 1;
      if (!rest) {
        /* Past the beads a pole draws: off the wire, still in the list. */
        this.beads.delete(id);
        continue;
      }
      const from = bead.pole;
      bead.pole = pole;
      bead.rest = rest;
      if (from === pole) continue;
      const route = animate && bead.route.length === 0 ? this.journey(bead, from, rest) : null;
      if (route) {
        bead.route = route;
        bead.seg = 0;
        bead.p = 0;
      } else if (!animate || bead.route.length) this.settle(bead);
    }
    this.first = false;
    this.sync();
  }

  private fresh(id: string, pole: Pole, route: Seg[]): Bead {
    return {
      id,
      pole,
      wire: route[0]?.[0] ?? "ab1",
      t: route[0]?.[1] ?? 0,
      rest: null,
      route,
      seg: 0,
      p: 0,
      alpha: 1,
      idle: false,
      leaving: false,
      flashes: pole === "done",
    };
  }

  /** Off it goes along the deep span to done, from wherever it is. */
  private depart(bead: Bead, to: "done") {
    /* Mid-trip: finish it at once, then leave from there. */
    if (bead.route.length && bead.rest) {
      bead.route = [];
      bead.wire = bead.rest.wire;
      bead.t = bead.rest.t;
    }
    const from = bead.pole;
    bead.pole = to;
    bead.rest = null;
    bead.flashes = true;
    const lead: Seg[] = this.toDoingPole(bead, from) ?? [];
    bead.route = [...lead, ["bd", 0, 1], ["done2", 0, 1]];
    bead.seg = 0;
    bead.p = 0;
  }

  /** The legs from where a bead sits on `from` to the doing pole, or null when it is not on a wire we know. */
  private toDoingPole(bead: Bead, from: Pole): Seg[] | null {
    if (bead.route.length) return null;
    if (from === "doing") return [];
    if (from === "todo") return [[bead.wire, bead.t, 1]];
    if (from === "blocked") return [["bb", bead.t, 0]];
    return null;
  }

  /** The way from one pole to another along the wires, or null to just put it there. */
  private journey(bead: Bead, from: Pole, rest: { wire: WireName; t: number }): Seg[] | null {
    const to = bead.pole;
    if (from === "todo" && to === "todo") return null;
    if (to === "todo" && from === "doing") return [["ab1", bead.wire === "ab1" ? bead.t : 1, rest.t]];
    if (to === "todo" && from === "blocked") return [["bb", bead.t, 0], ["ab1", 1, rest.t]];
    const lead = this.toDoingPole(bead, from);
    if (!lead) return null;
    if (to === "doing") {
      /* Already at the pole on its slot wire: no trip, it just eases along. */
      if (from === "doing") return null;
      const last = lead[lead.length - 1];
      if (from === "todo") return [[rest.wire, last[1], rest.t]];
      return [...lead, [rest.wire, 1, rest.t]];
    }
    if (to === "blocked") return [...lead, ["bb", 0, rest.t]];
    return null;
  }

  private settle(bead: Bead) {
    bead.route = [];
    bead.seg = 0;
    bead.p = 0;
    if (bead.leaving || !bead.rest) {
      this.beads.delete(bead.id);
      return;
    }
    bead.wire = bead.rest.wire;
    bead.t = bead.rest.t;
  }

  /* ---------------------------------------------------------- loop ---- */

  /** Animate while there is motion and the scene is on screen; otherwise draw once. */
  private sync() {
    const run = this.motion && this.visible;
    if (run && !this.running) {
      this.running = true;
      this.last = performance.now();
      const tick = (now: number) => {
        if (!this.running) return;
        this.step(Math.min(0.05, (now - this.last) / 1000));
        this.last = now;
        this.draw();
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    } else if (!run && this.running) {
      this.running = false;
      cancelAnimationFrame(this.frame);
    }
    if (!this.running) this.draw();
  }

  private redraw() {
    if (!this.running) this.draw();
  }

  private advance(bead: Bead, dt: number): boolean {
    const [wn, a, b] = bead.route[bead.seg];
    const len = Math.max(4, this.wires[wn].len * Math.abs(b - a));
    bead.p += (TRAVEL * dt) / len;
    if (bead.p >= 1) {
      bead.seg++;
      bead.p = 0;
      if (bead.seg >= bead.route.length) {
        const last = bead.route[bead.route.length - 1];
        bead.wire = last[0];
        bead.t = last[2];
        return true;
      }
    }
    const [wn2, a2, b2] = bead.route[bead.seg];
    bead.wire = wn2;
    bead.t = a2 + (b2 - a2) * bead.p;
    return false;
  }

  private step(dt: number) {
    this.clock += dt;
    this.wires = buildWires(this.clock);
    for (const bead of [...this.beads.values()]) {
      if (bead.route.length) {
        if (this.advance(bead, dt)) {
          bead.route = [];
          if (bead.pole === "done") this.beads.delete(bead.id);
        } else if (bead.pole === "done" && bead.wire === "done2") {
          if (bead.flashes) {
            bead.flashes = false;
            this.flashDone = 1;
          }
          bead.alpha = 1 - Math.max(0, (bead.t - 0.5) / 0.5);
        }
      } else if (bead.leaving) {
        bead.alpha -= dt * 2.5;
        if (bead.alpha <= 0) this.beads.delete(bead.id);
      } else if (bead.rest) {
        if (bead.wire !== bead.rest.wire) bead.wire = bead.rest.wire;
        bead.t += (bead.rest.t - bead.t) * (1 - Math.exp((-dt * TRAVEL) / 12));
      }
    }
    this.flashDone = Math.max(0, this.flashDone - dt * 0.8);
  }

  /* ---------------------------------------------------------- draw ---- */

  private plot(x: number, y: number, c: RGB, a = 1) {
    if (x < 0 || y < 0 || x >= BW || y >= BH || a <= 0) return;
    this.ctx.fillStyle = css(c, Math.min(1, a));
    this.ctx.fillRect(x, y, 1, 1);
  }

  private drawWire(w: Wire, base: RGB, pulse = 0) {
    const steps = Math.ceil(w.len * 3);
    const seen = new Set<string>();
    const pts: [number, number, number][] = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const [x, y] = at(w, t);
      const px = Math.round(x);
      const py = Math.round(y);
      const k = `${px},${py}`;
      if (!seen.has(k)) {
        seen.add(k);
        pts.push([px, py, t]);
      }
    }
    const lv = pts.map(([, , t]) => {
      if (!pulse) return 0;
      const d = Math.abs(t - pulse) / (PULSE_LEN / w.len / 2);
      return d < 1 ? Math.pow(1 - d, 1.6) : 0;
    });
    const cur = this.colors.yellow;
    pts.forEach(([x, y], j) => {
      if (lv[j] > 0.05) {
        this.plot(x, y - 1, cur, lv[j] * GLOW * 0.55);
        this.plot(x, y + 1, cur, lv[j] * GLOW * 0.55);
      }
    });
    pts.forEach(([x, y], j) => this.plot(x, y, mix(base, cur, lv[j])));
  }

  private blinkLevel(): number {
    if (!this.motion) return 1;
    const p = (this.clock % BLINK) / BLINK;
    const hard = p < DUTY ? 1 : 0;
    const soft = 0.5 - 0.5 * Math.cos(2 * Math.PI * Math.min(1, p / Math.max(0.01, DUTY * 2)));
    return hard * (1 - SOFT) + soft * SOFT;
  }

  /** The logo's pole: LogoMark's rectangles, with a lamp on its head. */
  private drawPole(x: number, top: number, lampCol: RGB, lamp: number) {
    const { ctx, colors: C } = this;
    ctx.fillStyle = css(mix(C.surface, C.ink, POLE_TONE));
    ctx.fillRect(x + 4, top, 2, POLE_H);
    ctx.fillRect(x, top + 3, 10, 2);
    ctx.fillRect(x + 2, top + 8, 6, 1);
    ctx.fillStyle = css(mix(mix(C.surface, C.faint, 0.8), lampCol, lamp));
    ctx.fillRect(x + 4, top - 2, 2, 2);
    if (lamp > 0.6) {
      ctx.fillStyle = css(lampCol, (lamp - 0.6) * GLOW);
      ctx.fillRect(x + 3, top - 3, 4, 1);
      ctx.fillRect(x + 3, top, 1, 1);
      ctx.fillRect(x + 6, top, 1, 1);
    }
  }

  private draw() {
    const { ctx, colors: C, wires: W } = this;
    ctx.clearRect(0, 0, BW, BH);
    ctx.fillStyle = css(C.surface);
    ctx.fillRect(0, 0, BW, BH);
    const base = mix(C.surface, C.muted, IDLE);
    const tinted = (role: Role) => mix(base, C[role], TINT);
    const beads = [...this.beads.values()];
    const resting = (pole: Pole) => beads.filter((b) => b.pole === pole && !b.route.length && !b.leaving);
    const working = resting("doing").filter((b) => !b.idle);
    const pulse = (wire: WireName) => {
      if (!this.motion || !working.some((b) => b.wire === wire)) return 0;
      return ((this.clock * PULSE_SPEED) / W[wire].len) % 1;
    };
    this.drawWire(W.in1, tinted("blue"));
    this.drawWire(W.in2, tinted("blue"));
    this.drawWire(W.ab1, base, pulse("ab1"));
    this.drawWire(W.ab2, base, pulse("ab2"));
    this.drawWire(W.bd, tinted("green"));
    this.drawWire(W.bb, tinted("red"));
    this.drawWire(W.done1, tinted("green"));
    this.drawWire(W.done2, tinted("green"));

    const bl = this.blinkLevel();
    const has = (pole: Pole) => beads.some((b) => b.pole === pole && !b.leaving);
    const anyIdle = beads.some((b) => b.pole === "doing" && b.idle && !b.leaving);
    const doingLamp = working.length ? (this.motion ? 0.85 + 0.15 * Math.sin(this.clock * 7) : 1) : anyIdle ? 0.4 : 0;
    this.drawPole(X[0], TOP, C.blue, has("todo") ? 1 : 0);
    this.drawPole(X[1], TOP, C.yellow, doingLamp);
    this.drawPole(X[2], TOP, C.red, has("blocked") ? bl : 0);
    this.drawPole(X[3], TOP, C.green, this.flashDone);

    for (const b of beads) {
      const [x, y] = at(W[b.wire], b.t);
      let a = b.alpha;
      if (b.pole === "blocked" && !b.route.length) a *= 0.45 + 0.55 * bl;
      if (b.pole === "doing" && b.idle) a *= 0.45;
      if (a <= 0) continue;
      const c = C[HUE[b.pole]];
      ctx.fillStyle = css(c, Math.min(1, a));
      ctx.fillRect(Math.round(x) - 1, Math.round(y) + 1, 2, 2);
      ctx.fillStyle = css(c, Math.min(1, a) * 0.5);
      ctx.fillRect(Math.round(x) - 1, Math.round(y), 2, 1);
    }
  }
}
