-- ============================================================================
-- Copland: the initial schema.
-- ----------------------------------------------------------------------------
-- Two kinds of data, with different privacy rules:
--
--   personal   settings, vault, notes: keyed by user_id and only ever read
--              by that user. No sharing, no roles.
--   boards     everything task-shaped. A board has members with roles, and
--              every read or write of a board's contents checks membership
--              (worker/access.ts). A personal todo list is a board with one
--              member; a project with a friend is the same board with two.
--
-- Ids are UUIDs (text). Times are ISO-8601 UTC text. Calendar dates are
-- YYYY-MM-DD text. Booleans are 0/1.
-- ============================================================================

-- --------------------------------------------------------------- people -----

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,          -- lowercased
  -- Google's stable account id. Null until the first real sign-in (a dev
  -- user, or a row created some other way before Google has seen it).
  google_sub  TEXT UNIQUE,
  name        TEXT NOT NULL,
  picture     TEXT,
  is_admin    INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- A disabled user cannot sign in and has no live sessions. Their boards
  -- and history stay.
  disabled_at TEXT
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,             -- sha-256 hex of the cookie value
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at   TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- An invite link: /auth/invite/<code>. Only the hash is stored, so the list
-- of invites cannot be turned back into working links. An invite may be
-- locked to one email, and may carry a board to join on arrival.
CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL UNIQUE,
  email       TEXT,                          -- null: anyone holding the link
  board_id    TEXT REFERENCES boards(id) ON DELETE CASCADE,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT NOT NULL,
  used_by     TEXT REFERENCES users(id),
  used_at     TEXT
);

-- ------------------------------------------------------------- personal -----

-- One row per setting. Values are JSON; domain/settings.ts owns the keys and
-- their shapes, so an unknown key is refused at the route, not here.
CREATE TABLE settings (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, key)
);

-- API keys people save for their widgets (CoinGecko, OpenAI, ...). AES-GCM
-- under the VAULT_KEY secret, with user_id and name as associated data, so a
-- row copied to another user or name fails to decrypt. The plaintext never
-- goes back to the browser; the Worker uses it to call the service.
CREATE TABLE vault (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  iv         TEXT NOT NULL,                  -- base64
  ciphertext TEXT NOT NULL,                  -- base64
  -- Last four characters, for the settings screen ("••••a1b2").
  hint       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, name)
);

CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX notes_user ON notes(user_id, updated_at);

-- ---------------------------------------------------------------- boards ----

CREATE TABLE boards (
  id            TEXT PRIMARY KEY,
  -- Short uppercase prefix for task keys (CPL-12). Unique per instance so a
  -- key names one task wherever it is pasted.
  key           TEXT NOT NULL UNIQUE CHECK (key GLOB '[A-Z]*' AND length(key) BETWEEN 2 AND 6),
  name          TEXT NOT NULL,
  -- Every user has exactly one inbox: their private board, which the
  -- dashboard's tasks pane shows. It cannot be shared or deleted.
  is_inbox      INTEGER NOT NULL DEFAULT 0 CHECK (is_inbox IN (0, 1)),
  -- Planning fields (parent, level, dependencies) are shown and accepted
  -- only where this is on.
  has_planning  INTEGER NOT NULL DEFAULT 0 CHECK (has_planning IN (0, 1)),
  next_number   INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at   TEXT
);

-- owner: everything, including members and deleting the board.
-- editor: tasks, comments, labels, stages.
-- viewer: reads, and comments.
CREATE TABLE board_members (
  board_id  TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  added_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX board_members_user ON board_members(user_id);
-- Each user's inbox board. The primary key is what keeps it to one.
CREATE TABLE inboxes (
  user_id  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  board_id TEXT NOT NULL UNIQUE REFERENCES boards(id) ON DELETE CASCADE
);

CREATE TABLE stages (
  id        TEXT PRIMARY KEY,
  board_id  TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  name      TEXT NOT NULL,
  -- What the stage means, whatever it is called: done and cancelled stages
  -- close a task (completed_at), backlog is not yet started.
  category  TEXT NOT NULL CHECK (category IN ('backlog', 'active', 'done', 'cancelled')),
  tone      INTEGER NOT NULL DEFAULT 0 CHECK (tone BETWEEN 0 AND 7)
);
CREATE INDEX stages_board ON stages(board_id, position);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  board_id     TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  title        TEXT NOT NULL,
  brief        TEXT NOT NULL DEFAULT '',     -- markdown
  stage_id     TEXT NOT NULL REFERENCES stages(id),
  -- Order within a stage. Fractional so a drag writes one row.
  rank         REAL NOT NULL DEFAULT 0,
  priority     TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  start_date   TEXT,
  due_date     TEXT,
  completed_at TEXT,
  -- Planning (boards.has_planning).
  parent_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  level        TEXT CHECK (level IN ('epic', 'story', 'task', 'milestone')),
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at   TEXT,
  UNIQUE (board_id, number),
  CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date)
);
CREATE INDEX tasks_board ON tasks(board_id, stage_id, rank) WHERE deleted_at IS NULL;
CREATE INDEX tasks_parent ON tasks(parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE task_assignees (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_assignees_user ON task_assignees(user_id);

CREATE TABLE task_dependencies (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);

CREATE TABLE labels (
  id       TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  tone     INTEGER NOT NULL DEFAULT 0 CHECK (tone BETWEEN 0 AND 7)
);
CREATE UNIQUE INDEX labels_name ON labels(board_id, lower(name));

CREATE TABLE task_labels (
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  edited_at  TEXT
);
CREATE INDEX comments_task ON comments(task_id, created_at);

-- The activity log for boards: who changed what, with before/after as JSON.
CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  board_id   TEXT REFERENCES boards(id) ON DELETE CASCADE,
  task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id   TEXT REFERENCES users(id),
  kind       TEXT NOT NULL,
  before     TEXT,
  after      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX events_board ON events(board_id, created_at);
CREATE INDEX events_task ON events(task_id, created_at);
