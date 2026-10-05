/* ============================================================================
   Tasks, stages and labels: the reads a board screen needs, and the row
   lookups the task routes start from.
   ----------------------------------------------------------------------------
   A board's everyday read (boardTasks) is bounded by what the board shows,
   not by its history (COPL-150): its open tasks, those closed in the last
   RECENT_CLOSED_DAYS, and the tasks those name as parent (up the tree) or
   depend on, so every key on screen resolves. Older closed tasks come a page
   at a time (closedTasks), only when someone asks for them. Whatever the
   tasks, what hangs off them (assignees, labels, dependencies, comment
   counts, claims, attachments, code, changed files) is one grouped query
   each over their ids, never a subquery per task, and a parent's progress is
   counted in SQL over its whole subtree, so it still counts the children
   the read left out.
   ========================================================================== */

import { clientLabel } from "@/domain/clients";
import { shortRunId } from "@/domain/runs";
import { RECENT_CLOSED_DAYS } from "@/domain/tasks";
import type { Attachment, ClosedPage, Label, Level, ParentProgress, Priority, Stage, StageCategory, Task } from "@/domain/types";
import { currentRun, currentVia } from "../tokens";
import { overlaps } from "@/domain/overlap";
import { codeFor } from "./github";
import { LIVE_CLAIM } from "./runs";

interface TaskRow {
  id: string;
  board_id: string;
  board_key: string;
  number: number;
  title: string;
  brief: string;
  stage_id: string;
  rank: number;
  priority: Priority;
  start_date: string | null;
  due_date: string | null;
  completed_at: string | null;
  parent_id: string | null;
  level: Level | null;
  review_first: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    boardId: row.board_id,
    number: row.number,
    key: `${row.board_key}-${row.number}`,
    title: row.title,
    brief: row.brief,
    stageId: row.stage_id,
    rank: row.rank,
    priority: row.priority,
    startDate: row.start_date,
    dueDate: row.due_date,
    completedAt: row.completed_at,
    parentId: row.parent_id,
    /* Backfilled by migration 0021 and refused by the routes; the column itself still allows null. */
    level: row.level ?? "task",
    assigneeIds: [],
    labelIds: [],
    dependsOn: [],
    commentCount: 0,
    attachments: [],
    claim: null,
    reviewFirst: row.review_first === 1,
    code: [],
    overlap: [],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TASK_SELECT = `SELECT t.*, b.key AS board_key FROM tasks t JOIN boards b ON b.id = t.board_id`;

/** A set of task ids, bound as one JSON array (?1): `task_id ${IN_IDS}`. */
const IN_IDS = `IN (SELECT value FROM json_each(?1))`;

interface ClaimRow {
  task_id: string;
  user_id: string;
  run_id: string;
  claimed_until: string;
  kind: string;
  hears: number;
  client: string | null;
}

const toClaim = (r: ClaimRow): Task["claim"] => ({
  userId: r.user_id,
  runId: r.run_id,
  run: shortRunId(r.run_id),
  kind: r.kind === "interactive" ? "interactive" : "supervised",
  client: r.client ? clientLabel(r.client) : null,
  until: r.claimed_until,
  hears: r.hears === 1,
});

/**
 * Tasks from their rows, with everything that hangs off them: one grouped
 * query each over all of their ids. `overlap` also works out which open
 * ones among them change the same files (domain/overlap.ts), which only
 * means something over a board's open tasks all together.
 */
async function hydrate(db: D1Database, rows: TaskRow[], overlap: boolean): Promise<Task[]> {
  const tasks = rows.map(rowToTask);
  if (tasks.length === 0) return tasks;
  /* One task (findTask) is bound as itself: json_each costs rows read too. */
  const one = tasks.length === 1;
  const IN = one ? "= ?1" : IN_IDS;
  const ids = one ? tasks[0].id : JSON.stringify(tasks.map((t) => t.id));
  /* Claims and changed files are only ever an open task's: closing one ends its claim, and housekeeping drops its files. */
  const openIds = tasks.filter((t) => t.completedAt === null).map((t) => t.id);
  const open = one ? ids : JSON.stringify(openIds);
  const pairs = (sql: string) => db.prepare(sql).bind(ids).all<{ task_id: string; value: string }>();
  const [assignees, labels, dependsOn, comments, claims, attachments, code, files] = await Promise.all([
    pairs(`SELECT task_id, user_id AS value FROM task_assignees WHERE task_id ${IN} ORDER BY task_id, user_id`),
    pairs(`SELECT task_id, label_id AS value FROM task_labels WHERE task_id ${IN} ORDER BY task_id, label_id`),
    pairs(`SELECT task_id, depends_on_id AS value FROM task_dependencies WHERE task_id ${IN} ORDER BY task_id, depends_on_id`),
    db.prepare(`SELECT task_id, count(*) AS n FROM comments WHERE task_id ${IN} GROUP BY task_id`).bind(ids).all<{ task_id: string; n: number }>(),
    openIds.length
      ? db
          .prepare(
            `SELECT c.task_id, c.user_id, c.run_id, c.claimed_until, r.kind, r.heard_until IS NOT NULL AS hears, r.client
               FROM task_claims c JOIN runs r ON r.id = c.run_id
              WHERE c.task_id ${IN} AND ${LIVE_CLAIM}`,
          )
          .bind(open)
          .all<ClaimRow>()
      : null,
    attachmentsFor(db, `a.task_id ${IN}`, ids),
    codeFor(db, `c.task_id ${IN}`, ids),
    overlap && openIds.length
      ? db.prepare(`SELECT task_id, files FROM task_files WHERE task_id ${IN}`).bind(open).all<{ task_id: string; files: string }>()
      : null,
  ]);
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  for (const r of assignees.results) byTask.get(r.task_id)?.assigneeIds.push(r.value);
  for (const r of labels.results) byTask.get(r.task_id)?.labelIds.push(r.value);
  for (const r of dependsOn.results) byTask.get(r.task_id)?.dependsOn.push(r.value);
  for (const r of comments.results) {
    const task = byTask.get(r.task_id);
    if (task) task.commentCount = r.n;
  }
  for (const r of claims?.results ?? []) {
    const task = byTask.get(r.task_id);
    if (task) task.claim = toClaim(r);
  }
  for (const task of tasks) {
    task.attachments = attachments.get(task.id) ?? [];
    task.code = code.get(task.id) ?? [];
  }
  if (files) {
    /* In board order, as overlaps() reports them. */
    const changed = new Map(files.results.map((r) => [r.task_id, JSON.parse(r.files) as string[]]));
    const shared = overlaps(tasks.filter((t) => changed.has(t.id)).map((t) => ({ id: t.id, files: changed.get(t.id)! })));
    for (const task of tasks) {
      task.overlap = (shared.get(task.id) ?? []).map((o) => ({ key: byTask.get(o.taskId)!.key, files: o.shared.length }));
    }
  }
  return tasks;
}

/**
 * Each of these tasks that has children: how many, and its leaf tasks at any
 * depth done out of those not cancelled, the way progress() in
 * domain/tasks.ts counts them, but over the whole subtree in the database,
 * closed tasks of any age included. A looped parent chain is walked once
 * (UNION), and a task is never counted under itself.
 */
async function progressFor(db: D1Database, ids: string[]): Promise<Record<string, ParentProgress>> {
  if (ids.length === 0) return {};
  const { results } = await db
    .prepare(
      `WITH RECURSIVE below(root, id) AS (
         SELECT parent_id, id FROM tasks WHERE parent_id ${IN_IDS} AND deleted_at IS NULL
         UNION
         SELECT b.root, t.id FROM below b JOIN tasks t ON t.parent_id = b.id AND t.deleted_at IS NULL
       )
       SELECT root, sum(parent_id = root) AS children,
              sum(leaf AND category = 'done') AS done, sum(leaf AND category != 'cancelled') AS total
         FROM (SELECT b.root, t.parent_id, s.category,
                      t.level IS NOT 'milestone'
                        AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.deleted_at IS NULL) AS leaf
                 FROM below b JOIN tasks t ON t.id = b.id JOIN stages s ON s.id = t.stage_id
                WHERE b.id != b.root)
        GROUP BY root`,
    )
    .bind(JSON.stringify(ids))
    .all<{ root: string; children: number; done: number; total: number }>();
  return Object.fromEntries(results.map((r) => [r.root, { children: r.children, done: r.done, total: r.total }]));
}

const recentCutoff = (now: number) => new Date(now - RECENT_CLOSED_DAYS * 86_400_000).toISOString();

/**
 * A board's everyday read (GET /api/boards/:id): its open tasks, those
 * closed since RECENT_CLOSED_DAYS ago, and the tasks those name as parent
 * (up the tree) or depend on, in board order; their parents' progress; and
 * whether older closed tasks were left out. Reads the same however long
 * the board's history is.
 */
export async function boardTasks(
  db: D1Database,
  boardId: string,
  now = Date.now(),
): Promise<{ tasks: Task[]; progress: Record<string, ParentProgress>; olderClosed: boolean }> {
  const cutoff = recentCutoff(now);
  const { results } = await db
    .prepare(
      `WITH RECURSIVE
         own(id) AS (
           SELECT id FROM tasks WHERE board_id = ?1 AND deleted_at IS NULL AND completed_at IS NULL
           UNION ALL
           SELECT id FROM tasks WHERE board_id = ?1 AND deleted_at IS NULL AND completed_at IS NOT NULL AND completed_at >= ?2),
         named(id) AS (
           SELECT id FROM own
           UNION
           SELECT d.depends_on_id FROM own o JOIN task_dependencies d ON d.task_id = o.id),
         shown(id) AS (
           SELECT id FROM named
           UNION
           SELECT t.parent_id FROM shown s JOIN tasks t ON t.id = s.id WHERE t.parent_id IS NOT NULL)
       SELECT t.*, b.key AS board_key FROM shown CROSS JOIN tasks t ON t.id = shown.id JOIN boards b ON b.id = t.board_id
        WHERE t.board_id = ?1 AND t.deleted_at IS NULL
        ORDER BY t.rank, t.number`,
    )
    .bind(boardId, cutoff)
    .all<TaskRow>();
  const ids = results.map((r) => r.id);
  const [tasks, progress, older] = await Promise.all([
    hydrate(db, results, true),
    progressFor(db, ids),
    /* Older ones it names are already here: the question is whether any were left out. */
    db
      .prepare(
        `SELECT 1 FROM tasks
          WHERE board_id = ?1 AND deleted_at IS NULL AND completed_at IS NOT NULL AND completed_at < ?2 AND id NOT IN (SELECT value FROM json_each(?3))
          LIMIT 1`,
      )
      .bind(boardId, cutoff, JSON.stringify(ids))
      .first(),
  ]);
  return { tasks, progress, olderClosed: older !== null };
}

/** The most a page of closedTasks holds. */
export const CLOSED_PAGE = 100;

/**
 * A page cursor: the last task's completed_at and rowid. tasks_completed
 * (migration 0033) holds a board's closed tasks in that order, so a page
 * reads only its own rows.
 */
const cursor = (r: TaskRow & { seq: number }) => `${r.completed_at}~${r.seq}`;

/**
 * GET /api/boards/:id/closed: a board's tasks closed before
 * RECENT_CLOSED_DAYS ago, newest first, `limit` at a time. `before` is the
 * `next` of the page before; without it, the first page. Tasks the board's
 * everyday read also has (it names old ones) can come again here; callers
 * merge by id.
 */
export async function closedTasks(
  db: D1Database,
  boardId: string,
  before: string | null,
  limit = CLOSED_PAGE,
  now = Date.now(),
): Promise<ClosedPage> {
  const [at, seq] = before && /^[^~]+~\d+$/.test(before) ? [before.split("~")[0], Number(before.split("~")[1])] : [recentCutoff(now), 0];
  const { results } = await db
    .prepare(
      `SELECT t.*, t.rowid AS seq, b.key AS board_key FROM tasks t JOIN boards b ON b.id = t.board_id
        WHERE t.board_id = ?1 AND t.deleted_at IS NULL AND t.completed_at IS NOT NULL
          AND (t.completed_at < ?2 OR (t.completed_at = ?2 AND t.rowid < ?3))
        ORDER BY t.completed_at DESC, t.rowid DESC
        LIMIT ?4`,
    )
    .bind(boardId, at, seq, limit + 1)
    .all<TaskRow & { seq: number }>();
  const rows = results.slice(0, limit);
  const [tasks, progress] = await Promise.all([hydrate(db, rows, false), progressFor(db, rows.map((r) => r.id))]);
  return { tasks, progress, next: results.length > limit ? cursor(rows[rows.length - 1]) : null };
}

/** An open task's latest changed files (migrations/0024_task_files.sql), with who is on it. */
export interface OpenTaskFiles {
  id: string;
  key: string;
  title: string;
  base: string;
  files: string[];
  truncated: boolean;
  reportedAt: string;
  /** Handles. */
  assignees: string[];
  /** The handle whose run holds its live claim, or null. */
  claimedBy: string | null;
}

/**
 * The latest file lists of a board's open tasks, in board order: what
 * overlap is computed from (domain/overlap.ts). One query per board; a closed
 * or deleted task's list is never read here, and housekeeping.ts deletes it a
 * week later.
 */
export async function openTaskFiles(db: D1Database, boardId: string): Promise<OpenTaskFiles[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, b.key || '-' || t.number AS key, t.title, f.base, f.files, f.truncated, f.reported_at,
              (SELECT group_concat(u.handle, ' ') FROM task_assignees a JOIN users u ON u.id = a.user_id
                WHERE a.task_id = t.id) AS assignees,
              (SELECT u.handle FROM task_claims c JOIN runs r ON r.id = c.run_id JOIN users u ON u.id = c.user_id
                WHERE c.task_id = t.id AND ${LIVE_CLAIM}) AS claimed_by
         FROM task_files f JOIN tasks t ON t.id = f.task_id JOIN boards b ON b.id = t.board_id
              JOIN stages s ON s.id = t.stage_id
        WHERE t.board_id = ?1 AND t.deleted_at IS NULL AND s.category NOT IN ('done', 'cancelled')
        ORDER BY t.rank, t.number`,
    )
    .bind(boardId)
    .all<{
      id: string;
      key: string;
      title: string;
      base: string;
      files: string;
      truncated: number;
      reported_at: string;
      assignees: string | null;
      claimed_by: string | null;
    }>();
  return results.map((r) => ({
    id: r.id,
    key: r.key,
    title: r.title,
    base: r.base,
    files: JSON.parse(r.files) as string[],
    truncated: r.truncated === 1,
    reportedAt: r.reported_at,
    assignees: r.assignees ? r.assignees.split(" ") : [],
    claimedBy: r.claimed_by,
  }));
}

/** A live (not deleted) task, or null. Access is the caller's job. */
export async function findTask(db: D1Database, id: string): Promise<Task | null> {
  const row = await db.prepare(`${TASK_SELECT} WHERE t.id = ?1 AND t.deleted_at IS NULL`).bind(id).first<TaskRow>();
  return row ? (await hydrate(db, [row], false))[0] : null;
}

interface AttachmentRow {
  id: string;
  task_id: string;
  name: string;
  mime: string;
  size: number;
  kind: Attachment["kind"];
  key: string | null;
  url: string | null;
  created_at: string;
}

/**
 * Attachments grouped by task (`where` over a, its one parameter ?1). A
 * comment's images are the comment's (routes/comments.ts), not here.
 */
async function attachmentsFor(db: D1Database, where: string, value: string): Promise<Map<string, Attachment[]>> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.task_id, a.name, a.mime, a.size, a.kind, a.key, a.url, a.created_at
         FROM attachments a
        WHERE ${where} AND a.comment_id IS NULL ORDER BY a.created_at`,
    )
    .bind(value)
    .all<AttachmentRow>();
  const out = new Map<string, Attachment[]>();
  for (const r of results) {
    const list = out.get(r.task_id) ?? [];
    list.push({ id: r.id, name: r.name, type: r.mime, size: r.size, kind: r.kind, key: r.key, url: r.url, createdAt: r.created_at });
    out.set(r.task_id, list);
  }
  return out;
}

export async function listStages(db: D1Database, boardId: string): Promise<Stage[]> {
  const { results } = await db
    .prepare(`SELECT id, position, name, category, tone FROM stages WHERE board_id = ?1 ORDER BY position`)
    .bind(boardId)
    .all<{ id: string; position: number; name: string; category: StageCategory; tone: number }>();
  return results;
}

export async function listLabels(db: D1Database, boardId: string): Promise<Label[]> {
  const { results } = await db
    .prepare(`SELECT id, name, tone FROM labels WHERE board_id = ?1 ORDER BY lower(name)`)
    .bind(boardId)
    .all<Label>();
  return results;
}

/** The rank that puts a task at the bottom of a stage. */
export async function bottomRank(db: D1Database, stageId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT max(rank) AS r FROM tasks WHERE stage_id = ?1 AND deleted_at IS NULL`)
    .bind(stageId)
    .first<{ r: number | null }>();
  return row?.r === null || row?.r === undefined ? 0 : row.r + 1;
}

/**
 * An event row for the board's activity log, as a statement for a batch.
 * `via` and `run_id` come from the request (tokens.ts asAccess): which
 * assistant or token made the change, and through which run; null for the
 * web app.
 */
export function eventStatement(
  db: D1Database,
  event: { boardId: string; taskId: string | null; actorId: string; kind: string; before?: unknown; after?: unknown },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO events (id, board_id, task_id, actor_id, kind, before, after, via, run_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      crypto.randomUUID(),
      event.boardId,
      event.taskId,
      event.actorId,
      event.kind,
      event.before === undefined ? null : JSON.stringify(event.before),
      event.after === undefined ? null : JSON.stringify(event.after),
      currentVia(),
      currentRun(),
    );
}
