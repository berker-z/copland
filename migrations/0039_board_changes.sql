-- ============================================================================
-- What each of a board's versions changed (COPL-210).
-- ----------------------------------------------------------------------------
-- A tab that falls behind on a board (a missed or crossed event, too many
-- tasks at once, a hidden tab shown again, a reconnect) used to read the
-- board whole: about 1,700 rows on a busy board. With this it asks
-- GET /api/boards/:id/changes?since=<its version> instead, which reads the
-- rows here after that version and the tasks they name.
--
-- One row per version, written when the write's live event goes out
-- (worker/live.ts Changes.record): `tasks` is the JSON array of the tasks
-- the event named, or NULL when more than tasks changed (stages, labels,
-- members, docs: those writes bump the version for their row). A version
-- with no row here (its record failed, or hasn't landed yet) can't be
-- answered, and nor can a NULL one: the read says "read it whole". Only the
-- last CHANGES_KEPT versions of each board are kept (domain/live.ts).
-- ============================================================================

CREATE TABLE board_changes (
  board_id  TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  version   INTEGER NOT NULL,
  tasks     TEXT,
  PRIMARY KEY (board_id, version)
);
