/* ============================================================================
   The /inbox pane: what needs your attention (routes/inbox.ts).
   ----------------------------------------------------------------------------
   Being given a task by someone else, @mentioned in a comment, or a new
   comment on a task you take part in lands here, newest first; the unread count sits in the header. So does a
   message (routes/messages.ts), with its sender, its text and, when it
   points at one, its task. One from someone you don't trust that way (not
   your own agent: someone else's agent answering you) reads like a
   comment, smaller and muted. "reply" under a message opens one line
   that answers it (replyTo), about the same task, and sending marks it read. Clicking an item opens
   its task over the dashboard, the way the tasks pane does, and opening a
   task marks every unread item on it read (useReadOnOpen, domain/inbox.ts),
   except messages: clicking a message marks that one read itself. × dismisses an item for good. Read items stay, dimmed, until
   dismissed. The first 50 load; "older" at the foot loads the next page
   (the route's cursor), so nothing old is out of reach.

   The list itself (InboxItems) is shared with the statusline's inbox badge
   (InboxBadge.tsx), which shows it in a modal on every screen.
   ========================================================================== */

import { useState } from "react";
import { Check, CornerDownRight, X } from "lucide-react";
import type { InboxItem } from "@/domain/types";
import { useBoardView, useInbox } from "@/lib/queries";
import { Avatar } from "@/ui/Avatar";
import { when } from "@/ui/tone";
import { WidgetFrame } from "@/ui/WidgetFrame";
import { TaskModal } from "../board/TaskModal";
import { useInboxWrite } from "./inboxWrite";
import { MessageInput } from "./MessageInput";

const VERB: Record<InboxItem["kind"], string> = {
  assigned: "gave you",
  mentioned: "mentioned you on",
  commented: "commented on",
  message: "messaged you",
};

function Item({ item, onOpen, onDismiss, onReplied }: { item: InboxItem; onOpen: () => void; onDismiss: () => void; onReplied: () => void }) {
  const unread = item.readAt === null;
  const [replying, setReplying] = useState(false);
  const [replied, setReplied] = useState(false);
  return (
    <div className={`group/item border-b border-divider last:border-b-0 hover:bg-raised transition-colors ${unread || replying ? "" : "opacity-60"}`}>
      <div className="flex items-start">
        <button onClick={onOpen} className="flex-1 min-w-0 text-left flex gap-2.5 pl-4 pr-1 py-2.5">
          <Avatar user={item.actor} size={18} className="mt-0.5" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm text-muted">
              <span className={unread ? "text-bright" : "text-ink"}>{item.actor.handle}</span>{" "}
              {VERB[item.kind]}
              {item.task && (
                <>
                  {item.kind === "message" ? " about " : " "}
                  <span className="text-ink">{item.task.key}</span>
                </>
              )}
              {item.via && <span className="text-faint"> via {item.via}</span>}
            </span>
            {item.task && <span className="block text-sm text-ink truncate">{item.task.title}</span>}
            {item.message && (
              <span
                className={`block mt-0.5 whitespace-pre-line ${item.message.trusted ? "text-sm text-ink line-clamp-3" : "text-xs text-muted line-clamp-2"}`}
              >
                {item.message.text}
              </span>
            )}
            {item.comment && <span className="block text-xs text-muted line-clamp-2 mt-0.5">{item.comment}</span>}
          </span>
          <span className="shrink-0 text-xs text-faint pt-0.5">{when(item.createdAt)}</span>
        </button>
        <button
          onClick={onDismiss}
          className="tap shrink-0 p-2.5 text-faint hover:text-red pointer-fine:opacity-0 pointer-fine:group-hover/item:opacity-100 transition-opacity"
          title="Dismiss"
          aria-label={`Dismiss ${item.task?.key ?? `message from ${item.actor.handle}`}`}
        >
          <X size={14} />
        </button>
      </div>
      {item.message &&
        (replying ? (
          <MessageInput
            replyTo={item.message.id}
            taskId={item.task?.id}
            placeholder={`reply to ${item.actor.handle}`}
            autoFocus
            onSent={() => {
              setReplying(false);
              setReplied(true);
              onReplied();
            }}
            className="pl-[2.75rem] pr-4 pb-2.5"
          />
        ) : (
          <button
            onClick={() => setReplying(true)}
            className={`tap flex items-center gap-1 ml-[2.75rem] mb-2 -mt-1 text-xs hover:text-accent transition-colors ${replied ? "text-green" : "text-muted"}`}
          >
            <CornerDownRight size={12} aria-hidden />
            {replied ? "replied · reply again" : "reply"}
          </button>
        ))}
    </div>
  );
}

/** What to open when an item is clicked: its task, on its board. */
export interface InboxTarget {
  boardId: string;
  taskId: string;
}

/** An item's task, over whatever is on screen, once its board has loaded (and it, when closed too long ago to be in the board's read). */
export function OpenTask({ boardId, taskId, onClose }: InboxTarget & { onClose: () => void }) {
  const { detail, finding } = useBoardView(boardId, { task: taskId });
  /* Not found at all (deleted since), the modal closes itself. */
  return detail && !finding ? <TaskModal detail={detail} taskId={taskId} onClose={onClose} /> : null;
}

/** "Mark all read", shown only while something is unread. */
export function MarkAllRead({ className = "tap p-1 hover:text-accent transition-colors" }: { className?: string }) {
  const { data: inbox } = useInbox();
  const markRead = useInboxWrite("/inbox/read");
  if (!inbox?.unread) return null;
  return (
    <button onClick={() => markRead.mutate(undefined)} className={className} title="Mark all read" aria-label="Mark all read">
      <Check size={14} />
    </button>
  );
}

/** The items, newest first. Opening one hands its task to `onOpen`; a message is marked read on the click. */
export function InboxItems({ onOpen }: { onOpen: (target: InboxTarget) => void }) {
  const { data: inbox, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useInbox();
  const markRead = useInboxWrite("/inbox/read");
  const dismiss = useInboxWrite("/inbox/dismiss");
  return (
    <>
      {error && <p className="p-4 text-red text-sm">{error.message}</p>}
      {!inbox && !error && <p className="px-4 py-3 text-muted text-sm animate-pulse">loading…</p>}
      {inbox && inbox.items.length === 0 && (
        <p className="px-4 py-3 text-faint text-sm">Nothing here. Being given a task, @mentioned, a new comment on a task you take part in, or a message from an agent lands here.</p>
      )}
      {inbox?.items.map((item) => (
        <Item
          key={item.id}
          item={item}
          onOpen={() => {
            /* An opened task marks its own items read (useReadOnOpen in
               TaskModal), all at once; a message it leaves alone. */
            if (item.readAt === null && (item.kind === "message" || !item.task)) markRead.mutate([item.id]);
            if (item.task) onOpen({ boardId: item.task.boardId, taskId: item.task.id });
          }}
          onDismiss={() => dismiss.mutate([item.id])}
          onReplied={() => item.readAt === null && markRead.mutate([item.id])}
        />
      ))}
      {hasNextPage && (
        <button
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
          className="tap block w-full px-4 py-2.5 text-left text-sm text-muted hover:text-accent hover:bg-raised transition-colors disabled:animate-pulse"
        >
          {isFetchingNextPage ? "loading…" : "older"}
        </button>
      )}
      {(markRead.error ?? dismiss.error) && (
        <p className="px-4 py-2 text-xs text-red">{(markRead.error ?? dismiss.error)?.message}</p>
      )}
    </>
  );
}

export function InboxPane() {
  const { data: inbox } = useInbox();
  const [task, setTask] = useState<InboxTarget | null>(null);
  const unread = inbox?.unread ?? 0;

  return (
    <WidgetFrame
      title="/inbox"
      meta={inbox ? (unread ? <span className="text-accent">{unread} unread</span> : "all read") : undefined}
      controls={<MarkAllRead />}
      bodyClassName="!p-0"
    >
      <InboxItems onOpen={setTask} />
      {task && <OpenTask {...task} onClose={() => setTask(null)} />}
    </WidgetFrame>
  );
}
