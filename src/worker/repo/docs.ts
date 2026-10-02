/* ============================================================================
   Board docs: reading the rows. Writes are in routes/docs.ts.
   ========================================================================== */

import type { BoardDoc } from "@/domain/types";

interface DocRow {
  id: string;
  name: string;
  mime: string;
  size: number;
  key: string;
  description: string;
  excerpt: string;
  added_by_handle: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `
  SELECT d.id, d.name, d.mime, d.size, d.key, d.description, d.excerpt, u.handle AS added_by_handle,
         d.created_at, d.updated_at
    FROM board_docs d LEFT JOIN users u ON u.id = d.added_by`;

function rowToDoc(row: DocRow): BoardDoc {
  return {
    id: row.id,
    name: row.name,
    type: row.mime,
    size: row.size,
    key: row.key,
    description: row.description,
    excerpt: row.excerpt,
    addedBy: row.added_by_handle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A board's docs, by name. */
export async function listDocs(db: D1Database, boardId: string): Promise<BoardDoc[]> {
  const { results } = await db
    .prepare(`${SELECT} WHERE d.board_id = ?1 ORDER BY d.name COLLATE NOCASE`)
    .bind(boardId)
    .all<DocRow>();
  return results.map(rowToDoc);
}

/** One doc on this board, or null. */
export async function findDoc(db: D1Database, boardId: string, docId: string): Promise<BoardDoc | null> {
  const row = await db.prepare(`${SELECT} WHERE d.board_id = ?1 AND d.id = ?2`).bind(boardId, docId).first<DocRow>();
  return row ? rowToDoc(row) : null;
}

/** A board's notes ('' when it has none). */
export async function boardNotes(db: D1Database, boardId: string): Promise<string> {
  const row = await db.prepare(`SELECT notes FROM boards WHERE id = ?1`).bind(boardId).first<{ notes: string }>();
  return row?.notes ?? "";
}
