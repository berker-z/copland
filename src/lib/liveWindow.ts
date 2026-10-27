/* ============================================================================
   How often a tab acts on live events (COPL-209), apart from lib/live.ts so
   a check can drive it with a fake clock (checks/live.check.ts).
   ----------------------------------------------------------------------------
   With agents busy a board sends events far more often than every few
   hundred milliseconds, and each round of them costs a read: a patch of the
   tasks named, or the whole board. So each lane (one per board, one for
   what reads across boards, one for every other topic) acts at most once
   every READ_EVERY_MS. The first event on a quiet lane waits QUICK_MS for
   the rest of its burst; one that comes inside the window waits for its
   end, and everything that arrived meanwhile goes in that one round.
   Nothing is dropped, only gathered.

   Catching up after the socket was away goes through the same lanes
   (catchUpLanes): a network that keeps dropping reads each board at most
   once a window, not once a reconnect.
   ========================================================================== */

import type { QueryKey } from "@tanstack/react-query";

/** The first event on a quiet lane waits this long for the rest of its burst. */
export const QUICK_MS = 300;
/** A lane acts at most once in this long. */
export const READ_EVERY_MS = 5_000;

export interface Lanes<T> {
  /** Add to a lane's next round, which starts its timer if it has none. */
  add(lane: string, items: Iterable<T>): void;
  /** Cancel every round not yet run. */
  stop(): void;
}

/** Lanes that hand what gathered to `act`, at most once every `every` ms each. */
export function lanes<T>(act: (lane: string, items: T[]) => void, opts: { quick?: number; every?: number; now?: () => number } = {}): Lanes<T> {
  const { quick = QUICK_MS, every = READ_EVERY_MS, now = () => Date.now() } = opts;
  const all = new Map<string, { items: T[]; last: number; timer?: ReturnType<typeof setTimeout> }>();
  return {
    add(lane, items) {
      let at = all.get(lane);
      if (!at) all.set(lane, (at = { items: [], last: -Infinity }));
      const held = at;
      held.items.push(...items);
      if (held.timer !== undefined) return;
      const t = now();
      const wait = Math.max(quick, held.last + every - t);
      held.timer = setTimeout(() => {
        held.timer = undefined;
        held.last = now();
        const items = held.items;
        held.items = [];
        act(lane, items);
      }, wait);
    },
    stop() {
      for (const at of all.values()) clearTimeout(at.timer);
      all.clear();
    },
  };
}

/** What a catch-up reads, by lane: the boards held (each its own lane), what reads across boards, and the rest. */
export interface CatchUp {
  boards: string[];
  across: boolean;
}

/**
 * The lanes a catch-up after the socket was away goes through, from the keys
 * of the queries on screen. A board's queries are under ["board", id, ...];
 * what reads across boards is under ["board", "~..."] (lib/queries.ts KEYS).
 */
export function catchUpLanes(keys: QueryKey[]): CatchUp {
  const boards = new Set<string>();
  let across = false;
  for (const key of keys) {
    if (key[0] !== "board" || typeof key[1] !== "string") continue;
    if (key[1].startsWith("~")) across = true;
    else boards.add(key[1]);
  }
  return { boards: [...boards], across };
}
