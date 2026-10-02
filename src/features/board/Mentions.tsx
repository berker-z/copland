/* ============================================================================
   Mentions in comments: showing them, and typing them.
   ----------------------------------------------------------------------------
   The Worker decides who a comment mentions (repo/inbox.ts) and sends them
   with the comment. CommentText lights up those names in the text. A name
   that is not on the board stays plain, which tells the writer nobody heard.

   MentionTextarea is a textarea that, after "@", lists the board's members
   whose handle starts with what follows: arrows to move, Enter or Tab to
   take one, Escape to close. People come before agents.
   ========================================================================== */

import { useState, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import type { BoardMember, Comment } from "@/domain/types";
import { Avatar, peopleFirst } from "@/ui/Avatar";

/* The same shape the Worker matches; kept in step with repo/inbox.ts. */
const MENTION = /(?<![a-z0-9])@([a-z0-9][a-z0-9-]*[a-z0-9](?:\/[a-z0-9][a-z0-9-]*[a-z0-9])?)/gi;

export function CommentText({ comment }: { comment: Pick<Comment, "text" | "mentions"> }) {
  const named = new Set(comment.mentions.map((m) => m.handle.toLowerCase()));
  const parts: (string | { handle: string })[] = [];
  let last = 0;
  for (const match of comment.text.matchAll(MENTION)) {
    if (!named.has(match[1].toLowerCase())) continue;
    parts.push(comment.text.slice(last, match.index), { handle: match[0] });
    last = (match.index ?? 0) + match[0].length;
  }
  parts.push(comment.text.slice(last));
  return (
    <p className="text-ink whitespace-pre-wrap break-words mt-0.5">
      {parts.map((p, i) => (typeof p === "string" ? p : <span key={i} className="text-accent">{p.handle}</span>))}
    </p>
  );
}

/** The "@partial" right before the caret, if the caret is in one. */
function partialAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?<![a-z0-9])@([a-z0-9/-]*)$/i.exec(text.slice(0, caret));
  return match ? { start: caret - match[0].length, query: match[1].toLowerCase() } : null;
}

interface MentionTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> {
  value: string;
  onValue: (text: string) => void;
  members: BoardMember[];
}

export function MentionTextarea({ value, onValue, members, onKeyDown, ...rest }: MentionTextareaProps) {
  const [caret, setCaret] = useState<number | null>(null);
  const [picked, setPicked] = useState(0);
  const partial = caret === null ? null : partialAt(value, caret);
  const options = partial
    ? peopleFirst(members)
        .filter((m) => m.user.handle.toLowerCase().startsWith(partial.query))
        .slice(0, 6)
    : [];
  const showing = options.length > 0 && !(options.length === 1 && options[0].user.handle.toLowerCase() === partial?.query);

  const take = (member: BoardMember, area: HTMLTextAreaElement | null) => {
    if (!partial || caret === null) return;
    const insert = `@${member.user.handle} `;
    const next = value.slice(0, partial.start) + insert + value.slice(caret);
    const at = partial.start + insert.length;
    onValue(next);
    setCaret(at);
    setPicked(0);
    requestAnimationFrame(() => area?.setSelectionRange(at, at));
  };

  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPicked((p) => (p + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault();
        take(options[Math.min(picked, options.length - 1)], e.currentTarget);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setCaret(null);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="relative">
      <textarea
        {...rest}
        value={value}
        onChange={(e) => {
          onValue(e.target.value);
          setCaret(e.target.selectionStart);
          setPicked(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onBlur={() => setCaret(null)}
        onKeyDown={keys}
      />
      {showing && (
        <ul className="absolute left-0 top-full mt-1 z-10 min-w-48 bg-surface border border-faint py-1" role="listbox">
          {options.map((m, i) => (
            <li key={m.user.id}>
              <button
                type="button"
                /* mousedown, so the textarea keeps its caret and does not blur first. */
                onMouseDown={(e) => {
                  e.preventDefault();
                  take(m, e.currentTarget.closest("div")?.querySelector("textarea") ?? null);
                }}
                className={`w-full flex items-center gap-2 px-2.5 py-1 text-left text-sm ${i === picked ? "bg-raised text-accent" : "text-ink hover:bg-raised"}`}
                role="option"
                aria-selected={i === picked}
              >
                <Avatar user={m.user} size={14} />
                {m.user.handle}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
