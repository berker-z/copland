/* ============================================================================
   The /inbox pane: what needs your attention (routes/inbox.ts).
   ----------------------------------------------------------------------------
   Being given a task by someone else, @mentioned in a comment, or a new
   comment on a task you take part in lands here, newest first; the unread count sits in the header. Clicking an item
   marks it read and opens its task over the dashboard, the way the tasks
   pane does. × dismisses an item for good. Read items stay, dimmed, until
   dismissed. The first 50 load; "older" at the foot loads the next page
   (the route's cursor), so nothing old is out of reach.

   The list itself (InboxItems) is shared with the statusline's inbox badge
   (InboxBadge.tsx), which shows it in a modal on every screen.
   ========================================================================== */

import { useState } from "react";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import type { Inbox, InboxItem } from "@/domain/types";
import { send } from "@/lib/api";
import { KEYS, useBoard, useInbox } from "@/lib/queries";
import { Avatar } from "@/ui/Avatar";
import { when } from "@/ui/tone";
import { WidgetFrame } from "@/ui/WidgetFrame";
import { TaskModal } from "../board/TaskModal";

/* The answer is the first page as it is now. Rather than swap it in, which
   could shift what the pages already loaded hold, the write is applied to
   every loaded page and the count taken from the answer. */
function useInboxWrite(path: "/inbox/read" | "/inbox/dismiss") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => send<Inbox>("POST", path, ids ? { ids } : {}),
    onSuccess: (inbox, ids) => {
      const hit = (item: InboxItem) => ids === undefined || ids.includes(item.id);
      const now = new Date().toISOString();
      queryClient.setQueryData<InfiniteData<Inbox, string | null>>(KEYS.inbox, (old) =>
        old && {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            unread: inbox.unread,
            items:
              path === "/inbox/dismiss"
                ? page.items.filter((item) => !hit(item))
                : page.items.map((item) => (item.readAt === null && hit(item) ? { ...item, readAt: now } : item)),
          })),
        },
      );
    },
  });
}

const VERB: Record<InboxItem["kind"], string> = {
  assigned: "gave you",
  mentioned: "mentioned you on",
  commented: "commented on",
};

function Item({ item, onOpen, onDismiss }: { item: InboxItem; onOpen: () => void; onDismiss: () => void }) {
  const unread = item.readAt === null;
  return (
    <div className={`group/item flex items-start border-b border-divider last:border-b-0 hover:bg-raised transition-colors ${unread ? "" : "opacity-60"}`}>
      <button onClick={onOpen} className="flex-1 min-w-0 text-left flex gap-2.5 pl-4 pr-1 py-2.5">
        <Avatar user={item.actor} size={18} className="mt-0.5" />
        <span className="flex-1 min-w-0">
          <span className="block text-sm text-muted">
            <span className={unread ? "text-bright" : "text-ink"}>{item.actor.handle}</span>{" "}
            {VERB[item.kind]} <span className="text-ink">{item.task.key}</span>
            {item.via && <span className="text-faint"> via {item.via}</span>}
          </span>
          <span className="block text-sm text-ink truncate">{item.task.title}</span>
          {item.comment && <span className="block text-xs text-muted line-clamp-2 mt-0.5">{item.comment}</span>}
        </span>
        <span className="shrink-0 text-xs text-faint pt-0.5">{when(item.createdAt)}</span>
      </button>
      <button
        onClick={onDismiss}
        className="tap shrink-0 p-2.5 text-faint hover:text-red pointer-fine:opacity-0 pointer-fine:group-hover/item:opacity-100 transition-opacity"
        title="Dismiss"
        aria-label={`Dismiss ${item.task.key}`}
      >
        <X size={14} />
      </button>
    </div>
  );
}

/** What to open when an item is clicked: its task, on its board. */
export interface InboxTarget {
  boardId: string;
  taskId: string;
}

/** An item's task, over whatever is on screen, once its board has loaded. */
export function OpenTask({ boardId, taskId, onClose }: InboxTarget & { onClose: () => void }) {
  const { data: detail } = useBoard(boardId);
  return detail ? <TaskModal detail={detail} taskId={taskId} onClose={onClose} /> : null;
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

/** The items, newest first. Opening one marks it read and hands its task to `onOpen`. */
export function InboxItems({ onOpen }: { onOpen: (target: InboxTarget) => void }) {
  const { data: inbox, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useInbox();
  const markRead = useInboxWrite("/inbox/read");
  const dismiss = useInboxWrite("/inbox/dismiss");
  return (
    <>
      {error && <p className="p-4 text-red text-sm">{error.message}</p>}
      {!inbox && !error && <p className="px-4 py-3 text-muted text-sm animate-pulse">loading…</p>}
      {inbox && inbox.items.length === 0 && (
        <p className="px-4 py-3 text-faint text-sm">Nothing here. Being given a task, @mentioned, or a new comment on a task you take part in lands here.</p>
      )}
      {inbox?.items.map((item) => (
        <Item
          key={item.id}
          item={item}
          onOpen={() => {
            if (item.readAt === null) markRead.mutate([item.id]);
            onOpen({ boardId: item.task.boardId, taskId: item.task.id });
          }}
          onDismiss={() => dismiss.mutate([item.id])}
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
