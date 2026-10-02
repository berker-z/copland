/* ============================================================================
   Runs and claims: the reads and the statements other modules batch
   (migrations/0015_runs_claims.sql, routes/runs.ts).
   ----------------------------------------------------------------------------
   A claim is live while claimed_until is in the future and its run is
   running; LIVE_CLAIM says so in SQL, and every read of a claim goes
   through it. Nothing deletes a lapsed claim on a timer: it is replaced by
   the next claim, or released with its run, its task, or its assignee.
   ========================================================================== */

import { clientLabel } from "@/domain/clients";
import { RUN_LEASE_MS, runStatus, shortRunId, type RunEnding } from "@/domain/runs";
import type { Run } from "@/domain/types";

const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/** A claim `c` joined to its run `r` holds right now. Uses the database's clock, so it needs no binding. */
export const LIVE_CLAIM = `c.claimed_until > ${NOW_SQL} AND r.status = 'running'`;

const at = (ms: number) => new Date(Date.now() + ms).toISOString();

/** When a claim taken or renewed now lapses. */
export const claimUntil = () => at(RUN_LEASE_MS);

/**
 * What any call through a run keeps alive, at most once a minute so a busy
 * run does not write per call: the run's last_seen_at, and its claims that
 * have not lapsed yet. A claim that lapsed stays lapsed; the run claims
 * again if it still wants the task.
 */
export function runTouchStatements(db: D1Database, runId: string): D1PreparedStatement[] {
  const now = new Date().toISOString();
  return [
    db
      .prepare(`UPDATE runs SET last_seen_at = ?2 WHERE id = ?1 AND status = 'running' AND last_seen_at < ?3`)
      .bind(runId, now, at(-60_000)),
    db
      .prepare(
        `UPDATE task_claims SET claimed_until = ?2
          WHERE run_id = ?1 AND claimed_until > ?3 AND claimed_until < ?4
            AND EXISTS (SELECT 1 FROM runs WHERE id = ?1 AND status = 'running')`,
      )
      .bind(runId, claimUntil(), now, at(RUN_LEASE_MS - 60_000)),
  ];
}

/** The runs of this principal and, for a person, of their agents. */
const RUNS_OF = `(SELECT id FROM runs WHERE user_id = ?1 OR user_id IN (SELECT id FROM users WHERE owner_id = ?1))`;

/** The boards where this principal (or a person's agents) holds a live claim: who to tell when they go. */
export async function claimedBoards(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT t.board_id FROM task_claims c JOIN runs r ON r.id = c.run_id JOIN tasks t ON t.id = c.task_id
        WHERE c.run_id IN ${RUNS_OF} AND ${LIVE_CLAIM}`,
    )
    .bind(userId)
    .all<{ board_id: string }>();
  return results.map((r) => r.board_id);
}

/**
 * Ending everything a principal has running, when it can no longer act: an
 * agent paused or deleted, a person disabled (with their agents). Their
 * credentials stop resolving anyway; this makes the board say so at once
 * instead of when the claims lapse.
 */
export function endRunsStatements(db: D1Database, userId: string): D1PreparedStatement[] {
  return [
    db.prepare(`DELETE FROM task_claims WHERE run_id IN ${RUNS_OF}`).bind(userId),
    db
      .prepare(`UPDATE runs SET status = 'cancelled', ended_at = ?2 WHERE status = 'running' AND id IN ${RUNS_OF}`)
      .bind(userId, new Date().toISOString()),
  ];
}

/** Ending one run: its claims go with it. Guarded on running, so a second finish changes nothing. */
export function finishRunStatements(db: D1Database, runId: string, status: RunEnding): D1PreparedStatement[] {
  return [
    db
      .prepare(`UPDATE runs SET status = ?2, ended_at = ?3 WHERE id = ?1 AND status = 'running'`)
      .bind(runId, status, new Date().toISOString()),
    db.prepare(`DELETE FROM task_claims WHERE run_id = ?1`).bind(runId),
  ];
}

/**
 * Claims on this board that no longer stand: their task closed or was
 * deleted, or their principal is no longer among its assignees. The last
 * statement of every task write, so whatever the write did, it holds.
 */
export function releaseClaimsStatement(db: D1Database, boardId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM task_claims
        WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?1)
          AND (task_id IN (SELECT id FROM tasks WHERE board_id = ?1 AND (completed_at IS NOT NULL OR deleted_at IS NOT NULL))
               OR NOT EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = task_claims.task_id AND a.user_id = task_claims.user_id))`,
    )
    .bind(boardId);
}

interface RunRow {
  id: string;
  user_id: string;
  client: string | null;
  status: "running" | RunEnding;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
  claims: string | null;
}

const RUN_SELECT = `
  SELECT r.id, r.user_id, r.client, r.status, r.started_at, r.last_seen_at, r.ended_at,
         (SELECT group_concat(b.key || '-' || t.number)
            FROM task_claims c JOIN tasks t ON t.id = c.task_id JOIN boards b ON b.id = t.board_id
           WHERE c.run_id = r.id AND c.claimed_until > ${NOW_SQL} AND r.status = 'running') AS claims
    FROM runs r`;

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    short: shortRunId(row.id),
    client: row.client ? clientLabel(row.client) : null,
    status: runStatus(row.status, row.last_seen_at),
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    endedAt: row.ended_at,
    claims: row.claims ? row.claims.split(",") : [],
  };
}

/** One run with its principal, or null. Who may see it is the caller's call. */
export async function findRun(db: D1Database, id: string): Promise<(Run & { userId: string }) | null> {
  const row = await db.prepare(`${RUN_SELECT} WHERE r.id = ?1`).bind(id).first<RunRow>();
  return row ? { ...toRun(row), userId: row.user_id } : null;
}

/** A principal's latest runs, newest first. */
export async function listRuns(db: D1Database, userId: string, limit = 5): Promise<Run[]> {
  const { results } = await db
    .prepare(`${RUN_SELECT} WHERE r.user_id = ?1 ORDER BY r.started_at DESC LIMIT ?2`)
    .bind(userId, limit)
    .all<RunRow>();
  return results.map(toRun);
}
