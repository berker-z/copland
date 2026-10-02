-- ============================================================================
-- Stage categories with the meanings agents need.
-- ----------------------------------------------------------------------------
-- backlog used to mean "open, not started", and boards started with a todo
-- stage of that category, so an agent took everything in it as claimable.
-- The categories are now, in the order work flows:
--
--   backlog    parked, not committed to; agents leave it unless asked
--   todo       ready to be picked up
--   active     someone is on it
--   blocked    waiting on a person (an answer or a decision asked for in a
--              comment)
--   done, cancelled   closed, as before
--
-- Existing data keeps its meaning:
--   - every backlog stage becomes todo (it was open and takeable);
--   - every board but an inbox gets a new, empty "backlog" stage in front,
--     unless it already has a stage of that name (which, like any old backlog
--     stage, is now todo: a board never gets two stages called backlog, and
--     no task is parked by this migration);
--   - a stage called "blocked" becomes the blocked category, and its tasks
--     reopen if it was a closing stage.
--
-- SQLite cannot change a CHECK constraint, so stages is rebuilt. tasks.stage_id
-- references stages(id) (no ON DELETE action, so nothing cascades), and D1
-- always enforces foreign keys. Dropping stages deletes its rows first, which
-- counts one violation per task. With defer_foreign_keys on, that count is
-- checked at commit instead of failing the DROP, and each row inserted into
-- the new table under the name stages takes back the violations of the tasks
-- pointing at it. So the rows go aside into a copy, and come back into a
-- table created as stages; the usual create-new-then-rename leaves the count
-- standing, because rows renamed into place are never inserted. Ids are kept,
-- so every task still points at its own stage. The pragma resets at commit.
-- ============================================================================

PRAGMA defer_foreign_keys = true;

CREATE TABLE stages_old AS SELECT * FROM stages;

DROP TABLE stages;

CREATE TABLE stages (
  id        TEXT PRIMARY KEY,
  board_id  TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  name      TEXT NOT NULL,
  -- What the stage means, whatever it is called. backlog, todo, active and
  -- blocked are open; done and cancelled close a task (completed_at).
  category  TEXT NOT NULL CHECK (category IN ('backlog', 'todo', 'active', 'blocked', 'done', 'cancelled')),
  tone      INTEGER NOT NULL DEFAULT 0 CHECK (tone BETWEEN 0 AND 7)
);
CREATE INDEX stages_board ON stages(board_id, position);

INSERT INTO stages (id, board_id, position, name, category, tone)
  SELECT s.id, s.board_id, s.position, s.name,
         CASE
           WHEN lower(trim(s.name)) = 'blocked' THEN 'blocked'
           WHEN s.category = 'backlog' THEN 'todo'
           ELSE s.category
         END,
         s.tone
    FROM stages_old s;

DROP TABLE stages_old;

-- A blocked stage is open: tasks a closing stage of that name had closed reopen.
UPDATE tasks SET completed_at = NULL
 WHERE completed_at IS NOT NULL
   AND stage_id IN (SELECT id FROM stages WHERE category = 'blocked');

-- The new backlog column, first on every board without one.
UPDATE stages SET position = position + 1
 WHERE board_id IN (SELECT id FROM boards
                     WHERE is_inbox = 0
                       AND id NOT IN (SELECT board_id FROM stages WHERE lower(trim(name)) = 'backlog'));

INSERT INTO stages (id, board_id, position, name, category, tone)
  SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
               substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
         b.id, 0, 'backlog', 'backlog', 6
    FROM boards b
   WHERE b.is_inbox = 0
     AND b.id NOT IN (SELECT board_id FROM stages WHERE lower(trim(name)) = 'backlog');
