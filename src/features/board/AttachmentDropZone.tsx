/* ============================================================================
   Where files land: drop them, paste them, or pick them. Ported from the
   work tracker.
   ----------------------------------------------------------------------------
   A dashed strip. Drag files over it and it lights up; drop and they upload.
   Paste a screenshot and the same happens, and not only with the strip
   focused: while it is mounted it listens for paste on the document, so
   Ctrl+V anywhere on the open task attaches the image, unless you are typing
   in a text field, which then gets the paste as usual.

   A pasted URL (no files, text that parses as http(s)) goes to onLink, so a
   Drive link goes in the same way a screenshot does. On a phone there is
   nothing to drag and no Ctrl+V; a tap opens the picker, and image/* in
   `accept` makes the phone offer the camera and photos too.
   ========================================================================== */

import { useEffect, useRef, useState, type DragEvent } from "react";
import { Download, Hourglass, Paperclip } from "lucide-react";

const ACCEPT = "image/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.csv,.md,.zip,video/mp4,video/quicktime,video/webm";

function isTextTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** A pasted screenshot arrives as "image.png"; give it a name worth keeping. */
export function nameFor(file: File): File {
  if (file.name && file.name !== "image.png" && file.name !== "image.jpeg") return file;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  return new File([file], `screenshot ${stamp}.${ext}`, { type: file.type });
}

/** The clipboard text as a URL, when it is one and nothing else. */
function urlIn(data: DataTransfer | null): string | null {
  const text = data?.getData("text/plain").trim() ?? "";
  if (!text || /\s/.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

interface AttachmentDropZoneProps {
  onFiles: (files: File[]) => void;
  /** A pasted http(s) URL. Omit and URL pastes are ignored. */
  onLink?: (url: string) => void;
  busy?: boolean;
}

export function AttachmentDropZone({ onFiles, onLink, busy = false }: AttachmentDropZoneProps) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  /* The latest handlers, so the document listener never calls a stale one. */
  const handlers = useRef({ onFiles, onLink });
  handlers.current = { onFiles, onLink };

  const take = (list: FileList | File[] | null | undefined) => {
    if (!list) return;
    const files = [...list].map(nameFor);
    if (files.length) handlers.current.onFiles(files);
  };

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isTextTarget(event.target)) return;
      const files = event.clipboardData?.files;
      if (files?.length) {
        event.preventDefault();
        take(files);
        return;
      }
      const url = handlers.current.onLink ? urlIn(event.clipboardData) : null;
      if (url) {
        event.preventDefault();
        handlers.current.onLink?.(url);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  /* dragenter/leave fire for every child; counting keeps the highlight steady. */
  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    depth.current += 1;
    setOver(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    depth.current -= 1;
    if (depth.current <= 0) {
      depth.current = 0;
      setOver(false);
    }
  };

  const Icon = busy ? Hourglass : over ? Download : Paperclip;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Add files: drag, paste or pick"
      onClick={() => input.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          input.current?.click();
        }
      }}
      onDragEnter={onDragEnter}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        take(e.dataTransfer.files);
      }}
      className={`flex items-center justify-center gap-2 px-3 py-2 border border-dashed text-sm cursor-pointer transition-colors ${
        over ? "border-accent bg-accent/10 text-accent" : "border-faint text-muted hover:border-muted hover:text-ink"
      }`}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
      />
      <Icon size={14} />
      {busy ? (
        <span>uploading…</span>
      ) : (
        <>
          <span className="hidden pointer-coarse:inline">tap to add files or photos</span>
          <span className="pointer-coarse:hidden">
            drag, paste or pick files{onLink && <span className="text-faint"> · links paste too</span>}
          </span>
        </>
      )}
    </div>
  );
}
