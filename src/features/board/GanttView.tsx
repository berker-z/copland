/* ============================================================================
   A board on a timeline.
   ----------------------------------------------------------------------------
   Every task with a start or due date is a bar from start to due (a task
   with only one of them is a one-day bar on it; a milestone is a diamond on
   its due date). Drag a bar to move it, drag either end to change that
   date. The change is one optimistic PATCH on release, so a drag that the
   Worker refuses (start after due) snaps back.

   Rows follow the board's order: by stage, then rank, with children under
   their parent, indented. Undated tasks are listed under
   the chart so they can be opened and given dates.

   It draws the filtered board (FilterBar). A task that matches when its
   parent does not is drawn at the top level with `↑ KEY` naming the
   parent, rather than with dimmed ancestors that the filter asked to hide.

   On a touchscreen the chart is read-only: bars are small targets and a
   drag would fight the page scrolling under the finger. Dates are edited in
   the task, which a tap opens.
   ========================================================================== */

import { useMemo, useRef, useState, type PointerEvent } from "react";
import { addDays, daysBetween } from "@/domain/tasks";
import type { BoardDetail, Task } from "@/domain/types";
import { tasksIn, useUpdateTask } from "@/lib/tasks";
import { LevelPill } from "@/ui/LevelPill";
import { isDraft, todayLocal, toneBg } from "@/ui/tone";
import { usePhone, useTouch } from "@/ui/useMediaQuery";
import type { Hierarchy } from "./BoardScreen";
import { ParentLink } from "./TaskRow";

const DAY_PX = 28;
const ROW_PX = 30;
const LABEL_PX = 260;
const PHONE_LABEL_PX = 140;

type DragMode = "move" | "start" | "end";

interface Drag {
  taskId: string;
  mode: DragMode;
  originX: number;
  delta: number;
}

/** The task's span as [start, end], both inclusive; null when undated. */
function span(task: Task): [string, string] | null {
  const start = task.startDate ?? task.dueDate;
  const end = task.dueDate ?? task.startDate;
  return start && end ? [start, end] : null;
}

/** Board order, with children placed right under their parent. */
function ordered(detail: BoardDetail): { task: Task; depth: number }[] {
  const flat = detail.stages.flatMap((s) => tasksIn(detail, s.id));
  const ids = new Set(flat.map((t) => t.id));
  const children = new Map<string, Task[]>();
  for (const t of flat) if (t.parentId && ids.has(t.parentId)) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
  const out: { task: Task; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (t: Task, depth: number) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push({ task: t, depth });
    for (const c of children.get(t.id) ?? []) walk(c, depth + 1);
  };
  for (const t of flat) if (!t.parentId || !ids.has(t.parentId)) walk(t, 0);
  /* Tasks in a parent loop have no root to hang from: start them at the top, once each. */
  for (const t of flat) walk(t, 0);
  return out;
}

export function GanttView({ detail, hierarchy, onOpen }: { detail: BoardDetail; hierarchy: Hierarchy; onOpen: (taskId: string) => void }) {
  const update = useUpdateTask(detail.board.id);
  const touch = useTouch();
  const labelPx = usePhone() ? PHONE_LABEL_PX : LABEL_PX;
  const canDrag = detail.board.role !== "viewer" && !touch;
  const [drag, setDrag] = useState<Drag | null>(null);
  const moved = useRef(false);
  const today = todayLocal();

  const rows = useMemo(() => ordered(detail), [detail]);
  const dated = rows.filter((r) => span(r.task));
  const undated = rows.filter((r) => !span(r.task));

  /* The visible range: every bar, plus today, with a week of air either side. */
  const [from, days] = useMemo(() => {
    let lo = today;
    let hi = addDays(today, 21);
    for (const { task } of dated) {
      const [s, e] = span(task) as [string, string];
      if (s < lo) lo = s;
      if (e > hi) hi = e;
    }
    const start = addDays(lo, -7);
    return [start, daysBetween(start, addDays(hi, 7)) + 1];
  }, [dated, today]);

  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => addDays(from, i)), [from, days]);
  const stageOf = (task: Task) => detail.stages.find((s) => s.id === task.stageId);

  /** Where a bar is drawn, with the drag in progress applied. */
  const shifted = (task: Task): [string, string] => {
    const [s, e] = span(task) as [string, string];
    if (!drag || drag.taskId !== task.id || drag.delta === 0) return [s, e];
    if (drag.mode === "move") return [addDays(s, drag.delta), addDays(e, drag.delta)];
    if (drag.mode === "start") {
      const ns = addDays(s, drag.delta);
      return [ns > e ? e : ns, e];
    }
    const ne = addDays(e, drag.delta);
    return [s, ne < s ? s : ne];
  };

  const begin = (event: PointerEvent, task: Task, mode: DragMode) => {
    if (!canDrag || isDraft(task.id)) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    moved.current = false;
    setDrag({ taskId: task.id, mode, originX: event.clientX, delta: 0 });
  };

  const onMove = (event: PointerEvent) => {
    if (!drag) return;
    const delta = Math.round((event.clientX - drag.originX) / DAY_PX);
    if (delta !== drag.delta) {
      moved.current = true;
      setDrag({ ...drag, delta });
    }
  };

  const end = (task: Task) => {
    if (!drag) return;
    const [s, e] = shifted(task);
    setDrag(null);
    if (drag.delta === 0) return;
    /* A one-date task keeps being a one-date task when moved. */
    const patch =
      task.startDate && task.dueDate
        ? { startDate: s, dueDate: e }
        : task.dueDate
          ? drag.mode === "start"
            ? { startDate: s, dueDate: e }
            : { dueDate: e }
          : drag.mode === "end"
            ? { startDate: s, dueDate: e }
            : { startDate: s };
    update.mutate({ id: task.id, patch });
  };

  return (
    <div className="flex-1 min-h-0 overflow-auto px-4 md:px-8 py-4">
      {update.error && <p className="text-red text-xs mb-2">{update.error.message}</p>}
      <div className="bg-surface inline-block min-w-full">
        {/* Header: months over days. */}
        <div className="flex sticky top-0 z-10 bg-surface border-b border-divider">
          <div className="shrink-0 sticky left-0 z-20 bg-surface border-r border-divider" style={{ width: labelPx }} />
          <div className="flex">
            {dayList.map((day) => {
              const d = new Date(`${day}T00:00:00Z`);
              const first = d.getUTCDate() === 1 || day === from;
              const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
              return (
                <div key={day} className="shrink-0 text-center text-xs" style={{ width: DAY_PX }}>
                  <div className="h-4 text-muted whitespace-nowrap overflow-visible text-left pl-0.5">
                    {first ? d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }).toLowerCase() : ""}
                  </div>
                  <div className={`py-1 ${day === today ? "text-accent" : weekend ? "text-faint" : "text-muted"}`}>
                    {d.getUTCDate()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {dated.length === 0 && <p className="px-4 py-6 text-faint text-sm">No task shown here has dates.</p>}

        {dated.map(({ task, depth }) => {
          const [s, e] = shifted(task);
          const left = daysBetween(from, s) * DAY_PX;
          const width = (daysBetween(s, e) + 1) * DAY_PX;
          const stage = stageOf(task);
          const closed = task.completedAt !== null;
          const milestone = task.level === "milestone";
          /* A child whose parent the filters hid sits at the top level and names its parent. */
          const lostParent = depth === 0 ? hierarchy.parentKey(task) : null;
          return (
            <div key={task.id} className="flex border-b border-divider group/row hover:bg-raised/40" style={{ height: ROW_PX }}>
              <div
                className="shrink-0 sticky left-0 z-[5] flex items-center gap-2 bg-surface group-hover/row:bg-raised border-r border-divider pr-3 text-sm"
                style={{ width: labelPx, paddingLeft: 12 + depth * 14 }}
              >
                <button onClick={() => !isDraft(task.id) && onOpen(task.id)} className="min-w-0 flex-1 text-left truncate" title={task.title}>
                  <span className="text-faint mr-2">{task.key}</span>
                  <span className={closed ? "text-muted line-through decoration-faint" : "text-ink"}>{task.title}</span>
                </button>
                {lostParent && (
                  <span className="shrink-0 text-xs">
                    <ParentLink parentKey={lostParent} onClick={() => hierarchy.onScope(lostParent)} />
                  </span>
                )}
                <LevelPill level={task.level} />
              </div>
              <div className="relative" style={{ width: days * DAY_PX }}>
                {/* Today. */}
                <div className="absolute inset-y-0 w-px bg-accent/40" style={{ left: daysBetween(from, today) * DAY_PX + DAY_PX / 2 }} />
                {milestone ? (
                  <div
                    onPointerDown={(ev) => begin(ev, task, "move")}
                    onPointerMove={onMove}
                    onPointerUp={() => end(task)}
                    onClick={() => !moved.current && onOpen(task.id)}
                    className={`absolute top-1/2 w-3.5 h-3.5 rotate-45 ${toneBg(stage?.tone ?? 0)} ${closed ? "opacity-40" : ""} ${canDrag ? "cursor-grab" : "cursor-pointer"}`}
                    style={{ left: daysBetween(from, e) * DAY_PX + DAY_PX / 2 - 7, marginTop: -7 }}
                    title={`${task.title} · ${e}`}
                  />
                ) : (
                  <div
                    onPointerDown={(ev) => begin(ev, task, "move")}
                    onPointerMove={onMove}
                    onPointerUp={() => end(task)}
                    onClick={() => !moved.current && onOpen(task.id)}
                    className={`absolute top-1.5 bottom-1.5 ${toneBg(stage?.tone ?? 0)} ${closed ? "opacity-35" : "opacity-80"} ${
                      canDrag ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                    } select-none ${canDrag ? "touch-none" : ""}`}
                    style={{ left: left + 2, width: width - 4 }}
                    title={`${task.title} · ${s} → ${e}`}
                  >
                    {canDrag && (
                      <>
                        <span
                          onPointerDown={(ev) => begin(ev, task, "start")}
                          className="absolute inset-y-0 left-0 w-2 cursor-ew-resize"
                        />
                        <span
                          onPointerDown={(ev) => begin(ev, task, "end")}
                          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize"
                        />
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {undated.length > 0 && (
        <div className="mt-4 bg-surface">
          <h4 className="text-label px-3 pt-3 pb-1">no dates ({undated.length})</h4>
          {undated.map(({ task }) => (
            <button
              key={task.id}
              onClick={() => !isDraft(task.id) && onOpen(task.id)}
              className="flex w-full items-baseline gap-2 text-left px-3 py-1.5 pointer-coarse:py-2.5 border-b border-divider hover:bg-raised text-sm"
            >
              <span className="text-faint">{task.key}</span>
              <span className="text-ink min-w-0 flex-1">{task.title}</span>
              <LevelPill level={task.level} className="self-center" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
