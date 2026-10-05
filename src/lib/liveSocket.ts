/* ============================================================================
   The live socket's life, apart from lib/live.ts so a check can drive it
   with a fake socket, page and query client (checks/live.check.ts).
   ----------------------------------------------------------------------------
   A visible tab keeps one socket open. While it is up the fallback polls
   stand down. When it drops, the polls come back, it reconnects with
   backoff, and once it is open again everything on screen is refetched,
   once: whatever changed meanwhile was never sent to us.

   A hidden tab lets go of its socket (Chromium wakes a background tab about
   once a minute and the socket dies each time anyway). It marks everything
   stale without fetching and stays quiet: no socket, no retries, and no
   polls, which React Query skips in a hidden tab. Shown again, it
   reconnects at once and catches up as above. A socket closed on purpose
   is not a failure: no backoff, no refetch.

   The live socket owns catching up, so while it runs React Query's own
   refetch on focus and on reconnect stand down (liveCatchesUp, read in
   main.tsx); otherwise showing the tab would fetch everything twice.
   ========================================================================== */

import type { QueryClient } from "@tanstack/react-query";

/** The part of a WebSocket this uses. */
export interface LiveSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}

export interface LivePage {
  open(): LiveSocket;
  hidden(): boolean;
  /** Listens for visibilitychange on the document or online on the window; returns the unsubscribe. */
  on(event: "visibilitychange" | "online", listener: () => void): () => void;
  setLive(value: boolean): void;
  setCatchingUp(value: boolean): void;
  message(data: string): void;
}

const OPEN = 1;
const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * The polls' interval (fallbackPoll in queries.ts) is read when a query
 * updates. Re-reading every observer's options turns them on or off now,
 * without fetching anything.
 */
function rereadPolls(queryClient: QueryClient): void {
  for (const query of queryClient.getQueryCache().getAll()) for (const observer of query.observers) observer.setOptions(observer.options);
}

/** Opens the live socket and keeps it as above; returns the stop. */
export function listen(queryClient: QueryClient, page: LivePage): () => void {
  let socket: LiveSocket | null = null;
  let stopped = false;
  let attempts = 0;
  /* Something may have changed that was never sent to us: refetch once the socket is open. */
  let behind = false;
  /* The tab was shown and React Query left the refetch to us: if the socket fails before
     it opens, refetch what's on screen anyway. */
  let owed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;

  const down = () => {
    page.setLive(false);
    rereadPolls(queryClient);
  };

  const connect = () => {
    const ws = page.open();
    socket = ws;

    ws.onopen = () => {
      attempts = 0;
      page.setLive(true);
      owed = false;
      if (behind) {
        behind = false;
        /* Refetching also re-reads the polls' interval, which stands them down. */
        void queryClient.invalidateQueries();
      } else rereadPolls(queryClient);
      ping = setInterval(() => ws.readyState === OPEN && ws.send("ping"), PING_MS);
    };

    ws.onmessage = ({ data }) => {
      if (typeof data === "string" && data !== "pong") page.message(data);
    };

    ws.onclose = () => {
      clearInterval(ping);
      /* Closed on purpose: hidden or stopped. */
      if (socket !== ws) return;
      socket = null;
      behind = true;
      down();
      if (owed) {
        owed = false;
        void queryClient.refetchQueries({ type: "active" });
      }
      if (stopped) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts) * (0.5 + Math.random() / 2);
      attempts += 1;
      retry = setTimeout(connect, delay);
    };
  };

  /* Let go on purpose: onclose sees the socket is no longer ours and does nothing. */
  const letGo = () => {
    clearTimeout(retry);
    clearInterval(ping);
    const ws = socket;
    socket = null;
    ws?.close(1000);
  };

  const hide = () => {
    letGo();
    attempts = 0;
    owed = false;
    behind = true;
    page.setLive(false);
    void queryClient.invalidateQueries({ refetchType: "none" });
  };

  const onVisibility = () => {
    if (stopped) return;
    if (page.hidden()) {
      hide();
      return;
    }
    if (socket) return;
    clearTimeout(retry);
    attempts = 0;
    owed = true;
    connect();
  };

  /* A laptop waking up or a phone coming back online: try now, not after the backoff. */
  const onOnline = () => {
    if (socket || stopped || page.hidden()) return;
    clearTimeout(retry);
    attempts = 0;
    connect();
  };

  page.setCatchingUp(true);
  const offVisibility = page.on("visibilitychange", onVisibility);
  const offOnline = page.on("online", onOnline);
  if (page.hidden()) hide();
  else connect();

  return () => {
    stopped = true;
    page.setLive(false);
    page.setCatchingUp(false);
    offVisibility();
    offOnline();
    letGo();
  };
}
