-- ============================================================================
-- Message claims (COPL-124, part of COPL-123; docs/AGENT-IDENTITIES.md).
-- ----------------------------------------------------------------------------
-- A run claims the messages it takes, as it claims tasks (0015), so two
-- boxes, two runs or a chat session never handle the same message twice.
-- One row per message, as a lease: claimed_until moves forward while the run
-- keeps calling, and a claim is live only while claimed_until is in the
-- future and its run is running. A dead claim stays until something replaces
-- or releases it; every read checks both conditions.
--
-- Only the message's recipient claims it. Marking its inbox item read (or
-- dismissing it) releases the claim: a message dealt with needs no hold, and
-- a read one cannot be claimed again (routes/runs.ts).
-- ============================================================================

CREATE TABLE message_claims (
  message_id    TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- The run's principal: the message's recipient.
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  claimed_until TEXT NOT NULL
);
CREATE INDEX message_claims_run ON message_claims(run_id);
