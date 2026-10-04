/* ============================================================================
   Images on comments (COPL-118, the browser half of COPL-117).
   ----------------------------------------------------------------------------
   In the thread, a comment's images are a row of thumbnails under its text
   that open full size in the same viewer as the task's own images.

   In the comment box, an image pasted into the text or dropped on the box
   uploads at once (POST /api/uploads) and waits as a thumbnail with an ×.
   Posting sends the keys with the text. Only the images a comment takes, and
   only as many as it holds (domain/commentImages.ts): the rest are turned
   away before they upload, with the reason under the box. A removed image's
   upload stays unattached, as a removed file in the new-task form does.
   ========================================================================== */

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Hourglass, ImagePlus, X } from "lucide-react";
import type { CommentAttachment } from "@/domain/types";
import { admitCommentImages, COMMENT_IMAGE_TYPES, COMMENT_IMAGES_MAX } from "@/domain/commentImages";
import { formatBytes, uploadFile } from "@/lib/uploads";
import { nameFor } from "./AttachmentDropZone";
import { Viewer, type Viewable } from "./Attachments";

const viewable = (image: CommentAttachment): Viewable => ({
  name: image.name,
  type: image.type,
  size: image.size,
  image: true,
  src: image.url,
  download: `${image.url}?download=1`,
});

/** A comment's images in the thread. */
export function CommentImages({ images }: { images: CommentAttachment[] }) {
  const [viewing, setViewing] = useState<CommentAttachment | null>(null);
  if (images.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {images.map((image) => (
        <button
          key={image.id}
          onClick={() => setViewing(image)}
          className="block cursor-zoom-in border border-faint hover:border-accent"
          aria-label={`${image.name}, enlarge`}
          title={`${image.name} · ${formatBytes(image.size)}`}
        >
          <img src={image.url} alt={image.name} loading="lazy" className="block h-24 w-auto max-w-40 object-cover" />
        </button>
      ))}
      {viewing && <Viewer file={viewable(viewing)} onClose={() => setViewing(null)} />}
    </div>
  );
}

interface Pending {
  id: string;
  name: string;
  /** An object URL for the thumbnail, so it shows before the upload ends. */
  preview: string;
  /** The upload's key once it is up. */
  key: string | null;
}

/**
 * The comment box's images: what is waiting to be posted, and the handlers
 * that feed it. Files go up one at a time, in order.
 */
export function useCommentImages() {
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  /* Every preview still alive, so leaving the task frees them all. */
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const alive = previews.current;
    return () => alive.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const drop = (ids: string[]) =>
    setPending((list) => {
      for (const item of list) {
        if (!ids.includes(item.id)) continue;
        URL.revokeObjectURL(item.preview);
        previews.current.delete(item.preview);
      }
      return list.filter((item) => !ids.includes(item.id));
    });

  const add = async (files: File[]) => {
    const { take, refused } = admitCommentImages(pending.length, files.map(nameFor));
    setError(refused);
    const items = take.map((file) => {
      const preview = URL.createObjectURL(file);
      previews.current.add(preview);
      return { file, item: { id: crypto.randomUUID(), name: file.name, preview, key: null } satisfies Pending };
    });
    setPending((list) => [...list, ...items.map((i) => i.item)]);
    for (const { file, item } of items) {
      try {
        const { key } = await uploadFile(file);
        /* Removed while it was going up: nothing to fill in. */
        setPending((list) => list.map((p) => (p.id === item.id ? { ...p, key } : p)));
      } catch (e) {
        drop([item.id]);
        setError(e instanceof Error ? e.message : `Could not upload “${file.name}”`);
      }
    }
  };

  return {
    pending,
    error,
    uploading: pending.some((p) => p.key === null),
    keys: pending.flatMap((p) => (p.key ? [p.key] : [])),
    remove: (id: string) => {
      setError(null);
      drop([id]);
    },
    /** After a post: the images are the comment's now. */
    clear: () => {
      setError(null);
      drop(pending.map((p) => p.id));
    },
    /** For the textarea: a pasted image comes here instead of into the text. */
    onPaste: (event: ClipboardEvent) => {
      const files = [...event.clipboardData.files];
      if (files.length === 0) return;
      event.preventDefault();
      void add(files);
    },
    onFiles: (files: File[]) => void add(files),
  };
}

/** Drop handling for the whole comment box, and whether something is over it. */
export function useDropTarget(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  return {
    over,
    handlers: {
      onDragEnter: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        onFiles([...e.dataTransfer.files]);
      },
    },
  };
}

/** The waiting images under the comment box, each with its ×. */
export function PendingImages({ pending, onRemove }: { pending: Pending[]; onRemove: (id: string) => void }) {
  if (pending.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {pending.map((p) => (
        <span key={p.id} className="relative block border border-faint">
          <img src={p.preview} alt={p.name} className={`block h-16 w-auto max-w-28 object-cover ${p.key ? "" : "opacity-50"}`} />
          {!p.key && <Hourglass size={14} className="absolute left-1 top-1 text-muted" aria-label="uploading" />}
          <button
            type="button"
            onClick={() => onRemove(p.id)}
            className="tap absolute right-0.5 top-0.5 bg-surface/90 p-0.5 text-muted hover:text-red"
            aria-label={`Remove ${p.name}`}
          >
            <X size={13} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** A picker for where there is no paste or drag: a phone. */
export function PickImages({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={COMMENT_IMAGE_TYPES.join(",")}
        className="hidden"
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled}
        title={`Add images (paste or drop works too, up to ${COMMENT_IMAGES_MAX})`}
        className="tap flex items-center gap-1.5 px-2 py-1 pointer-coarse:py-2.5 text-sm text-muted hover:text-accent disabled:opacity-50"
      >
        <ImagePlus size={14} /> image
      </button>
    </>
  );
}
