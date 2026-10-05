/* ============================================================================
   Live updates, the listening side.
   ----------------------------------------------------------------------------
   One WebSocket per tab to /api/live, which lands in this user's hub. When a
   write that concerns this user succeeds anywhere (another tab, another
   device, a friend on a shared board), the Worker sends the topics it
   touched and this refetches the queries under them.

   The message carries no data, only "this kind of thing changed": the
   refetch goes through the API like any other read. A tab ignores its own
   writes, which it has already applied.

   While the socket is up the fallback polls stop (isLive). When it drops
   they start again and it reconnects with backoff; once it is back,
   everything on screen is refetched, once. A hidden tab closes its socket,
   marks things stale without fetching, and reconnects and catches up when
   it is shown again. The socket's life is in lib/liveSocket.ts; this file
   is what its messages mean.
   ========================================================================== */

import { useEffect } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { LiveEvent, LiveTopic } from "@/domain/live";
import { KEYS } from "./queries";
import { setCatchingUp, setLive, TAB_ID } from "./liveState";
import { listen } from "./liveSocket";

const TOPIC_KEYS: Record<LiveTopic, QueryKey[]> = {
  boards: [KEYS.boards],
  /* Comments and history live under their own keys but change with the board. */
  board: [KEYS.boardAll, KEYS.boards, ["comments"], ["events"]],
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

export function useLiveUpdates(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof WebSocket === "undefined") return;

    let flush: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<LiveTopic>();

    const message = (data: string) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(data) as LiveEvent;
      } catch {
        return;
      }
      if (event.tab === TAB_ID || !Array.isArray(event.topics)) return;
      for (const topic of event.topics) pending.add(topic);
      flush ??= setTimeout(() => {
        flush = undefined;
        refresh(queryClient, pending);
        pending.clear();
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
