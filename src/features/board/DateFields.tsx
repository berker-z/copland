/* ============================================================================
   Start and due, with one-tap due dates.
   ----------------------------------------------------------------------------
   Most due dates are "a day", "a few days" or "a week" from when the work
   starts, so those are buttons next to the fields: +1d, +3d, +1w count from
   the start date, or from today when there is none. The fields stay for
   anything else.
   ========================================================================== */

import { addDays } from "@/domain/tasks";
import { todayLocal } from "@/ui/tone";

const field = "bg-raised border border-faint px-2 py-1.5 text-ink focus:outline-none focus:border-accent disabled:opacity-60";

const QUICK = [
  { label: "+1d", days: 1 },
  { label: "+3d", days: 3 },
  { label: "+1w", days: 7 },
];

interface DateFieldsProps {
  start: string | null;
  due: string | null;
  disabled?: boolean;
  onChange: (dates: { start?: string | null; due?: string | null }) => void;
}

export function DateFields({ start, due, disabled, onChange }: DateFieldsProps) {
  const base = start ?? todayLocal();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          className={field}
          disabled={disabled}
          value={start ?? ""}
          max={due ?? undefined}
          onChange={(e) => onChange({ start: e.target.value || null })}
          aria-label="start date"
        />
        <span className="text-faint">→</span>
        <input
          type="date"
          className={field}
          disabled={disabled}
          value={due ?? ""}
          min={start ?? undefined}
          onChange={(e) => onChange({ due: e.target.value || null })}
          aria-label="due date"
        />
      </div>
      {!disabled && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-faint text-xs mr-1">due</span>
          {QUICK.map((q) => {
            const target = addDays(base, q.days);
            return (
              <button
                key={q.label}
                type="button"
                onClick={() => onChange({ due: target })}
                className={`px-2 py-0.5 border transition-colors ${
                  due === target ? "border-accent text-accent" : "border-faint text-muted hover:text-ink hover:border-muted"
                }`}
                title={target}
              >
                {q.label}
              </button>
            );
          })}
          {due && (
            <button type="button" onClick={() => onChange({ due: null })} className="px-2 py-0.5 text-faint hover:text-red">
              clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
