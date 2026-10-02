/* ============================================================================
   Handles: the one name a person goes by here.
   ----------------------------------------------------------------------------
   Unique on the instance, case-insensitive (stored lowercased), 2 to 32 of
   a-z, 0-9 and "-", starting and ending with a letter or digit. No "/":
   that is kept for agents, whose handles will be "owner/agent".

   A new account's handle comes from its Google name ("Ada Lovelace" →
   "ada-lovelace"), or the part of the email before the @ when there is no
   name, with a number added when it is taken. Shared by the Worker, which
   decides, and the browser, which only checks early.
   ========================================================================== */

export const HANDLE_MIN = 2;
export const HANDLE_MAX = 32;

const PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/** Words that mean something else wherever a handle is accepted: "me", "myself" and "self" are the MCP's connected person, "none" its no one. */
const RESERVED = new Set(["me", "myself", "self", "none", "admin", "admins", "everyone", "here", "someone", "system", "copland", "agent", "agents"]);

/** Why a handle is not acceptable, or null when it is. */
export function handleProblem(handle: string): string | null {
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) {
    return `A handle is ${HANDLE_MIN} to ${HANDLE_MAX} characters`;
  }
  if (!PATTERN.test(handle)) return "A handle is a-z, 0-9 and -, and starts and ends with a letter or digit";
  if (RESERVED.has(handle)) return `\`${handle}\` is reserved`;
  return null;
}

/** What someone typed, the way it would be stored: trimmed, lowercased, without a leading @. */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

/* Letters NFKD does not take apart into a base letter and a mark. */
const SPELLED: Record<string, string> = { ı: "i", ß: "ss", ø: "o", æ: "ae", œ: "oe", ł: "l", đ: "d", ð: "d", þ: "th" };

/**
 * A handle-shaped version of any text ("Şükrü Öztürk" → "sukru-ozturk"), or
 * null when too little survives. Not checked against reserved words or taken
 * handles; the Worker does that when it picks one.
 */
export function handleFrom(text: string): string | null {
  const ascii = text
    .toLowerCase()
    .replace(/[ıßøæœłđðþ]/g, (c) => SPELLED[c] ?? c)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
  const slug = ascii
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, HANDLE_MAX)
    .replace(/-+$/, "");
  return slug.length >= HANDLE_MIN ? slug : null;
}
