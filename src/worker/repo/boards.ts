/* ============================================================================
   Boards: creation, listing, and the membership lookup every board route
   starts from.
   ========================================================================== */

import type { BoardChange } from "@/domain/live";
import type { BoardAccess, BoardMember, BoardRole, BoardSummary, StageCategory } from "@/domain/types";
import { rowToUser, type UserRow } from "./users";

type StageSeed = { name: string; category: StageCategory; tone: number };

/**
 * What a new board starts with. Renamed, reordered or replaced freely later.
 * Tones index src/ui/tone.ts: cyan, blue, yellow, red, green.
 */
const DEFAULT_STAGES: StageSeed[] = [
  { name: "backlog", category: "backlog", tone: 6 },
  { name: "todo", category: "todo", tone: 0 },
  { name: "doing", category: "active", tone: 1 },
  { name: "blocked", category: "blocked", tone: 4 },
  { name: "done", category: "done", tone: 3 },
];

/** An inbox is a personal todo list: nothing parked, nobody to wait on. */
const INBOX_STAGES: StageSeed[] = [
  { name: "todo", category: "todo", tone: 0 },
  { name: "doing", category: "active", tone: 1 },
  { name: "done", category: "done", tone: 3 },
];

interface AccessRow {
  id: string;
  key: string;
  name: string;
  is_inbox: number;
  role: BoardRole;
}

interface SummaryRow extends AccessRow {
  member_count: number;
  open_task_count: number;
}

function rowToAccess(row: AccessRow): BoardAccess {
  return { id: row.id, key: row.key, name: row.name, isInbox: row.is_inbox === 1, role: row.role };
}

function rowToSummary(row: SummaryRow): BoardSummary {
  return { ...rowToAccess(row), memberCount: row.member_count, openTaskCount: row.open_task_count };
}

/* Membership only: one board_members row and its board per board. Every
   access check runs this, so it counts nothing (COPL-133). The version
   (COPL-151) is on the board's row, so it costs nothing either. */
const ACCESS_SELECT = `
  SELECT b.id, b.key, b.name, b.is_inbox, b.version, bm.role
    FROM boards b
    JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = ?1`;

/* The open count reads the tasks_open index (0029), not the board's tasks. */
const SUMMARY_SELECT = `
  SELECT b.id, b.key, b.name, b.is_inbox, bm.role,
         (SELECT count(*) FROM board_members x WHERE x.board_id = b.id) AS member_count,
         (SELECT count(*) FROM tasks t
            WHERE t.board_id = b.id AND t.deleted_at IS NULL AND t.completed_at IS NULL) AS open_task_count
    FROM boards b
    JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = ?1`;

const LISTED = `WHERE b.archived_at IS NULL ORDER BY b.is_inbox DESC, lower(b.name)`;

/** Every board the user is on and their role there, inbox first, then by name. */
export async function listBoardsFor(db: D1Database, userId: string): Promise<BoardAccess[]> {
  const { results } = await db.prepare(`${ACCESS_SELECT} ${LISTED}`).bind(userId).all<AccessRow>();
  return results.map(rowToAccess);
}

/** The same boards with their member and open task counts, for GET /api/boards. */
export async function listBoardSummariesFor(db: D1Database, userId: string): Promise<BoardSummary[]> {
  const { results } = await db.prepare(`${SUMMARY_SELECT} ${LISTED}`).bind(userId).all<SummaryRow>();
  return results.map(rowToSummary);
}

/** One board and this user's role on it, with its version as it was read, or null when they are not a member. */
export async function boardFor(db: D1Database, userId: string, boardId: string): Promise<VersionedAccess | null> {
  const row = await db
    .prepare(`${ACCESS_SELECT} WHERE b.id = ?2 AND b.archived_at IS NULL`)
    .bind(userId, boardId)
    .first<AccessRow & { version: number }>();
  return row ? { ...rowToAccess(row), version: row.version } : null;
}

/** A board's access with its version (boards.version, COPL-151), as requireBoard read it. */
export type VersionedAccess = BoardAccess & { version: number };

/** This user's role on each of these boards they are on. */
export async function rolesOn(db: D1Database, userId: string, boardIds: string[]): Promise<Map<string, BoardRole>> {
  if (boardIds.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT board_id, role FROM board_members
        WHERE user_id = ?1 AND board_id IN (${boardIds.map((_, i) => `?${i + 2}`).join(",")})`,
    )
    .bind(userId, ...boardIds)
    .all<{ board_id: string; role: BoardRole }>();
  return new Map(results.map((r) => [r.board_id, r.role]));
}

export async function listMembers(db: D1Database, boardId: string): Promise<BoardMember[]> {
  const { results } = await db
    .prepare(
      `SELECT u.*, bm.role AS member_role FROM board_members bm
         JOIN users u ON u.id = bm.user_id
        WHERE bm.board_id = ?1
        ORDER BY bm.added_at`,
    )
    .bind(boardId)
    .all<UserRow & { member_role: BoardRole }>();
  return results.map((row) => ({ user: rowToUser(row), role: row.member_role }));
}

/** Who hears about a write to this board: its members. */
export async function boardAudience(db: D1Database, boardId: string): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT user_id FROM board_members WHERE board_id = ?1`)
    .bind(boardId)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

/**
 * A board key nobody else has: up to four letters from `base`, then a digit
 * if those are taken. Keys are instance-wide so "CPL-12" names one task
 * wherever it is pasted.
 */
export async function uniqueBoardKey(db: D1Database, base: string): Promise<string> {
  const letters = base.toUpperCase().replace(/[^A-Z]/g, "");
  const stem = (letters.length >= 2 ? letters : `${letters}XX`).slice(0, 4);
  const candidates = [stem, ...Array.from({ length: 9 }, (_, i) => `${stem.slice(0, 3)}${i + 1}`)];
  const { results } = await db
    .prepare(`SELECT key FROM boards WHERE key IN (${candidates.map((_, i) => `?${i + 1}`).join(",")})`)
    .bind(...candidates)
    .all<{ key: string }>();
  const taken = new Set(results.map((r) => r.key));
  const free = candidates.find((k) => !taken.has(k));
  if (free) return free;
  /* Ten collisions on one stem: fall back to random letters. */
  const random = crypto.getRandomValues(new Uint8Array(5));
  return `${stem.slice(0, 1)}${[...random].map((b) => String.fromCharCode(65 + (b % 26))).join("")}`;
}

/**
 * The statements that create a board, its default stages and its owner's
 * membership. Returned rather than run so the caller can put them in one
 * batch with whatever else belongs to the same change.
 */
export function createBoardStatements(
  db: D1Database,
  board: { id: string; key: string; name: string; ownerId: string; isInbox: boolean },
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO boards (id, key, name, is_inbox, created_by) VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(board.id, board.key, board.name, board.isInbox ? 1 : 0, board.ownerId),
    db
      .prepare(`INSERT INTO board_members (board_id, user_id, role) VALUES (?1, ?2, 'owner')`)
      .bind(board.id, board.ownerId),
    ...(board.isInbox ? INBOX_STAGES : DEFAULT_STAGES).map((stage, position) =>
      db
        .prepare(`INSERT INTO stages (id, board_id, position, name, category, tone) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .bind(crypto.randomUUID(), board.id, position, stage.name, stage.category, stage.tone),
    ),
    ...(board.isInbox
      ? [db.prepare(`INSERT INTO inboxes (user_id, board_id) VALUES (?1, ?2)`).bind(board.ownerId, board.id)]
      : []),
  ];
}

/* ------------------------------------------------- live board changes -- */

/**
 * The statement that bumps a board's version (COPL-151), for the batch of a
 * write whose live event names its tasks. It answers the new version, which
 * versionOf reads from the batch's results.
 */
export const bumpStatement = (db: D1Database, boardId: string): D1PreparedStatement =>
  db.prepare(`UPDATE boards SET version = version + 1 WHERE id = ?1 RETURNING version`).bind(boardId);

/** The version a bumpStatement answered, from its place in the batch's results. */
export const versionOf = (result: D1Result | undefined): number | undefined =>
  (result?.results?.[0] as { version?: number } | undefined)?.version;

/**
 * A write to these tasks as a live event (domain/live.ts BoardChange): the
 * board, its version after the write, the tasks and everyone assigned to
 * them, now and (`before`) as the write found them. `above` are tasks
 * whose progress the write moved (a parent, old or new): they and every
 * task above them are named too, one walk up tasks_parent's parents.
 * Then one read of task_assignees by its primary key.
 */
export async function taskChange(
  db: D1Database,
  boardId: string,
  version: number | undefined,
  taskIds: Iterable<string | null | undefined>,
  before: string[] = [],
  above: Array<string | null | undefined> = [],
): Promise<BoardChange> {
  const starts = [...new Set(above.filter((id): id is string => !!id))];
  const ancestors: string[] = [];
  if (starts.length) {
    const { results } = await db
      .prepare(
        `WITH RECURSIVE up(id) AS (
           SELECT value FROM json_each(?1)
           UNION
           SELECT t.parent_id FROM up JOIN tasks t ON t.id = up.id WHERE t.parent_id IS NOT NULL
         )
         SELECT id FROM up`,
      )
      .bind(JSON.stringify(starts))
      .all<{ id: string }>();
    ancestors.push(...results.map((r) => r.id));
  }
  const tasks = [...new Set([...[...taskIds].filter((id): id is string => !!id), ...ancestors])];
  const assignees = new Set(before);
  if (tasks.length) {
    const { results } = await db
      .prepare(`SELECT user_id FROM task_assignees WHERE task_id IN (${tasks.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...tasks)
      .all<{ user_id: string }>();
    for (const r of results) assignees.add(r.user_id);
  }
  return { board: boardId, ...(version === undefined ? {} : { version }), tasks, assignees: [...assignees] };
}

/** A write's statements in one batch with its board's version bump first; answers the new version. */
export async function bumped(db: D1Database, boardId: string, statements: D1PreparedStatement[]): Promise<number | undefined> {
  const results = await db.batch([bumpStatement(db, boardId), ...statements]);
  return versionOf(results[0]);
}
