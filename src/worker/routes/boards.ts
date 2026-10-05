/* ============================================================================
   Boards and their members.
   ----------------------------------------------------------------------------
   Anyone signed in can make a board and owns it. Owners add someone on the
   instance by picking them (GET /api/people, by handle, then { userId }),
   or invite someone who is not by email: an address that already has an
   account joins at once, any other gets an invite link carrying the board
   (routes/admin.ts createInvite), which the owner passes on. The people
   search answers handles and pictures only, never addresses. Editors bring
   their own agents through routes/agents.ts, not here. The inbox is private
   and stays that way.

   A board always keeps at least one owner, so it can never be orphaned.

   Agents never make boards and never manage one: access.ts caps them at
   editor, below everything here that needs an owner.
   ========================================================================== */

import { BOARD_ROLES, type BoardDetail, type BoardRole, type Person, type Viewer } from "@/domain/types";
import { boardSummariesFor, requireBoard, requirePerson } from "../access";
import type { Env } from "../env";
import { badRequest, conflict, forbidden, json, notFound, nowIso, readJson } from "../http";
import type { Changes } from "../live";
import {
  boardAudience,
  createBoardStatements,
  listMembers,
  uniqueBoardKey,
} from "../repo/boards";
import { boardNotes, listDocs } from "../repo/docs";
import { listRepos } from "../repo/github";
import { boardTasks, CLOSED_PAGE, closedTasks, listLabels, listStages } from "../repo/tasks";
import { avatarUrl, findUserByEmail, findUserById, type UserRow } from "../repo/users";
import { createInvite } from "./admin";
import { ownerOf } from "./agents";

const KEY = /^[A-Z][A-Z0-9]{1,5}$/;

const isRole = (value: unknown): value is BoardRole =>
  typeof value === "string" && (BOARD_ROLES as readonly string[]).includes(value);

function boardName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw badRequest("`name` must be a non-empty string");
  const name = raw.trim();
  if (name.length > 60) throw badRequest("`name` is longer than 60 characters");
  return name;
}

export async function getBoards(env: Env, viewer: Viewer): Promise<Response> {
  return json(await boardSummariesFor(env.DB, viewer));
}

/**
 * GET /api/boards/:id: the board as it shows, bounded by that and not by
 * its history: open tasks, those closed in the last RECENT_CLOSED_DAYS, and
 * the tasks they name (repo/tasks.ts boardTasks). getClosed pages back
 * through the rest.
 */
export async function getBoard(env: Env, viewer: Viewer, id: string): Promise<Response> {
  const board = await requireBoard(env.DB, viewer, id);
  const [members, stages, labels, { tasks, progress, olderClosed }, notes, docs, repos] = await Promise.all([
    listMembers(env.DB, id),
    listStages(env.DB, id),
    listLabels(env.DB, id),
    boardTasks(env.DB, id),
    boardNotes(env.DB, id),
    listDocs(env.DB, id),
    listRepos(env.DB, id),
  ]);
  const detail: BoardDetail = { board, members, stages, labels, tasks, progress, olderClosed, notes, docs, repos };
  return json(detail);
}

/**
 * GET /api/boards/:id/closed?before=&limit=: tasks closed before
 * RECENT_CLOSED_DAYS ago, newest first, a page (ClosedPage) at a time:
 * `before` is the previous page's `next`, `limit` at most CLOSED_PAGE.
 */
export async function getClosed(env: Env, viewer: Viewer, id: string, url: URL): Promise<Response> {
  await requireBoard(env.DB, viewer, id);
  const raw = url.searchParams.get("limit");
  const limit = raw === null ? CLOSED_PAGE : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > CLOSED_PAGE) throw badRequest(`\`limit\` must be a whole number from 1 to ${CLOSED_PAGE}`);
  return json(await closedTasks(env.DB, id, url.searchParams.get("before"), limit));
}

/** POST /api/boards { name, key? } */
export async function postBoard(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  requirePerson(viewer, "make boards");
  const body = await readJson(request);
  const name = boardName(body.name);
  let key: string;
  if (body.key === undefined) {
    key = await uniqueBoardKey(env.DB, name);
  } else {
    if (typeof body.key !== "string" || !KEY.test(body.key)) {
      throw badRequest("`key` must be 2-6 uppercase letters or digits, starting with a letter");
    }
    key = body.key;
    const taken = await env.DB.prepare(`SELECT 1 FROM boards WHERE key = ?1`).bind(key).first();
    if (taken) throw conflict(`The key ${key} is taken`);
  }
  const id = crypto.randomUUID();
  await env.DB.batch(
    createBoardStatements(env.DB, {
      id,
      key,
      name,
      ownerId: viewer.user.id,
      isInbox: false,
    }),
  );
  changes.notify([viewer.user.id], "boards");
  return getBoard(env, viewer, id).then((r) => new Response(r.body, { status: 201, headers: r.headers }));
}

/**
 * PATCH /api/boards/:id { name?, key? }: owners only. Task keys
 * are the board key plus the number, computed on read, so a new key renames
 * every task on the board at once (BERK-1 becomes ME-1); links and notes
 * that spelled out the old key stop matching.
 */
export async function patchBoard(
  request: Request,
  env: Env,
  viewer: Viewer,
  id: string,
  changes: Changes,
): Promise<Response> {
  await requireBoard(env.DB, viewer, id, "owner");
  const body = await readJson(request);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) {
    sets.push(`name = ?${values.length + 2}`);
    values.push(boardName(body.name));
  }
  if (body.key !== undefined) {
    if (typeof body.key !== "string" || !KEY.test(body.key.toUpperCase())) {
      throw badRequest("`key` must be 2-6 letters or digits, starting with a letter");
    }
    const key = body.key.toUpperCase();
    const taken = await env.DB.prepare(`SELECT 1 FROM boards WHERE key = ?1 AND id <> ?2`).bind(key, id).first();
    if (taken) throw conflict(`The key ${key} is taken`);
    sets.push(`key = ?${values.length + 2}`);
    values.push(key);
  }
  if (sets.length === 0) throw badRequest("Nothing to update");
  await env.DB.prepare(`UPDATE boards SET ${sets.join(", ")} WHERE id = ?1`).bind(id, ...values).run();
  changes.notify(await boardAudience(env.DB, id), "boards", "board");
  return getBoard(env, viewer, id);
}

/** DELETE /api/boards/:id: archives. Owners only; never the inbox. */
export async function deleteBoard(env: Env, viewer: Viewer, id: string, changes: Changes): Promise<Response> {
  const board = await requireBoard(env.DB, viewer, id, "owner");
  if (board.isInbox) throw forbidden("Your inbox cannot be deleted");
  const audience = await boardAudience(env.DB, id);
  await env.DB.prepare(`UPDATE boards SET archived_at = ?2 WHERE id = ?1`).bind(id, nowIso()).run();
  changes.notify(audience, "boards", "board");
  return json({ ok: true });
}

/* --------------------------------------------------------------- members -- */

const PEOPLE_LIMIT = 10;

/**
 * GET /api/people?q=: people on the instance whose handle holds q, those it
 * starts with first, for the share picker. People only (not agents, not
 * disabled, not you), and only id, handle and picture: never an email.
 */
export async function getPeople(env: Env, viewer: Viewer, url: URL): Promise<Response> {
  requirePerson(viewer, "browse people");
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().replace(/^@/, "").slice(0, 40);
  const like = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { results } = await env.DB.prepare(
    `SELECT id, handle, avatar_key FROM users
      WHERE kind = 'person' AND disabled_at IS NULL AND id <> ?1
        AND handle LIKE ?2 ESCAPE '\\'
      ORDER BY (handle LIKE ?3 ESCAPE '\\') DESC, handle
      LIMIT ?4`,
  )
    .bind(viewer.user.id, `%${like}%`, `${like}%`, PEOPLE_LIMIT)
    .all<Pick<UserRow, "id" | "handle" | "avatar_key">>();
  const people: Person[] = results.map((r) => ({ id: r.id, handle: r.handle, avatar: avatarUrl(r.avatar_key) }));
  return json(people);
}

/**
 * POST /api/boards/:id/members { userId, role? } or { email, role? }: owners
 * only. A userId is a person picked from GET /api/people and joins at once.
 * An email adds someone already here, or answers with an invite link for
 * someone who is not.
 */
export async function postMember(
  request: Request,
  env: Env,
  viewer: Viewer,
  id: string,
  url: URL,
  changes: Changes,
): Promise<Response> {
  const board = await requireBoard(env.DB, viewer, id, "owner");
  if (board.isInbox) throw forbidden("Your inbox is private; make a board to share");
  const body = await readJson(request);
  const role = body.role ?? "editor";
  if (!isRole(role)) throw badRequest("`role` must be owner, editor or viewer");

  let user: UserRow | null;
  if (body.userId !== undefined) {
    if (typeof body.userId !== "string") throw badRequest("`userId` must be a string");
    user = await findUserById(env.DB, body.userId);
    /* People only: agents come onto boards through their owner (routes/agents.ts). */
    if (!user || user.kind !== "person") throw notFound("No such person");
  } else {
    if (typeof body.email !== "string" || !body.email.includes("@")) {
      throw badRequest("Pass `userId`, or `email` to invite by address");
    }
    const email = body.email.trim().toLowerCase();
    user = await findUserByEmail(env.DB, email);
    if (!user) {
      const created = await createInvite(env, viewer, url.origin, { email, boardId: id });
      return json({ added: false, invite: created }, { status: 201 });
    }
  }
  if (user.disabled_at) throw forbidden("That account is disabled");
  await env.DB.prepare(
    `INSERT INTO board_members (board_id, user_id, role) VALUES (?1, ?2, ?3)
     ON CONFLICT (board_id, user_id) DO NOTHING`,
  )
    .bind(id, user.id, role)
    .run();
  changes.notify(await boardAudience(env.DB, id), "boards", "board");
  return json({ added: true }, { status: 201 });
}

/** PATCH /api/boards/:id/members/:userId { role }: owners only. */
export async function patchMember(
  request: Request,
  env: Env,
  viewer: Viewer,
  id: string,
  userId: string,
  changes: Changes,
): Promise<Response> {
  await requireBoard(env.DB, viewer, id, "owner");
  const { role } = await readJson(request);
  if (!isRole(role)) throw badRequest("`role` must be owner, editor or viewer");
  if (role === "owner" && (await ownerOf(env.DB, userId))) throw badRequest("An agent cannot own a board");
  if (role !== "owner") await requireAnotherOwner(env.DB, id, userId);
  const result = await env.DB.prepare(`UPDATE board_members SET role = ?3 WHERE board_id = ?1 AND user_id = ?2`)
    .bind(id, userId, role)
    .run();
  if (result.meta.changes === 0) throw notFound("Not a member of this board");
  changes.notify(await boardAudience(env.DB, id), "boards", "board");
  return json({ ok: true });
}

/** DELETE /api/boards/:id/members/:userId: owners remove anyone; anyone may leave. */
export async function deleteMember(
  env: Env,
  viewer: Viewer,
  id: string,
  userId: string,
  changes: Changes,
): Promise<Response> {
  const board = await requireBoard(env.DB, viewer, id, userId === viewer.user.id ? "viewer" : "owner");
  if (board.isInbox) throw forbidden("Your inbox cannot be left");
  await requireAnotherOwner(env.DB, id, userId);
  const audience = await boardAudience(env.DB, id);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM board_members WHERE board_id = ?1 AND user_id = ?2`).bind(id, userId),
    /* Their name on a card of a board they can no longer see helps nobody. */
    env.DB.prepare(
      `DELETE FROM task_assignees WHERE user_id = ?2 AND task_id IN (SELECT id FROM tasks WHERE board_id = ?1)`,
    ).bind(id, userId),
  ]);
  changes.notify(audience, "boards", "board");
  /* An agent taken off: its owner's settings list its boards. */
  const agentOwner = await ownerOf(env.DB, userId);
  if (agentOwner) changes.notify([agentOwner], "agents");
  return json({ ok: true });
}

/** Refuse a change that would leave the board without an owner. */
async function requireAnotherOwner(db: D1Database, boardId: string, userId: string): Promise<void> {
  const row = await db
    .prepare(`SELECT count(*) AS n FROM board_members WHERE board_id = ?1 AND role = 'owner' AND user_id <> ?2`)
    .bind(boardId, userId)
    .first<{ n: number }>();
  if (!row || row.n === 0) throw conflict("A board needs at least one other owner first");
}
