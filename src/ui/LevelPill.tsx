/* ============================================================================
   Where a task sits in the plan, at a glance: three dots filled from the
   right by depth. A task is `··●`, a story `·●●`, an epic `●●●`. A milestone
   is off that ladder, so it is a diamond in the same footprint. A task with
   no level gets nothing.
   ========================================================================== */

import type { Level } from "@/domain/types";

const FILLED: Record<Exclude<Level, "milestone">, number> = { task: 1, story: 2, epic: 3 };

/* 16 x 6 on the px grid: dots at x 3, 8, 13. */
const DOTS = [3, 8, 13];

/** `decorative` when the level is already written next to it (a filter chip): no title, hidden from screen readers. */
export function LevelPill({ level, className = "", decorative = false }: { level: Level | null | undefined; className?: string; decorative?: boolean }) {
  if (!level) return null;
  return (
    <span {...(decorative ? { "aria-hidden": true } : { title: level, role: "img", "aria-label": level })} className={`inline-flex shrink-0 items-center align-middle ${className}`}>
      <svg width={16} height={6} viewBox="0 0 16 6" aria-hidden className="block overflow-visible">
        {level === "milestone" ? (
          <path d="M8 -0.5 L11.5 3 L8 6.5 L4.5 3 Z" className="fill-muted" />
        ) : (
          DOTS.map((x, i) =>
            i >= DOTS.length - FILLED[level] ? (
              <circle key={x} cx={x} cy={3} r={2} className="fill-muted" />
            ) : (
              <circle key={x} cx={x} cy={3} r={1} className="fill-faint" />
            ),
          )
        )}
      </svg>
    </span>
  );
}
