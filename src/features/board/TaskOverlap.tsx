/* ============================================================================
   A task's overlap, opened (COPL-105): the other open tasks on its board
   whose changed files share some with its own (GET /api/tasks/:id/overlap,
   COPL-104), most shared first, each a link with who is on it and the
   shared paths, then when this task's own list was last reported.
   ----------------------------------------------------------------------------
   Information, not a warning: no hue, only ink, muted and faint. Long lists
   fold past a few, tasks and each task's paths alike.
   ========================================================================== */

import { useState } from "react";
import { Link } from "react-router";
import type { TaskOverlapRead } from "@/domain/overlap";
import { taskPath } from "@/domain/tasks";
import { when } from "@/ui/tone";

/** Tasks shown before "N more tasks", and paths per task before "N more". */
const SHOWN_TASKS = 3;
const SHOWN_PATHS = 3;

const more = "text-xs text-muted hover:text-accent";

function OverlapItem({ item }: { item: TaskOverlapRead["overlaps"][number] }) {
  const [open, setOpen] = useState(false);
  const paths = open ? item.shared : item.shared.slice(0, SHOWN_PATHS);
  const who = item.claimed_by ? `${item.claimed_by} is on it` : item.assignees.join(", ");
  return (
    <li className="min-w-0">
      <div className="flex items-baseline gap-1.5 min-w-0">
        <Link to={taskPath(item.key)} className="min-w-0 truncate text-ink hover:text-accent">
          <span className="text-muted">{item.key}</span> {item.title}
        </Link>
        {who && <span className="shrink-0 text-xs text-muted">{who}</span>}
        <span className="shrink-0 text-xs text-faint" title={`its list reported ${when(item.reported_at)}`}>
          {item.shared.length} {item.shared.length === 1 ? "file" : "files"}
        </span>
      </div>
      <ul className="pl-3 text-xs text-muted">
        {paths.map((path) => (
          <li key={path} className="truncate" title={path}>
            {path}
          </li>
        ))}
      </ul>
      {item.shared.length > SHOWN_PATHS && (
        <button type="button" onClick={() => setOpen(!open)} className={`pl-3 ${more}`}>
          {open ? "fewer" : `${item.shared.length - SHOWN_PATHS} more`}
        </button>
      )}
    </li>
  );
}

/** The modal's "overlap" row, given the task's overlap read. */
export function OverlapList({ data }: { data: TaskOverlapRead }) {
  const [all, setAll] = useState(false);
  const items = all ? data.overlaps : data.overlaps.slice(0, SHOWN_TASKS);
  const own = data.files;
  return (
    <div className="flex flex-col gap-1.5">
      {data.overlaps.length === 0 ? (
        <span className="text-muted">shares no files with other open tasks</span>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <OverlapItem key={item.key} item={item} />
          ))}
        </ul>
      )}
      {data.overlaps.length > SHOWN_TASKS && (
        <button type="button" onClick={() => setAll(!all)} className={`self-start ${more}`}>
          {all ? "fewer tasks" : `${data.overlaps.length - SHOWN_TASKS} more tasks`}
        </button>
      )}
      <span className="text-xs text-faint">
        {own
          ? `this task's list: ${own.files.length}${own.truncated ? "+" : ""} ${own.files.length === 1 && !own.truncated ? "file" : "files"}, reported ${when(own.reported_at)}`
          : "this task's files haven't been reported yet"}
      </span>
    </div>
  );
}
