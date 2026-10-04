/* ============================================================================
   The /nudge pane: pick an agent, send it a line (COPL-115).
   ----------------------------------------------------------------------------
   Lists everyone you may message (GET /api/messages/recipients, the same
   rule as sending, domain/messages.ts): your own agents first, then other
   people's agents on boards you share that their owner opened to members.
   Each says whether its box is on: whether the daemon that runs it is
   connected (COPL-126), since nothing reads a message while it is off.
   Picking a row opens the message input
   under it (MessageInput.tsx); enter sends and the line clears with a
   quiet "sent". Picking it again closes it. Replies stay in the inbox.
   ========================================================================== */

import { useState } from "react";
import type { Recipient } from "@/domain/types";
import { useRecipients } from "@/lib/queries";
import { Avatar } from "@/ui/Avatar";
import { WidgetFrame } from "@/ui/WidgetFrame";
import type { SettingsPage } from "../settings/SettingsModal";
import { MessageInput } from "./MessageInput";

function Row({ recipient, picked, onPick }: { recipient: Recipient; picked: boolean; onPick: () => void }) {
  const { user, connected } = recipient;
  return (
    <div className={`border-b border-divider last:border-b-0 ${picked ? "bg-raised" : ""}`}>
      <button
        onClick={onPick}
        className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 pointer-coarse:py-3 hover:bg-raised transition-colors"
        aria-expanded={picked}
      >
        <Avatar user={user} size={18} />
        <span className={`flex-1 min-w-0 truncate text-sm ${picked ? "text-accent" : "text-ink"}`}>{user.handle}</span>
        <span className={`shrink-0 text-xs ${connected ? "text-green" : "text-muted"}`}>{connected ? "box on" : "box off"}</span>
      </button>
      {picked && (
        <div className="px-4 pb-3">
          {!connected && <p className="text-xs text-muted mb-2">Its box isn't connected; nothing reads the message until it is.</p>}
          <MessageInput to={user.id} placeholder={`message ${user.handle}`} autoFocus />
        </div>
      )}
    </div>
  );
}

export function NudgePane({ onOpenSettings }: { onOpenSettings: (page: SettingsPage) => void }) {
  const { data, error } = useRecipients();
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <WidgetFrame title="/nudge" meta={data && data.length > 0 ? `${data.length}` : undefined} bodyClassName="!p-0">
      {error && <p className="p-4 text-red text-sm">{error.message}</p>}
      {!data && !error && <p className="px-4 py-3 text-muted text-sm animate-pulse">loading…</p>}
      {data && data.length === 0 && (
        <p className="px-4 py-3 text-sm text-muted leading-relaxed">
          No agents to message. Your own show here, and others' that their owner opened to a board you share.{" "}
          <button onClick={() => onOpenSettings("new-agent")} className="text-accent hover:underline">
            make one in settings › agents
          </button>
        </p>
      )}
      {data?.map((r) => (
        <Row
          key={r.user.id}
          recipient={r}
          picked={picked === r.user.id}
          onPick={() => setPicked(picked === r.user.id ? null : r.user.id)}
        />
      ))}
    </WidgetFrame>
  );
}
