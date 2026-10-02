-- ============================================================================
-- Runs and claims (docs/AGENT-IDENTITIES.md, the fourth layer).
-- ----------------------------------------------------------------------------
-- A run is one working session of a principal: an agent's, usually, though a
-- person's script may declare one too. Whoever launches the runtime (a daemon,
-- a script) starts it with the principal's own token and gets back a secret
-- bound to the run ("cplr_…"). Requests with that secret resolve to the same
-- principal, scope and token as the one that started it, plus the run: they
-- stamp run_id on the events they write and keep the run alive. Only its hash
-- is kept, like every other secret. It stops working the moment the run ends,
-- or its token is revoked or expires, or its principal is paused or disabled.
--
-- There is no stale status and nothing sweeps: a running run not heard from
-- for longer than the lease (RUN_LEASE_MS in src/domain/runs.ts) reads as
-- stale wherever it is shown.
--
-- A claim is a run saying "I am on this task right now". One per task, as a
-- lease: claimed_until moves forward while the run keeps calling, and a claim
-- is live only while claimed_until is in the future and its run is running.
-- A dead claim stays in the table until something replaces or releases it;
-- every read checks both conditions. Assignment is the durable part and lives
-- in task_assignees as before: a claim never outlives the run, an assignment
-- does.
-- ============================================================================

CREATE TABLE runs (
  id           TEXT PRIMARY KEY,
  -- The principal: an agent or a person.
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The token that started it. The run is never more than it: same scope,
  -- and revoking it ends the run's credential too.
  token_id     TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,                -- sha-256 hex of the run's secret
  -- The program doing the work ("codex"), as the starter or the MCP client said.
  client       TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at     TEXT
);
CREATE INDEX runs_user ON runs(user_id, started_at);

CREATE TABLE task_claims (
  task_id       TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- The run's principal, kept here so "is the claimer still assigned" is one lookup.
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  claimed_until TEXT NOT NULL
);
CREATE INDEX task_claims_run ON task_claims(run_id);

-- Which run made a change, when it came through a run's credential.
ALTER TABLE events ADD COLUMN run_id TEXT;
