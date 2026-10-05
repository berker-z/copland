/* ============================================================================
   Query definitions: every server read the app makes, with its key.
   Components use these hooks rather than calling api() for reads, so a key
   is spelled once and lib/live.ts can refetch by it.
   ========================================================================== */

import { useMemo, useState } from "react";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskOverlapRead } from "@/domain/overlap";
import type { MarketExtras, Note } from "@/domain/panes";
import type { Settings, VaultEntry } from "@/domain/settings";
import type {
  Agent,
  ApiToken,
  BoardDetail,
  BoardShell,
  BoardSummary,
  ClosedPage,
  Inbox,
  Invite,
  Me,
  MyWork,
  Person,
  Recipient,
  Task,
  TaskRead,
  User,
  Wired,
} from "@/domain/types";
import { api, ApiError } from "./api";
import { isLive } from "./liveState";

export const KEYS = {
  me: ["me"],
  settings: ["settings"],
  vault: ["vault"],
  boards: ["boards"],
  board: (id: string) => ["board", id],
  /* Under its board's key: the report route notifies the board, and a task closing changes who overlaps. */
  taskOverlap: (boardId: string, taskId: string) => ["board", boardId, "overlap", taskId],
  /* Also under its board's key, so whatever refetches the board refetches these with it. */
  boardClosed: (id: string) => ["board", id, "closed"],
  boardShell: (id: string) => ["board", id, "shell"],
  boardTask: (id: string, ref: string) => ["board", id, "task", ref],
  boardAll: ["board"],
  /* Under "board" on purpose: whatever changes a board can change whose work is whose. */
  myWork: ["board", "~mine"],
  /* The same, for the /wired pane: task moves, claims and run endings all arrive as "board". */
  wired: ["board", "~wired"],
  /* The nudge pane's list: board membership and runs arrive as "board", your agents' settings as "agents". */
  recipients: ["board", "~recipients"],
  admin: ["admin"],
  adminUsers: ["admin", "users"],
  adminInvites: ["admin", "invites"],
  notes: ["notes"],
  tokens: ["tokens"],
  agents: ["agents"],
  inbox: ["inbox"],
  people: (q: string) => ["people", q],
  /* Keyed on what the Worker will read (the ids in settings, the saved key),
     so changing either refetches without a live topic of its own. */
  marketExtras: (ids: unknown[]) => ["markets", "coingecko", ...ids],
} as const;

/** While the socket is down, poll instead; while it is up, it tells us. */
const fallbackPoll = (ms: number) => () => (isLive() ? false : ms);

export const useMe = () =>
  useQuery({ queryKey: KEYS.me, queryFn: () => api<Me>("/me"), retry: false, staleTime: Infinity });

export const useSettings = (enabled = true) =>
  useQuery({ queryKey: KEYS.settings, queryFn: () => api<Settings>("/settings"), enabled, staleTime: Infinity });

export const useVault = () => useQuery({ queryKey: KEYS.vault, queryFn: () => api<VaultEntry[]>("/vault") });

export const useBoards = () =>
  useQuery({
    queryKey: KEYS.boards,
    queryFn: () => api<BoardSummary[]>("/boards"),
    refetchInterval: fallbackPoll(60_000),
  });

/** What is yours and what you handed to your agents: ids only; the tasks come from their boards. */
export const useMyWork = () =>
  useQuery({ queryKey: KEYS.myWork, queryFn: () => api<MyWork>("/tasks/mine"), refetchInterval: fallbackPoll(60_000) });

/**
 * Your agents' work by pole, for the /wired pane. Polled every minute even
 * while live, since a claim lapsing sends nothing.
 */
export const useWired = () =>
  useQuery({ queryKey: KEYS.wired, queryFn: () => api<Wired>("/wired"), refetchInterval: 60_000 });

/**
 * Whom the nudge pane offers. Polled every minute too: a run starting, or
 * someone else's agent opening to its boards, tells only its owner.
 */
export const useRecipients = () =>
  useQuery({ queryKey: KEYS.recipients, queryFn: () => api<Recipient[]>("/messages/recipients"), refetchInterval: 60_000 });

/** One board's query, for useBoard and for the panes that read several boards at once. */
export const boardQuery = (id: string) => ({
  queryKey: KEYS.board(id),
  queryFn: () => api<BoardDetail>(`/boards/${id}`),
  refetchInterval: fallbackPoll(60_000),
});

export const useBoard = (id: string | null) => useQuery({ ...boardQuery(id ?? ""), enabled: id !== null });

/** One task's read (GET /api/tasks/:id), or null when it is gone (404). */
export const fetchTask = (ref: string): Promise<TaskRead | null> =>
  api<TaskRead>(`/tasks/${encodeURIComponent(ref)}`).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });

/** A task by key or id, under its board's key: whatever refetches the board refetches it too. */
const taskQuery = (boardId: string, ref: string) => ({
  queryKey: KEYS.boardTask(boardId, ref),
  queryFn: () => fetchTask(ref),
  retry: false,
});

/** Whether a task is the one `ref` names: its id, or its key in any case. */
const names = (ref: string) => (t: Task) => t.id === ref || t.key.toUpperCase() === ref.toUpperCase();

/**
 * A board as a screen draws it: its read (useBoard: open tasks, the last
 * RECENT_CLOSED_DAYS' closed ones, and the tasks those name), plus what
 * that leaves out once someone asks for it. With `older`, the tasks closed
 * before that, a page at a time (`closed` fetches the next); with `task`
 * (a key or id, from a link or an inbox item), that one task when it is in
 * neither. The board read's own copy of a task wins, so optimistic edits
 * show. `finding` is true while the named task is still being looked for.
 */
export function useBoardView(id: string | null, { older = false, task = null }: { older?: boolean; task?: string | null } = {}) {
  const board = useBoard(id);
  const closed = useInfiniteQuery({
    queryKey: KEYS.boardClosed(id ?? ""),
    queryFn: ({ pageParam }) => api<ClosedPage>(`/boards/${id}/closed${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    enabled: id !== null && older && board.data?.olderClosed === true,
  });
  const pages = older && board.data?.olderClosed ? (closed.data?.pages ?? []) : [];
  const missing = !!task && !!board.data && !board.data.tasks.some(names(task)) && !pages.some((p) => p.tasks.some(names(task)));
  const stray = useQuery({ ...taskQuery(id ?? "", task ?? ""), enabled: id !== null && missing });
  const found = missing && stray.data?.boardId === id ? stray.data : null;
  const detail = useMemo(() => {
    if (!board.data || (pages.length === 0 && !found)) return board.data;
    const seen = new Set(board.data.tasks.map((t) => t.id));
    const tasks = [...board.data.tasks];
    for (const t of [...pages.flatMap((p) => p.tasks), ...(found ? [found] : [])]) {
      if (!seen.has(t.id)) (seen.add(t.id), tasks.push(t));
    }
    const progress = Object.assign({}, ...pages.map((p) => p.progress), board.data.progress);
    return { ...board.data, tasks, progress };
  }, [board.data, closed.data, older, found]); // pages follows from closed.data and older

  return {
    board,
    detail,
    /* Paging back, while older closed tasks are asked for and there are any. */
    closed: older && board.data?.olderClosed ? closed : null,
    finding: missing && stray.isPending,
  };
}

/**
 * A task opened from outside its board (the inbox, /wired), as TaskModal
 * draws it (COPL-153). A board the tab already holds is used as it is
 * (useBoardView). Otherwise the task comes from its own read, with what
 * the modal needs of the board (GET /api/boards/:id/shell) and the few
 * tasks it names (its parent, what it waits on), not every task on the
 * board. `whole` reads the board too, for the modal's form, whose pickers
 * list the board's tasks; the board's copy takes over once it lands. It
 * all sits under the board's key, so a write that settles the board
 * refetches it, and a live event naming one of these tasks refetches that
 * one (lib/boardPatch.ts). Undefined while loading; a task that is gone
 * (or on another board) is not in what it returns, which closes the modal.
 */
export function useTaskView(boardId: string, taskId: string, whole: boolean): BoardDetail | undefined {
  const queryClient = useQueryClient();
  const [held] = useState(() => queryClient.getQueryData(KEYS.board(boardId)) !== undefined);
  const full = useBoardView(held || whole ? boardId : null, { task: taskId });
  const shell = useQuery({
    queryKey: KEYS.boardShell(boardId),
    queryFn: () => api<BoardShell>(`/boards/${boardId}/shell`),
    enabled: !held,
    refetchInterval: fallbackPoll(60_000),
  });
  const own = useQuery({ ...taskQuery(boardId, taskId), enabled: !held, refetchInterval: fallbackPoll(60_000) });
  const task = own.data?.boardId === boardId ? own.data : null;
  const named = task ? [...new Set([task.parentId, ...task.dependsOn])].filter((id): id is string => id !== null) : [];
  const around = useQueries({ queries: named.map((id) => ({ ...taskQuery(boardId, id), enabled: !held })) });

  if (full.detail && !full.finding) return full.detail;
  if (held || !shell.data || own.isPending || around.some((q) => q.isPending)) return undefined;
  const tasks = task ? [task, ...around.flatMap((q) => (q.data?.boardId === boardId ? [q.data] : []))] : [];
  const progress = task?.progress ? { [task.id]: task.progress } : {};
  return { ...shell.data, tasks, progress, olderClosed: false, notes: "", docs: [] };
}

/** A task's own changed files and the open tasks sharing them (routes/files.ts), for the task modal on a board with code. */
export const useTaskOverlap = (boardId: string, taskId: string, enabled: boolean) =>
  useQuery({
    queryKey: KEYS.taskOverlap(boardId, taskId),
    queryFn: () => api<TaskOverlapRead>(`/tasks/${taskId}/overlap`),
    enabled,
    refetchInterval: fallbackPoll(60_000),
  });

export const useAdminUsers = () =>
  useQuery({
    queryKey: KEYS.adminUsers,
    queryFn: () => api<(User & { disabledAt: string | null })[]>("/admin/users"),
  });

export const useAdminInvites = () =>
  useQuery({ queryKey: KEYS.adminInvites, queryFn: () => api<Invite[]>("/admin/invites") });

/** The inbox, a page at a time (newest first); fetchNextPage follows `next`. */
export const useInbox = () =>
  useInfiniteQuery({
    queryKey: KEYS.inbox,
    queryFn: ({ pageParam }) => api<Inbox>(pageParam ? `/inbox?cursor=${encodeURIComponent(pageParam)}` : "/inbox"),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    /* The pages as one list; the count is the whole inbox's, on every page. */
    select: (data) => ({ unread: data.pages[0]?.unread ?? 0, items: data.pages.flatMap((p) => p.items) }),
    refetchInterval: fallbackPoll(60_000),
  });

export const useTokens = () => useQuery({ queryKey: KEYS.tokens, queryFn: () => api<ApiToken[]>("/tokens") });

export const useAgents = (enabled = true) =>
  useQuery({ queryKey: KEYS.agents, queryFn: () => api<Agent[]>("/agents"), enabled });

/** The share picker's search: people on the instance by handle, never their emails. */
export const usePeople = (q: string, enabled = true) =>
  useQuery({
    queryKey: KEYS.people(q),
    queryFn: () => api<Person[]>(`/people?q=${encodeURIComponent(q)}`),
    enabled,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });

export const useNotes = () =>
  useQuery({ queryKey: KEYS.notes, queryFn: () => api<Note[]>("/notes"), refetchInterval: fallbackPoll(60_000) });

/* CoinGecko's demo plan is rate limited and the Worker caches for
   fifteen minutes, so asking more often would only get the same answer. */
const MARKET_EXTRAS_MS = 15 * 60_000;

export const useMarketExtras = (ids: unknown[], enabled: boolean) =>
  useQuery({
    queryKey: KEYS.marketExtras(ids),
    queryFn: () => api<MarketExtras>("/markets/coingecko"),
    enabled,
    staleTime: MARKET_EXTRAS_MS,
    refetchInterval: MARKET_EXTRAS_MS,
  });
