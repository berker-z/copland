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

import type { RunUsage, Spent } from "./types";

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

/** How long the reason a finish gives may be (COPL-136): a line like "exit 1 after 3.8s", never a log. */
export const RUN_REASON_MAX = 160;

/**
 * A finish's reason as it is stored: on one line, trimmed, null when there
 * is none. Undefined when it can't be one: not a string, or longer than
 * RUN_REASON_MAX once on one line.
 */
export function runReason(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length > RUN_REASON_MAX) return undefined;
  return line || null;
}

/** The most a usage count may be: far past any run, well inside a safe integer. */
export const USAGE_MAX = 1e12;

/**
 * A finish's `usage` (COPL-71) as it is stored, null when there is none, or
 * undefined when it can't be one. Token counts are whole numbers from 0 to
 * USAGE_MAX, all four required; costUsd, turns and durationMs are optional
 * and null when left out; resumed is false unless said.
 */
export function runUsage(value: unknown): RunUsage | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const count = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= USAGE_MAX;
  const optional = (x: unknown, ok: (x: unknown) => boolean) => x === undefined || x === null || ok(x);
  const known = new Set(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "turns", "durationMs", "resumed"]);
  if (Object.keys(v).some((k) => !known.has(k))) return undefined;
  if (![v.inputTokens, v.outputTokens, v.cacheReadTokens, v.cacheWriteTokens].every(count)) return undefined;
  const dollars = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1e6;
  if (!optional(v.costUsd, dollars) || !optional(v.turns, count) || !optional(v.durationMs, count)) return undefined;
  if (!optional(v.resumed, (x) => typeof x === "boolean")) return undefined;
  return {
    inputTokens: v.inputTokens as number,
    outputTokens: v.outputTokens as number,
    cacheReadTokens: v.cacheReadTokens as number,
    cacheWriteTokens: v.cacheWriteTokens as number,
    costUsd: (v.costUsd as number | null | undefined) ?? null,
    turns: (v.turns as number | null | undefined) ?? null,
    durationMs: (v.durationMs as number | null | undefined) ?? null,
    resumed: v.resumed === true,
  };
}

/** Every token a run's model read or wrote: in, out, and both ways through the cache. */
export const tokensOf = (u: Pick<RunUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">) =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** "1.2M", "48k", "312": a token count the way the app says it. */
export function tokenCount(n: number): string {
  const short = (x: number) => (x >= 10 ? String(Math.round(x)) : String(Math.round(x * 10) / 10));
  if (n >= 999_500) return `${short(n / 1e6)}M`;
  if (n >= 1e3) return `${short(n / 1e3)}k`;
  return String(n);
}

/** "$0.84", "$12", "<$0.01": a cost the way the app says it. */
export function dollars(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(usd >= 10 ? 0 : 2)}`;
}

/** "in 12k, out 3.1k, cache read 1.2M, cache write 40k": where the tokens went, for a tooltip. */
export const tokenBreakdown = (u: Pick<RunUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">) =>
  `in ${tokenCount(u.inputTokens)}, out ${tokenCount(u.outputTokens)}, cache read ${tokenCount(u.cacheReadTokens)}, cache write ${tokenCount(u.cacheWriteTokens)}`;

/** "$0.84 · 1.3M tokens · 23 turns · resumed": one run's usage in a line (settings). */
export function usageLine(u: RunUsage): string {
  const parts = [u.costUsd === null ? null : dollars(u.costUsd), `${tokenCount(tokensOf(u))} tokens`];
  if (u.turns !== null) parts.push(`${u.turns} turn${u.turns === 1 ? "" : "s"}`);
  if (u.resumed) parts.push("resumed");
  return parts.filter(Boolean).join(" · ");
}

/** "$3.20 · 4.8M tokens · 3 runs": what a task's runs cost, in a line (the task modal). */
export function spentLine(s: Spent): string {
  const runs = `${s.runs} run${s.runs === 1 ? "" : "s"}${s.resumed ? `, ${s.resumed} resumed` : ""}`;
  return [dollars(s.costUsd), `${tokenCount(tokensOf(s))} tokens`, runs].join(" · ");
}

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
 * Why POST /api/messages/:id/claim said no (COPL-124): another run holds a
 * live claim on the message ("claimed", which passes when that run ends or
 * its claim lapses), or its inbox item is read or dismissed already ("read":
 * it has been dealt with, and a read message is never claimed again).
 */
export const MESSAGE_CLAIM_REFUSALS = ["claimed", "read"] as const;
export type MessageClaimRefusal = (typeof MESSAGE_CLAIM_REFUSALS)[number];

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
