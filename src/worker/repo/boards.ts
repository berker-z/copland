/* ============================================================================
   Boards: creation, listing, and the membership lookup every board route
   starts from.
   ========================================================================== */

import type { BoardMember, BoardRole, BoardSummary, StageCategory } from "@/domain/types";
import { rowToUser, type UserRow } from "./users";

/** What a new board starts with. Renamed, reordered or replaced freely later. */
const DEFAULT_STAGES: { name: string; category: StageCategory; tone: number }[] = [
  { name: "todo", category: "backlog", tone: 0 },
  { name: "doing", category: "active", tone: 1 },
  { name: "done", category: "done", tone: 3 },
];

interface BoardRow {
  id: string;
  key: string;
  name: string;
  is_inbox: number;
  has_planning: number;
  role: BoardRole;
  member_count: number;
  open_task_count: number;
}

function rowToSummary(row: BoardRow): BoardSummary {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    isInbox: row.is_inbox === 1,
    hasPlanning: row.has_planning === 1,
    role: row.role,
    memberCount: row.member_count,
    openTaskCount: row.open_task_count,
  };
}

const SUMMARY_SELECT = `
  SELECT b.id, b.key, b.name, b.is_inbox, b.has_planning, bm.role,
         (SELECT count(*) FROM board_members x WHERE x.board_id = b.id) AS member_count,
         (SELECT count(*) FROM tasks t
            WHERE t.board_id = b.id AND t.deleted_at IS NULL AND t.completed_at IS NULL) AS open_task_count
    FROM boards b
    JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = ?1`;

/** Every board the user is on, inbox first, then by name. */
export async function listBoardsFor(db: D1Database, userId: string): Promise<BoardSummary[]> {
  const { results } = await db
    .prepare(`${SUMMARY_SELECT} WHERE b.archived_at IS NULL ORDER BY b.is_inbox DESC, lower(b.name)`)
    .bind(userId)
    .all<BoardRow>();
  return results.map(rowToSummary);
}

/** One board as this user sees it, or null when they are not a member. */
export async function boardFor(db: D1Database, userId: string, boardId: string): Promise<BoardSummary | null> {
  const row = await db
    .prepare(`${SUMMARY_SELECT} WHERE b.id = ?2 AND b.archived_at IS NULL`)
    .bind(userId, boardId)
    .first<BoardRow>();
  return row ? rowToSummary(row) : null;
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
  board: { id: string; key: string; name: string; ownerId: string; isInbox: boolean; hasPlanning: boolean },
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO boards (id, key, name, is_inbox, has_planning, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(board.id, board.key, board.name, board.isInbox ? 1 : 0, board.hasPlanning ? 1 : 0, board.ownerId),
    db
      .prepare(`INSERT INTO board_members (board_id, user_id, role) VALUES (?1, ?2, 'owner')`)
      .bind(board.id, board.ownerId),
    ...DEFAULT_STAGES.map((stage, position) =>
      db
        .prepare(`INSERT INTO stages (id, board_id, position, name, category, tone) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .bind(crypto.randomUUID(), board.id, position, stage.name, stage.category, stage.tone),
    ),
    ...(board.isInbox
      ? [db.prepare(`INSERT INTO inboxes (user_id, board_id) VALUES (?1, ?2)`).bind(board.ownerId, board.id)]
      : []),
  ];
}
