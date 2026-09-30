-- ============================================================================
-- Calendars: personal, like settings. Nobody sees anyone else's.
-- ----------------------------------------------------------------------------
-- A Google account is connected once (a separate consent from sign-in, with
-- calendar scopes) and its refresh token is kept encrypted under VAULT_KEY.
-- Each of its calendars is a row in `calendars`, so visibility and colour
-- are ours to keep. An ICS feed is a calendar with no account; its URL is
-- usually a secret link, so it is encrypted too.
--
-- Numbered 0003 because 0002 is taken by the API-access migration landing
-- alongside it.
-- ============================================================================

CREATE TABLE calendar_accounts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  -- The refresh token, sealed with context "<user_id>:calendar:<id>".
  iv          TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Set when Google refuses the refresh token (revoked, expired): the
  -- account shows as needing a reconnect instead of silently showing nothing.
  broken_at   TEXT,
  UNIQUE (user_id, email)
);

CREATE TABLE calendars (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('google', 'ics')),
  -- google: the account and Google's calendar id.
  account_id   TEXT REFERENCES calendar_accounts(id) ON DELETE CASCADE,
  external_id  TEXT,
  -- ics: the feed URL, sealed with context "<user_id>:calendar:<id>".
  iv           TEXT,
  ciphertext   TEXT,
  name         TEXT NOT NULL,
  tone         INTEGER NOT NULL DEFAULT 0 CHECK (tone BETWEEN 0 AND 7),
  visible      INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  -- Google's access role; events can be written only where it is owner or writer.
  writable     INTEGER NOT NULL DEFAULT 0 CHECK (writable IN (0, 1)),
  is_primary   INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (kind = 'google' AND account_id IS NOT NULL AND external_id IS NOT NULL) OR
    (kind = 'ics' AND iv IS NOT NULL AND ciphertext IS NOT NULL)
  )
);
CREATE INDEX calendars_user ON calendars(user_id);
CREATE UNIQUE INDEX calendars_google ON calendars(account_id, external_id) WHERE kind = 'google';
