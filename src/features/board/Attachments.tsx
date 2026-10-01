/* ============================================================================
   Files and links on a task, as a list you can add to. Ported from the work
   tracker's TaskAttachments, restyled in Splits.
   ----------------------------------------------------------------------------
   Images are a thumbnail row that opens the viewer; files and links a list.
   Files come in through the drop zone; a link through the small form, or by
   pasting a URL anywhere on the open task.

   This component only draws and collects. What "add" and "remove" mean is
   the caller's: the task modal writes to the task at once
   (useTaskAttachments below), the new-task form holds them until the task
   exists.
   ========================================================================== */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, File, FileText, Link2, X } from "lucide-react";
import type { Attachment } from "@/domain/types";
import { send } from "@/lib/api";
import { KEYS } from "@/lib/queries";
import { attachmentHref, formatBytes, hostOf, uploadFile } from "@/lib/uploads";
import { AttachmentDropZone } from "./AttachmentDropZone";

const input = "bg-raised border border-faint px-2 py-1 text-ink placeholder:text-faint focus:outline-none focus:border-accent";

/** Full-size look at one image or file. Escape closes this, not the modal under it. */
function Viewer({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="flex max-h-full max-w-[min(92vw,60rem)] flex-col bg-surface border border-faint" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 border-b border-divider px-4 py-2">
          <span className="min-w-0">
            <span className="block truncate text-bright">{attachment.name}</span>
            <span className="block text-xs text-muted">{formatBytes(attachment.size)}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-muted">
            <a href={attachmentHref(attachment, true)} download={attachment.name} className="p-2 hover:text-accent" title="Download">
              <Download size={16} />
            </a>
            <button onClick={onClose} className="tap p-2 hover:text-yellow" title="Close">
              <X size={16} />
            </button>
          </span>
        </header>
        {attachment.kind === "image" ? (
          <img src={attachmentHref(attachment)} alt={attachment.name} className="max-h-[78vh] w-auto object-contain" />
        ) : (
          /* <object> renders PDFs natively where the browser can. */
          <object data={attachmentHref(attachment)} type={attachment.type} className="h-[72vh] w-[min(88vw,48rem)]">
            <p className="p-6 text-muted">This file can't be previewed here. Use the download button.</p>
          </object>
        )}
      </div>
    </div>
  );
}

export interface AttachmentsProps {
  items: Attachment[];
  canEdit: boolean;
  busy: boolean;
  error: string | null;
  onFiles: (files: File[]) => void;
  onLink: (url: string, name: string) => void;
  onRemove: (item: Attachment) => void;
}

export function Attachments({ items, canEdit, busy, error, onFiles, onLink, onRemove }: AttachmentsProps) {
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const images = items.filter((a) => a.kind === "image");
  const others = items.filter((a) => a.kind !== "image");

  const removeButton = (item: Attachment, className: string) =>
    canEdit && (
      <button onClick={() => onRemove(item)} className={`tap text-muted hover:text-red ${className}`} aria-label={`Remove ${item.name}`}>
        <X size={13} />
      </button>
    );

  return (
    <div className="flex flex-col gap-2">
      {canEdit && (
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <AttachmentDropZone onFiles={onFiles} onLink={(u) => onLink(u, "")} busy={busy} />
          </div>
          <button
            type="button"
            onClick={() => setLinking((v) => !v)}
            aria-expanded={linking}
            className="flex items-center gap-1.5 px-2 py-2 text-sm text-muted hover:text-accent"
          >
            <Link2 size={14} /> link
          </button>
        </div>
      )}
      {linking && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!url.trim()) return;
            onLink(url.trim(), name.trim());
            setUrl("");
            setName("");
            setLinking(false);
          }}
        >
          <input autoFocus className={`${input} flex-[2] min-w-0`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          <input className={`${input} flex-1 min-w-0`} value={name} onChange={(e) => setName(e.target.value)} placeholder="name (optional)" />
          <button type="submit" className="px-3 py-1 pointer-coarse:py-2.5 border border-faint text-ink hover:border-accent hover:text-accent">
            add
          </button>
        </form>
      )}
      {error && <p className="text-red text-xs">{error}</p>}

      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((file) => (
            <span key={file.id} className="group/img relative">
              <button onClick={() => setViewing(file)} className="block cursor-zoom-in border border-faint" aria-label={`${file.name}, enlarge`}>
                <img src={attachmentHref(file)} alt={file.name} className="block h-20 w-auto max-w-36 object-cover" />
              </button>
              {removeButton(file, "absolute right-0.5 top-0.5 bg-surface/90 p-0.5 pointer-fine:opacity-0 pointer-fine:group-hover/img:opacity-100")}
            </span>
          ))}
        </div>
      )}

      {others.length > 0 && (
        <ul className="flex flex-col">
          {others.map((file) => (
            <li key={file.id} className="flex items-center gap-2 border-b border-divider last:border-b-0">
              {file.kind === "link" ? (
                <a href={attachmentHref(file)} target="_blank" rel="noopener noreferrer" className="flex min-w-0 flex-1 items-center gap-2 py-1.5 hover:text-accent">
                  <Link2 size={14} className="shrink-0 text-muted" />
                  <span className="truncate text-ink">{file.name}</span>
                  <span className="shrink-0 truncate text-xs text-faint max-w-40">{hostOf(file.url)}</span>
                </a>
              ) : (
                <button onClick={() => setViewing(file)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left hover:text-accent">
                  {file.type.includes("pdf") ? <FileText size={14} className="shrink-0 text-muted" /> : <File size={14} className="shrink-0 text-muted" />}
                  <span className="truncate text-ink">{file.name}</span>
                  <span className="shrink-0 text-xs text-faint tabular-nums">{formatBytes(file.size)}</span>
                </button>
              )}
              {removeButton(file, "p-1")}
            </li>
          ))}
        </ul>
      )}

      {items.length === 0 && !canEdit && <p className="text-faint text-sm">no files or links</p>}
      {viewing && <Viewer attachment={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/**
 * Attachments that write to an existing task as they are added. Files go up
 * one at a time, in order, so a batch of screenshots lands in the order it
 * was dropped; the counter keeps the zone busy across overlapping drops.
 */
export function useTaskAttachments(boardId: string, taskId: string) {
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEYS.board(boardId) });
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : "Could not add that");

  return {
    busy: uploading > 0,
    error,
    onFiles: async (files: File[]) => {
      setUploading((n) => n + 1);
      setError(null);
      try {
        for (const file of files) {
          const uploaded = await uploadFile(file);
          await send("POST", `/tasks/${taskId}/attachments`, { key: uploaded.key });
          refresh();
        }
      } catch (e) {
        fail(e);
      } finally {
        setUploading((n) => n - 1);
      }
    },
    onLink: (url: string, name: string) => {
      setError(null);
      send("POST", `/tasks/${taskId}/attachments`, { url, name }).then(refresh, fail);
    },
    onRemove: (item: Attachment) => {
      setError(null);
      send("DELETE", `/tasks/${taskId}/attachments/${item.id}`).then(refresh, fail);
    },
  };
}
