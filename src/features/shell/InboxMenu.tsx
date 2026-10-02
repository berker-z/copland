/* ============================================================================
   The bell in the statusline: your inbox (routes/inbox.ts).
   ----------------------------------------------------------------------------
   The count is what is unread. Opening the list does not mark anything; you
   are only looking. Clicking an item marks it read and opens its task over
   whatever is on screen, the way the tasks pane does. "mark all read" clears
   the count.
   ========================================================================== */

import { useCallback, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import type { Inbox, InboxItem } from "@/domain/types";
import { send } from "@/lib/api";
import { KEYS, useBoard, useInbox } from "@/lib/queries";
import { Avatar } from "@/ui/Avatar";
import { when } from "@/ui/tone";
import { useDismiss } from "@/ui/useDismiss";
import { TaskModal } from "../board/TaskModal";

function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => send<Inbox>("POST", "/inbox/read", ids ? { ids } : {}),
    onSuccess: (inbox) => queryClient.setQueryData(KEYS.inbox, inbox),
  });
}

function Item({ item, onOpen }: { item: InboxItem; onOpen: () => void }) {
  const unread = item.readAt === null;
  return (
    <button
      onClick={onOpen}
      className={`w-full text-left flex gap-2.5 px-3 py-2.5 border-b border-divider last:border-b-0 hover:bg-raised transition-colors ${
        unread ? "" : "opacity-60"
      }`}
    >
      <Avatar user={item.actor} size={18} className="mt-0.5" />
      <span className="flex-1 min-w-0 whitespace-normal">
        <span className="block text-sm text-muted">
          <span className={unread ? "text-bright" : "text-ink"}>{item.actor.handle}</span>{" "}
          {item.kind === "assigned" ? "gave you" : "mentioned you on"}{" "}
          <span className="text-ink">{item.task.key}</span>
          {item.via && <span className="text-faint"> via {item.via}</span>}
        </span>
        <span className="block text-sm text-ink truncate">{item.task.title}</span>
        {item.comment && <span className="block text-xs text-muted line-clamp-2 mt-0.5">{item.comment}</span>}
      </span>
      <span className="shrink-0 text-xs text-faint">{when(item.createdAt)}</span>
    </button>
  );
}

/** The task of an opened item, over the page, once its board has loaded. */
function OpenTask({ boardId, taskId, onClose }: { boardId: string; taskId: string; onClose: () => void }) {
  const { data: detail } = useBoard(boardId);
  return detail ? <TaskModal detail={detail} taskId={taskId} onClose={onClose} /> : null;
}

export function InboxMenu() {
  const { data: inbox } = useInbox();
  const markRead = useMarkRead();
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState<{ boardId: string; taskId: string } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const unread = inbox?.unread ?? 0;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`tap flex items-center gap-1 transition-colors ${unread ? "text-accent" : "text-muted hover:text-accent"}`}
        title={unread ? `${unread} unread` : "Inbox"}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Bell size={15} />
        {unread > 0 && <span className="text-sm tabular-nums">{unread}</span>}
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-2 w-[min(24rem,calc(100vw-2rem))] max-h-[min(70dvh,32rem)] overflow-auto bg-surface border border-faint z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-divider">
            <span className="text-label">inbox</span>
            {unread > 0 && (
              <button onClick={() => markRead.mutate(undefined)} className="tap text-xs text-muted hover:text-accent">
                mark all read
              </button>
            )}
          </div>
          {!inbox && <p className="px-3 py-3 text-xs text-muted animate-pulse">loading…</p>}
          {inbox && inbox.items.length === 0 && (
            <p className="px-3 py-3 text-xs text-faint whitespace-normal">
              Nothing yet. Being given a task, or @mentioned in a comment, lands here.
            </p>
          )}
          {inbox?.items.map((item) => (
            <Item
              key={item.id}
              item={item}
              onOpen={() => {
                if (item.readAt === null) markRead.mutate([item.id]);
                setTask({ boardId: item.task.boardId, taskId: item.task.id });
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
      {task && <OpenTask boardId={task.boardId} taskId={task.taskId} onClose={() => setTask(null)} />}
    </div>
  );
}
