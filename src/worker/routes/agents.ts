/* ============================================================================
   Settings › agents: making and managing your agents (docs/AGENT-IDENTITIES.md).
   ----------------------------------------------------------------------------
     GET    /api/agents                       mine, with grants, boards, tokens
     POST   /api/agents                       { name, description? }
     PATCH  /api/agents/:id                   { name?, description?, workFrom?, paused?, grants? }
     DELETE /api/agents/:id
     PUT    /api/agents/:id/avatar            a picture, like /api/me/avatar
     DELETE /api/agents/:id/avatar
     PUT    /api/agents/:id/boards/:boardId   { role }: onto a board, or a new role there
     DELETE /api/agents/:id/boards/:boardId

   Only the owner, and only in the app: a token is refused here the way it
   is refused on token management, so nothing an agent reads can talk its
   way into widening itself.

   A board an agent is put on is one you are on, at most at your own role
   and never above editor; your inbox counts. A board's owners can still
   remove it like any member (routes/boards.ts).

   Deleting keeps the row, so its comments and history still say who did
   them: it is disabled, loses its tokens, grants, boards and assignments,
   and is renamed "you/codex (deleted 1a2b)", which frees "codex" for a new
   agent that inherits nothing.
   ========================================================================== */

import { handleProblem, normalizeHandle } from "@/domain/handle";
import { AGENT_GRANTS, type Agent, type AgentGrant, type BoardRole, type Viewer } from "@/domain/types";
import { requireBoard, roleAtLeast } from "../access";
import type { Env } from "../env";
import { badRequest, conflict, forbidden, json, notFound, nowIso, readJson } from "../http";
import type { Changes } from "../live";
import { boardAudience } from "../repo/boards";
import { createAgent } from "../repo/agents";
import { findUserById, peopleAudience, rowToUser, type UserRow } from "../repo/users";
import { listTokens } from "../tokens";
import { replaceAvatar, storeAvatar } from "./profile";

const MAX_DESCRIPTION = 500;

/** People manage their agents, from the app. */
function requireOwnerInApp(viewer: Viewer): void {
  if (viewer.access) throw forbidden("Agents are managed from the app itself, not with a token");
}

interface AgentRow extends UserRow {
  name: string;
  description: string;
  work_from: "owner" | "members";
  paused_at: string | null;
  agent_created_at: string;
}

const AGENT_SELECT = `
  SELECT u.*, a.name, a.description, a.work_from, a.paused_at, a.created_at AS agent_created_at
    FROM users u JOIN agents a ON a.user_id = u.id`;

/** One of my live agents, or a 404 for anything else (someone else's, deleted, not an agent). */
async function ownedAgent(db: D1Database, viewer: Viewer, id: string): Promise<AgentRow> {
  const row = await db
    .prepare(`${AGENT_SELECT} WHERE u.id = ?1 AND u.owner_id = ?2 AND u.disabled_at IS NULL`)
    .bind(id, viewer.user.id)
    .first<AgentRow>();
  if (!row) throw notFound("No such agent");
  return row;
}

async function listAgents(db: D1Database, ownerId: string): Promise<Agent[]> {
  const [agents, grants, boards] = await Promise.all([
    db
      .prepare(`${AGENT_SELECT} WHERE u.owner_id = ?1 AND u.disabled_at IS NULL ORDER BY a.created_at`)
      .bind(ownerId)
      .all<AgentRow>(),
    db
      .prepare(`SELECT g.agent_id, g.name FROM agent_grants g JOIN users u ON u.id = g.agent_id WHERE u.owner_id = ?1`)
      .bind(ownerId)
      .all<{ agent_id: string; name: AgentGrant }>(),
    db
      .prepare(
        `SELECT bm.user_id, bm.board_id, bm.role FROM board_members bm
           JOIN users u ON u.id = bm.user_id
           JOIN boards b ON b.id = bm.board_id AND b.archived_at IS NULL
          WHERE u.owner_id = ?1`,
      )
      .bind(ownerId)
      .all<{ user_id: string; board_id: string; role: BoardRole }>(),
  ]);
  return Promise.all(
    agents.results.map(async (row) => ({
      user: rowToUser(row),
      name: row.name,
      description: row.description,
      workFrom: row.work_from,
      pausedAt: row.paused_at,
      grants: grants.results.filter((g) => g.agent_id === row.id).map((g) => g.name),
      boards: boards.results.filter((b) => b.user_id === row.id).map((b) => ({ boardId: b.board_id, role: b.role })),
      tokens: await listTokens(db, row.id),
      createdAt: row.agent_created_at,
    })),
  );
}

/** A name for the part after the slash: the handle rules. */
export function parseName(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("`name` must be a string");
  const name = normalizeHandle(raw);
  const problem = handleProblem(name);
  if (problem) throw badRequest(problem.replace("A handle", "A name"));
  return name;
}

function parseDescription(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("`description` must be a string");
  if (raw.length > MAX_DESCRIPTION) throw badRequest(`\`description\` is longer than ${MAX_DESCRIPTION} characters`);
  return raw.trim();
}

async function requireFreeHandle(db: D1Database, handle: string): Promise<void> {
  if (await db.prepare(`SELECT 1 FROM users WHERE handle = ?1`).bind(handle).first()) {
    throw conflict(`You already have an agent called \`${handle.split("/")[1]}\``);
  }
}

export async function getAgents(env: Env, viewer: Viewer): Promise<Response> {
  requireOwnerInApp(viewer);
  return json(await listAgents(env.DB, viewer.user.id));
}

/** POST /api/agents { name, description? }: closed by default, no boards, no grants, work only from you. */
export async function postAgent(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  requireOwnerInApp(viewer);
  const body = await readJson(request);
  const name = parseName(body.name);
  const description = body.description === undefined ? "" : parseDescription(body.description);
  const id = await createAgent(env.DB, viewer.user, name, description);
  changes.notify([viewer.user.id], "agents");
  const agent = (await listAgents(env.DB, viewer.user.id)).find((a) => a.user.id === id);
  return json(agent, { status: 201 });
}

/** PATCH /api/agents/:id: whatever is passed changes, in one batch. */
export async function patchAgent(request: Request, env: Env, viewer: Viewer, id: string, changes: Changes): Promise<Response> {
  requireOwnerInApp(viewer);
  const db = env.DB;
  const agent = await ownedAgent(db, viewer, id);
  const body = await readJson(request);
  const statements: D1PreparedStatement[] = [];
  let renamed = false;

  if (body.name !== undefined) {
    const name = parseName(body.name);
    if (name !== agent.name) {
      const handle = `${viewer.user.handle}/${name}`;
      await requireFreeHandle(db, handle);
      statements.push(
        db.prepare(`UPDATE agents SET name = ?2 WHERE user_id = ?1`).bind(id, name),
        db.prepare(`UPDATE users SET handle = ?2 WHERE id = ?1`).bind(id, handle),
      );
      renamed = true;
    }
  }
  if (body.description !== undefined) {
    statements.push(db.prepare(`UPDATE agents SET description = ?2 WHERE user_id = ?1`).bind(id, parseDescription(body.description)));
  }
  if (body.workFrom !== undefined) {
    if (body.workFrom !== "owner" && body.workFrom !== "members") throw badRequest("`workFrom` must be owner or members");
    statements.push(db.prepare(`UPDATE agents SET work_from = ?2 WHERE user_id = ?1`).bind(id, body.workFrom));
  }
  if (body.paused !== undefined) {
    if (typeof body.paused !== "boolean") throw badRequest("`paused` must be true or false");
    statements.push(db.prepare(`UPDATE agents SET paused_at = ?2 WHERE user_id = ?1`).bind(id, body.paused ? nowIso() : null));
  }
  if (body.grants !== undefined) {
    if (!Array.isArray(body.grants) || body.grants.some((g) => !(AGENT_GRANTS as readonly unknown[]).includes(g))) {
      throw badRequest(`\`grants\` must be a list of ${AGENT_GRANTS.join(", ")}`);
    }
    const grants = [...new Set(body.grants as AgentGrant[])];
    statements.push(
      db.prepare(`DELETE FROM agent_grants WHERE agent_id = ?1`).bind(id),
      ...grants.map((g) => db.prepare(`INSERT INTO agent_grants (agent_id, name) VALUES (?1, ?2)`).bind(id, g)),
    );
  }
  if (statements.length === 0) throw badRequest("Nothing to update");

  try {
    await db.batch(statements);
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw conflict("That name was just taken");
    throw error;
  }
  changes.notify([viewer.user.id], "agents");
  if (renamed) changes.notify(await peopleAudience(db, id), "people");
  return json((await listAgents(db, viewer.user.id)).find((a) => a.user.id === id));
}

/** DELETE /api/agents/:id. See the header for what stays. */
export async function deleteAgent(env: Env, viewer: Viewer, id: string, changes: Changes): Promise<Response> {
  requireOwnerInApp(viewer);
  const db = env.DB;
  const agent = await ownedAgent(db, viewer, id);
  const { results: boards } = await db.prepare(`SELECT board_id FROM board_members WHERE user_id = ?1`).bind(id).all<{ board_id: string }>();
  const audiences = await Promise.all(boards.map((b) => boardAudience(db, b.board_id)));
  const suffix = crypto.randomUUID().slice(0, 4);
  const gone = `${agent.name} (deleted ${suffix})`;
  const now = nowIso();

  await db.batch([
    db.prepare(`UPDATE agents SET name = ?2, paused_at = coalesce(paused_at, ?3) WHERE user_id = ?1`).bind(id, gone, now),
    db.prepare(`UPDATE users SET handle = ?2, disabled_at = ?3 WHERE id = ?1`).bind(id, `${viewer.user.handle}/${gone}`, now),
    db.prepare(`UPDATE api_tokens SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL`).bind(id, now),
    db.prepare(`DELETE FROM agent_grants WHERE agent_id = ?1`).bind(id),
    db.prepare(`DELETE FROM task_assignees WHERE user_id = ?1`).bind(id),
    db.prepare(`DELETE FROM board_members WHERE user_id = ?1`).bind(id),
  ]);
  if (agent.avatar_key) await replaceAvatar(env, id, null);
  changes.notify([viewer.user.id], "agents");
  for (const audience of audiences) changes.notify(audience, "boards", "board");
  return json({ ok: true });
}

/* --------------------------------------------------------------- picture -- */

export async function putAgentAvatar(request: Request, env: Env, viewer: Viewer, id: string, changes: Changes) {
  requireOwnerInApp(viewer);
  await ownedAgent(env.DB, viewer, id);
  await storeAvatar(request, env, id);
  changes.notify([viewer.user.id, ...(await peopleAudience(env.DB, id))], "agents", "people");
  return json((await listAgents(env.DB, viewer.user.id)).find((a) => a.user.id === id));
}

export async function deleteAgentAvatar(env: Env, viewer: Viewer, id: string, changes: Changes) {
  requireOwnerInApp(viewer);
  await ownedAgent(env.DB, viewer, id);
  await replaceAvatar(env, id, null);
  changes.notify([viewer.user.id, ...(await peopleAudience(env.DB, id))], "agents", "people");
  return json((await listAgents(env.DB, viewer.user.id)).find((a) => a.user.id === id));
}

/* ---------------------------------------------------------------- boards -- */

/** PUT /api/agents/:id/boards/:boardId { role }: viewer or editor, and no more than yours there. */
export async function putAgentBoard(
  request: Request,
  env: Env,
  viewer: Viewer,
  id: string,
  boardId: string,
  changes: Changes,
): Promise<Response> {
  requireOwnerInApp(viewer);
  const db = env.DB;
  await ownedAgent(db, viewer, id);
  const board = await requireBoard(db, viewer, boardId);
  const { role } = await readJson(request);
  if (role !== "viewer" && role !== "editor") throw badRequest("`role` must be viewer or editor: agents never own boards");
  if (!roleAtLeast(board.role, role)) throw forbidden(`You are a ${board.role} there, so your agent can be at most that`);
  await db
    .prepare(
      `INSERT INTO board_members (board_id, user_id, role) VALUES (?1, ?2, ?3)
       ON CONFLICT (board_id, user_id) DO UPDATE SET role = excluded.role`,
    )
    .bind(boardId, id, role)
    .run();
  changes.notify([viewer.user.id], "agents");
  changes.notify(await boardAudience(db, boardId), "boards", "board");
  return json((await listAgents(db, viewer.user.id)).find((a) => a.user.id === id));
}

/** DELETE /api/agents/:id/boards/:boardId: off the board, and off its tasks there. */
export async function deleteAgentBoard(env: Env, viewer: Viewer, id: string, boardId: string, changes: Changes) {
  requireOwnerInApp(viewer);
  const db = env.DB;
  await ownedAgent(db, viewer, id);
  const audience = await boardAudience(db, boardId);
  await db.batch([
    db.prepare(`DELETE FROM board_members WHERE board_id = ?1 AND user_id = ?2`).bind(boardId, id),
    db.prepare(`DELETE FROM task_assignees WHERE user_id = ?2 AND task_id IN (SELECT id FROM tasks WHERE board_id = ?1)`).bind(
      boardId,
      id,
    ),
  ]);
  changes.notify([viewer.user.id], "agents");
  changes.notify(audience, "boards", "board");
  return json((await listAgents(db, viewer.user.id)).find((a) => a.user.id === id));
}

/** For other routes: the agent behind a user id, if it is one, so its owner's settings can refresh. */
export async function ownerOf(db: D1Database, userId: string): Promise<string | null> {
  const row = await findUserById(db, userId);
  return row?.kind === "agent" ? row.owner_id : null;
}
