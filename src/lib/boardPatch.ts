/* ============================================================================
   A board's live events, applied to its cached read (COPL-151).
   ----------------------------------------------------------------------------
   An event that names a board's tasks, and runs on from the version the
   tab holds (domain/live.ts planBoard), refetches just those tasks
   (GET /api/tasks/:id) and puts them in the cached board: replaced, added
   when the cache doesn't have them, dropped when they 404. Anything else
   reads the board whole, as every board event used to.

   A task's thread and history refetch only for the tasks an event names,
   and only while they are on screen (an inactive query is just marked
   stale). A parent's progress is counted by the server over its whole
   subtree (COPL-150): a write that can move it (a task added or reparented
   under a parent, or one entering or leaving done or cancelled) names every
   task above, each read comes with its progress, and the patch takes it.
   Should one the tab holds above such a task not be named (an older Worker),
   it reads the board whole. Other things the read counts over more than the
   named tasks read it whole too: overlap (task.overlap) moves when a task
   closes or reopens on a board with code, and a task's new dependencies
   may be closed tasks the read doesn't hold. Everything else keeps each
   task's overlap. A closed task the board read doesn't hold (closed
   too long ago) is not added to it: the paged older ones and a stray
   task opened by key refetch under their own keys instead.

   A tab that holds no read of the board may still show one of its tasks,
   opened from the inbox or /wired without the board (useTaskView, COPL-153):
   then the tasks an event names refetch under the board's key, and an event
   that names none refetches everything under it.

   One board's events are applied one batch after another, so a batch never
   starts from a version the batch before it is about to move.
   ========================================================================== */

import type { QueryClient } from "@tanstack/react-query";
import { planBoard, type BoardChange } from "@/domain/live";
import type { BoardDetail, ParentProgress, Task, TaskRead } from "@/domain/types";
import { COMMENTS_KEY, EVENTS_KEY } from "./boardEdits";
import { KEYS } from "./queries";

/** One task's read (GET /api/tasks/:id), or null when it is gone (404). */
export type FetchTask = (id: string) => Promise<TaskRead | null>;

const inFlight = new Map<string, Promise<void>>();

/** Apply these events about one board, after any batch for it still under way. */
export function applyBoardEvents(
  queryClient: QueryClient,
  fetchTask: FetchTask,
  boardId: string,
  events: BoardChange[],
  hidden: boolean,
): Promise<void> {
  const next = (inFlight.get(boardId) ?? Promise.resolve()).then(() => apply(queryClient, fetchTask, boardId, events, hidden));
  const settled = next.finally(() => {
    if (inFlight.get(boardId) === settled) inFlight.delete(boardId);
  });
  inFlight.set(boardId, settled);
  return settled;
}

const isOpen = (t: Pick<Task, "completedAt">) => t.completedAt === null;

/** Whether a patch from `before` (absent: new to the cache) to `after` moves its parents' progress. */
function movesProgress(detail: BoardDetail, before: Task | undefined, after: Task): boolean {
  const counted = (t: Task) => {
    const c = detail.stages.find((s) => s.id === t.stageId)?.category;
    return c === "done" || c === "cancelled" ? c : "open";
  };
  if (!before) return after.parentId !== null;
  return before.parentId !== after.parentId || (after.parentId !== null && counted(before) !== counted(after));
}

/** What the read counts over more than the tasks named, that a patch can't put right: overlap, and dependencies it may not hold. */
const beyondPatch = (detail: BoardDetail, before: Task | undefined, after: Task) =>
  !!before && ((isOpen(before) !== isOpen(after) && detail.repos.length > 0) || before.dependsOn.join() !== after.dependsOn.join());

/** Every task above these, as the board holds them. */
function above(byId: Map<string, Task>, parents: Array<string | null>): Set<string> {
  const out = new Set<string>();
  for (let at of parents) {
    while (at && !out.has(at)) {
      out.add(at);
      at = byId.get(at)?.parentId ?? null;
    }
  }
  return out;
}

async function apply(
  queryClient: QueryClient,
  fetchTask: FetchTask,
  boardId: string,
  events: BoardChange[],
  hidden: boolean,
): Promise<void> {
  const key = KEYS.board(boardId);
  const refetchType = hidden ? "none" : "active";
  const whole = () => {
    /* Everything under the board's key (its overlap, docs, repos) and every thread: which task changed is not known. */
    void queryClient.invalidateQueries({ queryKey: key, refetchType });
    void queryClient.invalidateQueries({ queryKey: ["comments"], refetchType });
    void queryClient.invalidateQueries({ queryKey: ["events"], refetchType });
  };

  const held = queryClient.getQueryData<BoardDetail>(key);
  if (!held) {
    /* No board to patch. What is held under its key is at most a task modal's (COPL-153: its shell, its task and the few
       that one names), so only the tasks named refetch; an event that names none reads everything under the key. */
    if (events.some((e) => !e.tasks)) return whole();
    for (const id of new Set(events.flatMap((e) => e.tasks ?? []))) {
      void queryClient.invalidateQueries({ queryKey: [...key, "task", id], refetchType });
      void queryClient.invalidateQueries({ queryKey: COMMENTS_KEY(id), refetchType });
      void queryClient.invalidateQueries({ queryKey: EVENTS_KEY(id), refetchType });
    }
    void queryClient.invalidateQueries({ queryKey: [...key, "overlap"], refetchType });
    return;
  }
  const plan = planBoard(held.version, events);
  if (plan.kind === "none") return;
  /* A hidden tab fetches nothing, and an edit of this tab's own in flight would be overwritten by a patch. */
  if (plan.kind === "whole" || hidden || queryClient.isMutating() > 0) return whole();

  for (const id of plan.tasks) {
    void queryClient.invalidateQueries({ queryKey: COMMENTS_KEY(id), refetchType });
    void queryClient.invalidateQueries({ queryKey: EVENTS_KEY(id), refetchType });
  }
  /* The overlap, older closed pages and stray tasks under the board's key, each refetched if on screen. */
  for (const under of ["overlap", "closed", "task"]) void queryClient.invalidateQueries({ queryKey: [...key, under], refetchType });

  let read: Array<[string, TaskRead | null]>;
  try {
    read = await Promise.all(plan.tasks.map(async (id) => [id, await fetchTask(id)] as [string, TaskRead | null]));
  } catch {
    return whole();
  }

  const now = queryClient.getQueryData<BoardDetail>(key);
  /* A whole read landed meanwhile: it has these already when it is as new as they are. */
  if (!now || now.version !== held.version) {
    if (!now || now.version < plan.version) whole();
    return;
  }
  const cached = new Map(now.tasks.map((t) => [t.id, t]));
  const byId = new Map(cached);
  const named = new Set(plan.tasks);
  const progress: Record<string, ParentProgress> = { ...now.progress };
  for (const [id, fresh] of read) {
    const before = cached.get(id);
    /* Gone, or another board's (a stray id): not this board's to hold. */
    if (!fresh || fresh.boardId !== boardId) {
      if (before?.parentId) return whole();
      byId.delete(id);
      delete progress[id];
      continue;
    }
    const { progress: counted, ...task } = fresh;
    if (beyondPatch(now, before, task)) return whole();
    /* Everything above it, before and after, must have come with its new progress. */
    if (movesProgress(now, before, task) && [...above(cached, [before?.parentId ?? null, task.parentId])].some((p) => !named.has(p))) return whole();
    if (counted) progress[id] = counted;
    else delete progress[id];
    /* Closed long ago, and so not in the read: stays out. */
    if (!before && !isOpen(task)) continue;
    byId.set(id, { ...task, overlap: before?.overlap ?? [] });
  }
  queryClient.setQueryData<BoardDetail>(key, { ...now, tasks: [...byId.values()], progress, version: plan.version });
}
