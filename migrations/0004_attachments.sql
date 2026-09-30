-- ============================================================================
-- Attachments on tasks: images and files in R2, and links.
-- ----------------------------------------------------------------------------
-- Ported from the work tracker. Bytes never enter D1; a file row carries its
-- R2 object key, a link row its URL. Who may read a file is whoever may read
-- its task's board (worker/routes/uploads.ts checks on every GET).
-- ============================================================================

CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  kind       TEXT NOT NULL CHECK (kind IN ('image', 'file', 'link')),
  -- R2 object key for files and images; null for links.
  key        TEXT UNIQUE,
  -- The address, for links; null otherwise.
  url        TEXT,
  added_by   TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((kind = 'link') = (url IS NOT NULL)),
  CHECK ((kind = 'link') = (key IS NULL))
);
CREATE INDEX attachments_task ON attachments(task_id, created_at);
