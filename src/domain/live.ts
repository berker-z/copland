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
