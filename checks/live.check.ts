/* ============================================================================
   The live socket's life (src/lib/liveSocket.ts, listen).
   ----------------------------------------------------------------------------
   Run: npm run check. Drives it with a fake socket, page, query client and
   clock: a drop refetches once, a hidden tab lets go of its socket and stays
   quiet, and showing it again catches up once. And the window a tab's live
   events and catch-ups go through (src/lib/liveWindow.ts): a burst is a
   read or two, not one per event, and a flapping network reads a board at
   most once a window.
   ========================================================================== */

import { listen, type LivePage, type LiveSocket } from "../src/lib/liveSocket.ts";
import { catchUpLanes, lanes, QUICK_MS, READ_EVERY_MS } from "../src/lib/liveWindow.ts";

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

/* A clock of our own, so backoff and pings run when we say. */
let now = 0;
let nextId = 1;
const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
Object.assign(globalThis, {
  setTimeout: (fn: () => void, ms: number) => (timers.set(nextId, { at: now + ms, fn }), nextId++),
  setInterval: (fn: () => void, ms: number) => (timers.set(nextId, { at: now + ms, fn, every: ms }), nextId++),
  clearTimeout: (id?: number) => id !== undefined && timers.delete(id),
  clearInterval: (id?: number) => id !== undefined && timers.delete(id),
});
function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    const [id, timer] = due;
    now = timer.at;
    if (timer.every) timer.at += timer.every;
    else timers.delete(id);
    timer.fn();
  }
  now = end;
}

class FakeSocket implements LiveSocket {
  readyState = 0;
  sent: string[] = [];
  closedWith: number | undefined;
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code;
    this.drop();
  }
  /* The server's side. */
  accept() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  drop() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

function setup(startHidden = false, catchUp?: () => void) {
  const log: string[] = [];
  const sockets: FakeSocket[] = [];
  const listeners = new Map<string, () => void>();
  const state = { hidden: startHidden, live: false, catchingUp: false };
  const observer = { options: {}, setOptions: () => log.push("reread") };
  const client = {
    getQueryCache: () => ({ getAll: () => [{ observers: [observer] }] }),
    invalidateQueries: (opts?: { refetchType?: string }) => log.push(opts?.refetchType === "none" ? "stale" : "invalidate"),
    refetchQueries: () => log.push("refetch"),
  };
  const page: LivePage = {
    open: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    hidden: () => state.hidden,
    on: (event, listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    setLive: (v) => (state.live = v),
    setCatchingUp: (v) => (state.catchingUp = v),
    message: (data) => log.push(`message ${data}`),
    catchUp: () => {
      log.push("catchup");
      catchUp?.();
    },
  };
  const stop = listen(client as never, page);
  const fetches = () => log.filter((x) => x === "invalidate" || x === "refetch" || x === "catchup").length;
  const fire = (event: string) => listeners.get(event)?.();
  const setHidden = (hidden: boolean) => {
    state.hidden = hidden;
    fire("visibilitychange");
  };
  const last = () => sockets[sockets.length - 1];
  return { log, sockets, state, stop, fetches, fire, setHidden, last };
}

/* A visible tab: open, live, messages through, pings. */
{
  const s = setup();
  t("a visible tab opens a socket", s.sockets.length === 1);
  t("live catches up instead of React Query's focus refetch", s.state.catchingUp);
  s.last().accept();
  t("open: live", s.state.live);
  t("the first open fetches nothing", s.fetches() === 0);
  s.last().onmessage?.({ data: "pong" } as MessageEvent);
  s.last().onmessage?.({ data: '{"topics":["boards"]}' } as MessageEvent);
  t("messages go through, pongs don't", s.log.filter((x) => x.startsWith("message")).length === 1);
  advance(30_000);
  t("it pings", s.last().sent.includes("ping"));
  s.stop();
  t("stopped: not live, focus refetch back to React Query", !s.state.live && !s.state.catchingUp);
  t("stopped: the socket is closed", s.last().closedWith === 1000);
  advance(120_000);
  t("stopped: no reconnect", s.sockets.length === 1);
}

/* A visible tab's socket drops: the polls come back, and one refetch once it's open again. */
{
  const s = setup();
  s.last().accept();
  s.log.length = 0;
  s.last().drop();
  t("drop: not live", !s.state.live);
  t("drop: the polls are re-read (they come back)", s.log.includes("reread"));
  t("drop: no refetch while it's down", s.fetches() === 0);
  advance(1000);
  t("drop: it reconnects after the backoff", s.sockets.length === 2);
  s.last().drop();
  advance(2000);
  t("a failed attempt fetches nothing either", s.fetches() === 0 && s.sockets.length === 3);
  s.last().accept();
  t("back: live", s.state.live);
  t("back: one catch-up of what's on screen", s.fetches() === 1 && s.log.includes("catchup"));
  s.stop();
}

/* A hidden tab: lets go of its socket and stays quiet. */
{
  const s = setup();
  s.last().accept();
  s.log.length = 0;
  s.setHidden(true);
  t("hidden: the socket is closed on purpose", s.sockets[0].closedWith === 1000);
  t("hidden: not live", !s.state.live);
  t("hidden: things are marked stale", s.log.includes("stale"));
  t("hidden: nothing is fetched", s.fetches() === 0);
  t("hidden: the polls aren't re-read", !s.log.includes("reread"));
  advance(10 * 60_000);
  s.fire("online");
  t("hidden for ten minutes: no new socket, no timers left", s.sockets.length === 1 && timers.size === 0);
  t("hidden for ten minutes: nothing fetched", s.fetches() === 0);

  s.setHidden(false);
  t("shown: it reconnects at once", s.sockets.length === 2);
  s.last().accept();
  t("shown: one round of refetches", s.fetches() === 1);
  advance(10 * 60_000);
  t("shown: then quiet", s.fetches() === 1 && s.sockets.length === 2);
  s.stop();
}

/* Hidden while a reconnect is pending: no backoff left running. */
{
  const s = setup();
  s.last().accept();
  s.last().drop();
  s.setHidden(true);
  advance(60_000);
  t("hidden while down: the retry is cancelled", s.sockets.length === 1);
  s.setHidden(false);
  s.last().accept();
  t("shown again: one refetch", s.fetches() === 1);
  s.stop();
}

/* Shown, but the socket won't open: refetch what's on screen once anyway. */
{
  const s = setup();
  s.last().accept();
  s.setHidden(true);
  s.log.length = 0;
  s.setHidden(false);
  s.last().drop();
  t("shown, socket fails: one refetch, the polls back", s.fetches() === 1 && s.log.includes("reread"));
  advance(1000);
  s.last().drop();
  t("and only once", s.fetches() === 1);
  advance(2000);
  s.last().accept();
  t("open at last: one catch-up", s.fetches() === 2);
  s.stop();
}

/* Opened in the background: no socket until it is looked at. */
{
  const s = setup(true);
  t("opened hidden: no socket", s.sockets.length === 0);
  s.setHidden(false);
  s.last().accept();
  t("opened hidden, then shown: one catch-up", s.fetches() === 1);
  s.stop();
}

/* The window (liveWindow.ts): each lane acts at most once in READ_EVERY_MS, trailing, dropping nothing. */
{
  const rounds: Array<[string, number[], number]> = [];
  const l = lanes<number>((lane, items) => rounds.push([lane, items, now]), { now: () => now });
  const start = now;
  /* Twenty events on one board over four seconds, as a few busy agent runs send. */
  for (let i = 0; i < 20; i++) {
    l.add("b", [i]);
    advance(200);
  }
  advance(READ_EVERY_MS * 2);
  const b = rounds.filter(([lane]) => lane === "b");
  t("a burst: the first round after a moment for the rest of it", b[0]?.[2] === start + QUICK_MS);
  t("a burst over four seconds: two rounds, not twenty", b.length === 2);
  t("a burst: the second round waits for the window's end", b[1]?.[2] === b[0][2] + READ_EVERY_MS);
  t("a burst: nothing dropped, nothing twice", b.flatMap(([, items]) => items).join() === [...Array(20).keys()].join());

  /* A steady stream for a minute: one round a window, give or take the first. */
  rounds.length = 0;
  for (let i = 0; i < 600; i++) {
    l.add("b", [i]);
    advance(100);
  }
  advance(READ_EVERY_MS * 2);
  t("a minute of events every 100 ms: a round every window", rounds.length <= 60_000 / READ_EVERY_MS + 1);
  t("every round at least a window apart", rounds.every(([, , at], i) => i === 0 || at - rounds[i - 1][2] >= READ_EVERY_MS));

  /* A burst that comes after a quiet window: one round. */
  rounds.length = 0;
  advance(READ_EVERY_MS * 3);
  for (let i = 0; i < 5; i++) l.add("b", [i]);
  advance(READ_EVERY_MS * 2);
  t("a burst after a quiet spell: one round", rounds.length === 1 && rounds[0][1].length === 5);

  /* Boards are lanes of their own. */
  rounds.length = 0;
  l.add("b", [1]);
  l.add("c", [2]);
  advance(QUICK_MS);
  t("two boards: a round each, neither waits for the other", rounds.map(([lane]) => lane).sort().join() === "b,c");
  l.add("b", [3]);
  l.stop();
  advance(READ_EVERY_MS * 2);
  t("stopped: the round still due doesn't run", rounds.length === 2 && timers.size === 0);
}

/* What a catch-up reads, by lane: the boards on screen, and what reads across them. */
{
  const on = catchUpLanes([["board", "b1"], ["board", "b1", "overlap", "x"], ["board", "b2", "task", "B2-1"], ["board", "~mine"], ["inbox"], ["comments", "t"]]);
  t("catch-up: each board on screen once", on.boards.sort().join() === "b1,b2");
  t("catch-up: what reads across boards is a lane of its own", on.across);
  t("catch-up: nothing across boards on screen, no across lane", !catchUpLanes([["board", "b1"], ["settings"]]).across);
}

/* A flapping network: every reconnect catches up, but a board is read at most once a window. */
{
  const reads: number[] = [];
  const l = lanes<string>(() => reads.push(now), { now: () => now });
  const s = setup(false, () => l.add("b", ["whole"]));
  s.last().accept();
  const start = now;
  for (let i = 0; i < 6; i++) {
    s.last().drop();
    advance(1000);
    s.last().accept();
  }
  advance(READ_EVERY_MS * 2);
  t("flapping: a catch-up each time the socket is back", s.log.filter((x) => x === "catchup").length === 6);
  t("flapping for six seconds: the board read twice at most, not six times", reads.length <= 2 && reads.length >= 1);
  t("flapping: the last catch-up is still read, at the window's end", reads[reads.length - 1] >= start + 5000);
  s.stop();
  l.stop();
}

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} live checks passed`);
if (failed) process.exit(1);
