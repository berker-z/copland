/* ============================================================================
   Task writes, optimistic.
   ----------------------------------------------------------------------------
   The board cache (["board", id]) changes the moment you act: a checkbox
   ticks, a card lands in its new column, a new task appears. The request
   follows. On failure the cache is put back as it was; on either outcome the
   board is refetched, because the cache is a view of the server and not the
   truth. This is the fix for nord-dash's todo list, which waited for a
   Firestore transaction before anything moved.

   The rules the server applies (completed_at follows the stage, parents
   follow their children) are applied here too, from domain/tasks.ts, so the
   optimistic state and the response agree and nothing flickers.
   ========================================================================== */

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { defaultStage, followUp, isClosing } from "@/domain/tasks";
import type { BoardDetail, Task, TaskWrite } from "@/domain/types";
import { send } from "./api";
import { KEYS } from "./queries";

export type TaskPatch = Partial<
  Pick<
    Task,
    | "title"
    | "brief"
    | "stageId"
    | "rank"
    | "priority"
    | "startDate"
    | "dueDate"
    | "assigneeIds"
    | "labelIds"
    | "parentId"
    | "level"
    | "dependsOn"
  >
>;

export interface NewTask extends TaskPatch {
  title: string;
}

/** Apply a patch to a task the way the server will. */
function applyPatch(detail: BoardDetail, task: Task, patch: TaskPatch): Task {
  const next: Task = { ...task, ...patch, updatedAt: new Date().toISOString() };
  if (patch.stageId !== undefined && patch.stageId !== task.stageId) {
    const stage = detail.stages.find((s) => s.id === patch.stageId);
    next.completedAt = stage && isClosing(stage.category) ? (task.completedAt ?? new Date().toISOString()) : null;
    if (patch.rank === undefined) {
      const ranks = detail.tasks.filter((t) => t.stageId === patch.stageId).map((t) => t.rank);
      next.rank = ranks.length ? Math.max(...ranks) + 1 : 0;
    }
  }
  return next;
}

/**
 * Move parents the way the server will once `tasks` (the board after a
 * change) is written: `parents` are the ones to look at again.
 */
function follow(detail: BoardDetail, tasks: Task[], parents: Array<string | null>): Task[] {
  const starts = [...new Set(parents)].map((parentId) => ({ parentId, childId: "" }));
  const moves = followUp(tasks, detail.stages, starts);
  if (moves.length === 0) return tasks;
  const out = [...tasks];
  for (const move of moves) {
    const i = out.findIndex((t) => t.id === move.id);
    if (i >= 0) out[i] = applyPatch({ ...detail, tasks: out }, out[i], { stageId: move.to });
  }
  return out;
}

/** Snapshot, then edit, the cached board. Returns the snapshot for rollback. */
async function editBoard(
  queryClient: QueryClient,
  boardId: string,
  edit: (detail: BoardDetail) => BoardDetail,
): Promise<BoardDetail | undefined> {
  const key = KEYS.board(boardId);
  /* A refetch landing after this edit would undo it on screen. */
  await queryClient.cancelQueries({ queryKey: key });
  const previous = queryClient.getQueryData<BoardDetail>(key);
  if (previous) queryClient.setQueryData<BoardDetail>(key, edit(previous));
  return previous;
}

function settle(queryClient: QueryClient, boardId: string) {
  void queryClient.invalidateQueries({ queryKey: KEYS.board(boardId) });
  /* Open-task counts in the boards list. */
  void queryClient.invalidateQueries({ queryKey: KEYS.boards });
  /* An assignee changed, or a task came or went: whose work is whose may have too. */
  void queryClient.invalidateQueries({ queryKey: KEYS.myWork });
}

export function useCreateTask(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NewTask) => send<TaskWrite>("POST", `/boards/${boardId}/tasks`, input),
    onMutate: async (input) => {
      const tempId = `temp-${crypto.randomUUID()}`;
      const previous = await editBoard(queryClient, boardId, (detail) => {
        const stageId = input.stageId ?? defaultStage(detail.stages)?.id ?? "";
        const ranks = detail.tasks.filter((t) => t.stageId === stageId).map((t) => t.rank);
        const stage = detail.stages.find((s) => s.id === stageId);
        const now = new Date().toISOString();
        const draft: Task = {
          id: tempId,
          boardId,
          number: 0,
          key: `${detail.board.key}-…`,
          title: input.title,
          brief: input.brief ?? "",
          stageId,
          rank: input.rank ?? (ranks.length ? Math.max(...ranks) + 1 : 0),
          priority: input.priority ?? "normal",
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          completedAt: stage && isClosing(stage.category) ? now : null,
          parentId: input.parentId ?? null,
          level: input.level ?? null,
          assigneeIds: input.assigneeIds ?? [],
          labelIds: input.labelIds ?? [],
          dependsOn: input.dependsOn ?? [],
          commentCount: 0,
          attachments: [],
          claim: null,
          createdBy: "",
          createdAt: now,
          updatedAt: now,
        };
        return { ...detail, tasks: follow(detail, [...detail.tasks, draft], [draft.parentId]) };
      });
      return { previous, tempId };
    },
    onSuccess: ({ alsoMoved: _moved, ...task }, _input, context) => {
      /* Swap the draft for the real row so its key and number show at once. */
      queryClient.setQueryData<BoardDetail>(KEYS.board(boardId), (detail) =>
        detail ? { ...detail, tasks: detail.tasks.map((t) => (t.id === context?.tempId ? task : t)) } : detail,
      );
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(KEYS.board(boardId), context.previous);
    },
    onSettled: () => settle(queryClient, boardId),
  });
}

/**
 * Change a task on `boardId`, or, with no board given here, on the board
 * each call names (`boardId` in the variables): the /tasks pane holds tasks
 * from several boards.
 */
export function useUpdateTask(boardId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TaskPatch; boardId?: string }) =>
      send<TaskWrite>("PATCH", `/tasks/${id}`, patch),
    onMutate: async ({ id, patch, boardId: on }) => {
      const board = on ?? boardId ?? "";
      const previous = await editBoard(queryClient, board, (detail) => {
        const before = detail.tasks.find((t) => t.id === id);
        const tasks = detail.tasks.map((t) => (t.id === id ? applyPatch(detail, t, patch) : t));
        /* A new stage or parent moves parents, as on the server. */
        const moves = before && (patch.stageId !== undefined || patch.parentId !== undefined);
        return {
          ...detail,
          tasks: moves ? follow(detail, tasks, [before.parentId, patch.parentId ?? null]) : tasks,
        };
      });
      return { previous, board };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(KEYS.board(context.board), context.previous);
    },
    onSettled: (_data, _error, vars) => settle(queryClient, vars.boardId ?? boardId ?? ""),
  });
}

export function useDeleteTask(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => send("DELETE", `/tasks/${id}`),
    onMutate: async (id) => {
      const previous = await editBoard(queryClient, boardId, (detail) => {
        const parentId = detail.tasks.find((t) => t.id === id)?.parentId ?? null;
        /* Its children lose their parent, as on the server, and its own parent may close. */
        const tasks = detail.tasks
          .filter((t) => t.id !== id)
          .map((t) => (t.parentId === id ? { ...t, parentId: null } : t));
        return { ...detail, tasks: follow(detail, tasks, [parentId]) };
      });
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) queryClient.setQueryData(KEYS.board(boardId), context.previous);
    },
    onSettled: () => settle(queryClient, boardId),
  });
}

/** Tasks of one stage, in board order. */
export function tasksIn(detail: BoardDetail, stageId: string): Task[] {
  return detail.tasks.filter((t) => t.stageId === stageId).sort((a, b) => a.rank - b.rank || a.number - b.number);
}
