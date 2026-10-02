/* ============================================================================
   A new task with everything filled in up front.
   ----------------------------------------------------------------------------
   The "+ add" line at the bottom of a column is for a title and nothing
   else. This is the other door: the whole form before the task exists. The
   start date is already today, the due date is a tap away (+1d, +3d, +1w).

   Files and links can go in before the task exists. A file uploads the
   moment it is dropped (so a big one is not waited on at "create"), and the
   form holds its key; links are held as typed. When the task is created,
   each is attached to it in order. An upload that is never attached (the
   form was closed) stays unreachable to anyone but its uploader.
   ========================================================================== */

import { useState, type ReactNode } from "react";
import { Avatar, peopleFirst } from "@/ui/Avatar";
import { useQueryClient } from "@tanstack/react-query";
import { defaultStage } from "@/domain/tasks";
import { PRIORITIES, type Attachment, type BoardDetail, type Priority } from "@/domain/types";
import { send } from "@/lib/api";
import { KEYS } from "@/lib/queries";
import { useCreateTask } from "@/lib/tasks";
import { uploadFile } from "@/lib/uploads";
import { Checkbox } from "@/ui/Checkbox";
import { FormActions } from "@/ui/FormActions";
import { ModalFrame } from "@/ui/ModalFrame";
import { todayLocal, toneText } from "@/ui/tone";
import { Attachments } from "./Attachments";
import { DateFields } from "./DateFields";

const field = "max-w-full bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent";

/* Label beside the field from sm up; above it on a phone, where 6.5rem of
   label column leaves the field too little room. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-1 sm:gap-3 py-1.5">
      <span className="text-label sm:pt-2">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

interface NewTaskModalProps {
  detail: BoardDetail;
  /** The column it was opened from; the board's default stage (the first todo) otherwise. */
  stageId?: string;
  onClose: () => void;
  /** Called with the new task's id, e.g. to open it. */
  onCreated?: (taskId: string) => void;
}

export function NewTaskModal({ detail, stageId, onClose, onCreated }: NewTaskModalProps) {
  const queryClient = useQueryClient();
  const create = useCreateTask(detail.board.id);
  const [title, setTitle] = useState("");
  const [stage, setStage] = useState(stageId ?? defaultStage(detail.stages)?.id ?? "");
  const [priority, setPriority] = useState<Priority>("normal");
  const [start, setStart] = useState<string | null>(todayLocal());
  const [due, setDue] = useState<string | null>(null);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [brief, setBrief] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const pendingItem = (item: Omit<Attachment, "id" | "createdAt">): Attachment => ({
    ...item,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });

  const onFiles = async (files: File[]) => {
    setUploading((n) => n + 1);
    setError(null);
    try {
      for (const file of files) {
        const up = await uploadFile(file);
        setPending((p) => [...p, pendingItem({ name: up.name, type: up.type, size: up.size, kind: up.kind, key: up.key, url: null })]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not upload that");
    } finally {
      setUploading((n) => n - 1);
    }
  };

  const submit = async () => {
    const name = title.trim();
    if (!name || saving || uploading > 0) return;
    setSaving(true);
    setError(null);
    try {
      const task = await create.mutateAsync({
        title: name,
        stageId: stage,
        priority,
        startDate: start,
        dueDate: due,
        brief,
        assigneeIds: assignees,
        labelIds: labels,
      });
      for (const item of pending) {
        await send(
          "POST",
          `/tasks/${task.id}/attachments`,
          item.kind === "link" ? { url: item.url, name: item.name } : { key: item.key },
        );
      }
      if (pending.length) void queryClient.invalidateQueries({ queryKey: KEYS.board(detail.board.id) });
      onClose();
      onCreated?.(task.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the task");
      setSaving(false);
    }
  };

  return (
    <ModalFrame
      title={`new task · ${detail.board.name}`}
      onClose={onClose}
      size="lg"
    >
      <div
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), void submit())}
          placeholder="what needs doing"
          maxLength={200}
          className="w-full bg-transparent text-bright text-lg px-1 -mx-1 mb-3 placeholder:text-faint focus:outline-none focus:bg-raised"
        />

        <Row label="stage">
          <div className="flex flex-wrap gap-1.5">
            {detail.stages.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStage(s.id)}
                className={`px-2 py-1 border transition-colors ${
                  s.id === stage ? `border-accent ${toneText(s.tone)}` : "border-faint text-muted hover:text-ink"
                }`}
              >
                {s.name}
              </button>
            ))}
          </div>
        </Row>

        <Row label="priority">
          <select className={field} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Row>

        <Row label="dates">
          <DateFields
            start={start}
            due={due}
            onChange={(d) => {
              if (d.start !== undefined) setStart(d.start);
              if (d.due !== undefined) setDue(d.due);
            }}
          />
        </Row>

        {detail.members.length > 1 && (
          <Row label="assignees">
            <div className="flex flex-col gap-1 pt-1.5">
              {peopleFirst(detail.members).map((m) => (
                <Checkbox
                  key={m.user.id}
                  checked={assignees.includes(m.user.id)}
                  onChange={() => setAssignees(toggle(assignees, m.user.id))}
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

        {detail.labels.length > 0 && (
          <Row label="labels">
            <div className="flex flex-wrap gap-1.5 pt-1">
              {detail.labels.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setLabels(toggle(labels, l.id))}
                  className={`px-1.5 py-0.5 border text-sm transition-colors ${
                    labels.includes(l.id) ? `border-current ${toneText(l.tone)}` : "border-faint text-faint hover:text-muted"
                  }`}
                >
                  #{l.name}
                </button>
              ))}
            </div>
          </Row>
        )}

        <Row label="notes">
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="details, links, whatever"
            className={`${field} w-full min-h-24 resize-y leading-relaxed`}
          />
        </Row>

        <Row label="files">
          <Attachments
            items={pending}
            canEdit
            busy={uploading > 0}
            error={null}
            onFiles={(files) => void onFiles(files)}
            onLink={(url, name) => {
              let host = url;
              try {
                host = new URL(url).hostname.replace(/^www\./, "");
              } catch {
                /* the server checks it properly on create */
              }
              setPending((p) => [...p, pendingItem({ name: name || host, type: "", size: 0, kind: "link", key: null, url })]);
            }}
            onRemove={(item) => setPending((p) => p.filter((x) => x.id !== item.id))}
          />
        </Row>

        <FormActions error={error} onCancel={onClose} hint={<span className="hidden sm:inline">ctrl+enter creates</span>}>
          <button
            onClick={() => void submit()}
            disabled={!title.trim() || saving || uploading > 0}
            className="px-3 py-1.5 pointer-coarse:py-2.5 border border-faint text-ink hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {saving ? "creating…" : uploading > 0 ? "uploading…" : "create"}
          </button>
        </FormActions>
      </div>
    </ModalFrame>
  );
}
