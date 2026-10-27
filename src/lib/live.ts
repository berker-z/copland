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
   one that says only overlap moved reads the board's overlap (COPL-207);
   one that names a board but no tasks reads that board whole; one that
   names no board (an older Worker) reads every board, as before. The boards
   list refetches only on "boards". A tab ignores its own writes, which it
   has already applied.

   With agents busy a board sends far more events than a tab need act on:
   each board acts at most once every few seconds (lib/liveWindow.ts),
   gathering whatever arrived meanwhile into one patch or one read. What
   reads across boards (my work, wired, recipients) and every other topic
   are a lane each, held to the same window.

   While the socket is up the fallback polls stop (isLive). When it drops
   they start again and it reconnects with backoff; once it is back,
   what's on screen is caught up, once, through the same lanes. A hidden tab closes its socket,
   marks things stale without fetching, and reconnects and catches up when
   it is shown again. The socket's life is in lib/liveSocket.ts; this file
   is what its messages mean.
   ========================================================================== */

import { useEffect } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { BoardChange, LiveEvent, LiveTopic } from "@/domain/live";
import { applyBoardEvents } from "./boardPatch";
import { fetchOverlap, fetchTask, KEYS } from "./queries";
import { setCatchingUp, setLive, TAB_ID } from "./liveState";
import { listen } from "./liveSocket";
import { catchUpLanes, lanes } from "./liveWindow";

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

/** Refetch what these topics cover. Also for a tab's own writes that touch more than the query it changed. */
export function refresh(queryClient: QueryClient, topics: Iterable<LiveTopic>): void {
  const keys = new Map<string, QueryKey>();
  for (const topic of topics) for (const key of TOPIC_KEYS[topic] ?? []) keys.set(JSON.stringify(key), key);
  const refetchType = document.hidden ? "none" : "active";
  for (const queryKey of keys.values()) void queryClient.invalidateQueries({ queryKey, refetchType });
}

/* What reads tasks across boards: refetched on any board event, which can change whose work is whose. */
const ACROSS_BOARDS = [KEYS.myWork, KEYS.wired, KEYS.recipients];

/* The lane for every topic but a board's: "*" in it is a catch-up's everything else. */
const TOPICS = "topics";
type Gathered = LiveTopic | "*";
/* A board's, and read again with it: threads and history only show with a board's query on screen (a task modal is one). */
const WITH_BOARD = new Set(["board", "comments", "events"]);

/** A catch-up's share outside the board lanes: every query that is not a board's, refetched if on screen. */
function refreshRest(queryClient: QueryClient): void {
  const refetchType = document.hidden ? "none" : "active";
  void queryClient.invalidateQueries({ refetchType, predicate: ({ queryKey: [head] }) => !WITH_BOARD.has(head as string) });
}

export function useLiveUpdates(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof WebSocket === "undefined") return;

    /* Each board's events, by board: patched or read on its own, at most once a window (lib/liveWindow.ts). */
    const boards = lanes<BoardChange>((boardId, events) => void applyBoardEvents(queryClient, { task: fetchTask, overlap: fetchOverlap }, boardId, events, document.hidden));
    /* What reads across boards (only ever one lane), and every other topic (one lane too). */
    const across = lanes<never>(() => {
      for (const queryKey of ACROSS_BOARDS) void queryClient.invalidateQueries({ queryKey, refetchType: document.hidden ? "none" : "active" });
    });
    const topics = lanes<Gathered>((_lane, gathered) => {
      const all = new Set(gathered);
      if (all.delete("*")) refreshRest(queryClient);
      refresh(queryClient, all as Set<LiveTopic>);
    });

    /* Everything on screen, through the lanes: each board held, what reads across boards, the rest. */
    const catchUp = () => {
      /* Whatever isn't on screen is fetched when it next shows. */
      void queryClient.invalidateQueries({ refetchType: "none" });
      const on = catchUpLanes(
        queryClient
          .getQueryCache()
          .getAll()
          .filter((q) => q.isActive())
          .map((q) => q.queryKey),
      );
      for (const boardId of on.boards) boards.add(boardId, [{ board: boardId }]);
      if (on.across) across.add("", []);
      topics.add(TOPICS, ["*"]);
    };

    const message = (data: string) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(data) as LiveEvent;
      } catch {
        return;
      }
      if (event.tab === TAB_ID || !Array.isArray(event.topics)) return;
      const rest: LiveTopic[] = [];
      for (const topic of event.topics) {
        if (topic === "board" && typeof event.board === "string") {
          /* Any board event can change whose work is whose. */
          const { topics: _topics, tab: _tab, ...change } = event;
          boards.add(event.board, [change as BoardChange]);
          across.add("", []);
        } else rest.push(topic);
      }
      /* A "board" among them named no board (an older Worker): refresh reads every board for it. */
      if (rest.length) topics.add(TOPICS, rest);
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
      catchUp,
    });
    return () => {
      stop();
      boards.stop();
      across.stop();
      topics.stop();
    };
  }, [enabled, queryClient]);
}
