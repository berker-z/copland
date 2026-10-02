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

/* ---------------------------------------------------- parents follow -- */

/** A parent the board moved because of its children, and the child it followed. */
export interface Followed {
  id: string;
  from: string;
  to: string;
  /** The child whose change moved it (for a cascade, the parent below it). */
  childId: string;
}

/**
 * Where a parent's stage goes once its children change, or undefined to
 * leave it. Only the children's categories count, never how the parent got
 * where it is, so a parent moved by hand stays put until a child changes
 * again.
 *
 * - A child active or blocked: work is under way, so a parent that is not
 *   (parked, ready, or closed) goes to the first active stage.
 * - Otherwise, every child that is not parked in backlog is closed and at
 *   least one is done: the parent's work is delivered, so an open parent goes
 *   to the first done stage. Parked children don't hold it open. All of them
 *   cancelled is not delivery, so that leaves the parent alone, and so does a
 *   parent already closed (a cancelled epic stays cancelled).
 * - Otherwise, a closed parent with a child ready in todo has work left again
 *   (a child added under it, or reopened): it goes back to the board's
 *   default stage (defaultStage), as a reopened task would.
 *
 * A parent already active or blocked is never demoted, a parked parent is
 * not pulled into todo by a todo child, and a board without the stage a rule
 * needs leaves the parent where it is.
 */
export function followChildren<S extends { id: string; category: StageCategory }>(
  stages: S[],
  parentStageId: string,
  childStageIds: string[],
): string | undefined {
  if (childStageIds.length === 0) return undefined;
  const category = (id: string) => stages.find((s) => s.id === id)?.category;
  const parent = category(parentStageId);
  if (!parent) return undefined;
  const kids = childStageIds.map(category).filter((c): c is StageCategory => !!c);
  const target = (c: StageCategory) => stages.find((s) => s.category === c)?.id;

  if (kids.some((c) => c === "active" || c === "blocked")) {
    return parent === "active" || parent === "blocked" ? undefined : target("active");
  }
  const counted = kids.filter((c) => c !== "backlog");
  if (counted.length && counted.every(isClosing) && counted.includes("done")) {
    return isClosing(parent) ? undefined : target("done");
  }
  if (isClosing(parent) && counted.includes("todo")) {
    const open = defaultStage(stages);
    return open && !isClosing(open.category) ? open.id : undefined;
  }
  return undefined;
}

/**
 * Carry a change up the tree: `starts` are the parents to look at again
 * (with the child that changed under each), in a board whose tasks already
 * show the change. A parent that moves is looked at as a child in turn, so
 * a task can move its story and the story its epic. Returns the moves in the
 * order they happen; `tasks` is not touched. A parent chain that loops (the
 * Worker refuses one, but old rows could hold it) ends: the rules settle
 * rather than flip, and a hard cap on steps stops it regardless.
 */
export function followUp<T extends { id: string; parentId: string | null; stageId: string }, S extends { id: string; category: StageCategory }>(
  tasks: T[],
  stages: S[],
  starts: Array<{ parentId: string | null; childId: string }>,
): Followed[] {
  const stage = new Map(tasks.map((t) => [t.id, t.stageId]));
  const parentOf = new Map(tasks.map((t) => [t.id, t.parentId]));
  const children = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.parentId && t.parentId !== t.id) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t.id]);
  }
  const moves: Followed[] = [];
  const queue = starts.filter((s): s is { parentId: string; childId: string } => !!s.parentId && stage.has(s.parentId));
  for (let steps = 0; queue.length && steps < 4 * tasks.length + 8; steps++) {
    const { parentId, childId } = queue.shift()!;
    const from = stage.get(parentId)!;
    const to = followChildren(stages, from, (children.get(parentId) ?? []).map((id) => stage.get(id)!));
    if (!to || to === from) continue;
    stage.set(parentId, to);
    moves.push({ id: parentId, from, to, childId });
    const up = parentOf.get(parentId);
    if (up && stage.has(up)) queue.push({ parentId: up, childId: parentId });
  }
  return moves;
}
