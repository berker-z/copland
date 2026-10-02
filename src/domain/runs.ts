/* ============================================================================
   Runs and claims: the rules both sides read (migrations/0015_runs_claims.sql).
   ----------------------------------------------------------------------------
   One lease length for everything, on purpose: a run not heard from for that
   long is stale, and a claim not renewed for that long has lapsed. Any call a
   run makes renews both, so the two always agree. Nothing sweeps; whatever
   reads a run or a claim compares against the clock.
   ========================================================================== */

/** How long a run's silence is tolerated: its claims lapse and it reads as stale after this. */
export const RUN_LEASE_MS = 10 * 60 * 1000;

export const RUN_ENDINGS = ["completed", "failed", "cancelled"] as const;
export type RunEnding = (typeof RUN_ENDINGS)[number];

/** "stale" is never stored: it is a running run past its lease. */
export type RunStatus = "running" | "stale" | RunEnding;

/** How a run is named to people: "run 8f31". */
export function shortRunId(id: string): string {
  return id.replace(/-/g, "").slice(0, 4);
}

/** A stored status as it should be shown, given when the run was last heard from. */
export function runStatus(stored: "running" | RunEnding, lastSeenAt: string, now = Date.now()): RunStatus {
  return stored === "running" && Date.parse(lastSeenAt) + RUN_LEASE_MS < now ? "stale" : stored;
}
