/* ============================================================================
   The notepad's draft: what is in the textarea, which saved note it came
   from, and getting it back to the server.
   ----------------------------------------------------------------------------
   The draft is local state, not the query cache, because it changes on every
   keystroke and the server copy must not overwrite it mid-sentence. `base`
   is the server's copy the draft started from. The draft is clean when it
   still equals base.content.

   Saving: SAVE_DELAY_MS after typing stops, on blur, and on the save icon.
   Saves run one at a time through a queue and each reads the draft when it
   runs, so a burst of triggers coalesces into however many saves are
   actually needed. The answer goes into the notes cache by hand: this tab's
   own writes are not echoed back to it over the live socket.

   Taking another device's edit: a live message refetches ["notes"]. A copy
   newer than base is applied only while the draft is clean and nothing is
   saving. A dirty draft keeps its text and its next save wins; the notepad
   is last-write-wins by design (worker/routes/notes.ts).

   Nothing is created until there is something to keep. With no notes, or
   after "new", the draft has no base; its first save creates the note.
   ========================================================================== */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Note } from "@/domain/panes";
import { api, ApiError, send } from "@/lib/api";
import { KEYS, useNotes } from "@/lib/queries";

export type SaveState = "saved" | "dirty" | "saving";

const SAVE_DELAY_MS = 800;
const DEFAULT_NAME = "untitled";
/* Which note was open, so a reload comes back to it. A convenience only:
   losing it means opening the newest note instead. */
const LAST_NOTE = "copland_note";

function rememberNote(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_NOTE, id);
    else localStorage.removeItem(LAST_NOTE);
  } catch {
    /* storage unavailable */
  }
}

function lastNote(): string | null {
  try {
    return localStorage.getItem(LAST_NOTE);
  } catch {
    return null;
  }
}

const newestFirst = (a: Note, b: Note) => b.updatedAt.localeCompare(a.updatedAt);

export function useNotepad() {
  const queryClient = useQueryClient();
  const notesQuery = useNotes();
  const notes = notesQuery.data;

  const [base, setBaseState] = useState<Note | null>(null);
  const [draft, setDraftState] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  /* The name a note not yet created will get. */
  const [draftName, setDraftName] = useState(DEFAULT_NAME);

  /* Mirrors for the async paths, which must see the latest values rather
     than the ones their closure caught. */
  const baseRef = useRef<Note | null>(null);
  const draftRef = useRef("");
  const draftNameRef = useRef(DEFAULT_NAME);
  const savingRef = useRef(false);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pickedRef = useRef(false);

  const setBase = (note: Note | null) => {
    baseRef.current = note;
    setBaseState(note);
  };
  const setDraftText = (text: string) => {
    draftRef.current = text;
    setDraftState(text);
  };

  const upsert = useCallback(
    (note: Note) =>
      queryClient.setQueryData<Note[]>(KEYS.notes, (list = []) =>
        [note, ...list.filter((n) => n.id !== note.id)].sort(newestFirst),
      ),
    [queryClient],
  );

  const load = useCallback((note: Note | null) => {
    setBase(note);
    setDraftText(note?.content ?? "");
    setSaveState("saved");
    setError(null);
    draftNameRef.current = DEFAULT_NAME;
    setDraftName(DEFAULT_NAME);
    rememberNote(note?.id ?? null);
  }, []);

  /* One save, of whatever the draft is by the time it runs. Never throws. */
  const saveNow = useCallback(async () => {
    const text = draftRef.current;
    const from = baseRef.current;
    if (from ? text === from.content : text === "") {
      if (!savingRef.current) setSaveState("saved");
      return;
    }
    savingRef.current = true;
    setSaveState("saving");
    try {
      let note: Note;
      if (from) {
        try {
          note = await send<Note>("PATCH", `/notes/${from.id}`, { content: text });
        } catch (e) {
          /* Deleted on another device while this one had unsaved text: keep
             the text as a new note rather than lose it. */
          if (!(e instanceof ApiError && e.status === 404)) throw e;
          note = await send<Note>("POST", "/notes", { name: from.name, content: text });
        }
      } else {
        note = await send<Note>("POST", "/notes", { name: draftNameRef.current, content: text });
      }
      upsert(note);
      if (baseRef.current?.id === from?.id) {
        setBase(note);
        rememberNote(note.id);
      }
      setError(null);
      setSaveState(draftRef.current === note.content ? "saved" : "dirty");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setSaveState("dirty");
    } finally {
      savingRef.current = false;
    }
  }, [upsert]);

  const flush = useCallback(() => (queueRef.current = queueRef.current.then(saveNow)), [saveNow]);

  const setDraft = (text: string) => {
    setDraftText(text);
    setError(null);
    if (!savingRef.current) setSaveState("dirty");
  };

  /* Typing stopped: save. A failed save waits for the next keystroke or
     blur instead of retrying in a loop. */
  useEffect(() => {
    if (saveState !== "dirty" || error) return;
    const timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, saveState, error, flush]);

  /* The server's list changed: first load, a refetch after another device
     wrote, or our own save landing in the cache. */
  useEffect(() => {
    if (!notes) return;
    /* Open a note once there is one to open. Until then the pane is a blank
       draft, and a note made on another device should replace it, but not
       once this device has started typing or saving its own. */
    if (!pickedRef.current) {
      if (baseRef.current || draftRef.current !== "" || savingRef.current) {
        pickedRef.current = true;
      } else {
        if (notes.length === 0) return;
        pickedRef.current = true;
        const remembered = lastNote();
        load(notes.find((n) => n.id === remembered) ?? notes[0]);
        return;
      }
    }
    const current = baseRef.current;
    if (!current) return;
    const clean = !savingRef.current && draftRef.current === current.content;
    const server = notes.find((n) => n.id === current.id);
    if (!server) {
      /* Deleted elsewhere. A dirty draft stays; its save recreates it. */
      if (clean) load(notes[0] ?? null);
      return;
    }
    if (server.updatedAt <= current.updatedAt) return;
    if (clean) load(server);
    else if (server.name !== current.name) setBase({ ...current, name: server.name });
  }, [notes, load]);

  /* Closing the tab inside the save delay would lose the last words. A
     keepalive request outlives the page. */
  useEffect(() => {
    const onHide = () => {
      const from = baseRef.current;
      const text = draftRef.current;
      if (from ? text === from.content : text === "") return;
      const init = { keepalive: true, body: JSON.stringify(from ? { content: text } : { name: draftNameRef.current, content: text }) };
      void api(from ? `/notes/${from.id}` : "/notes", { ...init, method: from ? "PATCH" : "POST" }).catch(() => {});
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  const select = async (id: string) => {
    await flush();
    const note = queryClient.getQueryData<Note[]>(KEYS.notes)?.find((n) => n.id === id);
    if (note) load(note);
  };

  /** A blank draft; the note exists once something is typed in it. */
  const startNew = async () => {
    await flush();
    load(null);
  };

  const rename = async (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    const current = baseRef.current;
    if (!current) {
      draftNameRef.current = name;
      setDraftName(name);
      return;
    }
    if (name === current.name) return;
    try {
      const note = await send<Note>("PATCH", `/notes/${current.id}`, { name });
      upsert(note);
      /* Only the name: the content in this answer may be older than the
         draft, and base.content is what "clean" is measured against. */
      if (baseRef.current?.id === note.id) setBase({ ...baseRef.current, name: note.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rename failed");
    }
  };

  const remove = async (id: string) => {
    const current = baseRef.current;
    /* Deleting the open note throws its unsaved text away too, so no queued
       save brings it back. */
    if (current?.id === id) setDraftText(current.content);
    await queueRef.current;
    try {
      await send("DELETE", `/notes/${id}`);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) {
        setError(e instanceof Error ? e.message : "Delete failed");
        return;
      }
    }
    const rest = (queryClient.getQueryData<Note[]>(KEYS.notes) ?? []).filter((n) => n.id !== id);
    queryClient.setQueryData<Note[]>(KEYS.notes, rest);
    if (baseRef.current?.id === id) load(rest[0] ?? null);
  };

  return {
    notes: notes ?? [],
    isLoading: notesQuery.isPending,
    loadError: notesQuery.error,
    /** The open note, or null for a draft not saved yet. */
    note: base,
    name: base?.name ?? draftName,
    draft,
    setDraft,
    saveState,
    error,
    flush,
    select,
    startNew,
    rename,
    remove,
  };
}
