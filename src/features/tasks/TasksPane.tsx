/* ============================================================================
   The /tasks pane: your inbox board as a todo list, nord-dash's old widget.
   ----------------------------------------------------------------------------
   Ticking a task moves it to the board's first done stage; unticking moves
   it back to the first open one. Both are the same optimistic stage change
   the board screen makes, so the pane and /b/<inbox> are the same data.
   Finished tasks fold away under a count.
   ========================================================================== */

import { useState } from "react";
import { Link } from "react-router";
import { ArrowUpRight, Plus } from "lucide-react";
import { isClosing } from "@/domain/tasks";
import { useBoard, useMe } from "@/lib/queries";
import { tasksIn, useCreateTask, useUpdateTask } from "@/lib/tasks";
import { Checkbox } from "@/ui/Checkbox";
import { isDraft } from "@/ui/tone";
import { WidgetFrame } from "@/ui/WidgetFrame";
import { NewTaskModal } from "../board/NewTaskModal";
import { TaskModal } from "../board/TaskModal";
import { TaskRow } from "../board/TaskRow";

export function TasksPane() {
  const me = useMe();
  const inboxId = me.data?.inboxId ?? null;
  const { data: detail, error } = useBoard(inboxId);
  const create = useCreateTask(inboxId ?? "");
  const update = useUpdateTask(inboxId ?? "");
  const [draft, setDraft] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [newTask, setNewTask] = useState(false);

  const openStages = detail?.stages.filter((s) => !isClosing(s.category)) ?? [];
  const doneStage = detail?.stages.find((s) => s.category === "done");
  const open = detail ? openStages.flatMap((s) => tasksIn(detail, s.id)) : [];
  const done = detail
    ? detail.tasks
        .filter((t) => t.completedAt !== null)
        .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
    : [];

  const toggle = (taskId: string, closing: boolean) => {
    const target = closing ? doneStage : openStages[0];
    if (target) update.mutate({ id: taskId, patch: { stageId: target.id } });
  };

  return (
    <WidgetFrame
      title="/tasks"
      meta={detail ? `${open.length} open` : undefined}
      controls={
        detail && (
          <>
            <button onClick={() => setNewTask(true)} className="p-1 hover:text-accent transition-colors" title="New task with details">
              <Plus size={14} />
            </button>
            <Link to={`/b/${detail.board.key}`} className="p-1 hover:text-accent transition-colors" title="Open as a board">
              <ArrowUpRight size={14} />
            </Link>
          </>
        )
      }
      bodyClassName="!p-0"
    >
      {error && <p className="p-4 text-red text-sm">{error.message}</p>}
      <form
        className="px-3 py-2 border-b border-divider"
        onSubmit={(event) => {
          event.preventDefault();
          const title = draft.trim();
          if (!title || !detail) return;
          create.mutate({ title });
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="+ add a task"
          maxLength={200}
          className="w-full bg-transparent px-1 py-1 text-ink placeholder:text-faint focus:outline-none focus:bg-raised"
        />
      </form>

      {detail &&
        open.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            members={detail.members}
            labels={detail.labels}
            showKey={false}
            onOpen={() => setOpenTask(task.id)}
            lead={
              <span onClick={(e) => e.stopPropagation()} className="pt-0.5">
                <Checkbox
                  checked={false}
                  onChange={() => !isDraft(task.id) && toggle(task.id, true)}
                  size={16}
                  aria-label={`Finish ${task.title}`}
                />
              </span>
            }
          />
        ))}
      {detail && open.length === 0 && <p className="px-4 py-3 text-faint text-sm">nothing open</p>}

      {done.length > 0 && (
        <button
          onClick={() => setShowDone((s) => !s)}
          className="w-full text-left px-4 py-2 text-xs text-muted hover:text-accent transition-colors"
        >
          {showDone ? "▾" : "▸"} done ({done.length})
        </button>
      )}
      {detail &&
        showDone &&
        done.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            members={detail.members}
            labels={detail.labels}
            showKey={false}
            onOpen={() => setOpenTask(task.id)}
            lead={
              <span onClick={(e) => e.stopPropagation()} className="pt-0.5">
                <Checkbox checked onChange={() => toggle(task.id, false)} size={16} aria-label={`Reopen ${task.title}`} />
              </span>
            }
          />
        ))}

      {(create.error ?? update.error) && (
        <p className="px-4 py-2 text-xs text-red">{(create.error ?? update.error)?.message}</p>
      )}
      {detail && newTask && <NewTaskModal detail={detail} onClose={() => setNewTask(false)} />}
      {detail && openTask && <TaskModal detail={detail} taskId={openTask} onClose={() => setOpenTask(null)} />}
    </WidgetFrame>
  );
}
