/* ============================================================================
   Editing a board's stages and labels, inside board settings.
   ----------------------------------------------------------------------------
   Stages: rename in place (Enter or blur saves), pick what the stage means
   and its colour, move it left or right, delete it. Deleting a stage with
   tasks asks where they should go first. The Worker refuses a change that
   would leave no open stage or no done stage, and the message says so.

   Labels: rename, recolour, delete. New labels are made from a task.
   ========================================================================== */

import { useState } from "react";
import { ArrowLeft, ArrowRight, Trash2 } from "lucide-react";
import { isClosing, RECENT_CLOSED_DAYS } from "@/domain/tasks";
import { STAGE_CATEGORIES, type BoardDetail, type Label, type Stage, type StageCategory } from "@/domain/types";
import { useLabelEdits, useStageEdits } from "@/lib/boardEdits";
import { toneBg, toneText } from "@/ui/tone";

const input = "bg-raised border border-faint px-2 py-1 text-ink placeholder:text-faint focus:outline-none focus:border-accent";

function TonePicker({ tone, onPick }: { tone: number; onPick: (tone: number) => void }) {
  return (
    <span className="inline-flex gap-1">
      {Array.from({ length: 8 }, (_, t) => (
        <button
          key={t}
          type="button"
          onClick={() => t !== tone && onPick(t)}
          className={`w-3.5 h-3.5 ${toneBg(t)} ${t === tone ? "outline outline-1 outline-offset-1 outline-bright" : "opacity-50 hover:opacity-100"}`}
          aria-label={`colour ${t + 1}`}
        />
      ))}
    </span>
  );
}

/** A text field that saves on Enter or blur, and snaps back if emptied. */
function NameField({ value, onSave, maxLength }: { value: string; onSave: (name: string) => void; maxLength: number }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const shown = focused ? draft : value;
  return (
    <input
      className={`${input} w-32`}
      value={shown}
      maxLength={maxLength}
      onFocus={() => {
        setDraft(value);
        setFocused(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      onBlur={() => {
        setFocused(false);
        if (draft.trim() && draft.trim() !== value) onSave(draft.trim());
      }}
    />
  );
}

function StageRow({ detail, stage, index }: { detail: BoardDetail; stage: Stage; index: number }) {
  const edits = useStageEdits(detail.board.id);
  const [deleting, setDeleting] = useState(false);
  const others = detail.stages.filter((s) => s.id !== stage.id);
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? "");
  const count = detail.tasks.filter((t) => t.stageId === stage.id).length;
  /* A closing stage's count is the board read's, which leaves out tasks closed long ago. */
  const more = isClosing(stage.category) && detail.olderClosed;

  const move = (delta: number) => {
    const ids = detail.stages.map((s) => s.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    edits.reorder.mutate(ids);
  };

  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5">
      <NameField value={stage.name} maxLength={30} onSave={(name) => edits.patch.mutate({ id: stage.id, name })} />
      <select
        className={input}
        value={stage.category}
        onChange={(e) => edits.patch.mutate({ id: stage.id, category: e.target.value as StageCategory })}
        title="What this stage means: backlog is parked, todo is ready to pick up, active is being worked on, blocked waits on a person; done and cancelled close a task"
      >
        {STAGE_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <TonePicker tone={stage.tone} onPick={(tone) => edits.patch.mutate({ id: stage.id, tone })} />
      <span className="text-xs text-faint w-10 text-right" title={more ? `${count} closed in the last ${RECENT_CLOSED_DAYS} days, and older ones` : undefined}>
        {count}
        {more && "+"}
      </span>
      <span className="flex-1" />
      <button disabled={index === 0} onClick={() => move(-1)} className="tap p-1 text-muted hover:text-accent disabled:opacity-30" aria-label="Move left">
        <ArrowLeft size={13} />
      </button>
      <button
        disabled={index === detail.stages.length - 1}
        onClick={() => move(1)}
        className="tap p-1 text-muted hover:text-accent disabled:opacity-30"
        aria-label="Move right"
      >
        <ArrowRight size={13} />
      </button>
      <button onClick={() => setDeleting((d) => !d)} className="tap p-1 text-muted hover:text-red" aria-label="Delete stage">
        <Trash2 size={13} />
      </button>
      {deleting && (
        <div className="basis-full flex flex-wrap items-center gap-2 pl-1 text-sm">
          {count > 0 || more ? (
            <>
              <span className="text-muted">{more ? "move its tasks, older ones too, to" : `move its ${count} tasks to`}</span>
              <select className={input} value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                {others.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <span className="text-muted">it is empty.</span>
          )}
          <button
            onClick={() => edits.remove.mutate({ id: stage.id, moveTo })}
            className="px-2 py-0.5 border border-red text-red hover:bg-red/10"
          >
            delete {stage.name}
          </button>
        </div>
      )}
    </li>
  );
}

export function StageEditor({ detail }: { detail: BoardDetail }) {
  const edits = useStageEdits(detail.board.id);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<StageCategory>("active");
  const error = edits.add.error ?? edits.patch.error ?? edits.reorder.error ?? edits.remove.error;

  return (
    <>
      {error && <p className="text-red text-xs mb-2">{error.message}</p>}
      <ul className="mb-2">
        {detail.stages.map((stage, index) => (
          <StageRow key={stage.id} detail={detail} stage={stage} index={index} />
        ))}
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          edits.add.mutate({ name: name.trim(), category, tone: detail.stages.length % 8 }, { onSuccess: () => setName("") });
        }}
      >
        <input className={`${input} w-32`} value={name} onChange={(e) => setName(e.target.value)} placeholder="new stage" maxLength={30} />
        <select className={input} value={category} onChange={(e) => setCategory(e.target.value as StageCategory)}>
          {STAGE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button type="submit" className="px-3 py-1 pointer-coarse:py-2.5 border border-faint text-ink hover:border-accent hover:text-accent">
          add
        </button>
      </form>
    </>
  );
}

function LabelRow({ boardId, label }: { boardId: string; label: Label }) {
  const edits = useLabelEdits(boardId);
  return (
    <li className="flex items-center gap-2 py-1">
      <span className={toneText(label.tone)}>#</span>
      <NameField value={label.name} maxLength={24} onSave={(name) => edits.patch.mutate({ id: label.id, name })} />
      <TonePicker tone={label.tone} onPick={(tone) => edits.patch.mutate({ id: label.id, tone })} />
      <span className="flex-1" />
      <button onClick={() => edits.remove.mutate(label.id)} className="tap p-1 text-muted hover:text-red" aria-label={`Delete ${label.name}`}>
        <Trash2 size={13} />
      </button>
      {(edits.patch.error ?? edits.remove.error) && (
        <span className="text-red text-xs">{(edits.patch.error ?? edits.remove.error)?.message}</span>
      )}
    </li>
  );
}

export function LabelEditor({ detail }: { detail: BoardDetail }) {
  if (detail.labels.length === 0) {
    return <p className="text-faint text-sm">No labels yet. Add one from any task.</p>;
  }
  return (
    <ul>
      {detail.labels.map((label) => (
        <LabelRow key={label.id} boardId={detail.board.id} label={label} />
      ))}
    </ul>
  );
}
