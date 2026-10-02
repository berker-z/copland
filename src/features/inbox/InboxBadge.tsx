/* ============================================================================
   The inbox in the statusline: a bell with the unread count, on every
   screen, so something given to you shows without going back to the
   dashboard. It opens the same list as the /inbox pane in a modal; opening
   an item swaps the modal for its task, and closing the task comes back
   to the list. The count follows the `inbox` live topic like the pane does.
   ========================================================================== */

import { useState } from "react";
import { Bell } from "lucide-react";
import { useInbox } from "@/lib/queries";
import { ModalFrame } from "@/ui/ModalFrame";
import { InboxItems, MarkAllRead, OpenTask, type InboxTarget } from "./InboxPane";

export function InboxBadge() {
  const { data: inbox } = useInbox();
  const [view, setView] = useState<"list" | InboxTarget | null>(null);
  const unread = inbox?.unread ?? 0;
  const label = unread ? `Inbox: ${unread} unread` : "Inbox";

  return (
    <>
      <button
        onClick={() => setView("list")}
        className={`tap flex items-center gap-1 transition-colors ${unread ? "text-accent hover:text-bright" : "text-muted hover:text-accent"}`}
        title={label}
        aria-label={label}
      >
        <Bell size={16} aria-hidden />
        {unread > 0 && <span className="tabular-nums">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {view === "list" && (
        <ModalFrame
          title="inbox"
          subtitle={unread ? `${unread} unread` : "all read"}
          onClose={() => setView(null)}
          size="lg"
          bodyClassName="!p-0 overflow-y-auto"
          headerActions={<MarkAllRead className="tap p-2 hover:bg-raised hover:text-accent transition-colors" />}
        >
          <InboxItems onOpen={setView} />
        </ModalFrame>
      )}
      {view && view !== "list" && <OpenTask {...view} onClose={() => setView("list")} />}
    </>
  );
}
