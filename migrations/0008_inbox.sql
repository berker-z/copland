-- ============================================================================
-- Inboxes and mentions (docs/DIRECTION.md, step 4).
-- ----------------------------------------------------------------------------
-- Every principal, person or agent, has an inbox: things that happened which
-- need their attention. For now that is being assigned a task by someone
-- else, and being @mentioned in a comment. An agent reads its inbox over the
-- MCP; a person sees it under the bell in the statusline.
--
-- Mentions are resolved when the comment is written, against the members of
-- the task's board, and kept as ids. The comment text stays what was typed.
-- Renaming someone, or a deleted agent's name being reused, never moves a
-- mention to someone else.
--
-- `events` already means the board's history, so these are inbox_items.
-- ============================================================================

CREATE TABLE comment_mentions (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (comment_id, user_id)
);

CREATE TABLE inbox_items (
  id         TEXT PRIMARY KEY,
  -- Whose inbox: a person or an agent.
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('assigned', 'mentioned')),
  board_id   TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- The comment, for a mention.
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  -- Who did it, and through what ("Claude Code"), like events.
  actor_id   TEXT NOT NULL REFERENCES users(id),
  via        TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  read_at    TEXT
);
CREATE INDEX inbox_items_user ON inbox_items(user_id, read_at, created_at);
