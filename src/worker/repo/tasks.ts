/* ============================================================================
   Tasks: reading a board's tasks with their assignees, labels and
   dependencies attached. Writes arrive with the tracker (phase 4).
   ========================================================================== */

import type { Label, Level, Priority, Stage, StageCategory, Task } from "@/domain/types";

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
  assignee_ids: string | null;
  label_ids: string | null;
  depends_on: string | null;
  comment_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const ids = (csv: string | null) => (csv ? csv.split(",") : []);

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
    level: row.level,
    assigneeIds: ids(row.assignee_ids),
    labelIds: ids(row.label_ids),
    dependsOn: ids(row.depends_on),
    commentCount: row.comment_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listTasks(db: D1Database, boardId: string): Promise<Task[]> {
  const { results } = await db
    .prepare(
      `SELECT t.*, b.key AS board_key,
              (SELECT group_concat(user_id) FROM task_assignees WHERE task_id = t.id) AS assignee_ids,
              (SELECT group_concat(label_id) FROM task_labels WHERE task_id = t.id) AS label_ids,
              (SELECT group_concat(depends_on_id) FROM task_dependencies WHERE task_id = t.id) AS depends_on,
              (SELECT count(*) FROM comments WHERE task_id = t.id) AS comment_count
         FROM tasks t JOIN boards b ON b.id = t.board_id
        WHERE t.board_id = ?1 AND t.deleted_at IS NULL
        ORDER BY t.rank, t.number`,
    )
    .bind(boardId)
    .all<TaskRow>();
  return results.map(rowToTask);
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
