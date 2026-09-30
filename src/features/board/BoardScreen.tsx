/* ============================================================================
   A board: one column per stage, tasks as rows, drag to move.
   ----------------------------------------------------------------------------
   Columns are panes on the shared surface, split by the same 1px dividers as
   the dashboard. A drop on a task puts the dragged one above it; a drop on
   the column's empty space puts it at the bottom. Either way it is one PATCH
   of stageId and rank (domain/tasks.ts rankBetween), applied optimistically.

   The URL carries the board key (/b/CPL), which people can read and share;
   the id comes from the boards list. ?view=list and ?view=gantt switch to
   the other two views (ListView, GanttView) over the same data.
   ========================================================================== */

import { useState, type DragEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowLeft, Plus, Settings2, Users } from "lucide-react";
import { rankBetween } from "@/domain/tasks";
import type { BoardDetail, Stage } from "@/domain/types";
import { useBoard, useBoards } from "@/lib/queries";
import { tasksIn, useCreateTask, useUpdateTask } from "@/lib/tasks";
import { todayLocal, toneText } from "@/ui/tone";
import { BoardSettingsModal } from "./BoardSettingsModal";
import { GanttView } from "./GanttView";
import { ListView } from "./ListView";
import { NewTaskModal } from "./NewTaskModal";
import { TaskModal } from "./TaskModal";
import { TASK_DRAG_TYPE, TaskRow } from "./TaskRow";

function hasTask(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(TASK_DRAG_TYPE);
}

interface ColumnProps {
  detail: BoardDetail;
  stage: Stage;
  onOpen: (taskId: string) => void;
  onNew: (stageId: string) => void;
}

function Column({ detail, stage, onOpen, onNew }: ColumnProps) {
  const tasks = tasksIn(detail, stage.id);
  const update = useUpdateTask(detail.board.id);
  const create = useCreateTask(detail.board.id);
  const canEdit = detail.board.role !== "viewer";
  /** Where the dragged task would land: before this task id, or "end". */
  const [over, setOver] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const move = (taskId: string, beforeId: string | null) => {
    setOver(null);
    const moving = detail.tasks.find((t) => t.id === taskId);
    if (!moving || taskId === beforeId) return;
    const rest = tasks.filter((t) => t.id !== taskId);
    const at = beforeId === null ? rest.length : rest.findIndex((t) => t.id === beforeId);
    const rank = rankBetween(rest[at - 1]?.rank ?? null, rest[at]?.rank ?? null);
    if (moving.stageId === stage.id && moving.rank === rank) return;
    update.mutate({ id: taskId, patch: { stageId: stage.id, rank } });
  };

  const dropHandlers = (beforeId: string | null) =>
    canEdit
      ? {
          onDragOver: (event: DragEvent) => {
            if (!hasTask(event)) return;
            event.preventDefault();
            event.stopPropagation();
            setOver(beforeId ?? "end");
          },
          onDrop: (event: DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            move(event.dataTransfer.getData(TASK_DRAG_TYPE), beforeId);
          },
        }
      : {};

  return (
    <section
      className={`group/pane flex flex-col bg-surface w-[19rem] shrink-0 max-h-full ${over ? "bg-raised/40" : ""}`}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(null);
      }}
      {...dropHandlers(null)}
    >
      <div className="flex items-center gap-2.5 px-4 pt-3 pb-2 select-none whitespace-nowrap">
        <span className="text-faint" aria-hidden>
          ──
        </span>
        <span className={`tracking-[0.14em] ${toneText(stage.tone)}`}>{stage.name}</span>
        <span className="text-xs text-muted">{tasks.length}</span>
        <span className="flex-1 border-t border-faint/50" aria-hidden />
        {canEdit && (
          <button
            onClick={() => onNew(stage.id)}
            className="text-muted hover:text-accent md:opacity-0 md:group-hover/pane:opacity-100 transition-opacity"
            title={`New task in ${stage.name}`}
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-16">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            members={detail.members}
            labels={detail.labels}
            draggable={canEdit}
            dropMarker={over === task.id}
            onOpen={() => onOpen(task.id)}
            {...dropHandlers(task.id)}
          />
        ))}
        {over === "end" && <div className="border-t-2 border-accent" />}
      </div>

      {canEdit && (
        <form
          className="px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            const title = draft.trim();
            if (!title) return;
            create.mutate({ title, stageId: stage.id, startDate: todayLocal() });
            setDraft("");
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="+ add"
            maxLength={200}
            className="w-full bg-transparent px-1 py-1 text-ink placeholder:text-faint focus:outline-none focus:bg-raised"
          />
        </form>
      )}
      {(update.error ?? create.error) && (
        <p className="px-4 pb-2 text-xs text-red">{(update.error ?? create.error)?.message}</p>
      )}
    </section>
  );
}

const VIEWS = ["kanban", "list", "gantt"] as const;
type View = (typeof VIEWS)[number];

export function BoardScreen({ boardKey }: { boardKey: string }) {
  const navigate = useNavigate();
  const boards = useBoards();
  const summary = boards.data?.find((b) => b.key === boardKey.toUpperCase());
  const board = useBoard(summary?.id ?? null);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newTask, setNewTask] = useState<{ stageId?: string } | null>(null);
  const [params, setParams] = useSearchParams();
  const view = VIEWS.includes(params.get("view") as View) ? (params.get("view") as View) : "kanban";

  if (boards.isPending || (summary && board.isPending)) {
    return <p className="p-8 text-muted animate-pulse">loading…</p>;
  }
  if (!summary) {
    return (
      <div className="p-8">
        <p className="text-muted mb-4">No board {boardKey.toUpperCase()} here, or you are not on it.</p>
        <Link to="/" className="text-accent hover:underline">
          ← dashboard
        </Link>
      </div>
    );
  }
  if (board.error) return <p className="p-8 text-red">{board.error.message}</p>;
  const detail = board.data;
  if (!detail) return null;

  return (
    <div className="flex flex-col h-[calc(100vh-2.75rem)]">
      <div className="flex items-center gap-3 px-4 md:px-8 py-3 bg-surface border-b border-divider whitespace-nowrap">
        <button onClick={() => navigate("/")} className="text-muted hover:text-accent" title="Dashboard">
          <ArrowLeft size={16} />
        </button>
        <span className="text-faint">{detail.board.key}</span>
        <span className="text-bright truncate">{detail.board.name}</span>
        <span className="flex-1" />
        {detail.board.role !== "viewer" && (
          <button onClick={() => setNewTask({})} className="text-muted hover:text-accent flex items-center gap-1 text-sm">
            <Plus size={14} /> new
          </button>
        )}
        <span className="flex items-center gap-px text-sm">
          {VIEWS.map((v) => (
            <button
              key={v}
              onClick={() => setParams(v === "kanban" ? {} : { view: v }, { replace: true })}
              className={`px-2 py-0.5 transition-colors ${view === v ? "text-accent bg-raised" : "text-muted hover:text-ink"}`}
            >
              {v}
            </button>
          ))}
        </span>
        {detail.members.length > 1 && (
          <span className="flex items-center gap-1.5 text-muted text-sm" title={detail.members.map((m) => m.user.name).join(", ")}>
            <Users size={14} /> {detail.members.length}
          </span>
        )}
        {detail.board.role === "owner" && (
          <button onClick={() => setSettingsOpen(true)} className="text-muted hover:text-accent flex items-center gap-1.5">
            <Settings2 size={14} /> {detail.board.isInbox ? "settings" : "share"}
          </button>
        )}
        {detail.board.role === "viewer" && <span className="text-xs text-yellow">view only</span>}
      </div>

      {view === "kanban" && (
        <div className="flex-1 min-h-0 flex items-stretch gap-px overflow-x-auto px-4 md:px-8 py-4">
          {detail.stages.map((stage) => (
            <Column key={stage.id} detail={detail} stage={stage} onOpen={setOpenTask} onNew={(stageId) => setNewTask({ stageId })} />
          ))}
        </div>
      )}
      {view === "list" && <ListView detail={detail} onOpen={setOpenTask} />}
      {view === "gantt" && <GanttView detail={detail} onOpen={setOpenTask} />}

      {openTask && <TaskModal detail={detail} taskId={openTask} onClose={() => setOpenTask(null)} />}
      {newTask && (
        <NewTaskModal detail={detail} stageId={newTask.stageId} onClose={() => setNewTask(null)} />
      )}
      {settingsOpen && <BoardSettingsModal detail={detail} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
