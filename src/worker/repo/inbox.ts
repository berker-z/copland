/* ============================================================================
   Inboxes and mentions (migrations/0008_inbox.sql).
   ----------------------------------------------------------------------------
   What lands in an inbox, from the routes that cause it:
     assigned   routes/tasks.ts, when someone else puts you on a task
     mentioned  routes/comments.ts, when a comment names you
     commented  routes/comments.ts, when someone comments on a task you take
                part in (participantsOf) and does not name you
     message    routes/messages.ts, a note from your owner, your agent, or
                (untrusted) someone an open agent of yours shares a board with
     unblocked  routes/tasks.ts and routes/stages.ts, when the last open task
                one of your todo tasks waits on (depends_on) closes or is
                deleted: it can start now (unblockedStatement)

   A task's participants are its creator, its assignees, and everyone who has
   commented on it or been mentioned on it, as long as they are still on its
   board. Only a new comment tells them; editing one tells only whoever it
   newly names.

   A mention is "@handle" or "@owner/agent" outside code and quotes (the rule
   is domain/mentions.ts, shared with the browser's highlight), matched
   against the members of the task's board, case-insensitive, and only them:
   someone who cannot see the task gets nothing, so a mention can never leak
   a task's title.
   Nobody is told about their own doing, except unblocked: an agent that
   closes what its own next task waits on still has to hear that it can
   start it, since that is what wakes its daemon.
   ========================================================================== */

import type { BoardMember } from "@/domain/types";
import { mentionMatches } from "@/domain/mentions";
import { currentVia } from "../tokens";

/** The members a comment's text names, by id, each once. */
export function mentionedIn(text: string, members: BoardMember[]): string[] {
  const byHandle = new Map(members.map((m) => [m.user.handle.toLowerCase(), m.user.id]));
  const ids = new Set<string>();
  for (const match of mentionMatches(text)) {
    const id = byHandle.get(match.handle.toLowerCase());
    if (id) ids.add(id);
  }
  return [...ids];
}

/** A task's participants who are still members of its board, by id. */
export async function participantsOf(db: D1Database, taskId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT p.user_id FROM (
           SELECT created_by AS user_id FROM tasks WHERE id = ?1
           UNION SELECT user_id FROM task_assignees WHERE task_id = ?1
           UNION SELECT author_id FROM comments WHERE task_id = ?1
           UNION SELECT m.user_id FROM comment_mentions m JOIN comments c ON c.id = m.comment_id WHERE c.task_id = ?1
         ) p
         JOIN tasks t ON t.id = ?1
         JOIN board_members bm ON bm.board_id = t.board_id AND bm.user_id = p.user_id`,
    )
    .bind(taskId)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

export interface NewInboxItem {
  userId: string;
  kind: "assigned" | "mentioned" | "commented";
  boardId: string;
  taskId: string;
  commentId?: string;
  actorId: string;
}

/** The inserts for these items, minus any addressed to the person who caused them. */
export function inboxStatements(db: D1Database, items: NewInboxItem[]): D1PreparedStatement[] {
  return items
    .filter((item) => item.userId !== item.actorId)
    .map((item) =>
      db
        .prepare(
          `INSERT INTO inbox_items (id, user_id, kind, board_id, task_id, comment_id, actor_id, via)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(
          crypto.randomUUID(),
          item.userId,
          item.kind,
          item.boardId,
          item.taskId,
          item.commentId ?? null,
          item.actorId,
          currentVia(),
        ),
    );
}

/** Who a set of items reaches, for changes.notify(…, "inbox"). */
export const inboxAudience = (items: NewInboxItem[]) => [
  ...new Set(items.filter((i) => i.userId !== i.actorId).map((i) => i.userId)),
];

/**
 * The insert that tells the assignees of every task waiting on `closedIds`
 * that it can start, for those left with nothing open to wait on. It goes in
 * the same batch as the write that closes (or deletes) them, after it, so it
 * reads the board as that write leaves it. Only tasks in a todo stage, not
 * milestones, the same as GET /api/tasks/ready; work parked in backlog or
 * waiting on a person stays where it is. Assignees no longer on the board
 * get nothing. RETURNING says whom it reached, for changes.notify.
 */
export function unblockedStatement(db: D1Database, closedIds: string[], actorId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO inbox_items (id, user_id, kind, board_id, task_id, actor_id, via)
       SELECT lower(hex(randomblob(16))), a.user_id, 'unblocked', t.board_id, t.id, ?2, ?3
         FROM tasks t
         JOIN stages s ON s.id = t.stage_id AND s.category = 'todo'
         JOIN task_assignees a ON a.task_id = t.id
         JOIN board_members bm ON bm.board_id = t.board_id AND bm.user_id = a.user_id
        WHERE t.id IN (SELECT d.task_id FROM task_dependencies d WHERE d.depends_on_id IN (SELECT value FROM json_each(?1)))
          AND t.deleted_at IS NULL AND t.completed_at IS NULL
          AND coalesce(t.level, 'task') != 'milestone'
          AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks u ON u.id = d.depends_on_id
                           WHERE d.task_id = t.id AND u.deleted_at IS NULL AND u.completed_at IS NULL)
       RETURNING user_id`,
    )
    .bind(JSON.stringify(closedIds), actorId, currentVia());
}

/** Who an unblockedStatement reached, from its result in the batch. */
export const unblockedAudience = (result: D1Result | undefined) => [
  ...new Set(((result?.results ?? []) as { user_id: string }[]).map((r) => r.user_id)),
];
