/* ============================================================================
   Everything on a board besides tasks: stages, labels, comments, history.
   These are less frequent than task moves, so they are not optimistic: the
   request goes, then the board (or the comment list) refetches. Comments
   are the exception worth making feel instant, and they are, because the
   POST answers with the new list and that goes straight into the cache.
   ========================================================================== */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Comment, Label, StageCategory, TaskEvent } from "@/domain/types";
import { api, send } from "./api";
import { KEYS } from "./queries";

export const COMMENTS_KEY = (taskId: string) => ["comments", taskId];
export const EVENTS_KEY = (taskId: string) => ["events", taskId];

function useRefreshBoard(boardId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: KEYS.board(boardId) });
    void queryClient.invalidateQueries({ queryKey: KEYS.boards });
  };
}

/* --------------------------------------------------------------- stages -- */

export function useStageEdits(boardId: string) {
  const refresh = useRefreshBoard(boardId);
  return {
    add: useMutation({
      mutationFn: (input: { name: string; category: StageCategory; tone: number }) =>
        send("POST", `/boards/${boardId}/stages`, input),
      onSettled: refresh,
    }),
    patch: useMutation({
      mutationFn: ({ id, ...patch }: { id: string; name?: string; category?: StageCategory; tone?: number }) =>
        send("PATCH", `/stages/${id}`, patch),
      onSettled: refresh,
    }),
    reorder: useMutation({
      mutationFn: (ids: string[]) => send("PUT", `/boards/${boardId}/stages/order`, { ids }),
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: ({ id, moveTo }: { id: string; moveTo: string }) =>
        send("DELETE", `/stages/${id}?moveTo=${encodeURIComponent(moveTo)}`),
      onSettled: refresh,
    }),
  };
}

/* --------------------------------------------------------------- labels -- */

export function useLabelEdits(boardId: string) {
  const refresh = useRefreshBoard(boardId);
  return {
    add: useMutation({
      mutationFn: (input: { name: string; tone?: number }) => send<Label>("POST", `/boards/${boardId}/labels`, input),
      onSettled: refresh,
    }),
    patch: useMutation({
      mutationFn: ({ id, ...patch }: { id: string; name?: string; tone?: number }) => send("PATCH", `/labels/${id}`, patch),
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => send("DELETE", `/labels/${id}`),
      onSettled: refresh,
    }),
  };
}

/* ------------------------------------------------------------- comments -- */

export const useComments = (taskId: string) =>
  useQuery({ queryKey: COMMENTS_KEY(taskId), queryFn: () => api<Comment[]>(`/tasks/${taskId}/comments`) });

export const useTaskEvents = (taskId: string, enabled: boolean) =>
  useQuery({ queryKey: EVENTS_KEY(taskId), queryFn: () => api<TaskEvent[]>(`/tasks/${taskId}/events`), enabled });

export function useCommentEdits(boardId: string, taskId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshBoard(boardId);
  const done = (comments: Comment[]) => {
    queryClient.setQueryData(COMMENTS_KEY(taskId), comments);
    void queryClient.invalidateQueries({ queryKey: EVENTS_KEY(taskId) });
    /* The comment count on the card. */
    refresh();
  };
  return {
    add: useMutation({
      mutationFn: (text: string) => send<Comment[]>("POST", `/tasks/${taskId}/comments`, { text }),
      onSuccess: done,
    }),
    edit: useMutation({
      mutationFn: ({ id, text }: { id: string; text: string }) => send<Comment[]>("PATCH", `/comments/${id}`, { text }),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => send<Comment[]>("DELETE", `/comments/${id}`),
      onSuccess: done,
    }),
  };
}
