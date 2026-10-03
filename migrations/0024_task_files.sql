-- ============================================================================
-- Overlap: the files each task's work has changed (COPL-99, COPL-102;
-- docs/GITHUB.md, src/domain/overlap.ts).
-- ----------------------------------------------------------------------------
-- The daemon reports what a task's worktree changed against where the work
-- started (PUT /api/tasks/:id/files), while a run holds the task and once at
-- the end. One row per task, the latest report: a new one replaces it.
--
--   run_id       the run that reported it, which held the task's claim then
--   base         the commit the work started from
--   files        a JSON array of repo-relative paths, sorted, at most 500
--   truncated    1 when the work changed more files than were kept
--   reported_at  when the list last changed or was last confirmed
--
-- Nothing removes a row when its task closes: whatever reads overlap reads
-- open tasks only. It is information, not a lock.
-- ============================================================================

CREATE TABLE task_files (
  task_id     TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
  base        TEXT NOT NULL,
  files       TEXT NOT NULL,
  truncated   INTEGER NOT NULL DEFAULT 0,
  reported_at TEXT NOT NULL
);
