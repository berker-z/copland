/* ============================================================================
   Access: every route that touches a board's contents starts here, and so
   does everything an agent is or is not allowed.
   ----------------------------------------------------------------------------
   Not a member reads as not found, so a board's existence is not revealed to
   someone outside it. A member below the role the action needs is a 403.

   An agent (docs/AGENT-IDENTITIES.md) works on boards it was added to, at
   the lowest of three roles: its own there, its owner's there, and editor.
   Worked out on every request, so when the owner loses a board the agent
   does too, and an agent never manages a board (settings, members, stages
   that need an owner). Its owner's personal data it reaches only through
   personalViewer, with a grant the owner gave it.
   ========================================================================== */

import type { AgentGrant, BoardAccess, BoardRole, BoardSummary, Viewer } from "@/domain/types";
import { forbidden, notFound } from "./http";
import { boardFor, listBoardSummariesFor, listBoardsFor, rolesOn, type VersionedAccess } from "./repo/boards";

const RANK: Record<BoardRole, number> = { viewer: 0, editor: 1, owner: 2 };

/** The most an agent can be on any board. */
const AGENT_CEILING: BoardRole = "editor";

export function roleAtLeast(role: BoardRole, needed: BoardRole): boolean {
  return RANK[role] >= RANK[needed];
}

const lower = (a: BoardRole, b: BoardRole): BoardRole => (RANK[a] <= RANK[b] ? a : b);

/** For an agent: its boards that its owner is also on, at the capped role. Anyone else's pass through. */
async function capped<B extends BoardAccess>(db: D1Database, viewer: Viewer, boards: B[]): Promise<B[]> {
  if (!viewer.agent) return boards;
  const owner = await rolesOn(db, viewer.agent.owner.id, boards.map((b) => b.id));
  return boards.flatMap((b) => {
    const theirs = owner.get(b.id);
    return theirs ? [{ ...b, role: lower(lower(b.role, theirs), AGENT_CEILING) }] : [];
  });
}

/** Every board this viewer can see, at the role they have there. */
export async function boardsFor(db: D1Database, viewer: Viewer): Promise<BoardAccess[]> {
  return capped(db, viewer, await listBoardsFor(db, viewer.user.id));
}

/** The same boards with their counts: only for GET /api/boards, which shows them. */
export async function boardSummariesFor(db: D1Database, viewer: Viewer): Promise<BoardSummary[]> {
  return capped(db, viewer, await listBoardSummariesFor(db, viewer.user.id));
}

export async function requireBoard(
  db: D1Database,
  viewer: Viewer,
  boardId: string,
  needed: BoardRole = "viewer",
): Promise<VersionedAccess> {
  const found = await boardFor(db, viewer.user.id, boardId);
  const [board] = found ? await capped(db, viewer, [found]) : [];
  if (!board) throw notFound("No such board");
  if (!roleAtLeast(board.role, needed)) {
    throw forbidden(
      viewer.agent && needed === "owner" ? "Agents cannot manage boards" : `This needs the ${needed} role on the board`,
    );
  }
  return board;
}

export function requireAdmin(viewer: Viewer): void {
  if (!viewer.user.isAdmin) throw forbidden("Admins only");
}

/** Things only people do: making boards, for one. Agents work on boards they are given. */
export function requirePerson(viewer: Viewer, what: string): void {
  if (viewer.agent) throw forbidden(`Agents cannot ${what}`);
}

/**
 * The person whose personal data (notes, calendar, settings...) a request
 * reaches. A person reaches their own. An agent reaches its owner's, and
 * only with `grant`; null means no agent ever does. The viewer it returns is
 * the owner, so a personal route runs unchanged; it must never be used for
 * board work, which has to stay the agent's own.
 */
export function personalViewer(viewer: Viewer, grant: AgentGrant | null): Viewer {
  if (!viewer.agent) return viewer;
  if (grant && viewer.agent.grants.includes(grant)) return { user: viewer.agent.owner, access: viewer.access };
  throw forbidden(
    grant
      ? `This agent has not been given ${grant} by its owner`
      : "This is its owner's alone; agents cannot reach it",
  );
}

/** The person behind a viewer: themselves, or an agent's owner. */
export const personOf = (viewer: Viewer): string => viewer.agent?.owner.id ?? viewer.user.id;
