-- ============================================================================
-- Where each agent runs (COPL-176, part of COPL-135; routes/hosts.ts).
-- ----------------------------------------------------------------------------
-- An agent's daemon reports the machine it runs on with the agent's own
-- token: its hostname, the box's version, and what it can do there
-- (domain/hosts.ts HostCapabilities). One row per agent and hostname,
-- replaced on every report. One agent per place is the rule: choosing a host
-- means assigning to the right agent, and two rows for one agent are what
-- the owner is warned about once both are live at the same time.
--
-- runs.host is the hostname a run's launcher said it started the run on,
-- null when it didn't say (a script, an older daemon, a chat session).
-- ============================================================================

CREATE TABLE agent_hosts (
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hostname           TEXT NOT NULL,
  -- The box's version, as the daemon reported it.
  version            TEXT NOT NULL,
  -- JSON: { runtimes: [{ name, onPath, loggedIn }], repos: [{ repo, clone, push, detail }] }.
  capabilities       TEXT NOT NULL,
  first_reported_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_reported_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, hostname)
);

ALTER TABLE runs ADD COLUMN host TEXT;
