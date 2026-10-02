-- ============================================================================
-- A task's participants hear about new comments (COPL-24).
-- ----------------------------------------------------------------------------
-- An answer written in the thread, without tagging whoever asked, reached
-- nobody. Now a new comment puts a "commented" item in the inbox of everyone
-- taking part in the task: its creator, its assignees, whoever has commented
-- on it or been mentioned on it. Someone the comment @mentions gets only the
-- "mentioned" item.
--
-- SQLite cannot change a CHECK constraint, so inbox_items is rebuilt with the
-- new kind allowed. Nothing references inbox_items, so dropping it is safe.
-- ============================================================================

CREATE TABLE inbox_items_new (
  id         TEXT PRIMARY KEY,
  -- Whose inbox: a person or an agent.
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('assigned', 'mentioned', 'commented')),
  board_id   TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- The comment, for a mention or a new comment.
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  -- Who did it, and through what ("Claude Code"), like events.
  actor_id   TEXT NOT NULL REFERENCES users(id),
  via        TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  read_at    TEXT
);

INSERT INTO inbox_items_new (id, user_id, kind, board_id, task_id, comment_id, actor_id, via, created_at, read_at)
  SELECT id, user_id, kind, board_id, task_id, comment_id, actor_id, via, created_at, read_at FROM inbox_items;

DROP TABLE inbox_items;
ALTER TABLE inbox_items_new RENAME TO inbox_items;
CREATE INDEX inbox_items_user ON inbox_items(user_id, read_at, created_at);
