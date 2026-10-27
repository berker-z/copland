-- ============================================================================
-- The runtime account a run is on (COPL-234, part of COPL-231).
-- ----------------------------------------------------------------------------
-- A daemon caps the runs going at once on each runtime account (a Claude or
-- Codex subscription) across its own agents (COPL-232). Two machines signed
-- in to the same subscription share that cap through Copland: the daemon
-- sends the account with POST /api/runs, and the run is refused while the
-- owner's live runs on it are at the cap the daemon sends with it.
--
-- runs.account is the daemon's hash of the account (never an email or the
-- runtime's own id), null when it didn't say (a script, an older daemon, a
-- chat session, a runtime whose sign-in it couldn't read). An account is
-- one person's: the count takes the runs of the owner and their agents.
-- ============================================================================

ALTER TABLE runs ADD COLUMN account TEXT;
CREATE INDEX runs_account ON runs(account, last_seen_at) WHERE account IS NOT NULL AND status = 'running';
