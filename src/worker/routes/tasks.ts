/* ============================================================================
   Tasks: create, change, delete.
   ----------------------------------------------------------------------------
   Editors and owners write; viewers only read. Every write goes into the
   board's event log in the same batch as the change, and tells the board's
   members to refetch. Someone newly put on a task by someone else also gets
   it in their inbox (repo/inbox.ts).

   A PATCH carries only the fields that change, so the client can send one
   field at a time (a drag sends stageId and rank; a checkbox sends stageId).
   The stage decides completed_at: entering a done or cancelled stage stamps
   it, leaving one clears it. Planning fields (parentId, level, dependsOn)
   work on every board.

   Parents follow their children (domain/tasks.ts followChildren): a write
   that gives a task a new stage or a new parent, creates one under a parent,
   or deletes one moves the parents above it in the same batch, logged on
   each parent as the same principal's change, with `followed` naming the
   child. The response lists them under alsoMoved.

   A run's claim on a task (routes/runs.ts) does not survive the task
   closing, being deleted, moving to a blocked stage, or the claimer coming
   off its assignees: every write here ends with releaseClaimsStatement
   for the board.
   ========================================================================== */

import {
  BRIEF_MAX,
  defaultStage,
  followUp,
  isClosing,
  isDate,
  TITLE_MAX,
} from "@/domain/tasks";
import {
  LEVELS,
  PRIORITIES,
  type AlsoMoved,
  type BoardAccess,
  type Level,
  type Priority,
  type Stage,
  type Task,
  type TaskRead,
  type TaskWrite,
  type Viewer,
} from "@/domain/types";
import { personOf, requireBoard } from "../access";
import type { Env } from "../env";
import { badRequest, forbidden, HttpError, json, notFound, nowIso, readJson } from "../http";
import type { Changes } from "../live";
import { agentsAmong } from "../repo/agents";
import { inboxAudience, inboxStatements, type NewInboxItem } from "../repo/inbox";
import { boardAudience, bumpStatement, taskChange, versionOf } from "../repo/boards";
import { releaseClaimsStatement } from "../repo/runs";
import { bottomRank, eventStatement, findTask, listStages, progressFor } from "../repo/tasks";

/* ------------------------------------------------------------ parsing ---- */

function parseTitle(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw badRequest("`title` must be a non-empty string");
  const title = raw.trim().replace(/\s+/g, " ");
  if (title.length > TITLE_MAX) throw badRequest(`\`title\` is longer than ${TITLE_MAX} characters`);
  return title;
}

function parseBrief(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("`brief` must be a string");
  if (raw.length > BRIEF_MAX) throw badRequest(`\`brief\` is longer than ${BRIEF_MAX} characters`);
  return raw;
}

function parsePriority(raw: unknown): Priority {
  if (typeof raw !== "string" || !(PRIORITIES as readonly string[]).includes(raw)) {
    throw badRequest("`priority` must be low, normal, high or urgent");
  }
  return raw as Priority;
}

function parseDate(raw: unknown, name: string): string | null {
  if (raw === null) return null;
  if (!isDate(raw)) throw badRequest(`\`${name}\` must be YYYY-MM-DD or null`);
  return raw;
}

/** Every task has a level (COPL-85): one of LEVELS, never null. */
function parseLevel(raw: unknown): Level {
  if (!(LEVELS as readonly string[]).includes(raw as string)) throw badRequest(`\`level\` must be one of ${LEVELS.join(", ")}`);
  return raw as Level;
}

function parseFlag(raw: unknown, name: string): boolean {
  if (typeof raw !== "boolean") throw badRequest(`\`${name}\` must be true or false`);
  return raw;
}

function parseIdList(raw: unknown, name: string): string[] {
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string") || raw.length > 50) {
    throw badRequest(`\`${name}\` must be an array of ids`);
  }
  return [...new Set(raw as string[])];
}

function stageIn(stages: Stage[], id: unknown): Stage {
  const stage = stages.find((s) => s.id === id);
  if (!stage) throw badRequest("`stageId` is not a stage of this board");
  return stage;
}

/**
 * Everyone named must be on the board. An agent newly named also has to take
 * work from whoever is assigning: by default only its owner (and the owner's
 * other agents), unless the owner opened it to the board's members.
 * Unassigning, or keeping an assignment someone else made, needs nothing.
 */
export async function requireAssignable(
  db: D1Database,
  viewer: Viewer,
  boardId: string,
  userIds: string[],
  already: string[] = [],
): Promise<void> {
  if (userIds.length === 0) return;
  const members = new Set(await boardAudience(db, boardId));
  if (userIds.some((id) => !members.has(id))) throw badRequest("`assigneeIds` must all be members of the board");
  const added = userIds.filter((id) => !already.includes(id));
  const refused = (await agentsAmong(db, added)).filter((a) => a.workFrom === "owner" && a.ownerId !== personOf(viewer));
  if (refused.length) throw forbidden("Only an agent's owner can give it work");
}

async function requireLabels(db: D1Database, boardId: string, labelIds: string[]): Promise<void> {
  if (labelIds.length === 0) return;
  const { results } = await db
    .prepare(`SELECT id FROM labels WHERE board_id = ?1`)
    .bind(boardId)
    .all<{ id: string }>();
  const known = new Set(results.map((r) => r.id));
  if (labelIds.some((id) => !known.has(id))) throw badRequest("`labelIds` must all be labels of this board");
}

/** The board's task graph, for cycle checks: id → parent, id → dependencies. */
async function boardGraph(db: D1Database, boardId: string) {
  const [tasks, deps] = await Promise.all([
    db
      .prepare(`SELECT id, parent_id FROM tasks WHERE board_id = ?1 AND deleted_at IS NULL`)
      .bind(boardId)
      .all<{ id: string; parent_id: string | null }>(),
    db
      .prepare(
        `SELECT d.task_id, d.depends_on_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.board_id = ?1`,
      )
      .bind(boardId)
      .all<{ task_id: string; depends_on_id: string }>(),
  ]);
  const parent = new Map(tasks.results.map((t) => [t.id, t.parent_id]));
  const dependsOn = new Map<string, string[]>();
  for (const d of deps.results) dependsOn.set(d.task_id, [...(dependsOn.get(d.task_id) ?? []), d.depends_on_id]);
  return { parent, dependsOn };
}

async function checkParent(db: D1Database, board: BoardAccess, taskId: string | null, parentId: string | null) {
  if (parentId === null) return;
  const { parent } = await boardGraph(db, board.id);
  if (!parent.has(parentId)) throw badRequest("`parentId` is not a task on this board");
  /* Walk up from the new parent; meeting the task itself means a loop. */
  for (let at: string | null | undefined = parentId, hops = 0; at; at = parent.get(at), hops++) {
    if (at === taskId || hops > 1000) throw badRequest("That parent would put the task inside itself");
  }
}

async function checkDependencies(db: D1Database, board: BoardAccess, taskId: string, dependsOn: string[]) {
  if (dependsOn.length === 0) return;
  const graph = await boardGraph(db, board.id);
  if (dependsOn.some((id) => !graph.parent.has(id))) throw badRequest("`dependsOn` must all be tasks on this board");
  if (dependsOn.includes(taskId)) throw badRequest("A task cannot depend on itself");
  /* With the new edges in place, can we get from any dependency back here? */
  graph.dependsOn.set(taskId, dependsOn);
  const seen = new Set<string>();
  const stack = [...dependsOn];
  while (stack.length) {
    const at = stack.pop() as string;
    if (at === taskId) throw badRequest("Those dependencies would make a loop");
    if (seen.has(at)) continue;
    seen.add(at);
    stack.push(...(graph.dependsOn.get(at) ?? []));
  }
}

/* ---------------------------------------------- parents follow children -- */

interface FollowRow {
  id: string;
  parent_id: string | null;
  stage_id: string;
  rank: number;
  number: number;
  completed_at: string | null;
}

/**
 * The writes that move parents along with a change to one task (domain/
 * tasks.ts followUp), to go in the same batch as the change itself, so the
 * browser and the MCP get it the same way. `change` says what the board looks
 * like once the triggering write lands: the task's new stage or parent, a
 * task about to be created, or one about to be deleted. `parents` are the
 * parents to look at again (old and new on a reparent).
 *
 * Each move is logged as a task.updated event on the parent, by whoever made
 * the change, with `followed` naming the child it followed, which is what
 * the history shows as automatic.
 */
export async function followStatements(
  db: D1Database,
  viewer: Viewer,
  board: BoardAccess,
  stages: Stage[],
  child: { id: string; number: number },
  change: { stageId?: string; parentId?: string | null; rank?: number; created?: boolean; deleted?: boolean },
  parents: Array<string | null>,
): Promise<{ statements: D1PreparedStatement[]; moved: AlsoMoved[] }> {
  const starts = [...new Set(parents.filter((p): p is string => !!p))].map((parentId) => ({ parentId, childId: child.id }));
  if (starts.length === 0) return { statements: [], moved: [] };
  const { results } = await db
    .prepare(
      `SELECT id, parent_id, stage_id, rank, number, completed_at FROM tasks WHERE board_id = ?1 AND deleted_at IS NULL`,
    )
    .bind(board.id)
    .all<FollowRow>();
  let rows = results.map((r) => ({ ...r }));
  if (change.deleted) rows = rows.filter((r) => r.id !== child.id);
  if (change.created) {
    rows.push({ id: child.id, parent_id: change.parentId ?? null, stage_id: change.stageId ?? "", rank: change.rank ?? 0, number: child.number, completed_at: null });
  }
  const self = rows.find((r) => r.id === child.id);
  if (self && change.stageId !== undefined) self.stage_id = change.stageId;
  if (self && change.parentId !== undefined) self.parent_id = change.parentId;

  const moves = followUp(
    rows.map((r) => ({ id: r.id, parentId: r.parent_id, stageId: r.stage_id })),
    stages,
    starts,
  );
  if (moves.length === 0) return { statements: [], moved: [] };

  const byId = new Map(rows.map((r) => [r.id, r]));
  const keyOf = (number: number) => `${board.key}-${number}`;
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  const moved = new Map<string, AlsoMoved>();
  for (const move of moves) {
    const row = byId.get(move.id)!;
    const stage = stages.find((s) => s.id === move.to)!;
    /* The bottom of the new column, as for any move without a place. */
    const rank = Math.max(-1, ...rows.filter((r) => r.stage_id === move.to).map((r) => r.rank)) + 1;
    const completedAt = isClosing(stage.category) ? (row.completed_at ?? now) : null;
    const causeNumber = move.childId === child.id ? child.number : (byId.get(move.childId)?.number ?? 0);
    statements.push(
      db
        .prepare(`UPDATE tasks SET stage_id = ?2, rank = ?3, completed_at = ?4, updated_at = ?5 WHERE id = ?1`)
        .bind(move.id, move.to, rank, completedAt, now),
      eventStatement(db, {
        boardId: board.id,
        taskId: move.id,
        actorId: viewer.user.id,
        kind: "task.updated",
        before: { stageId: row.stage_id, rank: row.rank, completedAt: row.completed_at },
        after: { stageId: move.to, rank, completedAt, followed: keyOf(causeNumber) },
      }),
    );
    row.stage_id = move.to;
    row.rank = rank;
    row.completed_at = completedAt;
    moved.delete(move.id);
    moved.set(move.id, { id: move.id, key: keyOf(row.number), stageId: move.to });
  }
  return { statements, moved: [...moved.values()] };
}

/** A write's response: the task, and the parents that followed it when any did. */
export const written = (task: Task | null, moved: AlsoMoved[]): TaskWrite | null =>
  task && moved.length ? { ...task, alsoMoved: moved } : task;

/* ------------------------------------------------------------- routes ---- */

/** POST /api/boards/:id/tasks { title, stageId?, brief?, priority?, dates, assigneeIds?, ... } */
export async function postTask(
  request: Request,
  env: Env,
  viewer: Viewer,
  boardId: string,
  changes: Changes,
): Promise<Response> {
  const db = env.DB;
  const board = await requireBoard(db, viewer, boardId, "editor");
  const body = await readJson(request);
  const stages = await listStages(db, board.id);
  if (stages.length === 0) throw badRequest("This board has no stages");

  const title = parseTitle(body.title);
  /* No stage given: the first todo stage, not the first column (domain/tasks.ts). */
  const stage = body.stageId === undefined ? defaultStage(stages)! : stageIn(stages, body.stageId);
  const brief = body.brief === undefined ? "" : parseBrief(body.brief);
  const priority = body.priority === undefined ? "normal" : parsePriority(body.priority);
  const dueDate = body.dueDate === undefined ? null : parseDate(body.dueDate, "dueDate");
  /* No start given means it starts today (UTC here; the app sends the
     browser's own date). Only an explicit null leaves it undated. A due date
     already in the past pulls the default back to it, so start <= due holds. */
  const today = nowIso().slice(0, 10);
  const startDate =
    body.startDate === undefined
      ? dueDate !== null && dueDate < today
        ? dueDate
        : today
      : parseDate(body.startDate, "startDate");
  if (startDate && dueDate && startDate > dueDate) throw badRequest("The start date is after the due date");
  const assigneeIds = body.assigneeIds === undefined ? [] : parseIdList(body.assigneeIds, "assigneeIds");
  const labelIds = body.labelIds === undefined ? [] : parseIdList(body.labelIds, "labelIds");
  await requireAssignable(db, viewer, board.id, assigneeIds);
  await requireLabels(db, board.id, labelIds);

  let parentId: string | null = null;
  let level: Level = "task";
  if (body.parentId !== undefined && body.parentId !== null) {
    if (typeof body.parentId !== "string") throw badRequest("`parentId` must be a task id or null");
    await checkParent(db, board, null, body.parentId);
    parentId = body.parentId;
  }
  if (body.level !== undefined) level = parseLevel(body.level);

  const reviewFirst = body.reviewFirst === undefined ? false : parseFlag(body.reviewFirst, "reviewFirst");

  const rank = typeof body.rank === "number" && Number.isFinite(body.rank) ? body.rank : await bottomRank(db, stage.id);
  const id = crypto.randomUUID();
  const now = nowIso();
  /* The number the new task will get, for the log of any parent it moves. */
  const next = parentId
    ? ((await db.prepare(`SELECT next_number FROM boards WHERE id = ?1`).bind(board.id).first<{ next_number: number }>())
        ?.next_number ?? 0)
    : 0;
  const follow = await followStatements(
    db,
    viewer,
    board,
    stages,
    { id, number: next },
    { created: true, stageId: stage.id, parentId, rank },
    [parentId],
  );
  const assigned: NewInboxItem[] = assigneeIds.map((userId) => ({
    userId,
    kind: "assigned",
    boardId: board.id,
    taskId: id,
    actorId: viewer.user.id,
  }));

  const done = await db.batch([
    bumpStatement(db, board.id),
    /* The number comes from the board's counter and the counter moves in the
       same transaction, so two tasks created at once never share a number. */
    db
      .prepare(
        `INSERT INTO tasks (id, board_id, number, title, brief, stage_id, rank, priority, start_date, due_date,
                            completed_at, parent_id, level, review_first, created_by, created_at, updated_at)
         SELECT ?1, ?2, next_number, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?15, ?13, ?14, ?14
           FROM boards WHERE id = ?2`,
      )
      .bind(
        id,
        board.id,
        title,
        brief,
        stage.id,
        rank,
        priority,
        startDate,
        dueDate,
        isClosing(stage.category) ? now : null,
        parentId,
        level,
        viewer.user.id,
        now,
        reviewFirst ? 1 : 0,
      ),
    db.prepare(`UPDATE boards SET next_number = next_number + 1 WHERE id = ?1`).bind(board.id),
    ...assigneeIds.map((uid) =>
      db.prepare(`INSERT INTO task_assignees (task_id, user_id) VALUES (?1, ?2)`).bind(id, uid),
    ),
    ...labelIds.map((lid) => db.prepare(`INSERT INTO task_labels (task_id, label_id) VALUES (?1, ?2)`).bind(id, lid)),
    eventStatement(db, { boardId: board.id, taskId: id, actorId: viewer.user.id, kind: "task.created", after: { title } }),
    ...follow.statements,
    ...inboxStatements(db, assigned),
  ]);

  /* A new open task: the boards list's counts change too. */
  /* Under a parent, every task above it counts one more. */
  const news = await taskChange(db, board.id, versionOf(done[0]), [id, ...follow.moved.map((m) => m.id)], [], [parentId]);
  changes.board(await boardAudience(db, board.id), news, "boards");
  changes.notify(inboxAudience(assigned), "inbox");
  return json(written(await findTask(db, id), follow.moved), { status: 201 });
}

/** The task and its board, checked for the role the action needs. */
export async function taskFor(env: Env, viewer: Viewer, id: string, role: "viewer" | "editor") {
  const task = await findTask(env.DB, id);
  if (!task) throw notFound("No such task");
  /* Not a member reads as not found, same as for boards. */
  const board = await requireBoard(env.DB, viewer, task.boardId, role).catch((error: unknown) => {
    throw error instanceof HttpError && error.status === 404 ? notFound("No such task") : error;
  });
  return { task, board };
}

/** "CPL-12": a board key and a task number. A uuid never looks like this. */
const TASK_KEY = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,9})$/;

/**
 * GET /api/tasks/:ref, where ref is a task's id or its key ("cpl-12" works
 * too). The board screen has every task already; this is for a caller that
 * holds only a key, like an assistant. A task on a board the caller is not
 * on reads as not found, the same as a key that names nothing.
 */
export async function getTask(env: Env, viewer: Viewer, ref: string): Promise<Response> {
  let id = ref;
  const key = TASK_KEY.exec(ref);
  if (key) {
    const row = await env.DB.prepare(
      `SELECT t.id FROM tasks t JOIN boards b ON b.id = t.board_id
        WHERE b.key = ?1 AND t.number = ?2 AND t.deleted_at IS NULL`,
    )
      .bind(key[1].toUpperCase(), Number(key[2]))
      .first<{ id: string }>();
    if (!row) throw notFound("No such task");
    id = row.id;
  }
  const { task } = await taskFor(env, viewer, id, "viewer");
  /* A parent's progress, counted as the board read counts it, so a tab
     patching it in from a live event has it too. Most tasks have no
     children, which one probe of tasks_parent says before counting. */
  const parent = await env.DB.prepare(`SELECT 1 FROM tasks WHERE parent_id = ?1 AND deleted_at IS NULL LIMIT 1`).bind(task.id).first();
  const progress = parent ? (await progressFor(env.DB, [task.id]))[task.id] : undefined;
  return json((progress ? { ...task, progress } : task) satisfies TaskRead);
}

/** PATCH /api/tasks/:id: any subset of the fields POST takes. */
export async function patchTask(
  request: Request,
  env: Env,
  viewer: Viewer,
  id: string,
  changes: Changes,
): Promise<Response> {
  const db = env.DB;
  const { task, board } = await taskFor(env, viewer, id, "editor");
  const body = await readJson(request);

  const sets: string[] = [];
  const values: unknown[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const extra: D1PreparedStatement[] = [];
  const assigned: NewInboxItem[] = [];

  const set = (column: string, field: keyof Task, value: unknown) => {
    if (task[field] === value) return;
    sets.push(`${column} = ?${values.length + 2}`);
    /* SQLite has no booleans: a flag is stored as 0 or 1. */
    values.push(typeof value === "boolean" ? Number(value) : value);
    before[field] = task[field];
    after[field] = value;
  };

  if (body.title !== undefined) set("title", "title", parseTitle(body.title));
  if (body.brief !== undefined) set("brief", "brief", parseBrief(body.brief));
  if (body.priority !== undefined) set("priority", "priority", parsePriority(body.priority));
  if (body.reviewFirst !== undefined) set("review_first", "reviewFirst", parseFlag(body.reviewFirst, "reviewFirst"));

  const startDate = body.startDate === undefined ? task.startDate : parseDate(body.startDate, "startDate");
  const dueDate = body.dueDate === undefined ? task.dueDate : parseDate(body.dueDate, "dueDate");
  if (startDate && dueDate && startDate > dueDate) throw badRequest("The start date is after the due date");
  set("start_date", "startDate", startDate);
  set("due_date", "dueDate", dueDate);

  const stages = await listStages(db, board.id);
  if (body.stageId !== undefined) {
    const stage = stageIn(stages, body.stageId);
    if (stage.id !== task.stageId) {
      set("stage_id", "stageId", stage.id);
      const closing = isClosing(stage.category);
      set("completed_at", "completedAt", closing ? (task.completedAt ?? nowIso()) : null);
      /* Moved without a place in the new column: goes to the bottom. */
      if (body.rank === undefined) set("rank", "rank", await bottomRank(db, stage.id));
    }
  }
  if (body.rank !== undefined) {
    if (typeof body.rank !== "number" || !Number.isFinite(body.rank)) throw badRequest("`rank` must be a number");
    set("rank", "rank", body.rank);
  }

  if (body.parentId !== undefined) {
    if (body.parentId !== null && typeof body.parentId !== "string") throw badRequest("`parentId` must be a task id or null");
    await checkParent(db, board, task.id, body.parentId as string | null);
    set("parent_id", "parentId", body.parentId);
  }
  if (body.level !== undefined) set("level", "level", parseLevel(body.level));

  if (body.assigneeIds !== undefined) {
    const assigneeIds = parseIdList(body.assigneeIds, "assigneeIds");
    await requireAssignable(db, viewer, board.id, assigneeIds, task.assigneeIds);
    /* Only the newly added hear about it; staying on a task is not news. */
    for (const userId of assigneeIds.filter((uid) => !task.assigneeIds.includes(uid))) {
      assigned.push({ userId, kind: "assigned", boardId: board.id, taskId: id, actorId: viewer.user.id });
    }
    before.assigneeIds = task.assigneeIds;
    after.assigneeIds = assigneeIds;
    extra.push(
      db.prepare(`DELETE FROM task_assignees WHERE task_id = ?1`).bind(id),
      ...assigneeIds.map((uid) => db.prepare(`INSERT INTO task_assignees (task_id, user_id) VALUES (?1, ?2)`).bind(id, uid)),
    );
  }
  if (body.labelIds !== undefined) {
    const labelIds = parseIdList(body.labelIds, "labelIds");
    await requireLabels(db, board.id, labelIds);
    before.labelIds = task.labelIds;
    after.labelIds = labelIds;
    extra.push(
      db.prepare(`DELETE FROM task_labels WHERE task_id = ?1`).bind(id),
      ...labelIds.map((lid) => db.prepare(`INSERT INTO task_labels (task_id, label_id) VALUES (?1, ?2)`).bind(id, lid)),
    );
  }
  if (body.dependsOn !== undefined) {
    const dependsOn = parseIdList(body.dependsOn, "dependsOn");
    await checkDependencies(db, board, task.id, dependsOn);
    before.dependsOn = task.dependsOn;
    after.dependsOn = dependsOn;
    extra.push(
      db.prepare(`DELETE FROM task_dependencies WHERE task_id = ?1`).bind(id),
      ...dependsOn.map((dep) =>
        db.prepare(`INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?1, ?2)`).bind(id, dep),
      ),
    );
  }

  if (sets.length === 0 && extra.length === 0) return json(task);

  /* A new stage or a new parent can move parents: the one it had and the one it has now. */
  const follow =
    "stageId" in after || "parentId" in after
      ? await followStatements(
          db,
          viewer,
          board,
          stages,
          task,
          {
            ...("stageId" in after ? { stageId: after.stageId as string } : {}),
            ...("parentId" in after ? { parentId: after.parentId as string | null } : {}),
          },
          [task.parentId, "parentId" in after ? (after.parentId as string | null) : null],
        )
      : { statements: [], moved: [] };

  sets.push(`updated_at = ?${values.length + 2}`);
  values.push(nowIso());
  const done = await db.batch([
    bumpStatement(db, board.id),
    db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?1`).bind(id, ...values),
    ...extra,
    eventStatement(db, { boardId: board.id, taskId: id, actorId: viewer.user.id, kind: "task.updated", before, after }),
    ...follow.statements,
    ...inboxStatements(db, assigned),
    releaseClaimsStatement(db, board.id),
  ]);

  /* A new stage or parent names everything above it too, old parent and
     new: their progress can move. Whoever was on it before hears it as well
     as whoever is now. A new stage can close or reopen it or a parent, which
     changes the boards list's counts: sent on the write that can, never on
     comparing counts. */
  const parents =
    "stageId" in after || "parentId" in after
      ? [task.parentId, "parentId" in after ? (after.parentId as string | null) : null]
      : [];
  const news = await taskChange(db, board.id, versionOf(done[0]), [id, ...follow.moved.map((m) => m.id)], task.assigneeIds, parents);
  const topics = "stageId" in after ? (["boards"] as const) : [];
  changes.board(await boardAudience(db, board.id), news, ...topics);
  changes.notify(inboxAudience(assigned), "inbox");
  return json(written(await findTask(db, id), follow.moved));
}

/** DELETE /api/tasks/:id: soft, so the log still has something to point at. */
export async function deleteTask(env: Env, viewer: Viewer, id: string, changes: Changes): Promise<Response> {
  const db = env.DB;
  const { task, board } = await taskFor(env, viewer, id, "editor");
  /* Its parent may be left with nothing open under it. */
  const follow = await followStatements(db, viewer, board, await listStages(db, board.id), task, { deleted: true }, [
    task.parentId,
  ]);
  await db.batch([
    db.prepare(`UPDATE tasks SET deleted_at = ?2 WHERE id = ?1`).bind(id, nowIso()),
    /* Nothing should hang off a task that is gone. */
    db.prepare(`UPDATE tasks SET parent_id = NULL WHERE parent_id = ?1`).bind(id),
    db.prepare(`DELETE FROM task_dependencies WHERE depends_on_id = ?1 OR task_id = ?1`).bind(id),
    eventStatement(db, {
      boardId: board.id,
      taskId: id,
      actorId: viewer.user.id,
      kind: "task.deleted",
      before: { title: task.title },
    }),
    ...follow.statements,
    releaseClaimsStatement(db, board.id),
  ]);
  /* No task ids: a task gone (and its children unparented) is read with the whole board. */
  changes.board(await boardAudience(db, board.id), { board: board.id, assignees: task.assigneeIds }, "boards");
  return json(follow.moved.length ? { ok: true, alsoMoved: follow.moved } : { ok: true });
}
