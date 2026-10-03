/* ============================================================================
   Housekeeping on the cron (COPL-112, part of COPL-111).
   ----------------------------------------------------------------------------
   Rows that nothing reads any more, deleted a batch at a time:

     sessions      past expires_at (sign-in still deletes them on its way in)
     oauth_codes   past expires_at (so does the OAuth token exchange)
     runs          ended more than RUN_KEEP_MS ago. Their task_claims cascade
                   (ending a run deletes them already) and task_files.run_id
                   goes to null. events.run_id has no foreign key: the
                   history shows it as shortRunId of the id it stored, so a
                   deleted run still reads "run 8f31" there. An agent's
                   settings page lists its latest runs among those kept.
     api_tokens    revoked, or expired with no refresh left, more than
                   TOKEN_KEEP_MS ago, that no run still needs: none running
                   and none ended within RUN_KEEP_MS, since a run cascades on
                   its token. listTokens shows neither kind, so settings
                   loses nothing.
     task_files    of tasks closed or deleted more than FILES_KEEP_MS ago.
                   Overlap reads open tasks only; the task's own list stops
                   showing in its overlap read then.

   Device requests are tidied by their own sweep (routes/device.ts), which
   the cron calls too. Nothing here is anyone's to see, so nobody is
   notified. Each statement deletes at most BATCH rows, so one tick stays
   cheap and a backlog drains over the next ones.

   No value imports, so checks/housekeeping.check.ts runs it on node:sqlite.
   ========================================================================== */

/** How long an ended run is kept. */
export const RUN_KEEP_MS = 30 * 24 * 3600 * 1000;
/** How long a revoked or expired token is kept. */
export const TOKEN_KEEP_MS = 30 * 24 * 3600 * 1000;
/** How long a closed task keeps its changed files. */
export const FILES_KEEP_MS = 7 * 24 * 3600 * 1000;
/** Rows per table per tick. */
export const HOUSEKEEPING_BATCH = 500;

/** The deletes, in order: runs go before the tokens they would hold on to. */
export function housekeepingStatements(db: D1Database, now: Date, batch = HOUSEKEEPING_BATCH): D1PreparedStatement[] {
  const at = now.getTime();
  const iso = now.toISOString();
  const runsBefore = new Date(at - RUN_KEEP_MS).toISOString();
  const tokensBefore = new Date(at - TOKEN_KEEP_MS).toISOString();
  const filesBefore = new Date(at - FILES_KEEP_MS).toISOString();
  return [
    db
      .prepare(`DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at < ?1 LIMIT ?2)`)
      .bind(iso, batch),
    db
      .prepare(`DELETE FROM oauth_codes WHERE code_hash IN (SELECT code_hash FROM oauth_codes WHERE expires_at < ?1 LIMIT ?2)`)
      .bind(iso, batch),
    db
      .prepare(
        `DELETE FROM runs WHERE id IN (
           SELECT id FROM runs WHERE status != 'running' AND coalesce(ended_at, last_seen_at) < ?1 LIMIT ?2)`,
      )
      .bind(runsBefore, batch),
    db
      .prepare(
        `DELETE FROM api_tokens WHERE id IN (
           SELECT t.id FROM api_tokens t
            WHERE (t.revoked_at < ?1
                   OR (t.revoked_at IS NULL AND t.expires_at < ?1
                       AND (t.refresh_expires_at IS NULL OR t.refresh_expires_at < ?1)))
              AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.token_id = t.id
                                AND (r.status = 'running' OR coalesce(r.ended_at, r.last_seen_at) >= ?2))
            LIMIT ?3)`,
      )
      .bind(tokensBefore, runsBefore, batch),
    db
      .prepare(
        `DELETE FROM task_files WHERE task_id IN (
           SELECT f.task_id FROM task_files f JOIN tasks t ON t.id = f.task_id
            WHERE t.completed_at < ?1 OR t.deleted_at < ?1 LIMIT ?2)`,
      )
      .bind(filesBefore, batch),
  ];
}

/** One tick's housekeeping: how many rows each statement deleted, in order. */
export async function housekeep(db: D1Database, now = new Date()): Promise<number[]> {
  const results = await db.batch(housekeepingStatements(db, now));
  return results.map((r) => r.meta.changes ?? 0);
}
