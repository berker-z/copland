/* ============================================================================
   A board as a list: every task as one line, grouped by stage, with the
   fields a kanban card hides (priority, start, labels) in columns. Good for
   scanning a big board; the kanban is better for moving things.
   ========================================================================== */

import type { BoardDetail } from "@/domain/types";
import { tasksIn } from "@/lib/tasks";
import { dueClass, isDraft, PRIORITY_CLASS, shortDate, toneText } from "@/ui/tone";
import type { Hierarchy } from "./BoardScreen";
import { ParentLink } from "./TaskRow";

export function ListView({ detail, hierarchy, onOpen }: { detail: BoardDetail; hierarchy: Hierarchy; onOpen: (taskId: string) => void }) {
  const name = (id: string) => detail.members.find((m) => m.user.id === id)?.user.handle ?? "?";

  return (
    <div className="flex-1 min-h-0 overflow-auto px-4 md:px-8 py-4">
      <table className="w-full bg-surface text-sm border-collapse">
        <thead className="text-label text-left">
          <tr className="border-b border-divider">
            <th className="px-3 py-2 font-normal w-20">key</th>
            <th className="px-3 py-2 font-normal">title</th>
            <th className="px-3 py-2 font-normal w-20">priority</th>
            <th className="px-3 py-2 font-normal w-24 hidden md:table-cell">start</th>
            <th className="px-3 py-2 font-normal w-24">due</th>
            <th className="px-3 py-2 font-normal hidden lg:table-cell">labels</th>
            {detail.members.length > 1 && <th className="px-3 py-2 font-normal hidden md:table-cell">people</th>}
          </tr>
        </thead>
        {detail.stages.map((stage) => {
          const tasks = tasksIn(detail, stage.id);
          return (
            <tbody key={stage.id}>
              <tr>
                <td colSpan={7} className="px-3 pt-4 pb-1">
                  <span className={`tracking-[0.14em] ${toneText(stage.tone)}`}>{stage.name}</span>
                  <span className="text-xs text-muted ml-2">{tasks.length}</span>
                </td>
              </tr>
              {tasks.map((task) => {
                const closed = task.completedAt !== null;
                const parentKey = hierarchy.parentKey(task);
                return (
                  <tr
                    key={task.id}
                    onClick={() => !isDraft(task.id) && onOpen(task.id)}
                    className="border-b border-divider hover:bg-raised cursor-pointer"
                  >
                    <td className="px-3 py-1.5 text-faint whitespace-nowrap">{task.key}</td>
                    <td className={`px-3 py-1.5 ${closed ? "text-muted line-through decoration-faint" : "text-ink"}`}>
                      {task.level && <span className="text-faint mr-1.5">[{task.level}]</span>}
                      {task.title}
                      {parentKey && (
                        <span className="ml-2 text-xs no-underline inline-block">
                          <ParentLink parentKey={parentKey} onClick={() => hierarchy.onScope(parentKey)} />
                        </span>
                      )}
                    </td>
                    <td className={`px-3 py-1.5 ${PRIORITY_CLASS[task.priority]}`}>{task.priority}</td>
                    <td className="px-3 py-1.5 text-muted hidden md:table-cell">{task.startDate ? shortDate(task.startDate) : ""}</td>
                    <td className={`px-3 py-1.5 ${dueClass(task.dueDate, closed)}`}>{task.dueDate ? shortDate(task.dueDate) : ""}</td>
                    <td className="px-3 py-1.5 hidden lg:table-cell">
                      {detail.labels
                        .filter((l) => task.labelIds.includes(l.id))
                        .map((l) => (
                          <span key={l.id} className={`${toneText(l.tone)} mr-2`}>
                            #{l.name}
                          </span>
                        ))}
                    </td>
                    {detail.members.length > 1 && (
                      <td className="px-3 py-1.5 text-muted hidden md:table-cell">{task.assigneeIds.map(name).join(", ")}</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
