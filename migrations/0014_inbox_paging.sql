-- ============================================================================
-- Inbox paging (COPL-42).
-- ----------------------------------------------------------------------------
-- GET /api/inbox pages newest first by (created_at, id), optionally only
-- the unread, with a cursor at the last item's (created_at, id). These two
-- indexes give both orders straight off the user's items, so a page never
-- sorts the whole inbox:
--   inbox_items_unread  ?unread=true, and the unread count (read_at IS NULL)
--   inbox_items_newest  everything, read or not
-- The first replaces inbox_items_user, which lacked the id tie-break.
-- ============================================================================

DROP INDEX IF EXISTS inbox_items_user;
CREATE INDEX inbox_items_unread ON inbox_items(user_id, read_at, created_at, id);
CREATE INDEX inbox_items_newest ON inbox_items(user_id, created_at, id);
