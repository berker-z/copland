/* ============================================================================
   Labels on a task: every board label as a chip, lit when the task has it.
   Typing a name that is not a label yet and pressing Enter makes the label
   and puts it on the task in one go.
   ========================================================================== */

import { useRef, useState } from "react";
import type { BoardDetail, Task } from "@/domain/types";
import { useLabelEdits } from "@/lib/boardEdits";
import { toneText } from "@/ui/tone";

interface LabelPickerProps {
  detail: BoardDetail;
  task: Task;
  canEdit: boolean;
  onChange: (labelIds: string[]) => void;
}

export function LabelPicker({ detail, task, canEdit, onChange }: LabelPickerProps) {
  const labels = useLabelEdits(detail.board.id);
  const [draft, setDraft] = useState("");
  /* The label is made first and put on the task when the Worker answers; by
     then the task may have changed (another toggle), so read it fresh. */
  const current = useRef(task.labelIds);
  current.current = task.labelIds;
  const shown = canEdit ? detail.labels : detail.labels.filter((l) => task.labelIds.includes(l.id));

  const toggle = (id: string) =>
    onChange(task.labelIds.includes(id) ? task.labelIds.filter((x) => x !== id) : [...task.labelIds, id]);

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      {shown.map((label) => {
        const on = task.labelIds.includes(label.id);
        return (
          <button
            key={label.id}
            disabled={!canEdit}
            onClick={() => toggle(label.id)}
            className={`px-1.5 py-0.5 border text-sm transition-colors ${
              on ? `border-current ${toneText(label.tone)}` : "border-faint text-faint hover:text-muted"
            }`}
          >
            #{label.name}
          </button>
        );
      })}
      {shown.length === 0 && !canEdit && <span className="text-faint text-sm pt-1">none</span>}
      {canEdit && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = draft.trim().replace(/^#/, "");
            if (!name) return;
            const existing = detail.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
            setDraft("");
            if (existing) {
              if (!task.labelIds.includes(existing.id)) toggle(existing.id);
              return;
            }
            labels.add.mutate({ name }, { onSuccess: (label) => onChange([...current.current, label.id]) });
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="+ label"
            maxLength={24}
            className="w-24 bg-transparent px-1 py-0.5 text-sm text-ink placeholder:text-faint focus:outline-none focus:bg-raised"
          />
        </form>
      )}
      {labels.add.error && <span className="text-red text-xs">{labels.add.error.message}</span>}
    </div>
  );
}
