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
}
