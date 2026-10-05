-- ============================================================================
-- Runs the cron ended as stale, until their launcher says how they really
-- ended (COPL-148; deadRuns.ts, routes/runs.ts).
-- ----------------------------------------------------------------------------
-- A supervised run nobody hears from for its lease is ended by the cron's
-- sweep as failed, a strike on its task. When Copland itself was down, that
-- silence was ours, not the run's: its launcher kept trying to finish it and
-- lands the finish once Copland answers again. swept_at is when the sweep
-- ended it; a finish that lands after that replaces the sweep's "failed"
-- with the launcher's ending, once, and clears it. Null for every other run.
-- ============================================================================

ALTER TABLE runs ADD COLUMN swept_at TEXT;
