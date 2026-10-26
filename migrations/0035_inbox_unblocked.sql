-- ============================================================================
-- A task whose dependencies have all closed tells its assignees (COPL-164).
-- ----------------------------------------------------------------------------
-- An agent given a task that waits on another was refused the claim
-- ("waiting") and, with nothing new in its inbox when the other closed, never
-- came back to it. Now the write that closes (or deletes) the last open task
-- something depends on puts an "unblocked" item in the inbox of each of that
-- dependent's assignees, so their daemons wake as they do for an assignment
-- (repo/inbox.ts unblockedStatement).
--
-- inbox_items is rebuilt (SQLite cannot change a CHECK) with the new kind
-- allowed, exactly as 0025 left it otherwise, and its indexes made again.
-- Nothing references inbox_items, so dropping it is safe.
-- ============================================================================

CREATE TABLE inbox_items_new (
  id         TEXT PRIMARY KEY,
  -- Whose inbox: a person or an agent.
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('assigned', 'mentioned', 'commented', 'message', 'unblocked')),
  -- Null only for a message that points at no task.
  board_id   TEXT REFERENCES boards(id) ON DELETE CASCADE,
  task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  -- The comment, for a mention or a new comment.
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  -- The message, for a message.
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  -- Who did it, and through what ("Claude Code"), like events. For
  -- unblocked, whoever closed the last task it waited on.
  actor_id   TEXT NOT NULL REFERENCES users(id),
  via        TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  read_at    TEXT,
  CHECK ((kind = 'message') = (message_id IS NOT NULL)),
  CHECK (kind = 'message' OR task_id IS NOT NULL),
  CHECK ((board_id IS NULL) = (task_id IS NULL))
);

INSERT INTO inbox_items_new (id, user_id, kind, board_id, task_id, comment_id, message_id, actor_id, via, created_at, read_at)
  SELECT id, user_id, kind, board_id, task_id, comment_id, message_id, actor_id, via, created_at, read_at FROM inbox_items;

DROP TABLE inbox_items;
ALTER TABLE inbox_items_new RENAME TO inbox_items;
CREATE INDEX inbox_items_unread ON inbox_items(user_id, read_at, created_at, id);
CREATE INDEX inbox_items_newest ON inbox_items(user_id, created_at, id);

-- What depends on a task that just closed, read on every closing write.
CREATE INDEX task_dependencies_on ON task_dependencies(depends_on_id);
