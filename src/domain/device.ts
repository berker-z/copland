/* ============================================================================
   Device login (COPL-47): the shapes both sides share, and the user code.
   ----------------------------------------------------------------------------
   The box shows a user code like "KQ7M-X3TP"; the person types or follows
   it to /device. The alphabet leaves out what reads ambiguously on a
   screen or when typed (0/O, 1/I/L, U/V), and the code is normalised the
   same way on both sides, so "kq7m x3tp" finds the same request.
   ========================================================================== */

/** 29 characters: digits and capitals without 0 O 1 I L U V. */
export const USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTWXYZ";

/** How long a request waits for approval, and then for its pickup (seconds). */
export const DEVICE_EXPIRES_IN = 600;
/** How often the box is asked to poll (seconds). */
export const DEVICE_INTERVAL = 3;

/** What the person typed or followed → "ABCD-EFGH", or null when it cannot be a code. */
export function normalizeUserCode(raw: string): string | null {
  const chars = raw.toUpperCase().replace(/[\s-]/g, "");
  if (chars.length !== 8) return null;
  for (const c of chars) if (!USER_CODE_ALPHABET.includes(c)) return null;
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** As the approval page sees it: delivered reads as approved, from the person's side. */
export type DeviceStatus = "pending" | "approved" | "denied" | "expired";

/** GET /api/device/:userCode. */
export interface DeviceRequestInfo {
  client: string;
  host: string;
  createdAt: string;
  status: DeviceStatus;
  /** The agents the box asked for (handles or ids), when it named any: the page ticks those. */
  agents?: string[];
}

/** At most this many agents named in one request (approving takes at most as many too). */
export const MAX_DEVICE_AGENTS = 20;
const MAX_AGENT_REF = 100;

/**
 * `agents` on POST /api/device/start: the agents the box asks for, by handle
 * ("owner/name", an "@" allowed) or user id, which the approval page ticks to
 * begin with. Missing or empty is null: the page's own default. Anything else
 * that isn't a short list of strings is an error, said in `error`.
 */
export function parseWantedAgents(raw: unknown): { wanted: string[] | null } | { error: string } {
  if (raw === undefined || raw === null) return { wanted: null };
  if (!Array.isArray(raw)) return { error: "`agents` must be a list of agent handles or ids" };
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return { error: "`agents` must be a list of agent handles or ids" };
    const ref = item.trim().replace(/^@/, "");
    if (!ref || ref.length > MAX_AGENT_REF || /[\s\p{Cc}]/u.test(ref)) return { error: "`agents` holds something that isn't a handle or an id" };
    if (!out.some((o) => o.toLowerCase() === ref.toLowerCase())) out.push(ref);
  }
  if (out.length > MAX_DEVICE_AGENTS) return { error: `At most ${MAX_DEVICE_AGENTS} agents per box` };
  return { wanted: out.length ? out : null };
}

/**
 * Which of the person's agents the approval page ticks to begin with: exactly
 * those the box asked for (by id or handle, case aside), paused or not, when
 * it named any; else every one that isn't paused.
 */
export function preselectAgents(
  agents: ReadonlyArray<{ id: string; handle: string; paused: boolean }>,
  wanted: readonly string[] | undefined,
): Set<string> {
  if (!wanted?.length) return new Set(agents.filter((a) => !a.paused).map((a) => a.id));
  const refs = new Set(wanted.map((w) => w.replace(/^@/, "").toLowerCase()));
  return new Set(agents.filter((a) => refs.has(a.id.toLowerCase()) || refs.has(a.handle.toLowerCase())).map((a) => a.id));
}
