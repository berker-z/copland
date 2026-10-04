-- ============================================================================
-- Images on comments (COPL-117).
-- ----------------------------------------------------------------------------
-- An attachment can belong to a comment. It keeps its task_id, so reading it
-- is still checked against the task's board (routes/attachments.ts) and the
-- key stays unique across task attachments, comment images and board docs.
-- A row with a comment_id is the comment's, and is left out of the task's own
-- attachment list. Deleting the comment deletes its rows; the route deletes
-- the R2 objects, which the database can't.
-- ============================================================================

ALTER TABLE attachments ADD COLUMN comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE;
CREATE INDEX attachments_comment ON attachments(comment_id) WHERE comment_id IS NOT NULL;
