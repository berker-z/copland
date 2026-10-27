/* ============================================================================
   A board's live events, applied to its cached read (COPL-151).
   ----------------------------------------------------------------------------
   An event that names a board's tasks, and runs on from the version the
   tab holds (domain/live.ts planBoard), refetches just those tasks
   (GET /api/tasks/:id) and puts them in the cached board: replaced, added
   when the cache doesn't have them, dropped when they 404. A tab that
   can't tell from its events what changed (a missed or crossed version,
   too many tasks, an event without a version, a catch-up after its socket
   was away or the tab hidden) asks the board what changed since its
   version (GET /api/boards/:id/changes, COPL-210) and patches that in the
   same way: the tasks changed, each with its progress, and the ones gone.
   An event that changed more than tasks (stages, labels, members, docs),
   or a board that can't say what changed since, reads the board whole.

   A task's thread and history refetch only for the tasks an event names,
   and only while they are on screen (an inactive query is just marked
   stale). A parent's progress is counted by the server over its whole
   subtree (COPL-150): a write that can move it (a task added, deleted or
   reparented under a parent, or one entering or leaving done or cancelled)
   names every task above, each read comes with its progress, and the patch
   takes it. Should one the tab holds above such a task not be named (an
   older Worker), it reads the board whole. A task's new dependency the tab
   doesn't hold may be a closed task the read would have, so that reads it
   whole too. A closed task the board read doesn't hold (closed longer than
   RECENT_CLOSED_DAYS ago) is not added to it: the paged older ones and a
   stray task opened by key refetch under their own keys instead.

   Overlap (task.overlap) is worked out over all the board's open tasks
   together, so a task's own read leaves it empty and a patch keeps what the
   tab held. When it may have moved (an event that says so, BoardChange
   .overlap: a changed-files report; or a task closing or reopening on a
   board with code), the tab reads the board's overlap
   (GET /api/boards/:id/overlap, COPL-207) and puts it on every task it
   holds, rather than the board. A report changes nothing else, so it
   patches no task and leaves the version alone; and since no version
   records one, a tab on a board with code that was behind reads the
   overlap again with what changed.

   A tab that holds no read of the board may still show one of its tasks,
   opened from the inbox or /wired without the board (useTaskView, COPL-153):
   then the tasks an event names refetch under the board's key, and an event
   that names none refetches everything under it.

   One board's events are applied one batch after another, so a batch never
   starts from a version the batch before it is about to move.
   ========================================================================== */

import type { QueryClient } from "@tanstack/react-query";
import { planBoard, type BoardChange } from "@/domain/live";
import type { BoardOverlapRead } from "@/domain/overlap";
import { RECENT_CLOSED_DAYS } from "@/domain/tasks";
import type { BoardChanges, BoardDetail, ParentProgress, Task, TaskRead } from "@/domain/types";
import { COMMENTS_KEY, EVENTS_KEY } from "./boardEdits";
import { KEYS } from "./queries";

/** One task's read (GET /api/tasks/:id), or null when it is gone (404). */
export type FetchTask = (id: string) => Promise<TaskRead | null>;

/** What a patch reads: a task (null when it is gone), a board's overlap, and what changed on it since a version. */
export interface BoardReads {
  task: FetchTask;
  overlap: (boardId: string) => Promise<BoardOverlapRead>;
  changes: (boardId: string, since: number) => Promise<BoardChanges>;
}

const inFlight = new Map<string, Promise<void>>();

/** Apply these events about one board, after any batch for it still under way. */
export function applyBoardEvents(
  queryClient: QueryClient,
  reads: BoardReads,
  boardId: string,
  events: BoardChange[],
  hidden: boolean,
): Promise<void> {
  const next = (inFlight.get(boardId) ?? Promise.resolve()).then(() => apply(queryClient, reads, boardId, events, hidden));
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

/** A new dependency the tab doesn't hold, which may be a closed task the read doesn't hold: a patch can't put that right. */
const beyondPatch = (held: Map<string, Task>, before: Task | undefined, after: Task) =>
  !!before && after.dependsOn.some((d) => !before.dependsOn.includes(d) && !held.has(d));

/** Whether a patch from `before` to `after` moves who overlaps whom: an open task closing, or a closed one reopening, on a board with code. */
const movesOverlap = (detail: BoardDetail, before: Task | undefined, after: Task) =>
  !!before && isOpen(before) !== isOpen(after) && detail.repos.length > 0;

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
  reads: BoardReads,
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
  /* The board's overlap, read and put on every task the tab holds (a closed one shares nothing). */
  const patchOverlap = async () => {
    let read: BoardOverlapRead;
    try {
      read = await reads.overlap(boardId);
    } catch {
      return whole();
    }
    const now = queryClient.getQueryData<BoardDetail>(key);
    if (!now) return;
    queryClient.setQueryData<BoardDetail>(key, {
      ...now,
      tasks: now.tasks.map((t) => ({ ...t, overlap: isOpen(t) ? (read.tasks[t.id] ?? []) : [] })),
    });
  };
  let overlapMoved = events.some((e) => e.overlap);

  const plan = planBoard(held.version, events);
  if (plan.kind === "none") {
    if (!overlapMoved) return;
    /* A hidden tab fetches nothing. The task modal's overlap is under the board's key too. */
    if (hidden) return whole();
    void queryClient.invalidateQueries({ queryKey: [...key, "overlap"], refetchType });
    return patchOverlap();
  }
  /* A hidden tab fetches nothing, and an edit of this tab's own in flight would be overwritten by a patch. */
  if (plan.kind === "whole" || hidden || queryClient.isMutating() > 0) return whole();

  /* Behind: what changed since the version held, from the board (COPL-210), rather than the board whole. */
  let read: Array<[string, TaskRead | null]> | undefined;
  let version: number;
  let named: string[];
  if (plan.kind === "behind") {
    let delta: BoardChanges;
    try {
      delta = await reads.changes(boardId, held.version);
    } catch {
      return whole();
    }
    if (delta.whole) return whole();
    read = [...delta.tasks.map((t) => [t.id, t] as [string, TaskRead]), ...delta.gone.map((id) => [id, null] as [string, null])];
    named = read.map(([id]) => id);
    version = delta.version;
    /* A changed-files report has no version, so the log can't say whether one was missed: on a board with code, read the overlap again. */
    if (held.repos.length > 0) overlapMoved = true;
  } else {
    named = plan.tasks;
    version = plan.version;
  }

  for (const id of named) {
    void queryClient.invalidateQueries({ queryKey: COMMENTS_KEY(id), refetchType });
    void queryClient.invalidateQueries({ queryKey: EVENTS_KEY(id), refetchType });
  }
  /* The overlap, older closed pages and stray tasks under the board's key, each refetched if on screen. */
  for (const under of ["overlap", "closed", "task"]) void queryClient.invalidateQueries({ queryKey: [...key, under], refetchType });

  if (!read) {
    try {
      read = await Promise.all(named.map(async (id) => [id, await reads.task(id)] as [string, TaskRead | null]));
    } catch {
      return whole();
    }
  }

  const now = queryClient.getQueryData<BoardDetail>(key);
  /* A whole read landed meanwhile: it has these already when it is as new as they are. */
  if (!now || now.version !== held.version) {
    if (!now || now.version < version) whole();
    return;
  }
  const cached = new Map(now.tasks.map((t) => [t.id, t]));
  const byId = new Map(cached);
  const isNamed = new Set(named);
  /* Everything above a task, as the tab held them, named with it: their progress came with them. */
  const aboveNamed = (...parents: Array<string | null>) => [...above(cached, parents)].every((p) => isNamed.has(p));
  const progress: Record<string, ParentProgress> = { ...now.progress };
  const recentCutoff = new Date(Date.now() - RECENT_CLOSED_DAYS * 86_400_000).toISOString();
  for (const [id, fresh] of read) {
    const before = cached.get(id);
    /* Gone, or another board's (a stray id): not this board's to hold. */
    if (!fresh || fresh.boardId !== boardId) {
      if (before?.parentId && !aboveNamed(before.parentId)) return whole();
      byId.delete(id);
      delete progress[id];
      continue;
    }
    const { progress: counted, ...task } = fresh;
    if (beyondPatch(cached, before, task)) return whole();
    if (movesOverlap(now, before, task)) overlapMoved = true;
    /* Everything above it, before and after, must have come with its new progress. */
    if (movesProgress(now, before, task) && !aboveNamed(before?.parentId ?? null, task.parentId)) return whole();
    if (counted) progress[id] = counted;
    else delete progress[id];
    /* Closed long ago, and so not in the read: stays out. One closed lately is in it. */
    if (!before && !isOpen(task) && task.completedAt! < recentCutoff) continue;
    byId.set(id, { ...task, overlap: before?.overlap ?? [] });
  }
  queryClient.setQueryData<BoardDetail>(key, { ...now, tasks: [...byId.values()], progress, version });
  if (overlapMoved) await patchOverlap();
}
