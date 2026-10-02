/* ============================================================================
   Someone's picture, or a stand-in when they have none (or it fails to load):
   their initials in a square for a person, a bot mark for an agent. Square
   like everything else; sized in pixels so it sits on a text line at 14 or 16.
   ========================================================================== */

import { useState } from "react";
import { Bot } from "lucide-react";
import type { User } from "@/domain/types";

/** Agents are "owner/name"; a person's handle can never hold a slash (domain/handle.ts). */
export const isAgentHandle = (handle: string) => handle.includes("/");

/** "ada-lovelace" → "al", "ada" → "ad". */
export function initials(handle: string): string {
  const parts = handle.split("-").filter(Boolean);
  return parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : handle.slice(0, 2);
}

export function Avatar({ user, size = 16, className = "" }: { user: Pick<User, "handle" | "avatar">; size?: number; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const box = { width: size, height: size };
  if (user.avatar && broken !== user.avatar) {
    return (
      <img
        src={user.avatar}
        alt=""
        title={user.handle}
        style={box}
        onError={() => setBroken(user.avatar)}
        className={`inline-block shrink-0 object-cover border border-faint bg-raised ${className}`}
      />
    );
  }
  const agent = isAgentHandle(user.handle);
  return (
    <span
      title={user.handle}
      style={{ ...box, fontSize: Math.max(9, Math.round(size * 0.5)) }}
      className={`inline-flex shrink-0 items-center justify-center leading-none border border-faint text-muted select-none ${className}`}
    >
      {agent ? <Bot size={Math.round(size * 0.7)} strokeWidth={1.75} /> : initials(user.handle)}
    </span>
  );
}

/** Members for a picker: people first, then agents, each in the order given. */
export function peopleFirst<T extends { user: Pick<User, "handle"> }>(members: T[]): T[] {
  return [...members].sort((a, b) => Number(isAgentHandle(a.user.handle)) - Number(isAgentHandle(b.user.handle)));
}
