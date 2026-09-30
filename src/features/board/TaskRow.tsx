/* ============================================================================
   One task as a row: the card on a board column, and the line in the tasks
   pane. Splits has no cards in the rounded-box sense; a task is a row on the
   pane's surface, separated by a hairline, raised on hover.
   ========================================================================== */

import type { DragEvent, ReactNode } from "react";
import type { BoardMember, Task } from "@/domain/types";
import { dueClass, isDraft, shortDate } from "@/ui/tone";

export const TASK_DRAG_TYPE = "application/x-copland-task";

const PRIORITY_MARK: Record<Task["priority"], ReactNode> = {
  urgent: <span className="text-red">!!</span>,
  high: <span className="text-orange">!</span>,
  normal: null,
  low: <span className="text-faint">↓</span>,
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toLowerCase();
}

interface TaskRowProps {
  task: Task;
  members: BoardMember[];
  /** Left of the title: the tasks pane puts a checkbox here. */
  lead?: ReactNode;
  showKey?: boolean;
  draggable?: boolean;
  dropMarker?: boolean;
  onOpen: () => void;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
}

export function TaskRow({ task, members, lead, showKey = true, draggable, dropMarker, onOpen, onDragOver, onDrop }: TaskRowProps) {
  const closed = task.completedAt !== null;
  const draft = isDraft(task.id);
  const assignees = task.assigneeIds
    .map((id) => members.find((m) => m.user.id === id)?.user)
    .filter((u): u is NonNullable<typeof u> => u !== undefined);

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable && !draft}
      onDragStart={(event) => {
        event.dataTransfer.setData(TASK_DRAG_TYPE, task.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={() => !draft && onOpen()}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && !draft) {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`group/task flex items-start gap-2.5 px-3 py-2 border-b border-divider hover:bg-raised focus:outline-none focus-visible:bg-raised transition-colors cursor-pointer ${
        dropMarker ? "border-t-2 border-t-accent" : ""
      } ${draft ? "opacity-60" : ""}`}
    >
      {lead}
      <div className="min-w-0 flex-1">
        <div className={`leading-snug break-words ${closed ? "text-muted line-through decoration-faint" : "text-ink"}`}>
          {PRIORITY_MARK[task.priority] && <span className="mr-1.5">{PRIORITY_MARK[task.priority]}</span>}
          {task.title}
        </div>
        {(showKey || task.dueDate || assignees.length > 0 || task.commentCount > 0) && (
          <div className="flex items-center gap-2 mt-0.5 text-xs">
            {showKey && <span className="text-faint">{task.key}</span>}
            {task.dueDate && <span className={dueClass(task.dueDate, closed)}>{shortDate(task.dueDate)}</span>}
            {task.commentCount > 0 && <span className="text-muted">¶{task.commentCount}</span>}
            <span className="flex-1" />
            {assignees.map((u) => (
              <span key={u.id} title={u.name} className="text-muted border border-faint px-1 leading-4">
                {initials(u.name)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
