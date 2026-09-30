/* ============================================================================
   A task, opened. Every field saves on its own as soon as it changes (text
   on blur or Enter), through the same optimistic update as a drag, so there
   is no save button to forget. Viewers see the same modal read-only.
   ========================================================================== */

import { useEffect, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { LEVELS, PRIORITIES, type BoardDetail, type Task } from "@/domain/types";
import { useDeleteTask, useUpdateTask, type TaskPatch } from "@/lib/tasks";
import { Checkbox } from "@/ui/Checkbox";
import { ModalFrame } from "@/ui/ModalFrame";
import { toneText } from "@/ui/tone";
import { LabelPicker } from "./LabelPicker";
import { TaskActivity } from "./TaskActivity";

const field = "bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent disabled:opacity-60";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-start gap-3 py-1.5">
      <span className="text-label pt-2">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

interface TaskModalProps {
  detail: BoardDetail;
  taskId: string;
  onClose: () => void;
}

export function TaskModal({ detail, taskId, onClose }: TaskModalProps) {
  const task = detail.tasks.find((t) => t.id === taskId);
  const update = useUpdateTask(detail.board.id);
  const remove = useDeleteTask(detail.board.id);
  const canEdit = detail.board.role !== "viewer";
  const [confirmDelete, setConfirmDelete] = useState(false);

  /* Text fields keep a local draft and save on blur; a live update from
     someone else replaces the draft only while this field is not focused. */
  const [title, setTitle] = useState(task?.title ?? "");
  const [brief, setBrief] = useState(task?.brief ?? "");
  const [editing, setEditing] = useState<"title" | "brief" | null>(null);
  useEffect(() => {
    if (task && editing !== "title") setTitle(task.title);
    if (task && editing !== "brief") setBrief(task.brief);
  }, [task, editing]);

  /* Deleted, here or by someone else while it was open. */
  useEffect(() => {
    if (!task) onClose();
  }, [task, onClose]);
  if (!task) return null;

  const save = (patch: TaskPatch) => update.mutate({ id: task.id, patch });
  const stage = detail.stages.find((s) => s.id === task.stageId);
  const planning = detail.board.hasPlanning;
  const others = detail.tasks.filter((t) => t.id !== task.id);

  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <ModalFrame
      title={
        <span>
          <span className="text-faint">{task.key}</span> <span className={toneText(stage?.tone ?? 0)}>{stage?.name}</span>
        </span>
      }
      onClose={onClose}
      size="lg"
      className="max-h-[90vh]"
      footer={
        canEdit && (
          <>
            {(update.error ?? remove.error) && (
              <span className="text-red text-xs mr-auto">{(update.error ?? remove.error)?.message}</span>
            )}
            <button
              onClick={() => (confirmDelete ? remove.mutate(task.id) : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
              className={`flex items-center gap-1.5 px-3 py-1.5 border transition-colors ${
                confirmDelete ? "border-red text-red" : "border-faint text-muted hover:border-red hover:text-red"
              }`}
            >
              <Trash2 size={14} /> {confirmDelete ? "really delete" : "delete"}
            </button>
          </>
        )
      }
    >
      <textarea
        value={title}
        disabled={!canEdit}
        rows={1}
        onFocus={() => setEditing("title")}
        onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
        onBlur={() => {
          setEditing(null);
          const next = title.trim();
          if (next && next !== task.title) save({ title: next });
          else setTitle(task.title);
        }}
        className="w-full resize-none bg-transparent text-bright text-lg leading-snug focus:outline-none focus:bg-raised px-1 -mx-1 mb-3 [field-sizing:content]"
      />

      <Row label="stage">
        <div className="flex flex-wrap gap-1.5">
          {detail.stages.map((s) => (
            <button
              key={s.id}
              disabled={!canEdit}
              onClick={() => s.id !== task.stageId && save({ stageId: s.id })}
              className={`px-2 py-1 border transition-colors ${
                s.id === task.stageId ? `border-accent ${toneText(s.tone)}` : "border-faint text-muted hover:text-ink"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      </Row>

      <Row label="priority">
        <select
          className={field}
          disabled={!canEdit}
          value={task.priority}
          onChange={(e) => save({ priority: e.target.value as Task["priority"] })}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Row>

      <Row label="dates">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            className={field}
            disabled={!canEdit}
            value={task.startDate ?? ""}
            max={task.dueDate ?? undefined}
            onChange={(e) => save({ startDate: e.target.value || null })}
            aria-label="start date"
          />
          <span className="text-faint">→</span>
          <input
            type="date"
            className={field}
            disabled={!canEdit}
            value={task.dueDate ?? ""}
            min={task.startDate ?? undefined}
            onChange={(e) => save({ dueDate: e.target.value || null })}
            aria-label="due date"
          />
        </div>
      </Row>

      <Row label="labels">
        <LabelPicker detail={detail} task={task} canEdit={canEdit} onChange={(labelIds) => save({ labelIds })} />
      </Row>

      {detail.members.length > 1 && (
        <Row label="assignees">
          <div className="flex flex-col gap-1 pt-1.5">
            {detail.members.map((m) => (
              <Checkbox
                key={m.user.id}
                checked={task.assigneeIds.includes(m.user.id)}
                onChange={() => canEdit && save({ assigneeIds: toggleIn(task.assigneeIds, m.user.id) })}
                label={<span className="text-ink">{m.user.name}</span>}
                size={15}
              />
            ))}
          </div>
        </Row>
      )}

      {planning && (
        <>
          <Row label="level">
            <select
              className={field}
              disabled={!canEdit}
              value={task.level ?? ""}
              onChange={(e) => save({ level: (e.target.value || null) as Task["level"] })}
            >
              <option value="">none</option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Row>
          <Row label="parent">
            <select
              className={`${field} w-full`}
              disabled={!canEdit}
              value={task.parentId ?? ""}
              onChange={(e) => save({ parentId: e.target.value || null })}
            >
              <option value="">none</option>
              {others.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.key} {t.title}
                </option>
              ))}
            </select>
          </Row>
          <Row label="after">
            <div className="flex flex-wrap items-center gap-1.5">
              {task.dependsOn.map((id) => {
                const dep = detail.tasks.find((t) => t.id === id);
                return (
                  <span key={id} className={`inline-flex items-center gap-1 border border-faint px-1.5 py-0.5 text-sm ${dep?.completedAt ? "text-green" : "text-ink"}`}>
                    {dep ? `${dep.key} ${dep.title}` : "(deleted)"}
                    {canEdit && (
                      <button onClick={() => save({ dependsOn: task.dependsOn.filter((x) => x !== id) })} className="text-muted hover:text-red" aria-label="Remove dependency">
                        ×
                      </button>
                    )}
                  </span>
                );
              })}
              {canEdit && (
                <select
                  className={field}
                  value=""
                  onChange={(e) => e.target.value && save({ dependsOn: [...task.dependsOn, e.target.value] })}
                >
                  <option value="">+ waits on…</option>
                  {others
                    .filter((t) => !task.dependsOn.includes(t.id))
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.key} {t.title}
                      </option>
                    ))}
                </select>
              )}
            </div>
          </Row>
        </>
      )}

      <Row label="notes">
        <textarea
          value={brief}
          disabled={!canEdit}
          placeholder={canEdit ? "details, links, whatever" : ""}
          onFocus={() => setEditing("brief")}
          onChange={(e) => setBrief(e.target.value)}
          onBlur={() => {
            setEditing(null);
            if (brief !== task.brief) save({ brief });
          }}
          className={`${field} w-full min-h-28 resize-y leading-relaxed`}
        />
      </Row>

      <TaskActivity detail={detail} taskId={task.id} />
    </ModalFrame>
  );
}
