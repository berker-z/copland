-- ============================================================================
-- Agents: principals of their own, owned by a person (docs/AGENT-IDENTITIES.md).
-- ----------------------------------------------------------------------------
-- An agent is a row in users, so it can be a board member, an assignee, a
-- comment author and a history actor like anyone: everything that points at
-- a person already points at users(id). What only agents have lives in
-- `agents`, and what personal data of its owner it may reach in
-- `agent_grants`.
--
-- users.email stays NOT NULL. Relaxing it means rebuilding the table, and in
-- D1 dropping users cascades into every table that references it (sessions,
-- memberships, settings...), which was tried on a copy and emptied them. So
-- an agent's email is "<id>@agent.invalid": the .invalid domain is reserved,
-- Google never verifies an address there, so nobody signs in as an agent,
-- and repo/users.ts reports it as no email at all.
--
-- An agent's handle is "owner/name", stored whole so every query reading
-- users.handle keeps working; renaming the owner rewrites them.
-- ============================================================================

ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'agent'));
-- The person an agent belongs to and acts for. Null for people.
ALTER TABLE users ADD COLUMN owner_id TEXT REFERENCES users(id);
CREATE INDEX users_owner ON users(owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE agents (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- The part after the slash.
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- Who may assign it work: its owner (and the owner's other agents), or
  -- anyone on a board it is on.
  work_from   TEXT NOT NULL DEFAULT 'owner' CHECK (work_from IN ('owner', 'members')),
  -- A paused agent's tokens stop working until it is resumed.
  paused_at   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Personal data of the owner an agent may reach. Board work needs no grant:
-- it follows board membership, capped by the owner's own role.
CREATE TABLE agent_grants (
  agent_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (name IN ('calendar:read', 'notes:read', 'notes:write')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (agent_id, name)
);
