/* ============================================================================
   Task rules shared by the Worker and the browser.
   ----------------------------------------------------------------------------
   The browser applies these to its cache the moment you act (optimistic
   updates), and the Worker applies them again as the truth. Keeping them in
   one place is what stops the card from flickering between the two.
   ========================================================================== */

import type { StageCategory } from "./types";

/** A task in a done or cancelled stage is closed and carries completed_at. */
export function isClosing(category: StageCategory): boolean {
  return category === "done" || category === "cancelled";
}

/**
 * Where a new task lands when nobody picks a stage, and where a reopened one
 * goes back to: the first todo stage; on a board without one, the first open
 * stage that is not backlog, then backlog itself. Something just written down
 * is ready to be picked up, not parked.
 */
export function defaultStage<S extends { category: StageCategory }>(stages: S[]): S | undefined {
  return (
    stages.find((s) => s.category === "todo") ??
    stages.find((s) => !isClosing(s.category) && s.category !== "backlog") ??
    stages.find((s) => !isClosing(s.category)) ??
    stages[0]
  );
}

/** YYYY-MM-DD, and a real calendar date. */
export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * A rank that sorts between two neighbours, so a drag writes one row. Null
 * means "no neighbour on that side". Floats run out of room after about fifty
 * halvings in the same gap, which a person dragging cards will not reach; if
 * they ever do, the order is still valid, just with ties broken by number.
 */
export function rankBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 0;
  if (before === null) return (after as number) - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}

export const TITLE_MAX = 200;
export const BRIEF_MAX = 20_000;

/* ---------------------------------------------------------- calendar days -- */

const DAY_MS = 86_400_000;

/** YYYY-MM-DD plus n days (negative goes back). Done in UTC, so no DST drift. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/* ------------------------------------------------------------- hierarchy -- */

/**
 * Every task under `rootId` at any depth, by parent links, not the root
 * itself. A parent chain that loops (the Worker refuses one, but old rows or
 * a race could leave it) is walked once: a task already seen is not walked
 * again.
 */
export function descendantIds<T extends { id: string; parentId: string | null }>(tasks: T[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const t of tasks) if (t.parentId) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t.id]);
  const out = new Set<string>();
  const queue = [...(children.get(rootId) ?? [])];
  while (queue.length) {
    const id = queue.pop() as string;
    if (id === rootId || out.has(id)) continue;
    out.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return out;
}
