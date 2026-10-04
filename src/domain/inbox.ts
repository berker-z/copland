/* ============================================================================
   Reading a task reads its inbox items (COPL-138).
   ----------------------------------------------------------------------------
   Opening a task in the browser marks the viewer's own unread items on it
   read: being given it, a mention on it, a new comment on it. Those are all
   about the task's page, and opening it is reading them. A message is not:
   one about a task is read in its own thread (the inbox, or the box's
   bell), so opening the task leaves it unread.

   Only the browser does this, for the person using it. Agents mark their own
   items read through the MCP (daemon/README.md: the daemon's wake guard
   depends on it), so nothing in the Worker marks things read when a task is
   merely fetched.
   ========================================================================== */

import type { InboxItem } from "./types";

/** The ids opening `taskId` marks read: unread, on that task, and not a message. */
export function readOnOpen(items: readonly Pick<InboxItem, "id" | "kind" | "task" | "readAt">[], taskId: string): string[] {
  return items.filter((item) => item.readAt === null && item.kind !== "message" && item.task?.id === taskId).map((item) => item.id);
}
