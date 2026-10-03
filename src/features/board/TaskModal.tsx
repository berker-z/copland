/* ============================================================================
   A task, opened. It opens to read: the fields as plain text, empty ones
   left out, the notes as written. The pencil beside delete switches to the
   form, where every field saves on its own as soon as it changes (text on
   blur or Enter), through the same optimistic update as a drag, so there is
   no save button to forget. The pencil again (now a tick), or Escape, goes
   back to reading; Escape closes the modal only from there. Comments and
   files work in both modes: adding to a task is not editing it. Viewers
   never get the pencil.

   Everyone gets the link button, which copies the task's own link
   (taskPath: its board with this modal open). Opened over the dashboard
   (tasks, inbox, /wired), the key in the header is that link too, to go
   and see the task where it lives.
   ========================================================================== */

import { useEffect, useState, type ReactNode } from "react";
import { Link, useMatch } from "react-router";
import { Check, Link2, Pencil } from "lucide-react";
import { Avatar, peopleFirst } from "@/ui/Avatar";
import { LEVELS, PRIORITIES, type BoardDetail, type Task } from "@/domain/types";
import { progress, taskPath } from "@/domain/tasks";
import { useDeleteTask, useUpdateTask, type TaskPatch } from "@/lib/tasks";
import { Checkbox } from "@/ui/Checkbox";
import { DeleteButton } from "@/ui/DeleteButton";
import { LevelPill } from "@/ui/LevelPill";
import { ModalFrame } from "@/ui/ModalFrame";
import { dueClass, PRIORITY_CLASS, shortDate, toneText } from "@/ui/tone";
import { Attachments, useTaskAttachments } from "./Attachments";
import { DateFields } from "./DateFields";
import { LabelPicker } from "./LabelPicker";
import { TaskActivity } from "./TaskActivity";
import { CodeList } from "./TaskCode";

const field = "max-w-full bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent disabled:opacity-60";

/* Label beside the field from sm up; above it on a phone, where 6.5rem of
   label column leaves the field too little room. `text` rows hold plain
   text, so the label is not pushed down to meet an input's padding. */
function Row({ label, text, children }: { label: string; text?: boolean; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-1 sm:gap-3 py-1.5">
      <span className={`text-label ${text ? "" : "sm:pt-2"}`}>{label}</span>
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
  const files = useTaskAttachments(detail.board.id, taskId);
  const canEdit = detail.board.role !== "viewer";
  const [mode, setMode] = useState<"view" | "edit">("view");
  const editMode = canEdit && mode === "edit";
  const onBoard = useMatch("/b/:key") !== null;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  /* Text fields keep a local draft and save on blur; a live update from
     someone else replaces the draft only while this field is not focused. */
  const [title, setTitle] = useState(task?.title ?? "");
  const [brief, setBrief] = useState(task?.brief ?? "");
  const [editing, setEditing] = useState<"title" | "brief" | null>(null);
  useEffect(() => {
    if (task && editing !== "title") setTitle(task.title);
    if (task && editing !== "brief") setBrief(task.brief);
  }, [task, editing]);

  /* Back to reading. Blurring first saves a draft still in a text field,
     which unmounting it would drop. */
  const finishEditing = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setMode("view");
  };

  /* Escape in the form goes back to reading instead of closing. This sits
     on body, which the key passes before ModalFrame's listener on document;
     a picker that already handled the key (preventDefault) keeps it. */
  useEffect(() => {
    if (!editMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.stopPropagation();
      finishEditing();
    };
    document.body.addEventListener("keydown", onKey);
    return () => document.body.removeEventListener("keydown", onKey);
  }, [editMode]);

  /* Deleted, here or by someone else while it was open. */
  useEffect(() => {
    if (!task) onClose();
  }, [task, onClose]);
  if (!task) return null;

  const save = (patch: TaskPatch) => update.mutate({ id: task.id, patch });
  const stage = detail.stages.find((s) => s.id === task.stageId);
  const others = detail.tasks.filter((t) => t.id !== task.id);

  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <ModalFrame
      title={
        <span>
          {onBoard ? (
            <span className="text-faint">{task.key}</span>
          ) : (
            <Link to={taskPath(task.key)} className="text-faint hover:text-accent hover:underline" title="Open on its board">
              {task.key}
            </Link>
          )}{" "}
          <span className={toneText(stage?.tone ?? 0)}>{stage?.name}</span>
          <LevelPill level={task.level} className="ml-2.5" />
        </span>
      }
      onClose={onClose}
      size="lg"
      headerActions={
        <>
          <button
            onClick={() =>
              void navigator.clipboard.writeText(location.origin + taskPath(task.key)).then(() => setCopied(true), () => undefined)
            }
            className={`tap p-2 flex items-center gap-1.5 hover:bg-raised transition-colors ${copied ? "text-green" : "hover:text-accent"}`}
            title="Copy link to this task"
            aria-label="Copy link to this task"
          >
            {copied ? <Check size={18} /> : <Link2 size={18} />}
            {copied && <span className="text-xs">copied</span>}
          </button>
          {canEdit && (
            <>
              <button
                onClick={() => (editMode ? finishEditing() : setMode("edit"))}
                className={`tap p-2 flex items-center gap-1.5 hover:bg-raised transition-colors ${editMode ? "text-accent" : "hover:text-accent"}`}
                title={editMode ? "Done editing" : "Edit"}
              >
                {editMode ? <Check size={18} /> : <Pencil size={18} />}
                {editMode && <span className="text-xs">done</span>}
              </button>
              <DeleteButton onDelete={() => remove.mutate(task.id)} />
            </>
          )}
        </>
      }
    >
      {(update.error ?? remove.error) && (
        <p className="text-red text-xs mb-3">{(update.error ?? remove.error)?.message}</p>
      )}

      {editMode ? (
        <TaskForm
          detail={detail}
          task={task}
          others={others}
          title={title}
          brief={brief}
          setTitle={setTitle}
          setBrief={setBrief}
          setEditing={setEditing}
          save={save}
          toggleIn={toggleIn}
        />
      ) : (
        <TaskView detail={detail} task={task} />
      )}

      {task.code.length > 0 && (
        <Row label="code" text>
          <CodeList links={task.code} />
        </Row>
      )}

      <Row label="files">
        <Attachments items={task.attachments} canEdit={canEdit} {...files} />
      </Row>

      <TaskActivity detail={detail} taskId={task.id} />
    </ModalFrame>
  );
}

/* Reading: what is set, as text. */
function TaskView({ detail, task }: { detail: BoardDetail; task: Task }) {
  const stage = detail.stages.find((s) => s.id === task.stageId);
  const labels = detail.labels.filter((l) => task.labelIds.includes(l.id));
  const assignees = peopleFirst(detail.members.filter((m) => task.assigneeIds.includes(m.user.id)));
  const parent = task.parentId ? detail.tasks.find((t) => t.id === task.parentId) : undefined;
  const count = progress(detail.tasks, detail.stages, task.id);

  return (
    <>
      <h2 className="text-bright text-lg leading-snug mb-3 break-words">{task.title}</h2>

      {stage && (
        <Row label="stage" text>
          <span className={toneText(stage.tone)}>{stage.name}</span>
        </Row>
      )}

      <Row label="priority" text>
        <span className={PRIORITY_CLASS[task.priority]}>{task.priority}</span>
      </Row>

      {(task.startDate || task.dueDate) && (
        <Row label="dates" text>
          <span className="text-ink">
            {task.startDate && shortDate(task.startDate)}
            {task.startDate && task.dueDate && <span className="text-faint"> → </span>}
            {task.dueDate && (
              <span className={dueClass(task.dueDate, !!task.completedAt)}>
                {!task.startDate && "due "}
                {shortDate(task.dueDate)}
              </span>
            )}
          </span>
        </Row>
      )}

      {labels.length > 0 && (
        <Row label="labels" text>
          <span className="flex flex-wrap gap-x-2">
            {labels.map((l) => (
              <span key={l.id} className={toneText(l.tone)}>
                #{l.name}
              </span>
            ))}
          </span>
        </Row>
      )}

      {assignees.length > 0 && (
        <Row label="assignees" text>
          <span className="flex flex-col gap-1">
            {assignees.map((m) => (
              <span key={m.user.id} className="inline-flex items-center gap-1.5 text-ink">
                <Avatar user={m.user} size={16} />
                {m.user.handle}
              </span>
            ))}
          </span>
        </Row>
      )}

      {task.level && (
        <Row label="level" text>
          <span className="text-ink">{task.level}</span>
        </Row>
      )}

      {count && (
        <Row label="progress" text>
          <span className={count.total > 0 && count.done === count.total ? "text-green" : "text-ink"}>
            {count.done} of {count.total} done
          </span>
        </Row>
      )}

      {task.parentId && (
        <Row label="parent" text>
          <span className="text-ink">{parent ? `${parent.key} ${parent.title}` : "(deleted)"}</span>
        </Row>
      )}

      {task.dependsOn.length > 0 && (
        <Row label="after" text>
          <span className="flex flex-col gap-0.5">
            {task.dependsOn.map((id) => {
              const dep = detail.tasks.find((t) => t.id === id);
              return (
                <span key={id} className={dep?.completedAt ? "text-green" : "text-ink"}>
                  {dep ? `${dep.key} ${dep.title}` : "(deleted)"}
                </span>
              );
            })}
          </span>
        </Row>
      )}

      {task.reviewFirst && (
        <Row label="merge" text>
          <span className="text-ink">review first: a person merges the PR</span>
        </Row>
      )}

      {task.brief.trim() && (
        <Row label="notes" text>
          <p className="text-ink leading-relaxed whitespace-pre-wrap break-words">{task.brief}</p>
        </Row>
      )}
    </>
  );
}

interface TaskFormProps {
  detail: BoardDetail;
  task: Task;
  others: Task[];
  title: string;
  brief: string;
  setTitle: (title: string) => void;
  setBrief: (brief: string) => void;
  setEditing: (field: "title" | "brief" | null) => void;
  save: (patch: TaskPatch) => void;
  toggleIn: (list: string[], id: string) => string[];
}

/* Editing: every field as a control, each saving on its own. */
function TaskForm({ detail, task, others, title, brief, setTitle, setBrief, setEditing, save, toggleIn }: TaskFormProps) {
  return (
    <>
      <textarea
        value={title}
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
        <select className={field} value={task.priority} onChange={(e) => save({ priority: e.target.value as Task["priority"] })}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Row>

      <Row label="dates">
        <DateFields
          start={task.startDate}
          due={task.dueDate}
          onChange={({ start, due }) =>
            save({ ...(start !== undefined ? { startDate: start } : {}), ...(due !== undefined ? { dueDate: due } : {}) })
          }
        />
      </Row>

      <Row label="labels">
        <LabelPicker detail={detail} task={task} canEdit onChange={(labelIds) => save({ labelIds })} />
      </Row>

      {detail.members.length > 1 && (
        <Row label="assignees">
          <div className="flex flex-col gap-1 pt-1.5">
            {peopleFirst(detail.members).map((m) => (
              <Checkbox
                key={m.user.id}
                checked={task.assigneeIds.includes(m.user.id)}
                onChange={() => save({ assigneeIds: toggleIn(task.assigneeIds, m.user.id) })}
                label={
                  <span className="inline-flex items-center gap-1.5 text-ink">
                    <Avatar user={m.user} size={16} />
                    {m.user.handle}
                  </span>
                }
                size={15}
              />
            ))}
          </div>
        </Row>
      )}

      <Row label="level">
        <select className={field} value={task.level} onChange={(e) => save({ level: e.target.value as Task["level"] })}>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </Row>
      <Row label="parent">
        <select className={`${field} w-full`} value={task.parentId ?? ""} onChange={(e) => save({ parentId: e.target.value || null })}>
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
                <button onClick={() => save({ dependsOn: task.dependsOn.filter((x) => x !== id) })} className="tap text-muted hover:text-red" aria-label="Remove dependency">
                  ×
                </button>
              </span>
            );
          })}
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
        </div>
      </Row>
      {/* Only where there is code: a board with a GitHub repo. */}
      {(detail.repos.length > 0 || task.reviewFirst) && (
        <Row label="merge">
          <div className="pt-1.5">
            <Checkbox
              checked={task.reviewFirst}
              onChange={(next) => save({ reviewFirst: next })}
              label={<span className="text-ink">review first: the agent opens the PR, a person merges it</span>}
              size={15}
            />
          </div>
        </Row>
      )}

      <Row label="notes">
        <textarea
          value={brief}
          placeholder="details, links, whatever"
          onFocus={() => setEditing("brief")}
          onChange={(e) => setBrief(e.target.value)}
          onBlur={() => {
            setEditing(null);
            if (brief !== task.brief) save({ brief });
          }}
          className={`${field} w-full min-h-28 resize-y leading-relaxed`}
        />
      </Row>
    </>
  );
}
