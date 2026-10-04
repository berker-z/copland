/* ============================================================================
   Live updates: what a write changed, and for whom.
   ----------------------------------------------------------------------------
   Every user has a hub of their own (worker/live.ts) holding their open tabs.
   After a write succeeds, the route names who should hear about it and which
   topics changed; each of those users' tabs refetches what it shows of those
   topics. A personal write reaches only its author's other tabs. A board
   write reaches every member of the board.

   The message names topics and nothing else: no ids, no content. A refetch
   goes through the routes and their access checks like any other read.

   Shared by both sides so the Worker's topics and the client's topic → query
   map cannot disagree about the names.
   ========================================================================== */

export type LiveTopic =
  /** Which boards someone is on, and their names and counts. */
  | "boards"
  /** Anything on a board: tasks, stages, labels, members, comments. */
  | "board"
  | "settings"
  | "vault"
  | "notes"
  /** Calendar connections and events (your own only). */
  | "calendar"
  /** Someone's handle or picture: theirs, and everywhere it is shown. */
  | "people"
  /** Admin screens: users and invites. */
  | "admin"
  /** My API tokens and connected apps (settings). */
  | "tokens"
  /** My agents: their settings, boards, grants and tokens. */
  | "agents"
  /** My inbox: assigned to me, mentioned me. */
  | "inbox";

export interface LiveEvent {
  topics: LiveTopic[];
  /** The tab that made the change, which has already refreshed itself. */
  tab: string | null;
}

/** The request header a tab identifies itself with. */
export const TAB_HEADER = "x-copland-tab";

/**
 * How long a daemon's socket counts as connected after the hub last heard
 * from it: the daemon pings every 30 s and gives a connection up after 75 s
 * of silence (PING_EVERY and SILENCE in daemon/core/src/live.rs), so the
 * hub gives it up at the same mark.
 */
export const LISTENING_SILENCE_MS = 75_000;

/** One open socket in a hub, as listeningTokens weighs it. */
export interface HeldSocket {
  /** The API token it was opened with; absent for a browser tab. */
  tokenId?: string;
  /** When it was opened (ms), or 0 when the hub doesn't know. */
  openedAt: number;
  /** When its last ping was answered (ms), or null when none has been. */
  pongAt: number | null;
}

/**
 * The tokens with a socket heard from within LISTENING_SILENCE_MS: opened,
 * or a ping answered, that recently. A browser tab has no token and never
 * counts. A socket whose peer died without a close can sit in the hub for a
 * while, so being held is not enough; a recent ping is the daemon still there.
 */
export function listeningTokens(sockets: HeldSocket[], now: number): string[] {
  const live = new Set<string>();
  for (const s of sockets) {
    if (!s.tokenId) continue;
    if (now - Math.max(s.openedAt, s.pongAt ?? 0) <= LISTENING_SILENCE_MS) live.add(s.tokenId);
  }
  return [...live];
}
