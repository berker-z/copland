/* ============================================================================
   Board access: every route that touches a board's contents starts here.
   ----------------------------------------------------------------------------
   Not a member reads as not found, so a board's existence is not revealed to
   someone outside it. A member below the role the action needs is a 403.
   ========================================================================== */

import type { BoardRole, BoardSummary, Viewer } from "@/domain/types";
import { forbidden, notFound } from "./http";
import { boardFor } from "./repo/boards";

const RANK: Record<BoardRole, number> = { viewer: 0, editor: 1, owner: 2 };

export function roleAtLeast(role: BoardRole, needed: BoardRole): boolean {
  return RANK[role] >= RANK[needed];
}

export async function requireBoard(
  db: D1Database,
  viewer: Viewer,
  boardId: string,
  needed: BoardRole = "viewer",
): Promise<BoardSummary> {
  const board = await boardFor(db, viewer.user.id, boardId);
  if (!board) throw notFound("No such board");
  if (!roleAtLeast(board.role, needed)) throw forbidden(`This needs the ${needed} role on the board`);
  return board;
}

export function requireAdmin(viewer: Viewer): void {
  if (!viewer.user.isAdmin) throw forbidden("Admins only");
}
