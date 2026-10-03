/* ============================================================================
   Runs and claims: the rules both sides read (migrations/0015_runs_claims.sql,
   0018_interactive_runs.sql).
   ----------------------------------------------------------------------------
   Two kinds of run. A supervised run is started by a launcher (the daemon, a
   script) that holds the process and renews the run while it lives. An
   interactive run is a chat session (Claude Code, Codex in a terminal): the
   Worker makes one for a credential the first time it claims a task without
   a run's secret, and any call with that credential renews it (a Claude Code
   hook calls the MCP's `heartbeat` on every tool use).

   One lease per kind, the same for a run and its claims: a run not heard from
   for that long is stale, and its claims not renewed for that long have
   lapsed. Any call a run makes renews both, so the two always agree.
   Whatever reads a run or a claim compares against the clock; the one sweep
   (worker/deadRuns.ts, on the Worker's cron) ends supervised runs past their
   lease so the tasks they held go back (COPL-97).
   ========================================================================== */

export const RUN_KINDS = ["supervised", "interactive"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** How long a supervised run's silence is tolerated: its claims lapse and it reads as stale after this. */
export const RUN_LEASE_MS = 10 * 60 * 1000;

/**
 * The same for an interactive run. A little longer, because a chat session
 * goes quiet while its person reads and types; with the hook renewing it on
 * every tool use, fifteen quiet minutes means nobody is at the session.
 */
export const INTERACTIVE_LEASE_MS = 15 * 60 * 1000;

export const leaseFor = (kind: RunKind) => (kind === "interactive" ? INTERACTIVE_LEASE_MS : RUN_LEASE_MS);

export const RUN_ENDINGS = ["completed", "failed", "cancelled"] as const;
export type RunEnding = (typeof RUN_ENDINGS)[number];

/** "stale" is never stored: it is a running run past its lease. */
export type RunStatus = "running" | "stale" | RunEnding;

/** How a run is named to people: "run 8f31". */
export function shortRunId(id: string): string {
  return id.replace(/-/g, "").slice(0, 4);
}

/** A stored status as it should be shown, given when the run was last heard from. */
export function runStatus(stored: "running" | RunEnding, lastSeenAt: string, kind: RunKind, now = Date.now()): RunStatus {
  return stored === "running" && Date.parse(lastSeenAt) + leaseFor(kind) < now ? "stale" : stored;
}

/**
 * Why POST /api/tasks/:id/claim said no, as the `code` of its 409: the task
 * is closed, it is assigned to others and not the claimer, another run holds
 * a live claim on it, or a task it depends on is still open (COPL-78). A
 * daemon tells them apart: "claimed" passes when that run ends, "waiting"
 * when the tasks it waits on close, the first two do not.
 */
export const CLAIM_REFUSALS = ["closed", "assigned_elsewhere", "claimed", "waiting"] as const;
export type ClaimRefusal = (typeof CLAIM_REFUSALS)[number];

/**
 * How a supervised run ended, as far as the tasks it held are concerned
 * (COPL-97): failed (the runtime or the agent said so), stale (nobody heard
 * from it for its lease: the launcher or the machine went away), cancelled
 * (a person stopped it) or interrupted (its launcher stopped it for its own
 * reasons, shutting down or reloading, and nobody decided against the work).
 */
export type RunDeath = "failed" | "stale" | "cancelled" | "interrupted";

/** How many dead runs in a row a task takes before it waits for a person instead of another run. */
export const STRIKES = 3;

/**
 * The stage category a task goes back to when the supervised run that held
 * it dies. `strikes` is how many runs in a row have now died on it, this one
 * included (strikesOf). A task a person stopped is parked; one interrupted
 * goes back to be picked up, and so does one whose run died, until the
 * third in a row, which waits for a person instead of looping.
 */
export function returnTo(death: RunDeath, strikes: number): "todo" | "backlog" | "blocked" {
  if (death === "cancelled") return "backlog";
  if (death === "interrupted") return "todo";
  return strikes >= STRIKES ? "blocked" : "todo";
}

/**
 * The runs that claimed a task since a person last touched it, newest first,
 * as stored: how many died in a row, counting back from the newest. A run
 * that completed, or was cancelled, ends the streak.
 */
export function strikesOf(endings: Array<"running" | RunEnding>): number {
  let n = 0;
  for (const e of endings) {
    if (e !== "failed") break;
    n++;
  }
  return n;
}
