/* ============================================================================
   The live connection's state, apart from lib/live.ts so the API client and
   the query definitions can read it without importing the listener.
   ========================================================================== */

/** This tab, sent with every request so the Worker can say whose write it was. */
export const TAB_ID = crypto.randomUUID();

let live = false;

/** Whether this tab's live connection is up; fallback polls stand down while it is. */
export const isLive = () => live;

export function setLive(value: boolean): void {
  live = value;
}

let catchingUp = false;

/**
 * Whether the live socket catches this tab up when it is shown again or comes
 * back online. React Query's own refetch on focus and on reconnect stand down
 * while it does (main.tsx), so that is one round of refetches, not two.
 */
export const liveCatchesUp = () => catchingUp;

export function setCatchingUp(value: boolean): void {
  catchingUp = value;
}
