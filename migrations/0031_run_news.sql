-- ============================================================================
-- What a run has been told while it works (COPL-139; routes/runs.ts news).
-- ----------------------------------------------------------------------------
-- A runtime that asks for news at every step (the Claude Code hook calling
-- the MCP's heartbeat with its event) is told, once each, the comments and
-- mentions that reached its principal's inbox on the tasks it has claimed.
-- heard_until is where that stopped: the newest item it was told about, or
-- when it was started if it asked and there was nothing yet. Null until it
-- first asks, which is how the task modal knows whether a new comment will
-- reach the run at its next step or only when it next reads the task.
-- ============================================================================

ALTER TABLE runs ADD COLUMN heard_until TEXT;
