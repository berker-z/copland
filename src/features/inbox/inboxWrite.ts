/* ============================================================================
   Writes to your inbox from the browser: marking read and dismissing, and
   marking a task's items read when it is opened (domain/inbox.ts).
   ========================================================================== */

import { useEffect, useRef } from "react";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { Inbox, InboxItem } from "@/domain/types";
import { readOnOpen } from "@/domain/inbox";
import { send } from "@/lib/api";
import { KEYS, useInbox } from "@/lib/queries";

/* The answer is the first page as it is now. Rather than swap it in, which
   could shift what the pages already loaded hold, the write is applied to
   every loaded page and the count taken from the answer. */
export function useInboxWrite(path: "/inbox/read" | "/inbox/dismiss") {
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

/**
 * Opening a task marks the viewer's unread items on it read, messages
 * aside: once per opening, as soon as the inbox has loaded, and with no
 * write at all when nothing on it is unread. The ids come from the pages
 * already loaded (the newest fifty, more if "older" was pressed).
 */
export function useReadOnOpen(taskId: string) {
  const { data: inbox } = useInbox();
  const markRead = useInboxWrite("/inbox/read");
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!inbox || done.current === taskId) return;
    done.current = taskId;
    const ids = readOnOpen(inbox.items, taskId);
    if (ids.length) markRead.mutate(ids);
  }, [inbox, taskId]);
}
