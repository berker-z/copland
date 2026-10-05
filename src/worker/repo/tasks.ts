/* ============================================================================
   Tasks, stages and labels: the reads a board screen needs, and the row
   lookups the task routes start from.
   ========================================================================== */

import { clientLabel } from "@/domain/clients";
import { shortRunId } from "@/domain/runs";
import type { Attachment, Label, Level, Priority, Stage, StageCategory, Task } from "@/domain/types";
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
  assignee_ids: string | null;
  label_ids: string | null;
  depends_on: string | null;
  comment_count: number;
  /** "user_id run_id claimed_until kind hears client" of a live claim, or null (client may be empty or hold spaces). */
  claim: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const ids = (csv: string | null) => (csv ? csv.split(",") : []);

function toClaim(packed: string | null): Task["claim"] {
  if (!packed) return null;
  const [userId, runId, until, kind, hears, ...client] = packed.split(" ");
  return {
    userId,
    runId,
    run: shortRunId(runId),
    kind: kind === "interactive" ? "interactive" : "supervised",
    client: client.join(" ") ? clientLabel(client.join(" ")) : null,
    until,
    hears: hears === "1",
  };
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
    assigneeIds: ids(row.assignee_ids),
    labelIds: ids(row.label_ids),
    dependsOn: ids(row.depends_on),
    commentCount: row.comment_count,
    attachments: [],
    claim: toClaim(row.claim),
    reviewFirst: row.review_first === 1,
    code: [],
    overlap: [],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TASK_SELECT = `
  SELECT t.*, b.key AS board_key,
         (SELECT group_concat(user_id) FROM task_assignees WHERE task_id = t.id) AS assignee_ids,
         (SELECT group_concat(label_id) FROM task_labels WHERE task_id = t.id) AS label_ids,
         (SELECT group_concat(depends_on_id) FROM task_dependencies WHERE task_id = t.id) AS depends_on,
         (SELECT count(*) FROM comments WHERE task_id = t.id) AS comment_count,
         (SELECT c.user_id || ' ' || c.run_id || ' ' || c.claimed_until || ' ' || r.kind || ' ' || (r.heard_until IS NOT NULL) || ' ' || coalesce(r.client, '')
            FROM task_claims c JOIN runs r ON r.id = c.run_id
           WHERE c.task_id = t.id AND ${LIVE_CLAIM}) AS claim
    FROM tasks t JOIN boards b ON b.id = t.board_id`;

export async function listTasks(db: D1Database, boardId: string): Promise<Task[]> {
  const { results } = await db
    .prepare(`${TASK_SELECT} WHERE t.board_id = ?1 AND t.deleted_at IS NULL ORDER BY t.rank, t.number`)
    .bind(boardId)
    .all<TaskRow>();
  const tasks = results.map(rowToTask);
  const [byTask, code, files] = await Promise.all([
    attachmentsFor(db, `t.board_id = ?1`, boardId),
    codeFor(db, `t.board_id = ?1`, boardId),
    openTaskFiles(db, boardId),
  ]);
  const shared = overlaps(files);
  const keyOf = new Map(files.map((f) => [f.id, f.key]));
  for (const task of tasks) {
    task.attachments = byTask.get(task.id) ?? [];
    task.code = code.get(task.id) ?? [];
    task.overlap = (shared.get(task.id) ?? []).map((o) => ({ key: keyOf.get(o.taskId)!, files: o.shared.length }));
  }
  return tasks;
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
  const row = await db
    .prepare(`${TASK_SELECT} WHERE t.id = ?1 AND t.deleted_at IS NULL`)
    .bind(id)
    .first<TaskRow>();
  if (!row) return null;
  const task = rowToTask(row);
  const [attachments, code] = await Promise.all([attachmentsFor(db, `a.task_id = ?1`, id), codeFor(db, `c.task_id = ?1`, id)]);
  task.attachments = attachments.get(id) ?? [];
  task.code = code.get(id) ?? [];
  return task;
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
 * Attachments grouped by task, for one board or one task (`where` over a and
 * t). A comment's images are the comment's (routes/comments.ts), not here.
 */
async function attachmentsFor(db: D1Database, where: string, value: string): Promise<Map<string, Attachment[]>> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.task_id, a.name, a.mime, a.size, a.kind, a.key, a.url, a.created_at
         FROM attachments a JOIN tasks t ON t.id = a.task_id
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
