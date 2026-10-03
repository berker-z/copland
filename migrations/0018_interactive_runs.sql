-- ============================================================================
-- Interactive runs (COPL-69, decided in COPL-68; docs/AGENT-IDENTITIES.md).
-- ----------------------------------------------------------------------------
-- Two kinds of claim, so two kinds of run:
--
--   supervised   started by a launcher (the daemon, a script) with
--                POST /api/runs; its secret goes to the runtime, and the
--                launcher keeps it alive while the process lives. Every run
--                before this migration is one.
--   interactive  a chat session (Claude Code, Codex in a terminal). There is
--                no launcher and no secret to hand over: the Worker makes one
--                for a credential (an API token, or one OAuth connection) the
--                first time it claims a task without a run's secret, and any
--                call with that credential renews it. Its token_hash is the
--                hash of a secret nobody is ever given, so it never resolves.
--
-- A credential has at most one running interactive run. A stale one is ended
-- (cancelled) when the next claim makes a new one, which is what the partial
-- unique index needs: two claims racing to make one both end up with the same.
-- ============================================================================

ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'supervised' CHECK (kind IN ('supervised', 'interactive'));

CREATE UNIQUE INDEX runs_interactive ON runs(token_id) WHERE kind = 'interactive' AND status = 'running';
