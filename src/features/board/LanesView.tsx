/* ============================================================================
   The kanban grouped by epic (?group=epic), from sm up: one lane per epic
   across the stage columns, under one shared row of stage headers that
   sticks to the top while the lanes scroll. Which lane a task is in, which
   lanes show and what a drag across lanes does are in lanes.ts.
   ----------------------------------------------------------------------------
   A lane's header is the epic: key, title (opens it), its stage, how many
   cards the lane shows, `under` (scope the board to it), and a chevron that
   folds the lane to its header. Folded lanes are remembered per board in
   this browser (a convenience, not a setting).

   A drop on a card puts the dragged one above it, a drop on a cell's empty
   space puts it under the lane's last card in that stage; either way the
   rank comes from the whole stage, so the plain kanban keeps the same
   order. Across lanes the same PATCH also carries the new parent, or the
   cell refuses the drop and says why.

   On a phone the board stays the swipeable strip; BoardScreen's Column
   draws the lanes as sections inside each stage instead.
   ========================================================================== */

import { useMemo, useRef, useState, type DragEvent } from "react";
import { ChevronDown, CornerLeftUp, Plus } from "lucide-react";
import { rankBetween } from "@/domain/tasks";
import type { BoardDetail, Stage } from "@/domain/types";
import { tasksIn, useUpdateTask } from "@/lib/tasks";
import { toneText } from "@/ui/tone";
import type { Hierarchy } from "./BoardScreen";
import { buildLanes, laneIds, parentForLane, type Lane } from "./lanes";
import { TASK_DRAG_TYPE, TaskRow } from "./TaskRow";

const storageKey = (boardId: string) => `copland.lanes.${boardId}`;

function readFolded(boardId: string): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(boardId)) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function useFolded(boardId: string) {
  const [folded, setFolded] = useState(() => readFolded(boardId));
  const toggle = (laneId: string) =>
    setFolded((was) => {
      const next = new Set(was);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      try {
        if (next.size) localStorage.setItem(storageKey(boardId), JSON.stringify([...next]));
        else localStorage.removeItem(storageKey(boardId));
      } catch {
        /* private mode: fold for this visit only */
      }
      return next;
    });
  return { folded, toggle };
}

/** Where a drag is over: a lane's cell, before a card or at its end, and whether it may drop. */
interface Over {
  lane: string;
  stage: string;
  before: string | null;
  refused: boolean;
}

interface LanesViewProps {
  /** The whole board: parents the filters hid still decide lanes. */
  detail: BoardDetail;
  /** What the filters let through. */
  shown: BoardDetail;
  hierarchy: Hierarchy;
  onOpen: (taskId: string) => void;
  onNew: (stageId: string) => void;
}

const COLUMN = "w-[19rem] shrink-0";

export function LanesView({ detail, shown, hierarchy, onOpen, onNew }: LanesViewProps) {
  const update = useUpdateTask(detail.board.id);
  const canEdit = detail.board.role !== "viewer";
  const { folded, toggle } = useFolded(detail.board.id);
  const [over, setOver] = useState<Over | null>(null);
  /* dataTransfer cannot be read during dragover, so the dragged id is kept here from dragstart. */
  const dragging = useRef<string | null>(null);

  const laneOf = useMemo(() => laneIds(detail.tasks), [detail.tasks]);
  const lanes = useMemo(() => buildLanes(detail.tasks, shown.tasks, detail.stages, laneOf), [detail.tasks, shown.tasks, detail.stages, laneOf]);
  const byStage = useMemo(() => new Map(detail.stages.map((s) => [s.id, tasksIn(shown, s.id)])), [shown, detail.stages]);
  const cardCount = (stageId: string) => lanes.reduce((n, l) => n + l.tasks.filter((t) => t.stageId === stageId).length, 0);

  const cell = (lane: Lane, stageId: string) => (byStage.get(stageId) ?? []).filter((t) => t.level !== "epic" && laneOf.get(t.id) === lane.id);

  const verdict = (lane: Lane) => {
    const task = detail.tasks.find((t) => t.id === dragging.current);
    return task ? parentForLane(task, detail.tasks, laneOf, lane.id) : false;
  };

  const drop = (lane: Lane, stage: Stage, beforeId: string | null) => {
    setOver(null);
    const moving = detail.tasks.find((t) => t.id === dragging.current);
    dragging.current = null;
    if (!moving || moving.id === beforeId) return;
    const parent = parentForLane(moving, detail.tasks, laneOf, lane.id);
    if (parent === false) return;
    const rest = (byStage.get(stage.id) ?? []).filter((t) => t.id !== moving.id);
    let at: number;
    if (beforeId !== null) at = rest.findIndex((t) => t.id === beforeId);
    else {
      const last = cell(lane, stage.id).filter((t) => t.id !== moving.id).at(-1);
      at = last ? rest.indexOf(last) + 1 : rest.length;
    }
    const rank = rankBetween(rest[at - 1]?.rank ?? null, rest[at]?.rank ?? null);
    if (parent === undefined && moving.stageId === stage.id && moving.rank === rank) return;
    update.mutate({ id: moving.id, patch: { stageId: stage.id, rank, ...(parent !== undefined ? { parentId: parent } : {}) } });
  };

  const dropHandlers = (lane: Lane, stage: Stage, beforeId: string | null) =>
    canEdit
      ? {
          onDragOver: (event: DragEvent) => {
            if (!event.dataTransfer.types.includes(TASK_DRAG_TYPE) || !dragging.current) return;
            event.stopPropagation();
            const refused = verdict(lane) === false;
            if (!refused) event.preventDefault();
            if (over?.lane !== lane.id || over.stage !== stage.id || over.before !== beforeId || over.refused !== refused) {
              setOver({ lane: lane.id, stage: stage.id, before: beforeId, refused });
            }
          },
          onDrop: (event: DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            drop(lane, stage, beforeId);
          },
        }
      : {};

  return (
    <div
      className="flex-1 min-h-0 overflow-auto px-4 md:px-8 pb-4"
      onDragStart={(event) => {
        dragging.current = event.dataTransfer.getData(TASK_DRAG_TYPE) || null;
      }}
      onDragEnd={() => {
        dragging.current = null;
        setOver(null);
      }}
    >
      <div className="w-max flex flex-col gap-px">
        <div className="sticky top-0 z-10 flex gap-px bg-divider pt-4">
          {detail.stages.map((stage) => (
            <div key={stage.id} className={`${COLUMN} group/pane flex items-center gap-2.5 px-4 pt-3 pb-2 bg-surface select-none whitespace-nowrap`}>
              <span className="text-faint" aria-hidden>
                ──
              </span>
              <span className={`tracking-[0.14em] ${toneText(stage.tone)}`}>{stage.name}</span>
              <span className="text-xs text-muted">{cardCount(stage.id)}</span>
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
          ))}
        </div>

        {lanes.length === 0 && <p className="bg-surface px-4 py-6 text-muted">Nothing here with these filters.</p>}

        {lanes.map((lane) => {
          const isFolded = folded.has(lane.id);
          const epicStage = lane.epic ? detail.stages.find((s) => s.id === lane.epic?.stageId) : undefined;
          const epicKey = lane.epic?.key ?? null;
          return (
            <section key={lane.id} className="flex flex-col gap-px" aria-label={lane.epic ? `${lane.epic.key} ${lane.epic.title}` : "No epic"}>
              <div className="bg-surface">
                <div className="sticky left-0 flex items-center gap-2.5 px-3 py-1.5 max-w-[calc(100vw-2rem)] md:max-w-[calc(100vw-4rem)] whitespace-nowrap">
                  <button
                    onClick={() => toggle(lane.id)}
                    className="tap text-muted hover:text-accent"
                    aria-expanded={!isFolded}
                    title={isFolded ? "Unfold lane" : "Fold lane"}
                  >
                    <ChevronDown size={14} className={`transition-transform ${isFolded ? "-rotate-90" : ""}`} />
                  </button>
                  {lane.epic ? (
                    <>
                      <span className="text-faint">{lane.epic.key}</span>
                      <button
                        onClick={() => lane.epic && onOpen(lane.epic.id)}
                        className={`truncate min-w-0 text-left hover:text-accent ${lane.epic.completedAt ? "text-muted line-through decoration-faint" : "text-bright"}`}
                        title={`Open ${lane.epic.key}`}
                      >
                        {lane.epic.title}
                      </button>
                      {epicStage && <span className={`text-xs ${toneText(epicStage.tone)}`}>{epicStage.name}</span>}
                    </>
                  ) : (
                    <span className="text-muted">no epic</span>
                  )}
                  <span className="text-xs text-muted tabular-nums">{lane.tasks.length}</span>
                  {epicKey && (
                    <button
                      onClick={() => hierarchy.onScope(epicKey)}
                      className="tap flex items-center gap-1 text-xs text-muted hover:text-accent"
                      title={`Show only what is under ${epicKey}`}
                    >
                      <CornerLeftUp size={12} /> under
                    </button>
                  )}
                </div>
              </div>

              {!isFolded && (
                <div className="flex gap-px">
                  {detail.stages.map((stage) => {
                    const tasks = cell(lane, stage.id);
                    const here = over?.lane === lane.id && over.stage === stage.id ? over : null;
                    return (
                      <div
                        key={stage.id}
                        className={`${COLUMN} flex flex-col bg-surface min-h-12 ${here && !here.refused ? "bg-raised/40" : ""}`}
                        onDragLeave={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(null);
                        }}
                        {...dropHandlers(lane, stage, null)}
                      >
                        {tasks.map((task) => {
                          /* `↑ KEY` only when the parent is not the lane's own epic: that one is the header. */
                          const parentKey = task.parentId && task.parentId !== lane.epic?.id ? hierarchy.parentKey(task) : null;
                          return (
                            <TaskRow
                              key={task.id}
                              task={task}
                              members={detail.members}
                              labels={detail.labels}
                              parentKey={parentKey}
                              onParent={() => parentKey && hierarchy.onScope(parentKey)}
                              draggable={canEdit}
                              dropMarker={here?.before === task.id && !here.refused}
                              onOpen={() => onOpen(task.id)}
                              {...dropHandlers(lane, stage, task.id)}
                            />
                          );
                        })}
                        {here && !here.refused && here.before === null && <div className="border-t-2 border-accent" />}
                        {here?.refused && (
                          <p className="px-3 py-2 text-xs text-muted">only a task straight under its epic, or with no parent, changes lanes; move its parent</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {update.error && <p className="px-4 py-2 text-xs text-red">{update.error.message}</p>}
    </div>
  );
}
