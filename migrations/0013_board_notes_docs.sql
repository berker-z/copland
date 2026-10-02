-- ============================================================================
-- Board notes and board docs (COPL-27).
-- ----------------------------------------------------------------------------
-- Notes: a board's rules for working on it, free markdown up to 1000
-- characters, edited by owners and editors. The MCP guide quotes them under
-- the board, so an agent reads them before its first change there.
--
-- Docs: reference files that belong to a board (a spec, a style guide, a
-- brief). The bytes are in R2 like attachments (same upload, same
-- "attachments/" key space, same authenticated download route); a row
-- carries the key and what an agent needs to know the doc exists without
-- reading it: name, type, size, a description the uploader may give, and an
-- excerpt (the first heading, or the opening of the text) taken from text
-- docs. Board roles decide access: viewers read, editors add and remove.
-- Docs are never put into an assistant's context on their own; the guide
-- lists them and read_doc fetches one when asked.
-- ============================================================================

ALTER TABLE boards ADD COLUMN notes TEXT NOT NULL DEFAULT '';

CREATE TABLE board_docs (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  -- R2 object key, "attachments/<uuid>". A new version gets a new key.
  key         TEXT NOT NULL UNIQUE,
  -- What the uploader says it is; '' when they said nothing.
  description TEXT NOT NULL DEFAULT '',
  -- From a text doc: its first heading, or its first ~200 characters.
  excerpt     TEXT NOT NULL DEFAULT '',
  added_by    TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- A board's doc names are unique regardless of case, so a doc can be named.
CREATE UNIQUE INDEX board_docs_name ON board_docs(board_id, name COLLATE NOCASE);
