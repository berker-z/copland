/* ============================================================================
   Swimlanes by epic: which lane a task is in, which lanes show, and what a
   drag from one lane into another means. Pure, like filters.ts; the kanban
   (BoardScreen, ?group=epic) draws what this returns.
   ----------------------------------------------------------------------------
   - A task is in the lane of its nearest epic ancestor, walking up parent
     links (a loop is walked once). No epic above it: the "no epic" lane,
     which comes last.
   - Epics are the lanes, never cards in them. An epic under an epic is a
     lane of its own, and its tasks are in it, not in the outer one.
   - A lane shows when it has a card the filters let through, or when the
     epic itself does (so an epic with no children yet, or none matching,
     still shows as an empty lane while it is in scope). Closed epics follow
     the done filter like any task: gone after 14 days unless done=all,
     unless something open is still in them.
   - Lanes are in board order of their epics: stage, then rank.
   - Dragging into another lane changes the parent, but only for a task
     hanging straight off its lane (its parent is the epic, or it has no
     parent and is in "no epic"): it takes the new epic as parent, or none.
     Anything deeper (a task under a story) moves with its story; dragging
     it alone across is refused, so nothing is reparented by surprise. So is
     a drop that would make a loop (the epic is under the task).
   ========================================================================== */

import { descendantIds } from "@/domain/tasks";
import type { Stage, Task } from "@/domain/types";

/** The lane id of tasks with no epic above them. Epic lanes use the epic's id. */
export const NO_EPIC = "none";

export interface Lane {
  /** The epic's id, or NO_EPIC. */
  id: string;
  epic: Task | null;
  /** Shown cards, in no particular order: callers split them by stage. */
  tasks: Task[];
}

const isEpic = (t: Task) => t.level === "epic";

/** The lane id for every task on the board (epics included: their own id). */
export function laneIds(tasks: Task[]): Map<string, string> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Map<string, string>();
  for (const task of tasks) {
    if (isEpic(task)) {
      out.set(task.id, task.id);
      continue;
    }
    let lane = NO_EPIC;
    const seen = new Set<string>([task.id]);
    for (let at = task.parentId ? byId.get(task.parentId) : undefined; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
      if (isEpic(at)) {
        lane = at.id;
        break;
      }
      seen.add(at.id);
    }
    out.set(task.id, lane);
  }
  return out;
}

/**
 * The lanes to draw. `all` is the whole board (for parents the filters
 * hid), `shown` what the filters let through.
 */
export function buildLanes(all: Task[], shown: Task[], stages: Stage[], lanes = laneIds(all)): Lane[] {
  const position = new Map(stages.map((s) => [s.id, s.position]));
  const shownIds = new Set(shown.map((t) => t.id));
  const cards = new Map<string, Task[]>();
  for (const t of shown) {
    if (isEpic(t)) continue;
    const id = lanes.get(t.id) ?? NO_EPIC;
    cards.set(id, [...(cards.get(id) ?? []), t]);
  }
  const epics = all
    .filter((t) => isEpic(t) && (shownIds.has(t.id) || cards.has(t.id)))
    .sort((a, b) => (position.get(a.stageId) ?? 0) - (position.get(b.stageId) ?? 0) || a.rank - b.rank || a.number - b.number);
  const out: Lane[] = epics.map((epic) => ({ id: epic.id, epic, tasks: cards.get(epic.id) ?? [] }));
  const loose = cards.get(NO_EPIC);
  if (loose) out.push({ id: NO_EPIC, epic: null, tasks: loose });
  return out;
}

/**
 * What dropping `task` into lane `to` does to its parent: undefined for no
 * change (same lane), the new parent (an epic id, or null for "no epic"), or
 * false when the drop is refused. See the rules at the top.
 */
export function parentForLane(task: Task, all: Task[], lanes: Map<string, string>, to: string): string | null | undefined | false {
  const from = lanes.get(task.id) ?? NO_EPIC;
  if (from === to) return undefined;
  if (isEpic(task)) return false;
  const straight = from === NO_EPIC ? task.parentId === null : task.parentId === from;
  if (!straight) return false;
  if (to === NO_EPIC) return null;
  if (descendantIds(all, task.id).has(to)) return false;
  return to;
}
