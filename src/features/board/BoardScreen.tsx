/* ============================================================================
   A board: one column per stage, tasks as rows, drag to move.
   ----------------------------------------------------------------------------
   Columns are panes on the shared surface, split by the same 1px dividers as
   the dashboard. A drop on a task puts the dragged one above it; a drop on
   the column's empty space puts it at the bottom. Either way it is one PATCH
   of stageId and rank (domain/tasks.ts rankBetween), applied optimistically.

   The URL carries the board key (/b/CPL), which people can read and share;
   the id comes from the boards list. ?view=list and ?view=gantt switch to
   the other two views (ListView, GanttView) over the same data. The filter
   bar (FilterBar, filters.ts) sits over all three; its state is more of the
   query string, and each view draws the filtered board. ?group=epic (the
   "by epic" switch next to the views) splits the kanban into a lane per
   epic: LanesView from sm up, sections inside each column on a phone
   (lanes.ts has the rules).

   On a touchscreen there is no HTML5 drag: a long press on a card opens
   MoveSheet instead, and on a phone the columns become a swipeable strip.

   The header's "share" (owners and editors) opens ShareModal: members, and
   adding people or your agents by handle. The gear (owners only) opens
   BoardSettingsModal: stages, labels, name, key, archive. The book (everyone
   on the board) opens BoardDocsModal: the board's notes and docs, written by
   owners and editors.
   ========================================================================== */

import { useRef, useState, type DragEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowLeft, BookOpen, Plus, Settings2, UserPlus, Users } from "lucide-react";
import { rankBetween } from "@/domain/tasks";
import type { BoardDetail, Stage, Task } from "@/domain/types";
import { useBoard, useBoards, useMe } from "@/lib/queries";
import { tasksIn, useCreateTask, useUpdateTask } from "@/lib/tasks";
import { todayLocal, toneText } from "@/ui/tone";
import { usePhone } from "@/ui/useMediaQuery";
import { BoardDocsModal } from "./BoardDocsModal";
import { BoardSettingsModal } from "./BoardSettingsModal";
import { FilterBar } from "./FilterBar";
import { applyFilters, readFilters, writeFilters } from "./filters";
import { GanttView } from "./GanttView";
import { buildLanes, laneIds, type Lane } from "./lanes";
import { LanesView } from "./LanesView";
import { ListView } from "./ListView";
import { MoveSheet } from "./MoveSheet";
import { NewTaskModal } from "./NewTaskModal";
import { ShareModal } from "./ShareModal";
import { TaskModal } from "./TaskModal";
import { TASK_DRAG_TYPE, TaskRow } from "./TaskRow";

function hasTask(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(TASK_DRAG_TYPE);
}

/** A task's parent, by key, and scoping the board to it: what `↑ KEY` needs. */
export interface Hierarchy {
  parentKey: (task: Task) => string | null;
  onScope: (parentKey: string) => void;
}

/** Lanes by epic, drawn as sections inside each column (the phone's ?group=epic). */
interface Grouping {
  lanes: Lane[];
  laneOf: Map<string, string>;
}

interface ColumnProps {
  detail: BoardDetail;
  stage: Stage;
  hierarchy: Hierarchy;
  grouping: Grouping | null;
  onOpen: (taskId: string) => void;
  onNew: (stageId: string) => void;
  onMoveMenu: (taskId: string) => void;
}

function Column({ detail, stage, hierarchy, grouping, onOpen, onNew, onMoveMenu }: ColumnProps) {
  const tasks = tasksIn(detail, stage.id);
  /* Grouped, epics are the section headers rather than cards. */
  const cards = grouping ? tasks.filter((t) => t.level !== "epic") : tasks;
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
      className={`group/pane flex flex-col bg-surface w-[85vw] sm:w-[19rem] snap-start shrink-0 max-h-full ${over ? "bg-raised/40" : ""}`}
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
        <span className="text-xs text-muted">{cards.length}</span>
        <span className="flex-1 border-t border-faint/50" aria-hidden />
        {canEdit && (
          <button
            onClick={() => onNew(stage.id)}
            className="tap text-muted hover:text-accent pointer-fine:opacity-0 pointer-fine:group-hover/pane:opacity-100 transition-opacity"
            title={`New task in ${stage.name}`}
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-16">
        {(grouping ? grouping.lanes : [null]).map((lane) => {
          const rows = lane && grouping ? cards.filter((t) => grouping.laneOf.get(t.id) === lane.id) : cards;
          if (lane && rows.length === 0) return null;
          return (
            <div key={lane?.id ?? "all"}>
              {lane && (
                <button
                  onClick={() => lane.epic && onOpen(lane.epic.id)}
                  disabled={!lane.epic}
                  className="w-full flex items-baseline gap-2 px-3 pt-2.5 pb-1 text-left text-xs border-b border-divider whitespace-nowrap"
                >
                  {lane.epic ? (
                    <>
                      <span className="text-faint">{lane.epic.key}</span>
                      <span className="text-muted truncate">{lane.epic.title}</span>
                    </>
                  ) : (
                    <span className="text-faint">no epic</span>
                  )}
                </button>
              )}
              {rows.map((task) => {
                /* `↑ KEY` only when the parent is not the section's own epic. */
                const parentKey = task.parentId && task.parentId !== lane?.epic?.id ? hierarchy.parentKey(task) : null;
                return (
                  <TaskRow
                    key={task.id}
                    task={task}
                    members={detail.members}
                    labels={detail.labels}
                    parentKey={parentKey}
                    onParent={() => parentKey && hierarchy.onScope(parentKey)}
                    draggable={canEdit}
                    dropMarker={over === task.id}
                    onOpen={() => onOpen(task.id)}
                    onLongPress={canEdit ? () => onMoveMenu(task.id) : undefined}
                    {...dropHandlers(task.id)}
                  />
                );
              })}
            </div>
          );
        })}
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

interface KanbanProps {
  detail: BoardDetail;
  hierarchy: Hierarchy;
  grouping: Grouping | null;
  onOpen: (taskId: string) => void;
  onNew: (stageId: string) => void;
  onMoveMenu: (taskId: string) => void;
}

/**
 * The columns side by side. On a phone they are a scroll-snap strip, each
 * column most of the screen wide with the next peeking in, and a row of
 * stage chips above that shows where you are and jumps.
 */
function Kanban({ detail, hierarchy, grouping, onOpen, onNew, onMoveMenu }: KanbanProps) {
  const strip = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);

  /** One column plus its 1px gap. */
  const step = () => ((strip.current?.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0) + 1;
  const onScroll = () => {
    if (strip.current) setActive(Math.round(strip.current.scrollLeft / step()));
  };
  const jump = (index: number) => strip.current?.scrollTo({ left: index * step(), behavior: "smooth" });

  return (
    <>
      <div className="sm:hidden flex gap-px overflow-x-auto bg-divider border-b border-divider">
        {detail.stages.map((stage, i) => (
          <button
            key={stage.id}
            onClick={() => jump(i)}
            className={`shrink-0 px-4 py-2.5 whitespace-nowrap ${i === active ? `bg-raised ${toneText(stage.tone)}` : "bg-surface text-muted"}`}
          >
            {stage.name}{" "}
            <span className="text-xs text-faint">{tasksIn(detail, stage.id).filter((t) => !grouping || t.level !== "epic").length}</span>
          </button>
        ))}
      </div>
      <div
        ref={strip}
        onScroll={onScroll}
        className="flex-1 min-h-0 flex items-stretch gap-px overflow-x-auto snap-x snap-mandatory sm:snap-none sm:px-4 md:px-8 sm:py-4"
      >
        {detail.stages.map((stage) => (
          <Column key={stage.id} detail={detail} stage={stage} hierarchy={hierarchy} grouping={grouping} onOpen={onOpen} onNew={onNew} onMoveMenu={onMoveMenu} />
        ))}
      </div>
    </>
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
  const [moving, setMoving] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [newTask, setNewTask] = useState<{ stageId?: string } | null>(null);
  const [params, setParams] = useSearchParams();
  const view = VIEWS.includes(params.get("view") as View) ? (params.get("view") as View) : "kanban";
  const filters = readFilters(params);
  const byEpic = params.get("group") === "epic";
  const me = useMe();
  const phone = usePhone();

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

  /* Every view draws the filtered board; modals and the move sheet get the whole one. */
  const result = applyFilters(detail, filters, me.data?.user.id);
  const shown: BoardDetail = { ...detail, tasks: result.tasks };
  const setFilters = (next: typeof filters) => setParams((prev) => writeFilters(prev, next), { replace: true });
  const byId = new Map(detail.tasks.map((t) => [t.id, t]));
  const hierarchy: Hierarchy = {
    parentKey: (task) => (task.parentId ? (byId.get(task.parentId)?.key ?? null) : null),
    onScope: (key) => setFilters({ ...filters, under: key }),
  };
  const setGroup = (on: boolean) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (on) next.set("group", "epic");
        else next.delete("group");
        return next;
      },
      { replace: true },
    );
  /* On a phone the lanes are sections inside the swipeable columns; from sm up, LanesView. */
  const phoneLanes = (() => {
    if (!byEpic || !phone || view !== "kanban") return null;
    const laneOf = laneIds(detail.tasks);
    return { laneOf, lanes: buildLanes(detail.tasks, shown.tasks, detail.stages, laneOf) };
  })();

  return (
    <div className="flex flex-col h-[calc(100dvh-2.75rem)]">
      {/* On a phone the view switch wraps onto its own full-width row. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 md:px-8 py-2 sm:py-3 bg-surface border-b border-divider whitespace-nowrap">
        <button onClick={() => navigate("/")} className="tap text-muted hover:text-accent" title="Dashboard">
          <ArrowLeft size={16} />
        </button>
        <span className="text-faint">{detail.board.key}</span>
        <span className="text-bright truncate min-w-0 flex-1 sm:flex-none">{detail.board.name}</span>
        <span className="hidden sm:block flex-1" />
        {detail.board.role !== "viewer" && (
          <button onClick={() => setNewTask({})} className="tap text-muted hover:text-accent flex items-center gap-1 text-sm" title="New task">
            <Plus size={14} /> <span className="hidden sm:inline">new</span>
          </button>
        )}
        <span className="order-last sm:order-none basis-full sm:basis-auto flex items-center gap-px text-sm">
          {VIEWS.map((v) => (
            <button
              key={v}
              onClick={() =>
                setParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    if (v === "kanban") next.delete("view");
                    else next.set("view", v);
                    return next;
                  },
                  { replace: true },
                )
              }
              className={`tap flex-1 sm:flex-none px-2 py-0.5 transition-colors ${view === v ? "text-accent bg-raised" : "text-muted hover:text-ink"}`}
            >
              {v}
            </button>
          ))}
          {view === "kanban" && (
            <button
              onClick={() => setGroup(!byEpic)}
              aria-pressed={byEpic}
              title={byEpic ? "One kanban, no lanes" : "A lane per epic"}
              className={`tap flex-1 sm:flex-none sm:ml-2 px-2 py-0.5 transition-colors ${byEpic ? "text-accent bg-raised" : "text-muted hover:text-ink"}`}
            >
              by epic
            </button>
          )}
        </span>
        {detail.members.length > 1 && (
          <span className="hidden sm:flex items-center gap-1.5 text-muted text-sm" title={detail.members.map((m) => m.user.handle).join(", ")}>
            <Users size={14} /> {detail.members.length}
          </span>
        )}
        <button
          onClick={() => setDocsOpen(true)}
          className="tap text-muted hover:text-accent flex items-center gap-1.5"
          title="Notes & docs"
        >
          <BookOpen size={14} />
          {detail.docs.length > 0 && <span className="text-xs tabular-nums">{detail.docs.length}</span>}
        </button>
        {detail.board.role !== "viewer" && (
          <button
            onClick={() => setShareOpen(true)}
            className="tap text-muted hover:text-accent flex items-center gap-1.5"
            title={detail.board.role === "owner" && !detail.board.isInbox ? "Share" : "Bring your agents"}
          >
            <UserPlus size={14} /> <span className="hidden sm:inline">share</span>
          </button>
        )}
        {detail.board.role === "owner" && (
          <button onClick={() => setSettingsOpen(true)} className="tap text-muted hover:text-accent" title="Board settings">
            <Settings2 size={14} />
          </button>
        )}
        {detail.board.role === "viewer" && <span className="text-xs text-yellow">view only</span>}
      </div>

      <FilterBar detail={detail} filters={filters} result={result} onChange={setFilters} />

      {view === "kanban" && byEpic && !phone ? (
        <LanesView detail={detail} shown={shown} hierarchy={hierarchy} onOpen={setOpenTask} onNew={(stageId) => setNewTask({ stageId })} />
      ) : (
        view === "kanban" && (
          <Kanban
            detail={shown}
            hierarchy={hierarchy}
            grouping={phoneLanes}
            onOpen={setOpenTask}
            onNew={(stageId) => setNewTask({ stageId })}
            onMoveMenu={setMoving}
          />
        )
      )}
      {view === "list" && <ListView detail={shown} hierarchy={hierarchy} onOpen={setOpenTask} />}
      {view === "gantt" && <GanttView detail={shown} hierarchy={hierarchy} onOpen={setOpenTask} />}

      {moving && (
        <MoveSheet
          detail={detail}
          taskId={moving}
          onClose={() => setMoving(null)}
          onOpen={() => {
            setMoving(null);
            setOpenTask(moving);
          }}
        />
      )}
      {openTask && <TaskModal detail={detail} taskId={openTask} onClose={() => setOpenTask(null)} />}
      {newTask && (
        <NewTaskModal detail={detail} stageId={newTask.stageId} onClose={() => setNewTask(null)} />
      )}
      {settingsOpen && <BoardSettingsModal detail={detail} onClose={() => setSettingsOpen(false)} />}
      {shareOpen && <ShareModal detail={detail} onClose={() => setShareOpen(false)} />}
      {docsOpen && <BoardDocsModal detail={detail} onClose={() => setDocsOpen(false)} />}
    </div>
  );
}
