-- ============================================================================
-- Review first (COPL-77; docs/GITHUB.md).
-- ----------------------------------------------------------------------------
-- An agent working a coding task opens the PR and merges it itself once CI
-- is green. A task with review_first set stops at the open PR, for a person
-- to review and merge. Off by default.
-- ============================================================================

ALTER TABLE tasks ADD COLUMN review_first INTEGER NOT NULL DEFAULT 0;
