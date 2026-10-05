/* ============================================================================
   The live socket's life (src/lib/liveSocket.ts, listen).
   ----------------------------------------------------------------------------
   Run: npm run check. Drives it with a fake socket, page, query client and
   clock: a drop refetches once, a hidden tab lets go of its socket and stays
   quiet, and showing it again catches up once.
   ========================================================================== */

import { listen, type LivePage, type LiveSocket } from "../src/lib/liveSocket.ts";

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

function setup(startHidden = false) {
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
  };
  const stop = listen(client as never, page);
  const fetches = () => log.filter((x) => x === "invalidate" || x === "refetch").length;
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
  t("back: one refetch of everything", s.fetches() === 1 && s.log.includes("invalidate"));
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

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} live checks passed`);
if (failed) process.exit(1);
