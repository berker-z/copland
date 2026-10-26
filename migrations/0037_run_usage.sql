-- ============================================================================
-- What a run cost (COPL-71; routes/runs.ts, domain/runs.ts runUsage).
-- ----------------------------------------------------------------------------
-- A run's launcher reads its usage from the runtime when it ends (Claude
-- Code's --output-format json result) and sends it with the run's finish:
-- tokens in, out, read from the cache and written to it, what the runtime
-- says it cost in dollars when it says, its turns, how long the runtime
-- worked, and whether it resumed an earlier session. Null for every run
-- before this and for a run nobody reported on; input_tokens IS NOT NULL is
-- "reported". Taken once: a later finish doesn't change it.
--
-- task_id is the first task the run claimed, so a task sums its runs and a
-- parent its subtree's (repo/tasks.ts). Null for a run that claimed nothing
-- (a message run, or one that only answered on a task it couldn't take).
-- ============================================================================

ALTER TABLE runs ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE runs ADD COLUMN output_tokens INTEGER;
ALTER TABLE runs ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE runs ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE runs ADD COLUMN cost_usd REAL;
ALTER TABLE runs ADD COLUMN turns INTEGER;
ALTER TABLE runs ADD COLUMN duration_ms INTEGER;
ALTER TABLE runs ADD COLUMN resumed INTEGER;

CREATE INDEX runs_task ON runs(task_id) WHERE task_id IS NOT NULL;
