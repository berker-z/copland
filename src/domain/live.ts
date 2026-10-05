/* ============================================================================
   Live updates: what a write changed, and for whom.
   ----------------------------------------------------------------------------
   Every user has a hub of their own (worker/live.ts) holding their open tabs.
   After a write succeeds, the route names who should hear about it and which
   topics changed; each of those users' tabs refetches what it shows of those
   topics. A personal write reaches only its author's other tabs. A board
   write reaches every member of the board.

   The message carries ids, never content (COPL-151). A board event can say
   which board, the board's version after the write, and which tasks'
   rows changed and who is on them, so a tab refetches those tasks instead
   of the whole board and the box can tell a change none of its agents is
   on. Everyone hearing a board event is on that board's audience
   (boardAudience), so the ids tell them nothing they could not read. What
   changed is still read through the routes and their access checks.

   Every field past `topics` and `tab` is optional, and an event without
   them means what it always did: anything under those topics may have
   changed. Old daemons ignore what they don't know.

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

/**
 * What one write to a board changed, as its route knows it. Only `board` is
 * required; leaving out `tasks` says anything on the board may have changed
 * (stages, labels, members, docs), and a listener reads the board whole.
 */
export interface BoardChange {
  board: string;
  /** boards.version after the write, when the write bumped it in its own batch. */
  version?: number;
  /**
   * The tasks whose rows changed: the one written and the parents that moved
   * with it. Never a deleted task: a delete leaves this out.
   */
  tasks?: string[];
  /** Everyone assigned to those tasks, before the write and after it. */
  assignees?: string[];
}

export interface LiveEvent extends Partial<BoardChange> {
  topics: LiveTopic[];
  /** The tab that made the change, which has already refreshed itself. */
  tab: string | null;
}

/** More tasks than this in one event, and a tab reads the board whole rather than each task. */
export const PATCH_LIMIT = 10;

/** What a tab does about the board events it gathered for one board (planBoard). */
export type BoardPlan =
  /** Every event is already in the board it holds. */
  | { kind: "none" }
  /** Refetch these tasks, patch them in, and hold the board at `version`. */
  | { kind: "patch"; tasks: string[]; version: number }
  /** Read the board whole. */
  | { kind: "whole" };

/**
 * What a tab holding a board at version `held` (undefined: it holds none
 * that says) does about the events it gathered for that board. Events at or
 * below `held` are already in what it holds. The rest are patched in only
 * when they run on from `held` without a gap (held + 1, held + 2, ...: one
 * event each, nothing missed), each names its tasks, and together they name
 * at most PATCH_LIMIT. Anything else (a missed or doubled version, an event
 * without a version or tasks, too many tasks) reads the board whole.
 */
export function planBoard(held: number | undefined, events: BoardChange[]): BoardPlan {
  const fresh = events.filter((e) => held === undefined || e.version === undefined || e.version > held);
  if (fresh.length === 0) return { kind: "none" };
  if (held === undefined || fresh.some((e) => e.version === undefined || !e.tasks)) return { kind: "whole" };
  const versions = fresh.map((e) => e.version as number).sort((a, b) => a - b);
  if (versions.some((v, i) => v !== held + 1 + i)) return { kind: "whole" };
  const tasks = [...new Set(fresh.flatMap((e) => e.tasks ?? []))];
  if (tasks.length > PATCH_LIMIT) return { kind: "whole" };
  return { kind: "patch", tasks, version: versions[versions.length - 1] };
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
