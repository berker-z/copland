/* ============================================================================
   Settings → profile: your handle and your picture.
   ----------------------------------------------------------------------------
   The picture takes a file any way it comes: dropped on the square, pasted
   anywhere on the page (Ctrl+V a screenshot, unless the handle box has the
   focus), or picked with a click, which on a phone offers the camera too.
   ========================================================================== */

import { useEffect, useRef, useState, type DragEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { handleProblem, HANDLE_MAX, normalizeHandle } from "@/domain/handle";
import type { Me } from "@/domain/types";
import { send } from "@/lib/api";
import { uploadAvatar } from "@/lib/avatar";
import { refresh } from "@/lib/live";
import { KEYS } from "@/lib/queries";
import { Avatar } from "@/ui/Avatar";
import { Group, Section, button, input } from "./Section";

/** After a change to me: /me from the answer, and everything that shows me refetched. */
function useMeChange<A>(fn: (arg: A) => Promise<Me>, onDone?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (me) => {
      queryClient.setQueryData(KEYS.me, me);
      refresh(queryClient, ["people"]);
      onDone?.();
    },
  });
}

function isTextTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}

function PictureGroup({ me }: { me: Me }) {
  const upload = useMeChange(uploadAvatar);
  const remove = useMeChange(() => send<Me>("DELETE", "/me/avatar"));
  const picker = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  /* The latest mutate, for the document listener. */
  const take = useRef<(files: FileList | null | undefined) => void>(() => {});
  take.current = (files) => {
    const file = files && [...files].find((f) => f.type.startsWith("image/"));
    if (file) upload.mutate(file);
  };

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isTextTarget(event.target) || !event.clipboardData?.files.length) return;
      event.preventDefault();
      take.current(event.clipboardData.files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const dragEnter = (e: DragEvent) => {
    e.preventDefault();
    depth.current += 1;
    setOver(true);
  };
  const dragLeave = (e: DragEvent) => {
    e.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  };

  const busy = upload.isPending || remove.isPending;
  const error = upload.error ?? remove.error;

  return (
    <Group title="picture">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => picker.current?.click()}
          onDragEnter={dragEnter}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={dragLeave}
          onDrop={(e) => {
            e.preventDefault();
            depth.current = 0;
            setOver(false);
            take.current(e.dataTransfer.files);
          }}
          aria-label="Change picture: drop, paste or pick one"
          className={`relative p-1 border border-dashed transition-colors ${
            over ? "border-accent bg-accent/10" : "border-faint hover:border-accent"
          } ${busy ? "animate-pulse" : ""}`}
        >
          <Avatar user={me.user} size={72} className="!border-0" />
        </button>
        <div className="text-xs text-muted leading-relaxed">
          <p className="pointer-coarse:hidden">Drop a picture on the square, paste one, or click to pick.</p>
          <p className="hidden pointer-coarse:block">Tap the square to pick a photo or take one.</p>
          <p className="text-faint">Cropped to a square in the middle.</p>
          {me.user.avatar && (
            <button onClick={() => remove.mutate(undefined)} disabled={busy} className="tap mt-1 text-muted hover:text-red disabled:opacity-50">
              remove picture
            </button>
          )}
        </div>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            take.current(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {error && <p className="text-red text-xs mt-2">{error.message}</p>}
    </Group>
  );
}

function HandleGroup({ me }: { me: Me }) {
  const [draft, setDraft] = useState(me.user.handle);
  const save = useMeChange((handle: string) => send<Me>("PATCH", "/me", { handle }));
  /* Someone else's tab renamed us: show the new one unless mid-edit. */
  useEffect(() => setDraft(me.user.handle), [me.user.handle]);

  const handle = normalizeHandle(draft);
  const problem = handle === me.user.handle ? null : handleProblem(handle);
  const changed = handle !== me.user.handle;

  return (
    <Group title="handle">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed && !problem) save.mutate(handle);
        }}
      >
        <span className={`${input} flex flex-1 min-w-0 items-baseline gap-0.5 focus-within:border-accent`}>
          <span className="text-faint">@</span>
          <input
            className="flex-1 min-w-0 bg-transparent text-ink focus:outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={HANDLE_MAX + 1}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            aria-label="Handle"
          />
        </span>
        <button className={button} type="submit" disabled={!changed || !!problem || save.isPending}>
          save
        </button>
      </form>
      {(problem ?? save.error?.message) && <p className="text-red text-xs mt-2">{problem ?? save.error?.message}</p>}
      <p className="text-xs text-faint mt-2">
        a-z, 0-9 and -. Unique here. Renaming keeps your assignments, comments and history; your old handle becomes free for
        anyone.
      </p>
    </Group>
  );
}

export function ProfileSection({ me }: { me: Me }) {
  return (
    <Section title="profile" hint="How you show up to the people you share boards with. Your Google name and photo are not used.">
      <PictureGroup me={me} />
      <HandleGroup me={me} />
      <p className="text-xs text-faint mt-5">
        signed in as <span className="text-muted">{me.user.email}</span>, which board members can also see
      </p>
    </Section>
  );
}
