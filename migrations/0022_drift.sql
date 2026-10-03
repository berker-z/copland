-- ============================================================================
-- Drift (COPL-75, COPL-93; docs/GITHUB.md).
-- ----------------------------------------------------------------------------
-- What changed on the default branch while a PR's task was being worked on,
-- kept on the PR's rows in task_code (a PR naming several tasks has a row on
-- each, and they share it):
--
--   base_sha          where the work started: the parent of the PR's first
--                     commit, read once
--   drift             the last measurement, as JSON (domain/github.ts Drift)
--   revalidated_main  the default branch's head someone re-checked the PR
--                     against (revalidate); a newer head needs a new re-check
-- ============================================================================

ALTER TABLE task_code ADD COLUMN base_sha TEXT;
ALTER TABLE task_code ADD COLUMN drift TEXT;
ALTER TABLE task_code ADD COLUMN revalidated_main TEXT;
