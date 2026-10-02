/* ============================================================================
   Someone's picture, or their initials in a square when they have none (or
   it fails to load). Square like everything else; sized in pixels so it
   sits on a text line at 14 or 16.
   ========================================================================== */

import { useState } from "react";
import type { User } from "@/domain/types";

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
  return (
    <span
      title={user.handle}
      style={{ ...box, fontSize: Math.max(9, Math.round(size * 0.5)) }}
      className={`inline-flex shrink-0 items-center justify-center leading-none border border-faint text-muted select-none ${className}`}
    >
      {initials(user.handle)}
    </span>
  );
}
