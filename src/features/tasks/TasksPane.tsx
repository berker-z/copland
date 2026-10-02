/* ============================================================================
   The /tasks pane: your work as a todo list, nord-dash's old widget.
   ----------------------------------------------------------------------------
   What shows is GET /api/tasks/mine, the same answer the MCP's my_work
   gives (routes/work.ts): tasks assigned to you on any board, and the tasks
   in your inbox assigned to nobody. What you handed to your agents folds
   away under "delegated", what is finished under "done".

   The tasks themselves come from their boards' caches, so ticking one is the
   same optimistic stage change the board screen makes: into its board's
   first done stage, or back to the first open one. Quick add goes to the
   inbox. Tasks from other boards show their key, so you know where they live.
   ========================================================================== */

import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link } from "react-router";
import { ArrowUpRight, Plus } from "lucide-react";
import { isClosing } from "@/domain/tasks";
import type { BoardDetail, MyWork, Task } from "@/domain/types";
import { boardQuery, useMe, useMyWork } from "@/lib/queries";
import { useCreateTask, useUpdateTask } from "@/lib/tasks";
import { Checkbox } from "@/ui/Checkbox";
import { isDraft, todayLocal } from "@/ui/tone";
import { WidgetFrame } from "@/ui/WidgetFrame";
import { NewTaskModal } from "../board/NewTaskModal";
import { TaskModal } from "../board/TaskModal";
import { TaskRow } from "../board/TaskRow";

interface Item {
  task: Task;
  detail: BoardDetail;
}

/** Inbox first in board order (stage, then rank), then other boards' tasks soonest due first. */
function order(a: Item, b: Item): number {
  const ai = a.detail.board.isInbox ? 0 : 1;
  const bi = b.detail.board.isInbox ? 0 : 1;
  if (ai !== bi) return ai - bi;
  if (ai === 0) {
    const stage = (i: Item) => i.detail.stages.findIndex((s) => s.id === i.task.stageId);
    return stage(a) - stage(b) || a.task.rank - b.task.rank || a.task.number - b.task.number;
  }
  if (a.task.dueDate !== b.task.dueDate) {
    if (a.task.dueDate === null) return 1;
    if (b.task.dueDate === null) return -1;
    return a.task.dueDate < b.task.dueDate ? -1 : 1;
  }
  return a.task.key.localeCompare(b.task.key);
}

export function TasksPane() {
  const me = useMe();
  const inboxId = me.data?.inboxId ?? null;
  const work = useMyWork();
  /* The inbox always, for quick add, plus every board a task of yours is on. */
  const boardIds = [
    ...new Set([...(inboxId ? [inboxId] : []), ...[...(work.data?.mine ?? []), ...(work.data?.delegated ?? [])].map((r) => r.boardId)]),
  ];
  const boards = useQueries({ queries: boardIds.map((id) => boardQuery(id)) });
  const details = boards.flatMap((q) => (q.data ? [q.data] : []));
  const inbox = details.find((d) => d.board.id === inboxId);
  const error = work.error ?? boards.find((q) => q.error)?.error;

  const create = useCreateTask(inboxId ?? "");
  const update = useUpdateTask();
  const [draft, setDraft] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [showDelegated, setShowDelegated] = useState(false);
  const [openTask, setOpenTask] = useState<Item | null>(null);
  const [newTask, setNewTask] = useState(false);

  const items = (refs: MyWork["mine"]): Item[] =>
    refs.flatMap(({ taskId, boardId }) => {
      const detail = details.find((d) => d.board.id === boardId);
      const task = detail?.tasks.find((t) => t.id === taskId);
      return detail && task ? [{ task, detail }] : [];
    });
  /* Inbox tasks with nobody on them are yours by the route's own rule, read
     straight from the inbox cache so a quick add shows (and keeps showing
     through its swap to a real id) before "mine" has refetched. */
  const unassigned: Item[] = inbox
    ? inbox.tasks.filter((t) => t.assigneeIds.length === 0).map((task) => ({ task, detail: inbox }))
    : [];
  const mine = [...unassigned, ...items(work.data?.mine ?? []).filter((i) => !unassigned.some((u) => u.task.id === i.task.id))];
  const open = mine.filter((i) => i.task.completedAt === null).sort(order);
  const done = mine
    .filter((i) => i.task.completedAt !== null)
    .sort((a, b) => (b.task.completedAt ?? "").localeCompare(a.task.completedAt ?? ""));
  const delegated = items(work.data?.delegated ?? [])
    .filter((i) => i.task.completedAt === null)
    .sort(order);

  const toggle = ({ task, detail }: Item, closing: boolean) => {
    const target = closing
      ? detail.stages.find((s) => s.category === "done")
      : detail.stages.find((s) => !isClosing(s.category));
    if (target) update.mutate({ id: task.id, patch: { stageId: target.id }, boardId: detail.board.id });
  };

  const row = (item: Item, closed: boolean) => (
    <TaskRow
      key={item.task.id}
      task={item.task}
      members={item.detail.members}
      labels={item.detail.labels}
      showKey={!item.detail.board.isInbox}
      onOpen={() => setOpenTask(item)}
      lead={
        <span onClick={(e) => e.stopPropagation()} className="pt-0.5">
          <Checkbox
            checked={closed}
            onChange={() => !isDraft(item.task.id) && toggle(item, !closed)}
            size={16}
            aria-label={`${closed ? "Reopen" : "Finish"} ${item.task.title}`}
          />
        </span>
      }
    />
  );

  const fold = (label: string, count: number, shown: boolean, flip: () => void) =>
    count > 0 && (
      <button onClick={flip} className="w-full text-left px-4 py-2 text-xs text-muted hover:text-accent transition-colors">
        {shown ? "▾" : "▸"} {label} ({count})
      </button>
    );

  const ready = !!work.data && !!inbox;

  return (
    <WidgetFrame
      title="/tasks"
      meta={ready ? `${open.length} open` : undefined}
      controls={
        inbox && (
          <>
            <button onClick={() => setNewTask(true)} className="tap p-1 hover:text-accent transition-colors" title="New task with details">
              <Plus size={14} />
            </button>
            <Link to={`/b/${inbox.board.key}`} className="tap p-1 hover:text-accent transition-colors" title="Open your inbox as a board">
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
          if (!title || !inbox) return;
          create.mutate({ title, startDate: todayLocal() });
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

      {ready && open.map((item) => row(item, false))}
      {ready && open.length === 0 && <p className="px-4 py-3 text-faint text-sm">nothing open</p>}

      {fold("delegated", delegated.length, showDelegated, () => setShowDelegated((s) => !s))}
      {showDelegated && delegated.map((item) => row(item, false))}

      {fold("done", done.length, showDone, () => setShowDone((s) => !s))}
      {showDone && done.map((item) => row(item, true))}

      {(create.error ?? update.error) && (
        <p className="px-4 py-2 text-xs text-red">{(create.error ?? update.error)?.message}</p>
      )}
      {inbox && newTask && <NewTaskModal detail={inbox} onClose={() => setNewTask(false)} />}
      {openTask && (
        <TaskModal
          /* The board's latest, not the one captured when it was opened. */
          detail={details.find((d) => d.board.id === openTask.detail.board.id) ?? openTask.detail}
          taskId={openTask.task.id}
          onClose={() => setOpenTask(null)}
        />
      )}
    </WidgetFrame>
  );
}
