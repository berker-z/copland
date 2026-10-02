/* ============================================================================
   A board's notes and docs (the book icon in the board header), for
   everyone on the board: viewers read, owners and editors write.
   ----------------------------------------------------------------------------
   Notes are the board's rules for working on it, plain markdown shown as
   written, and the MCP guide quotes them to every assistant on the board.
   Docs are reference files: they go up through the same upload as task
   attachments and are listed here by name, with a description an editor
   can give. A text doc opens here as text; anything else opens (or
   downloads) through the attachment route.

   Not in board settings: that is the owners' gear, and editors write these.
   ========================================================================== */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, File, FileText, Pencil, X } from "lucide-react";
import { MAX_BOARD_NOTES, type BoardDetail, type BoardDoc, type BoardDocContent } from "@/domain/types";
import { api, send } from "@/lib/api";
import { KEYS } from "@/lib/queries";
import { attachmentUrl, formatBytes, uploadFile } from "@/lib/uploads";
import { ModalFrame } from "@/ui/ModalFrame";
import { AttachmentDropZone } from "./AttachmentDropZone";

const input = "bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent";
const button = "px-3 py-1.5 pointer-coarse:py-2.5 border border-faint text-ink hover:border-accent hover:text-accent transition-colors disabled:opacity-50";
const TEXT_TYPES = ["text/plain", "text/markdown", "text/csv"];

const isText = (doc: BoardDoc) => TEXT_TYPES.includes(doc.type);

function Notes({ detail, canEdit }: { detail: BoardDetail; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(detail.notes);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(detail.notes);
  }, [detail.notes, editing]);
  const save = useMutation({
    mutationFn: (notes: string) => send("PUT", `/boards/${detail.board.id}/notes`, { notes }),
    onSuccess: () => setEditing(false),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEYS.board(detail.board.id) }),
  });

  if (!editing) {
    return (
      <div className="flex items-start gap-2">
        {detail.notes ? (
          <p className="flex-1 text-ink leading-relaxed whitespace-pre-wrap break-words">{detail.notes}</p>
        ) : (
          <p className="flex-1 text-faint">
            {canEdit ? "No notes yet. Write the rules for working on this board; assistants read them first." : "No notes."}
          </p>
        )}
        {canEdit && (
          <button onClick={() => setEditing(true)} className="tap p-1 text-muted hover:text-accent" title="Edit notes">
            <Pencil size={14} />
          </button>
        )}
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(draft);
      }}
    >
      <textarea
        autoFocus
        className={`${input} min-h-36 leading-relaxed`}
        value={draft}
        maxLength={MAX_BOARD_NOTES}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="e.g. Branch per task, named after its key. Ask @sam before touching billing."
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {save.error ? (
          <span className="mr-auto text-xs text-red">{save.error.message}</span>
        ) : (
          <span className="mr-auto text-xs text-faint tabular-nums">
            {draft.length}/{MAX_BOARD_NOTES} · markdown
          </span>
        )}
        <button type="button" onClick={() => setEditing(false)} className="px-3 py-1.5 pointer-coarse:py-2.5 text-muted hover:text-ink">
          cancel
        </button>
        <button type="submit" className={button} disabled={save.isPending || draft.trim() === detail.notes}>
          save
        </button>
      </div>
    </form>
  );
}

/** A text doc's contents, in place of the list. */
function DocText({ boardId, doc, onBack }: { boardId: string; doc: BoardDoc; onBack: () => void }) {
  const content = useQuery({
    queryKey: [...KEYS.board(boardId), "doc", doc.id, doc.updatedAt],
    queryFn: () => api<BoardDocContent>(`/boards/${boardId}/docs/${doc.id}`),
  });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="tap p-1 text-muted hover:text-accent" title="Back to the list">
          <ArrowLeft size={14} />
        </button>
        <span className="flex-1 truncate text-bright">{doc.name}</span>
        <a href={attachmentUrl(doc.key, true)} download={doc.name} className="tap p-1 text-muted hover:text-accent" title="Download">
          <Download size={14} />
        </a>
      </div>
      {content.isPending && <p className="text-muted animate-pulse">loading…</p>}
      {content.error && <p className="text-red text-xs">{content.error.message}</p>}
      {content.data && (
        <>
          <pre className="whitespace-pre-wrap break-words bg-raised border border-faint p-3 text-sm text-ink max-h-[60vh] overflow-auto">
            {content.data.text}
          </pre>
          {content.data.truncated && <p className="text-xs text-yellow">Cut off at 256 KB; download it for the rest.</p>}
        </>
      )}
    </div>
  );
}

function DocRow({ boardId, doc, canEdit, onOpen }: { boardId: string; doc: BoardDoc; canEdit: boolean; onOpen: () => void }) {
  const queryClient = useQueryClient();
  const [describing, setDescribing] = useState(false);
  const [about, setAbout] = useState(doc.description);
  const [armed, setArmed] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEYS.board(boardId) });
  const describe = useMutation({
    mutationFn: (description: string) => send("PATCH", `/boards/${boardId}/docs/${doc.id}`, { description }),
    onSuccess: () => setDescribing(false),
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: () => send("DELETE", `/boards/${boardId}/docs/${doc.id}`), onSettled: refresh });
  const summary = doc.description || doc.excerpt;
  const Icon = isText(doc) || doc.type === "application/pdf" ? FileText : File;
  const name = (
    <>
      <Icon size={14} className="shrink-0 text-muted" />
      <span className="truncate text-ink">{doc.name}</span>
    </>
  );

  return (
    <li className="group/doc flex flex-col gap-1 border-b border-divider py-1.5 last:border-b-0">
      <div className="flex items-center gap-2">
        {isText(doc) ? (
          <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-accent">
            {name}
          </button>
        ) : (
          <a href={attachmentUrl(doc.key)} target="_blank" rel="noopener noreferrer" className="flex min-w-0 flex-1 items-center gap-2 hover:text-accent">
            {name}
          </a>
        )}
        <span className="shrink-0 text-xs text-faint tabular-nums">
          {formatBytes(doc.size)} · {doc.updatedAt.slice(0, 10)}
        </span>
        {canEdit && (
          <>
            <button
              onClick={() => setDescribing((v) => !v)}
              className="tap p-1 text-muted hover:text-accent pointer-fine:opacity-0 pointer-fine:group-hover/doc:opacity-100"
              title="Describe"
            >
              <Pencil size={13} />
            </button>
            <button
              onClick={() => (armed ? remove.mutate() : setArmed(true))}
              onBlur={() => setArmed(false)}
              className={`tap flex items-center gap-1 p-1 ${armed ? "text-red" : "text-muted hover:text-red pointer-fine:opacity-0 pointer-fine:group-hover/doc:opacity-100"}`}
              title={armed ? "Click again to delete" : "Delete"}
            >
              <X size={13} />
              {armed && <span className="text-xs">delete?</span>}
            </button>
          </>
        )}
      </div>
      {describing ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            describe.mutate(about.trim());
          }}
        >
          <input
            autoFocus
            className={`${input} flex-1 min-w-0 text-sm`}
            value={about}
            maxLength={200}
            onChange={(e) => setAbout(e.target.value)}
            placeholder="what it is, in a line (shown to assistants)"
          />
          <button type="submit" className={button} disabled={describe.isPending}>
            save
          </button>
        </form>
      ) : (
        summary && <p className="truncate pl-6 text-xs text-muted">{summary}</p>
      )}
      {(describe.error ?? remove.error) && <p className="pl-6 text-xs text-red">{(describe.error ?? remove.error)?.message}</p>}
    </li>
  );
}

function Docs({ detail, canEdit }: { detail: BoardDetail; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const boardId = detail.board.id;
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const open = detail.docs.find((d) => d.id === reading);

  const onFiles = async (files: File[]) => {
    setUploading((n) => n + 1);
    setError(null);
    try {
      for (const file of files) {
        const uploaded = await uploadFile(file);
        await send("POST", `/boards/${boardId}/docs`, { key: uploaded.key });
        void queryClient.invalidateQueries({ queryKey: KEYS.board(boardId) });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add that");
    } finally {
      setUploading((n) => n - 1);
    }
  };

  if (open) return <DocText boardId={boardId} doc={open} onBack={() => setReading(null)} />;
  return (
    <div className="flex flex-col gap-2">
      {canEdit && <AttachmentDropZone onFiles={onFiles} busy={uploading > 0} />}
      {error && <p className="text-red text-xs">{error}</p>}
      {detail.docs.length > 0 ? (
        <ul className="flex flex-col">
          {detail.docs.map((doc) => (
            <DocRow key={doc.id} boardId={boardId} doc={doc} canEdit={canEdit} onOpen={() => setReading(doc.id)} />
          ))}
        </ul>
      ) : (
        <p className="text-faint text-sm">
          {canEdit ? "No docs yet: specs, briefs, style guides. Assistants see the list and read one when asked." : "No docs."}
        </p>
      )}
    </div>
  );
}

export function BoardDocsModal({ detail, onClose }: { detail: BoardDetail; onClose: () => void }) {
  const canEdit = detail.board.role !== "viewer";
  return (
    <ModalFrame title={`${detail.board.key} · notes & docs`} onClose={onClose} size="lg">
      <section className="pb-4 border-b border-divider">
        <h4 className="text-label mb-3">notes</h4>
        <Notes detail={detail} canEdit={canEdit} />
      </section>
      <section className="pt-4">
        <h4 className="text-label mb-3">docs</h4>
        <Docs detail={detail} canEdit={canEdit} />
      </section>
    </ModalFrame>
  );
}
