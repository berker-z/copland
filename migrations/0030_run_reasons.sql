-- ============================================================================
-- How a run ended, in a line (COPL-136; routes/runs.ts).
-- ----------------------------------------------------------------------------
-- Whatever finishes a run may say why it ended: "exit 1 after 3.8s",
-- "did not start: bwrap: No such file or directory". Short and on one line
-- (RUN_REASON_MAX, src/domain/runs.ts), never a log's contents, since a log
-- can hold anything. Null when nobody said, and for every run before this.
-- Settings shows it on the run, and a dead run's put-back move says it in
-- the task's history.
-- ============================================================================

ALTER TABLE runs ADD COLUMN reason TEXT;
