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
   stale). Overlap (task.overlap) is the board read's own: a patched task
   keeps the overlap it had, and a task closing or reopening on a board with
   code, which changes who overlaps, reads the board whole.

   One board's events are applied one batch after another, so a batch never
   starts from a version the batch before it is about to move.
   ========================================================================== */

import type { QueryClient } from "@tanstack/react-query";
import { planBoard, type BoardChange } from "@/domain/live";
import type { BoardDetail, Task } from "@/domain/types";
import { COMMENTS_KEY, EVENTS_KEY } from "./boardEdits";
import { KEYS } from "./queries";

/** One task's read (GET /api/tasks/:id), or null when it is gone (404). */
export type FetchTask = (id: string) => Promise<Task | null>;

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
  const plan = planBoard(held?.version, events);
  if (plan.kind === "none") return;
  /* A hidden tab fetches nothing, and an edit of this tab's own in flight would be overwritten by a patch. */
  if (plan.kind === "whole" || hidden || !held || queryClient.isMutating() > 0) return whole();

  for (const id of plan.tasks) {
    void queryClient.invalidateQueries({ queryKey: COMMENTS_KEY(id), refetchType });
    void queryClient.invalidateQueries({ queryKey: EVENTS_KEY(id), refetchType });
  }
  void queryClient.invalidateQueries({ queryKey: [...key, "overlap"], refetchType });

  let read: Array<[string, Task | null]>;
  try {
    read = await Promise.all(plan.tasks.map(async (id) => [id, await fetchTask(id)] as [string, Task | null]));
  } catch {
    return whole();
  }

  const now = queryClient.getQueryData<BoardDetail>(key);
  /* A whole read landed meanwhile: it has these already when it is as new as they are. */
  if (!now || now.version !== held.version) {
    if (!now || now.version < plan.version) whole();
    return;
  }
  const byId = new Map(now.tasks.map((t) => [t.id, t]));
  const gone = new Set<string>();
  for (const [id, task] of read) {
    const before = byId.get(id);
    /* Another board's task (moved boards, or a stray id) is not this board's to hold. */
    if (!task || task.boardId !== boardId) {
      gone.add(id);
      continue;
    }
    if (before && isOpen(before) !== isOpen(task) && now.repos.length > 0) return whole();
    byId.set(id, { ...task, overlap: before?.overlap ?? [] });
  }
  for (const id of gone) byId.delete(id);
  queryClient.setQueryData<BoardDetail>(key, { ...now, tasks: [...byId.values()], version: plan.version });
}
