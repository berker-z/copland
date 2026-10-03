/* ============================================================================
   One task as a row: the card on a board column, and the line in the tasks
   pane. Splits has no cards in the rounded-box sense; a task is a row on the
   pane's surface, separated by a hairline, raised on hover.
   ========================================================================== */

import type { DragEvent, ReactNode } from "react";
import { Paperclip } from "lucide-react";
import type { BoardMember, Label, Task } from "@/domain/types";
import { Avatar } from "@/ui/Avatar";
import { LevelPill } from "@/ui/LevelPill";
import { dueClass, isDraft, shortDate, toneText } from "@/ui/tone";
import { useLongPress } from "@/ui/useLongPress";

export const TASK_DRAG_TYPE = "application/x-copland-task";

/**
 * `↑ CPL-5`: a task's parent, on a card, a list row or a Gantt label. A
 * click scopes the board to the parent's subtree and does not open the task
 * it sits in, so it stops the click (and Enter) from reaching the row.
 */
export function ParentLink({ parentKey, onClick }: { parentKey: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      className="text-muted hover:text-accent whitespace-nowrap"
      title={`Show only what is under ${parentKey}`}
    >
      ↑ {parentKey}
    </button>
  );
}

const PRIORITY_MARK: Record<Task["priority"], ReactNode> = {
  urgent: <span className="text-red">!!</span>,
  high: <span className="text-orange">!</span>,
  normal: null,
  low: <span className="text-faint">↓</span>,
};

interface TaskRowProps {
  task: Task;
  members: BoardMember[];
  labels?: Label[];
  /** Left of the title: the tasks pane puts a checkbox here. */
  lead?: ReactNode;
  showKey?: boolean;
  /** The parent's key, shown as `↑ KEY` when onParent is given too. */
  parentKey?: string | null;
  /** Clicking `↑ KEY`: on a board, show only what is under the parent. */
  onParent?: () => void;
  draggable?: boolean;
  dropMarker?: boolean;
  onOpen: () => void;
  /** A long press on touch, where there is no drag: the board's move menu. */
  onLongPress?: () => void;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
}

export function TaskRow({ task, members, labels = [], lead, showKey = true, parentKey, onParent, draggable, dropMarker, onOpen, onLongPress, onDragOver, onDrop }: TaskRowProps) {
  const parent = parentKey && onParent ? parentKey : null;
  const closed = task.completedAt !== null;
  const draft = isDraft(task.id);
  const press = useLongPress(draft ? undefined : onLongPress);
  const assignees = task.assigneeIds
    .map((id) => members.find((m) => m.user.id === id)?.user)
    .filter((u): u is NonNullable<typeof u> => u !== undefined);
  const taskLabels = labels.filter((l) => task.labelIds.includes(l.id));
  /* A run on it right now (claim_task). The server sends only live claims; one that lapsed since the last fetch is hidden here too. */
  const claimer =
    task.claim && !closed && Date.parse(task.claim.until) > Date.now()
      ? members.find((m) => m.user.id === task.claim?.userId)?.user
      : undefined;

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
      {...press.handlers}
      onClick={() => !press.swallowClick() && !draft && onOpen()}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && !draft) {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`group/task flex items-start gap-2.5 px-3 py-2 border-b border-divider hover:bg-raised focus:outline-none focus-visible:bg-raised transition-colors cursor-pointer ${
        onLongPress ? "pointer-coarse:select-none [-webkit-touch-callout:none]" : ""
      } ${
        dropMarker ? "border-t-2 border-t-accent" : ""
      } ${draft ? "opacity-60" : ""}`}
    >
      {lead}
      <div className="min-w-0 flex-1">
        {/* The level sits at the top right, on the title's first line; the title wraps beside it, never under it. */}
        <div className="flex items-start gap-2 leading-snug">
          <div className={`min-w-0 flex-1 break-words ${closed ? "text-muted line-through decoration-faint" : "text-ink"}`}>
            {PRIORITY_MARK[task.priority] && <span className="mr-1.5">{PRIORITY_MARK[task.priority]}</span>}
            {task.title}
          </div>
          <LevelPill level={task.level} className="h-[1lh]" />
        </div>
        {(showKey || parent || task.dueDate || assignees.length > 0 || task.commentCount > 0 || taskLabels.length > 0 || task.attachments.length > 0 || claimer) && (
          <div className="flex flex-wrap items-center gap-x-2 mt-0.5 text-xs">
            {showKey && <span className="text-faint">{task.key}</span>}
            {parent && <ParentLink parentKey={parent} onClick={onParent as () => void} />}
            {task.dueDate && <span className={dueClass(task.dueDate, closed)}>{shortDate(task.dueDate)}</span>}
            {task.commentCount > 0 && <span className="text-muted">¶{task.commentCount}</span>}
            {task.attachments.length > 0 && (
              <span className="text-muted inline-flex items-center gap-0.5" title={`${task.attachments.length} attachments`}>
                <Paperclip size={11} />
                {task.attachments.length}
              </span>
            )}
            {taskLabels.map((l) => (
              <span key={l.id} className={toneText(l.tone)}>
                #{l.name}
              </span>
            ))}
            <span className="flex-1" />
            {claimer && task.claim && (
              <span
                className="text-muted min-w-0 truncate"
                title={
                  task.claim.kind === "interactive"
                    ? `${claimer.handle}, interactive: a chat session${task.claim.client ? ` in ${task.claim.client}` : ""} (run ${task.claim.run}), working on it now`
                    : `${claimer.handle}, supervised run ${task.claim.run} (started by a launcher), working on it now`
                }
              >
                {claimer.handle.split("/").pop()} is on this
                <span className="text-faint">
                  {" · "}
                  {task.claim.kind === "interactive" ? (task.claim.client ?? "chat") : `run ${task.claim.run}`}
                </span>
              </span>
            )}
            {assignees.map((u) => (
              <Avatar key={u.id} user={u} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
