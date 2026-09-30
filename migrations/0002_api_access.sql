-- ============================================================================
-- API access: personal tokens, OAuth for AI assistants, and "via" on the log.
-- ----------------------------------------------------------------------------
-- Copland can be used from outside the browser: Claude (claude.ai, the
-- desktop app, Claude Code), another MCP client, or a script. Whatever the
-- client, it acts as one user with exactly that user's board roles; a token
-- is another way of being signed in, not a separate identity with rights of
-- its own.
--
-- Two ways to get a token, one table:
--   personal   made by the user in settings, shown once, pasted into a tool
--              as "Authorization: Bearer cpl_…"
--   oauth      issued to an app that went through /oauth/authorize (the
--              "Connect" button in claude.ai), with a refresh token
--
-- Only hashes are stored, like sessions. `scope` is read or write: a read
-- token cannot change anything, whatever its owner may do.
--
-- events.via records what made a change ("Claude", "Claude Code"), so a
-- task's history can say so. Null means the web app.
-- ============================================================================

CREATE TABLE api_tokens (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('personal', 'oauth')),
  -- personal: what the user called it; oauth: the app's registered name
  name               TEXT NOT NULL,
  scope              TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  token_hash         TEXT NOT NULL UNIQUE,          -- sha-256 hex of the secret
  refresh_hash       TEXT UNIQUE,                   -- oauth only
  client_id          TEXT,                          -- oauth only
  -- The MCP client that last introduced itself with this token ("claude-code").
  agent              TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at       TEXT,
  -- Null: a personal token made without an expiry. OAuth tokens always expire.
  expires_at         TEXT,
  refresh_expires_at TEXT,
  revoked_at         TEXT
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);

-- Apps that registered themselves (OAuth dynamic client registration). A
-- registration grants nothing: a person still has to sign in and approve.
-- Public clients only, so there is no secret column.
CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  -- JSON array; a redirect must match one exactly.
  redirect_uris TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Ten-minute, single-use authorization codes, bound to PKCE.
CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,                     -- S256
  scope          TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  expires_at     TEXT NOT NULL
);

ALTER TABLE events ADD COLUMN via TEXT;
