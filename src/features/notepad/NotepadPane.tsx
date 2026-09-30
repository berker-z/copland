/* ============================================================================
   The notepad pane, from nord-dash's NotepadWidget: one textarea, several
   notes behind it. Saving is automatic (useNotepad); the save icon's colour
   says where it stands: yellow unsaved, blue saving, green saved.
   ========================================================================== */

import { useEffect, useRef, useState } from "react";
import { FilePlus, FolderOpen, Pencil, Save, Trash2 } from "lucide-react";
import { NOTE_NAME_MAX, type Note } from "@/domain/panes";
import { ModalFrame } from "@/ui/ModalFrame";
import { WidgetFrame } from "@/ui/WidgetFrame";
import { useNotepad, type SaveState } from "./useNotepad";

const SNIPPET_LENGTH = 40;

const SAVE_COLOR: Record<SaveState, string> = {
  dirty: "text-yellow",
  saving: "text-blue",
  saved: "text-green",
};

const SAVE_TITLE: Record<SaveState, string> = {
  dirty: "Unsaved: saves when you stop typing",
  saving: "Saving…",
  saved: "Saved",
};

function snippet(note: Note): string {
  const trimmed = note.content.trim().replace(/\s+/g, " ");
  if (!trimmed) return "[empty]";
  return trimmed.length <= SNIPPET_LENGTH ? trimmed : `${trimmed.slice(0, SNIPPET_LENGTH)}…`;
}

const iconButton = "p-1.5 text-muted hover:text-accent transition-colors";

export function NotepadPane() {
  const pad = useNotepad();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  /* Grow with the text instead of scrolling inside the pane. */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [pad.draft]);

  const finishRename = () => {
    if (renaming !== null) void pad.rename(renaming);
    setRenaming(null);
  };

  const confirmDelete = (note: Note) => {
    if (window.confirm(`Delete "${note.name}"? This cannot be undone.`)) void pad.remove(note.id);
  };

  if (pad.isLoading) {
    return (
      <WidgetFrame title="/notepad">
        <p className="text-muted animate-pulse">loading…</p>
      </WidgetFrame>
    );
  }

  return (
    <WidgetFrame title="/notepad" meta={pad.notes.length > 1 ? `${pad.notes.length}` : undefined}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {renaming !== null ? (
            <input
              autoFocus
              className="flex-1 min-w-0 bg-raised border border-faint px-2 py-1 text-ink focus:outline-none focus:border-accent"
              value={renaming}
              maxLength={NOTE_NAME_MAX}
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={finishRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") finishRename();
                if (e.key === "Escape") setRenaming(null);
              }}
              aria-label="Note name"
            />
          ) : (
            <button
              onClick={() => setRenaming(pad.name)}
              className="text-muted text-xs uppercase tracking-[0.12em] truncate hover:text-accent transition-colors text-left"
              title="Rename"
            >
              {pad.name}
              {!pad.note && <span className="text-faint normal-case tracking-normal"> · new</span>}
            </button>
          )}
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <button onClick={() => void pad.startNew()} className={iconButton} title="New note">
              <FilePlus size={16} />
            </button>
            <button onClick={() => setPickerOpen(true)} className={iconButton} title="Open note">
              <FolderOpen size={16} />
            </button>
            <button onClick={() => setRenaming(pad.name)} className={iconButton} title="Rename">
              <Pencil size={16} />
            </button>
            <button
              onClick={() => void pad.flush()}
              className={`p-1.5 hover:text-accent transition-colors ${SAVE_COLOR[pad.saveState]}`}
              title={SAVE_TITLE[pad.saveState]}
            >
              <Save size={16} />
            </button>
          </div>
        </div>

        <textarea
          ref={textareaRef}
          value={pad.draft}
          onChange={(e) => pad.setDraft(e.target.value)}
          onBlur={() => void pad.flush()}
          placeholder="Write here..."
          className="w-full bg-raised border border-faint px-3 py-2.5 focus:outline-none focus:border-accent text-ink placeholder-muted leading-relaxed resize-none"
          style={{ minHeight: "10.5rem" }}
        />

        {(pad.error ?? pad.loadError) && (
          <p className="px-3 py-2 text-sm text-red border border-red/60 bg-red/10">
            ! NOTE_SYNC_FAILED: {pad.error ?? pad.loadError?.message}
          </p>
        )}
      </div>

      {pickerOpen && (
        <ModalFrame title="/notepad/load" onClose={() => setPickerOpen(false)} size="sm">
          <div className="flex flex-col">
            {pad.notes.length === 0 && <div className="text-muted text-xs text-center py-4">No notes yet.</div>}
            {pad.notes.map((note) => {
              const active = note.id === pad.note?.id;
              return (
                <div
                  key={note.id}
                  className={`group flex items-center gap-3 px-3 py-2 border-b border-divider last:border-b-0 ${
                    active ? "bg-raised" : "hover:bg-raised"
                  }`}
                >
                  <button
                    onClick={() => {
                      setPickerOpen(false);
                      void pad.select(note.id);
                    }}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className={`text-sm truncate ${active ? "text-accent" : "text-ink"}`}>{note.name}</div>
                    <div className="text-xs text-muted truncate">{snippet(note)}</div>
                  </button>
                  <button
                    onClick={() => confirmDelete(note)}
                    className="md:opacity-0 md:group-hover:opacity-100 text-red hover:bg-surface p-1.5 transition-all"
                    title="Delete note"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}
          </div>
        </ModalFrame>
      )}
    </WidgetFrame>
  );
}
