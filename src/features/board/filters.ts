/* ============================================================================
   Board filters: what the filter bar asks for, read from and written to the
   URL, and applied to a board's tasks. Every view (kanban, list, Gantt) gets
   the same filtered board, so a filter means the same thing in all three.
   ----------------------------------------------------------------------------
   The query string is the state, next to ?view=, so a filtered board is a
   link you can share and it survives a reload:

     level=epic&level=task   levels, any of
     under=CPL-5             CPL-5 and everything below it, at any depth
     who=me | none | handle  assignee: you, nobody, or a member (agents too)
     label=bug&label=ui      labels by name, any of
     q=text                  in the key, title or brief, any case
     done=all                closed tasks of every age, not only the last 14 days

   The scoped task itself always shows, whatever the other filters say, so
   you can see which stage the thing you are looking inside is in. The other
   filters apply to everything under it.
   ========================================================================== */

import { descendantIds, isClosing } from "@/domain/tasks";
import { LEVELS, type BoardDetail, type Task } from "@/domain/types";

/** Closed tasks older than this are hidden unless done=all. */
export const RECENT_DONE_DAYS = 14;

export const LEVEL_FILTERS = LEVELS;
export type LevelFilter = (typeof LEVEL_FILTERS)[number];

export interface BoardFilters {
  levels: LevelFilter[];
  /** A task key. */
  under: string | null;
  /** "me", "none", or a member's handle. */
  who: string | null;
  /** Label names, lowercase. */
  labels: string[];
  q: string;
  allDone: boolean;
}

const PARAMS = ["level", "under", "who", "label", "q", "done"] as const;

export function readFilters(params: URLSearchParams): BoardFilters {
  return {
    levels: params.getAll("level").filter((l): l is LevelFilter => (LEVEL_FILTERS as readonly string[]).includes(l)),
    under: params.get("under")?.trim().toUpperCase() || null,
    who: params.get("who")?.trim().toLowerCase() || null,
    labels: params.getAll("label").map((l) => l.trim().toLowerCase()).filter(Boolean),
    q: params.get("q") ?? "",
    allDone: params.get("done") === "all",
  };
}

/** The params with these filters in place of the old ones; anything else (view) is kept. */
export function writeFilters(params: URLSearchParams, filters: BoardFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const p of PARAMS) next.delete(p);
  for (const l of filters.levels) next.append("level", l);
  if (filters.under) next.set("under", filters.under);
  if (filters.who) next.set("who", filters.who);
  for (const l of filters.labels) next.append("label", l);
  if (filters.q) next.set("q", filters.q);
  if (filters.allDone) next.set("done", "all");
  return next;
}

export const NO_FILTERS: BoardFilters = { levels: [], under: null, who: null, labels: [], q: "", allDone: false };

/** How many filters narrow the board. The 14-day default for closed tasks is not one. */
export function activeCount(f: BoardFilters): number {
  return (f.levels.length ? 1 : 0) + (f.under ? 1 : 0) + (f.who ? 1 : 0) + (f.labels.length ? 1 : 0) + (f.q.trim() ? 1 : 0);
}

export interface Filtered {
  tasks: Task[];
  /** The task the board is scoped to; "missing" when ?under= names none on this board. */
  scope: Task | "missing" | null;
  /** Tasks that match everything but are closed longer ago than RECENT_DONE_DAYS. */
  olderDone: number;
}

export function applyFilters(detail: BoardDetail, f: BoardFilters, meId: string | undefined, now = Date.now()): Filtered {
  const scopeTask = f.under ? detail.tasks.find((t) => t.key === f.under) : undefined;
  const scope: Filtered["scope"] = f.under ? (scopeTask ?? "missing") : null;
  const below = scopeTask ? descendantIds(detail.tasks, scopeTask.id) : null;

  const whoId =
    f.who === null || f.who === "none"
      ? f.who
      : f.who === "me"
        ? (meId ?? "")
        : (detail.members.find((m) => m.user.handle.toLowerCase() === f.who)?.user.id ?? "");
  const labelIds = new Set(detail.labels.filter((l) => f.labels.includes(l.name.toLowerCase())).map((l) => l.id));
  const needle = f.q.trim().toLowerCase();
  const closing = new Set(detail.stages.filter((s) => isClosing(s.category)).map((s) => s.id));
  const cutoff = now - RECENT_DONE_DAYS * 86_400_000;

  const matches = (t: Task) =>
    (!below || below.has(t.id)) &&
    (!f.levels.length || f.levels.includes(t.level)) &&
    (whoId === null || (whoId === "none" ? t.assigneeIds.length === 0 : t.assigneeIds.includes(whoId))) &&
    (!f.labels.length || t.labelIds.some((id) => labelIds.has(id))) &&
    (!needle || `${t.key}\n${t.title}\n${t.brief}`.toLowerCase().includes(needle));
  const old = (t: Task) => closing.has(t.stageId) && t.completedAt !== null && Date.parse(t.completedAt) < cutoff;

  let olderDone = 0;
  const tasks = detail.tasks.filter((t) => {
    if (scopeTask && t.id === scopeTask.id) return true;
    if (!matches(t)) return false;
    if (!f.allDone && old(t)) {
      olderDone++;
      return false;
    }
    return true;
  });
  return { tasks, scope, olderDone };
}
