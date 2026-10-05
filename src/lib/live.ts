/* ============================================================================
   Live updates, the listening side.
   ----------------------------------------------------------------------------
   One WebSocket per tab to /api/live, which lands in this user's hub. When a
   write that concerns this user succeeds anywhere (another tab, another
   device, a friend on a shared board), the Worker sends the topics it
   touched and this refetches the queries under them.

   The message carries no data, only "this kind of thing changed" and, for
   a board, which board and which tasks (COPL-151): the refetch goes through
   the API like any other read. A board event that names its tasks
   refetches those and patches them into the cached board (lib/boardPatch.ts);
   one that names a board but no tasks reads that board whole; one that
   names no board (an older Worker) reads every board, as before. The boards
   list refetches only on "boards". A tab ignores its own writes, which it
   has already applied.

   While the socket is up the fallback polls stop (isLive). When it drops
   they start again and it reconnects with backoff; once it is back,
   everything on screen is refetched, once. A hidden tab closes its socket,
   marks things stale without fetching, and reconnects and catches up when
   it is shown again. The socket's life is in lib/liveSocket.ts; this file
   is what its messages mean.
   ========================================================================== */

import { useEffect } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { BoardChange, LiveEvent, LiveTopic } from "@/domain/live";
import type { Task } from "@/domain/types";
import { api, ApiError } from "./api";
import { applyBoardEvents, type FetchTask } from "./boardPatch";
import { KEYS } from "./queries";
import { setCatchingUp, setLive, TAB_ID } from "./liveState";
import { listen } from "./liveSocket";

const TOPIC_KEYS: Record<LiveTopic, QueryKey[]> = {
  boards: [KEYS.boards],
  /* Comments and history live under their own keys but change with the board.
     Only for an event that doesn't say which board: see boardRefresh. */
  board: [KEYS.boardAll, ["comments"], ["events"]],
  settings: [KEYS.settings],
  vault: [KEYS.vault],
  notes: [KEYS.notes],
  calendar: [["calendar"]],
  /* /me too: being made or unmade an admin arrives on this topic. */
  admin: [KEYS.admin, KEYS.me],
  tokens: [KEYS.tokens],
  inbox: [KEYS.inbox],
  /* The wired and nudge panes list your agents too. */
  agents: [KEYS.agents, KEYS.wired, KEYS.recipients],
  /* Handles and pictures show in boards, comments, history, the people page and the share search. */
  people: [KEYS.me, KEYS.boardAll, ["comments"], ["events"], KEYS.adminUsers, ["people"]],
};

/* Several writes in a burst (a drag across stages, an assistant filing ten
   tasks) become one refetch. */
const COALESCE_MS = 300;

/** Refetch what these topics cover. Also for a tab's own writes that touch more than the query it changed. */
export function refresh(queryClient: QueryClient, topics: Iterable<LiveTopic>): void {
  const keys = new Map<string, QueryKey>();
  for (const topic of topics) for (const key of TOPIC_KEYS[topic] ?? []) keys.set(JSON.stringify(key), key);
  const refetchType = document.hidden ? "none" : "active";
  for (const queryKey of keys.values()) void queryClient.invalidateQueries({ queryKey, refetchType });
}

/* What reads tasks across boards: refetched on any board event, which can change whose work is whose. */
const ACROSS_BOARDS = [KEYS.myWork, KEYS.wired, KEYS.recipients];

const fetchTask: FetchTask = (id) =>
  api<Task>(`/tasks/${encodeURIComponent(id)}`).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });

/** Board events that say which board: each board patched or read on its own, and what reads across boards. */
function boardRefresh(queryClient: QueryClient, byBoard: Map<string, BoardChange[]>): void {
  const hidden = document.hidden;
  for (const queryKey of ACROSS_BOARDS) void queryClient.invalidateQueries({ queryKey, refetchType: hidden ? "none" : "active" });
  for (const [boardId, events] of byBoard) void applyBoardEvents(queryClient, fetchTask, boardId, events, hidden);
}

export function useLiveUpdates(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof WebSocket === "undefined") return;

    let flush: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<LiveTopic>();
    /* Board events that said which board, by board; a "board" topic in pending is one that didn't. */
    const boards = new Map<string, BoardChange[]>();

    const message = (data: string) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(data) as LiveEvent;
      } catch {
        return;
      }
      if (event.tab === TAB_ID || !Array.isArray(event.topics)) return;
      for (const topic of event.topics) {
        if (topic === "board" && typeof event.board === "string") {
          const { topics: _topics, tab: _tab, ...change } = event;
          boards.set(event.board, [...(boards.get(event.board) ?? []), change as BoardChange]);
        } else pending.add(topic);
      }
      flush ??= setTimeout(() => {
        flush = undefined;
        /* A board event that named no board reads every board, which covers the ones that did. */
        if (!pending.has("board")) boardRefresh(queryClient, boards);
        refresh(queryClient, pending);
        pending.clear();
        boards.clear();
      }, COALESCE_MS);
    };

    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const stop = listen(queryClient, {
      open: () => new WebSocket(`${scheme}//${location.host}/api/live`),
      hidden: () => document.hidden,
      on: (event, listener) => {
        const target = event === "visibilitychange" ? document : window;
        target.addEventListener(event, listener);
        return () => target.removeEventListener(event, listener);
      },
      setLive,
      setCatchingUp,
      message,
    });
    return () => {
      stop();
      clearTimeout(flush);
    };
  }, [enabled, queryClient]);
}
