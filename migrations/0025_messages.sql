-- ============================================================================
-- Messages: a short note to an agent, or from one to its owner (COPL-106).
-- ----------------------------------------------------------------------------
-- A message lands in its recipient's inbox as a new kind of item, "message",
-- optionally pointing at a task. Who may message whom is src/domain/
-- messages.ts. The text and its sender live in `messages`, so a reply can
-- name the message it answers even after the item is dismissed.
--
-- inbox_items is rebuilt (SQLite cannot change a CHECK or a NOT NULL) with
-- board_id and task_id nullable, "message" allowed, and message_id; a
-- task-less message is always visible to its recipient. The 0014 indexes are
-- made again. Nothing references inbox_items, so dropping it is safe.
-- ============================================================================

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  sender_id    TEXT NOT NULL REFERENCES users(id),
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  -- The message this one answers, when it is a reply.
  reply_to     TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX messages_recipient ON messages(recipient_id, created_at);

CREATE TABLE inbox_items_new (
  id         TEXT PRIMARY KEY,
  -- Whose inbox: a person or an agent.
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('assigned', 'mentioned', 'commented', 'message')),
  -- Null only for a message that points at no task.
  board_id   TEXT REFERENCES boards(id) ON DELETE CASCADE,
  task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  -- The comment, for a mention or a new comment.
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  -- The message, for a message.
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  -- Who did it, and through what ("Claude Code"), like events.
  actor_id   TEXT NOT NULL REFERENCES users(id),
  via        TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  read_at    TEXT,
  CHECK ((kind = 'message') = (message_id IS NOT NULL)),
  CHECK (kind = 'message' OR task_id IS NOT NULL),
  CHECK ((board_id IS NULL) = (task_id IS NULL))
);

INSERT INTO inbox_items_new (id, user_id, kind, board_id, task_id, comment_id, actor_id, via, created_at, read_at)
  SELECT id, user_id, kind, board_id, task_id, comment_id, actor_id, via, created_at, read_at FROM inbox_items;

DROP TABLE inbox_items;
ALTER TABLE inbox_items_new RENAME TO inbox_items;
CREATE INDEX inbox_items_unread ON inbox_items(user_id, read_at, created_at, id);
CREATE INDEX inbox_items_newest ON inbox_items(user_id, created_at, id);
