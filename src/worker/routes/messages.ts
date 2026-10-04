/* ============================================================================
   Messages: a short note to an agent, or from one to its owner (COPL-106,
   migrations/0025_messages.sql).
   ----------------------------------------------------------------------------
     POST /api/messages             { to?, text, taskId?, replyTo? } → SentMessage
     GET  /api/messages/recipients  → Recipient[], whom the viewer may message

   `to` is a user id or a handle ("@sam/dev" or "sam/dev"). `replyTo` is the
   id of a message the viewer was sent; the reply goes back to its sender,
   so `to` may be left out (given, it must be that sender). Who may message
   whom is domain/messages.ts. `text` is at most MESSAGE_MAX characters.

   With `taskId` (an id or a key like CPL-12) the sender must be able to see
   the task, and so must the recipient: the item shows only while they can
   see its board, like every inbox item, so one they can't see is refused
   rather than lost. A task-less message is always visible to its recipient.

   Not mine(grant): like the inbox, a principal's messages are its own. The
   item lands in the recipient's inbox, and they hear about it on "inbox".
   ========================================================================== */

import { MESSAGE_MAX, mayMessage, recipientsOf, type MessageParty } from "@/domain/messages";
import type { Recipient, SentMessage, Viewer } from "@/domain/types";
import { requireBoard } from "../access";
import type { Env } from "../env";
import { badRequest, forbidden, json, notFound, nowIso, readJson } from "../http";
import { connectedPrincipals, type Changes } from "../live";
import { rowToUser, type UserRow } from "../repo/users";
import { currentVia } from "../tokens";

interface PartyRow {
  id: string;
  handle: string;
  kind: "person" | "agent";
  owner_id: string | null;
  work_from: "owner" | "members" | null;
}

const PARTY = `SELECT u.id, u.handle, u.kind, u.owner_id, a.work_from FROM users u LEFT JOIN agents a ON a.user_id = u.id`;

const party = (row: PartyRow): MessageParty => ({
  id: row.id,
  kind: row.kind,
  ownerId: row.owner_id,
  ...(row.work_from ? { workFrom: row.work_from } : {}),
});

/** A live principal by id or handle, or a 404 that says nothing about who exists. */
async function findParty(db: D1Database, ref: string): Promise<PartyRow> {
  const handle = ref.replace(/^@/, "").toLowerCase();
  const row = await db
    .prepare(`${PARTY} WHERE (u.id = ?1 OR u.handle = ?2) AND u.disabled_at IS NULL`)
    .bind(ref, handle)
    .first<PartyRow>();
  if (!row) throw notFound(`No one goes by \`${ref}\``);
  return row;
}

/**
 * Whether this principal can see the board: a member, and for an agent its
 * owner too, as boardsFor in access.ts has it.
 */
async function canSee(db: D1Database, who: PartyRow, boardId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM board_members m WHERE m.board_id = ?1 AND m.user_id = ?2
          AND (?3 IS NULL OR EXISTS (SELECT 1 FROM board_members o WHERE o.board_id = ?1 AND o.user_id = ?3))`,
    )
    .bind(boardId, who.id, who.kind === "agent" ? who.owner_id : null)
    .first();
  return !!row;
}

/** Whether the person and the agent are both on a board the agent can see. */
async function shareABoard(db: D1Database, person: string, agent: PartyRow): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM board_members p
         JOIN board_members a ON a.board_id = p.board_id AND a.user_id = ?2
         JOIN board_members o ON o.board_id = p.board_id AND o.user_id = ?3
        WHERE p.user_id = ?1 LIMIT 1`,
    )
    .bind(person, agent.id, agent.owner_id)
    .first();
  return !!row;
}

const TASK_KEY = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,9})$/;

/** The task, by id or key, on a board the viewer can see. */
async function visibleTask(db: D1Database, viewer: Viewer, ref: string) {
  const key = TASK_KEY.exec(ref);
  const row = await db
    .prepare(
      key
        ? `SELECT t.id, t.board_id FROM tasks t JOIN boards b ON b.id = t.board_id
            WHERE b.key = ?1 AND t.number = ?2 AND t.deleted_at IS NULL`
        : `SELECT id, board_id FROM tasks WHERE id = ?1 AND deleted_at IS NULL`,
    )
    .bind(...(key ? [key[1].toUpperCase(), Number(key[2])] : [ref]))
    .first<{ id: string; board_id: string }>();
  if (!row) throw notFound("No such task");
  try {
    await requireBoard(db, viewer, row.board_id, "viewer");
  } catch {
    throw notFound("No such task");
  }
  return row;
}

export async function postMessage(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  const db = env.DB;
  const body = await readJson(request);
  if (typeof body.text !== "string" || !body.text.trim()) throw badRequest("`text` must be a non-empty string");
  const text = body.text.trim();
  if (text.length > MESSAGE_MAX) throw badRequest(`\`text\` is longer than ${MESSAGE_MAX} characters`);
  for (const field of ["to", "taskId", "replyTo"] as const) {
    if (body[field] !== undefined && body[field] !== null && (typeof body[field] !== "string" || !body[field])) {
      throw badRequest(`\`${field}\` must be a string`);
    }
  }
  const to = (body.to as string | null | undefined) ?? null;
  const replyTo = (body.replyTo as string | null | undefined) ?? null;
  const taskRef = (body.taskId as string | null | undefined) ?? null;
  if (!to && !replyTo) throw badRequest("Say whom it is `to`, or which message it is a reply to (`replyTo`)");

  const sender = await db.prepare(`${PARTY} WHERE u.id = ?1`).bind(viewer.user.id).first<PartyRow>();
  if (!sender) throw notFound("No such user");

  let recipient: PartyRow;
  if (replyTo) {
    /* Only a message you were sent can be answered: anyone else's reads as not there. */
    const original = await db
      .prepare(`SELECT sender_id FROM messages WHERE id = ?1 AND recipient_id = ?2`)
      .bind(replyTo, viewer.user.id)
      .first<{ sender_id: string }>();
    if (!original) throw notFound("No message of yours has that id (`replyTo`)");
    recipient = await findParty(db, original.sender_id);
    if (to && (await findParty(db, to)).id !== recipient.id) {
      throw badRequest("A reply goes to whoever sent the message it answers; leave `to` out");
    }
  } else {
    recipient = await findParty(db, to as string);
  }

  const sharesBoard =
    !replyTo && sender.kind === "person" && recipient.kind === "agent" && recipient.owner_id !== sender.id
      ? await shareABoard(db, sender.id, recipient)
      : false;
  const verdict = mayMessage(party(sender), party(recipient), { sharesBoard, reply: !!replyTo });
  if (!verdict.ok) throw forbidden(verdict.reason);

  const task = taskRef ? await visibleTask(db, viewer, taskRef) : null;
  if (task && !(await canSee(db, recipient, task.board_id))) {
    throw forbidden(`@${recipient.handle} cannot see that task; send it without one, or about a task you both see`);
  }

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  await db.batch([
    db
      .prepare(`INSERT INTO messages (id, sender_id, recipient_id, text, reply_to, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(id, sender.id, recipient.id, text, replyTo, createdAt),
    db
      .prepare(
        `INSERT INTO inbox_items (id, user_id, kind, board_id, task_id, message_id, actor_id, via, created_at)
         VALUES (?1, ?2, 'message', ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(crypto.randomUUID(), recipient.id, task?.board_id ?? null, task?.id ?? null, id, sender.id, currentVia(), createdAt),
  ]);
  changes.notify([recipient.id], "inbox");
  const sent: SentMessage = {
    id,
    to: { id: recipient.id, handle: recipient.handle },
    taskId: task?.id ?? null,
    replyTo,
    trusted: verdict.trusted,
    createdAt,
  };
  return json(sent, { status: 201 });
}

interface CandidateRow extends UserRow {
  work_from: "owner" | "members";
  shares: number;
}

/**
 * GET /api/messages/recipients: the agents the viewer may message, for the
 * nudge pane (COPL-115). The candidates are their own agents and the agents
 * open to members on a board they share, each held against mayMessage with
 * the same shared-board fact postMessage asks for, so the list never offers
 * someone a send would refuse. Disabled agents are left out, as findParty
 * leaves them out of sending.
 *
 * Each says whether its daemon is connected (connectedPrincipals in
 * live.ts): nothing reads a message while it is not. Whether it has a run
 * going isn't said: runs go side by side and a message gets one of its own
 * (COPL-123), so a run says nothing about when a message is read.
 */
export async function getRecipients(env: Env, viewer: Viewer): Promise<Response> {
  const db = env.DB;
  const sender = await db.prepare(`${PARTY} WHERE u.id = ?1`).bind(viewer.user.id).first<PartyRow>();
  if (!sender) throw notFound("No such user");
  const { results } = await db
    .prepare(
      `SELECT u.*, a.work_from,
              EXISTS (SELECT 1 FROM board_members p
                        JOIN board_members m ON m.board_id = p.board_id AND m.user_id = u.id
                        JOIN board_members o ON o.board_id = p.board_id AND o.user_id = u.owner_id
                       WHERE p.user_id = ?1) AS shares
         FROM users u JOIN agents a ON a.user_id = u.id
        WHERE u.kind = 'agent' AND u.disabled_at IS NULL AND (u.owner_id = ?1 OR a.work_from = 'members')`,
    )
    .bind(sender.id)
    .all<CandidateRow>();
  const candidates = results.map((row) => ({
    row,
    handle: row.handle,
    sharesBoard: row.shares === 1,
    party: party(row),
  }));
  const offered = recipientsOf(party(sender), candidates);
  const connected = await connectedPrincipals(env, offered.map(({ row }) => row.id));
  const list: Recipient[] = offered.map(({ row }) => ({
    user: rowToUser(row),
    own: row.owner_id === sender.id,
    connected: connected.has(row.id),
  }));
  return json(list);
}
