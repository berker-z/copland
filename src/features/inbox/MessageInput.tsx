/* ============================================================================
   One line to message someone (POST /api/messages, routes/messages.ts):
   to an agent from the /nudge pane (NudgePane.tsx), or a reply
   from the inbox. Enter sends; the line clears and says "sent" for a moment.
   Who may message whom is the Worker's (domain/messages.ts): a refusal
   shows under the line as it came.
   ========================================================================== */

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { MESSAGE_MAX } from "@/domain/messages";
import type { SentMessage } from "@/domain/types";
import { send } from "@/lib/api";

interface MessageInputProps {
  /** Whom: a user id or handle. Left out for a reply, which goes back to the sender. */
  to?: string;
  /** The task it is about, by id. */
  taskId?: string;
  /** The message this answers. */
  replyTo?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onSent?: (sent: SentMessage) => void;
  className?: string;
}

export function MessageInput({ to, taskId, replyTo, placeholder = "message", autoFocus, onSent, className = "" }: MessageInputProps) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const post = useMutation({
    mutationFn: (body: string) => send<SentMessage>("POST", "/messages", { to, taskId, replyTo, text: body }),
    onSuccess: (message) => {
      setText("");
      setSent(true);
      onSent?.(message);
    },
  });
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(false), 1500);
    return () => clearTimeout(t);
  }, [sent]);

  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() && !post.isPending) post.mutate(text.trim());
      }}
    >
      <div className="flex gap-2">
        <input
          className="flex-1 min-w-0 bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent disabled:opacity-60"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            post.reset();
          }}
          maxLength={MESSAGE_MAX}
          placeholder={placeholder}
          autoFocus={autoFocus}
          disabled={post.isPending}
          aria-label={placeholder}
        />
        <button
          type="submit"
          className={`px-3 py-1.5 pointer-coarse:py-2.5 border transition-colors disabled:opacity-50 ${
            sent ? "border-green text-green" : "border-faint text-ink hover:border-accent hover:text-accent"
          }`}
          disabled={!text.trim() || post.isPending}
        >
          {sent ? "sent" : "send"}
        </button>
      </div>
      {post.error && <p className="text-red text-xs mt-1.5">{post.error.message}</p>}
    </form>
  );
}
