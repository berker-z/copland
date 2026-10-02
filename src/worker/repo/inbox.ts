/* ============================================================================
   Inboxes and mentions (migrations/0008_inbox.sql).
   ----------------------------------------------------------------------------
   What lands in an inbox, from the routes that cause it:
     assigned   routes/tasks.ts, when someone else puts you on a task
     mentioned  routes/comments.ts, when a comment names you

   A mention is "@handle" or "@owner/agent" outside code and quotes (the rule
   is domain/mentions.ts, shared with the browser's highlight), matched
   against the members of the task's board, case-insensitive, and only them:
   someone who cannot see the task gets nothing, so a mention can never leak
   a task's title.
   Nobody is told about their own doing.
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

export interface NewInboxItem {
  userId: string;
  kind: "assigned" | "mentioned";
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
