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

   While the socket is up the fallback polls stop (isLive); when it drops
   they start again, everything on screen is refetched, and it reconnects
   with backoff. A hidden tab only marks things stale and catches up when it
   is looked at again.
   ========================================================================== */

import { useEffect } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { LiveEvent, LiveTopic } from "@/domain/live";
import { KEYS } from "./queries";
import { isLive, setLive, TAB_ID } from "./liveState";

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
const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

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

    let socket: WebSocket | null = null;
    let stopped = false;
    let attempts = 0;
    let everConnected = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<LiveTopic>();

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${scheme}//${location.host}/api/live`);
      socket = ws;

      ws.onopen = () => {
        attempts = 0;
        setLive(true);
        /* Whatever changed while we were away was never sent to us. */
        if (everConnected) void queryClient.invalidateQueries();
        everConnected = true;
        ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), PING_MS);
      };

      ws.onmessage = ({ data }) => {
        if (typeof data !== "string" || data === "pong") return;
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

      ws.onclose = () => {
        clearInterval(ping);
        if (socket !== ws) return;
        socket = null;
        if (isLive()) {
          setLive(false);
          /* Refetching also puts the polls back on: their interval is re-read
             when the query updates. */
          void queryClient.refetchQueries({ type: "active" });
        }
        if (stopped) return;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts) * (0.5 + Math.random() / 2);
        attempts += 1;
        retry = setTimeout(connect, delay);
      };
    };

    /* A laptop waking up or a phone coming back online: try now, not after
       the backoff. */
    const onOnline = () => {
      if (socket || stopped) return;
      clearTimeout(retry);
      attempts = 0;
      connect();
    };

    connect();
    window.addEventListener("online", onOnline);
    return () => {
      stopped = true;
      setLive(false);
      window.removeEventListener("online", onOnline);
      clearTimeout(retry);
      clearTimeout(flush);
      clearInterval(ping);
      const ws = socket;
      socket = null;
      ws?.close();
    };
  }, [enabled, queryClient]);
}
