/* ============================================================================
   The lower half of a task: comments, and what happened to it.
   ----------------------------------------------------------------------------
   Comments are plain text with line breaks kept. Ctrl/Cmd+Enter posts.
   History reads the event log; field changes are spelled out in words
   rather than dumped as JSON, since the log is for people.
   ========================================================================== */

import { useState } from "react";
import { Avatar } from "@/ui/Avatar";
import type { BoardDetail, TaskEvent } from "@/domain/types";
import { useCommentEdits, useComments, useTaskEvents } from "@/lib/boardEdits";
import { useMe } from "@/lib/queries";

function when(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

const FIELD_NAMES: Record<string, string> = {
  title: "title",
  brief: "notes",
  priority: "priority",
  startDate: "start date",
  dueDate: "due date",
  stageId: "stage",
  rank: "position",
  completedAt: "completion",
  assigneeIds: "assignees",
  labelIds: "labels",
  parentId: "parent",
  level: "level",
  dependsOn: "dependencies",
};

function describe(event: TaskEvent, detail: BoardDetail): string {
  switch (event.kind) {
    case "task.created":
      return "created it";
    case "task.deleted":
      return "deleted it";
    case "comment.added":
      return "commented";
    case "task.updated": {
      const after = event.after ?? {};
      if (typeof after.stageId === "string") {
        const stage = detail.stages.find((s) => s.id === after.stageId);
        return `moved it to ${stage?.name ?? "another stage"}`;
      }
      const fields = Object.keys(after)
        .filter((k) => k !== "rank" && k !== "completedAt")
        .map((k) => FIELD_NAMES[k] ?? k);
      if (fields.length === 0) return "reordered it";
      if (fields.length === 1 && fields[0] === "priority") return `set priority to ${String(after.priority)}`;
      return `changed ${fields.join(", ")}`;
    }
    default:
      return event.kind;
  }
}

export function TaskActivity({ detail, taskId }: { detail: BoardDetail; taskId: string }) {
  const [tab, setTab] = useState<"comments" | "history">("comments");
  const me = useMe();
  const comments = useComments(taskId);
  const events = useTaskEvents(taskId, tab === "history");
  const edits = useCommentEdits(detail.board.id, taskId);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const isOwner = detail.board.role === "owner";

  const post = () => {
    const text = draft.trim();
    if (!text) return;
    edits.add.mutate(text, { onSuccess: () => setDraft("") });
  };

  const tabButton = (id: typeof tab, label: string) => (
    <button
      onClick={() => setTab(id)}
      className={`text-label !tracking-widest transition-colors ${tab === id ? "!text-accent" : "hover:!text-ink"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="mt-4 pt-3 border-t border-divider">
      <div className="flex gap-4 mb-3">
        {tabButton("comments", `comments${comments.data?.length ? ` ${comments.data.length}` : ""}`)}
        {tabButton("history", "history")}
      </div>

      {tab === "comments" && (
        <>
          {comments.data?.map((c) => (
            <div key={c.id} className="group/comment mb-3">
              <div className="flex items-baseline gap-2 text-xs">
                <Avatar user={{ handle: c.authorHandle, avatar: c.authorAvatar }} size={16} className="self-center" />
                <span className="text-bright">{c.authorHandle}</span>
                <span className="text-faint">
                  {when(c.createdAt)}
                  {c.editedAt && " · edited"}
                </span>
                <span className="flex-1" />
                {c.authorId === me.data?.user.id && editing?.id !== c.id && (
                  <button onClick={() => setEditing({ id: c.id, text: c.text })} className="tap text-faint hover:text-accent pointer-fine:opacity-0 pointer-fine:group-hover/comment:opacity-100">
                    edit
                  </button>
                )}
                {(c.authorId === me.data?.user.id || isOwner) && (
                  <button onClick={() => edits.remove.mutate(c.id)} className="tap text-faint hover:text-red pointer-fine:opacity-0 pointer-fine:group-hover/comment:opacity-100">
                    delete
                  </button>
                )}
              </div>
              {editing?.id === c.id ? (
                <form
                  className="mt-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (editing.text.trim()) edits.edit.mutate(editing, { onSuccess: () => setEditing(null) });
                  }}
                >
                  <textarea
                    autoFocus
                    value={editing.text}
                    onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditing(null);
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
                    }}
                    className="w-full bg-raised border border-faint px-2 py-1.5 text-ink focus:outline-none focus:border-accent [field-sizing:content]"
                  />
                </form>
              ) : (
                <p className="text-ink whitespace-pre-wrap break-words mt-0.5">{c.text}</p>
              )}
            </div>
          ))}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), post())}
            placeholder="write a comment (ctrl+enter to post)"
            className="w-full min-h-16 bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent [field-sizing:content]"
          />
          <div className="flex justify-end mt-1.5">
            <button
              onClick={post}
              disabled={!draft.trim() || edits.add.isPending}
              className="px-3 py-1 pointer-coarse:py-2.5 border border-faint text-ink hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
            >
              post
            </button>
          </div>
          {(edits.add.error ?? edits.edit.error ?? edits.remove.error) && (
            <p className="text-red text-xs">{(edits.add.error ?? edits.edit.error ?? edits.remove.error)?.message}</p>
          )}
        </>
      )}

      {tab === "history" && (
        <ul className="text-sm">
          {events.isPending && <li className="text-muted animate-pulse">loading…</li>}
          {events.data?.map((e) => (
            <li key={e.id} className="flex gap-2 py-0.5">
              <span className="text-faint w-14 shrink-0">{when(e.createdAt)}</span>
              <span className="text-muted">
                <span className="text-ink">{e.actorHandle ?? "someone"}</span>
                {e.via && <span className="text-faint"> via {e.via}</span>} {describe(e, detail)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
