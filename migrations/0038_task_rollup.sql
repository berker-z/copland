-- ============================================================================
-- A task's progress and what its subtree's runs cost, kept (COPL-208).
-- ----------------------------------------------------------------------------
-- Until this, every board read walked each parent's whole subtree to count
-- its leaves and sum its runs (repo/tasks.ts progressFor): over a million
-- rows read a day. Now one row per task holds what that walk found, and the
-- triggers below keep it so on every write, whichever route makes it.
--
-- For a task t, with only live (not deleted) children counted:
--   children  how many children it has;
--   done      its subtree's leaf tasks in a done stage, itself when it is a
--   total     leaf, and its leaves not cancelled (domain/tasks.ts progress:
--             a leaf has no children and is not a milestone);
--   runs ...  the runs that reported usage (COPL-71) on it and on its
--             subtree, summed column by column as Spent sums them.
-- A parent's progress is its row when children > 0.
--
-- Keeping it: inserting a task id into the view task_rollup_refresh works
-- out that task's row afresh from its own stage, level and runs and its
-- live children's rows, and adds the difference to every live ancestor's.
-- Refreshing one task leaves every other row exactly as right or wrong as
-- it was, so refreshing each task whose inputs a write changed, in any
-- order, leaves them all right. The triggers refresh: a task whose stage or
-- level changed, or that was added; the parents a task joined or left (it
-- was added, deleted, or reparented); the task a reported run counts
-- toward; every task in a stage whose category changed. The backfill at the
-- end refreshes every task once.
--
-- A loop of parents (which the routes refuse, routes/tasks.ts checkParent)
-- can't be summed this way, since each task in it is under itself: the
-- walk up ends (UNION), the counts inside the loop are off, and nothing
-- outside it is.
-- ============================================================================

CREATE TABLE task_rollup (
  task_id             TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  children            INTEGER NOT NULL DEFAULT 0,
  done                INTEGER NOT NULL DEFAULT 0,
  total               INTEGER NOT NULL DEFAULT 0,
  runs                INTEGER NOT NULL DEFAULT 0,
  resumed             INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL NOT NULL DEFAULT 0,
  turns               INTEGER NOT NULL DEFAULT 0,
  duration_ms         INTEGER NOT NULL DEFAULT 0
);

-- The rows the reads want: a parent's. A leaf's lookup finds nothing here and reads no row.
CREATE INDEX task_rollup_parents ON task_rollup(task_id) WHERE children > 0;

-- Nothing is ever stored here: inserting into it runs the trigger below.
CREATE VIEW task_rollup_refresh (task_id) AS SELECT NULL;

CREATE TRIGGER task_rollup_refresh INSTEAD OF INSERT ON task_rollup_refresh
BEGIN
  -- The difference, onto each live ancestor: up from its parent while the
  -- task and each parent above it are live (a deleted one counts nowhere).
  UPDATE task_rollup
     SET done = task_rollup.done + d.done, total = task_rollup.total + d.total, runs = task_rollup.runs + d.runs, resumed = task_rollup.resumed + d.resumed,
         input_tokens = task_rollup.input_tokens + d.input_tokens, output_tokens = task_rollup.output_tokens + d.output_tokens,
         cache_read_tokens = task_rollup.cache_read_tokens + d.cache_read_tokens, cache_write_tokens = task_rollup.cache_write_tokens + d.cache_write_tokens,
         cost_usd = task_rollup.cost_usd + d.cost_usd, turns = task_rollup.turns + d.turns, duration_ms = task_rollup.duration_ms + d.duration_ms
    FROM (SELECT l.done - coalesce(r.done, 0) AS done, l.total - coalesce(r.total, 0) AS total,
                 l.runs - coalesce(r.runs, 0) AS runs, l.resumed - coalesce(r.resumed, 0) AS resumed,
                 l.input_tokens - coalesce(r.input_tokens, 0) AS input_tokens,
                 l.output_tokens - coalesce(r.output_tokens, 0) AS output_tokens,
                 l.cache_read_tokens - coalesce(r.cache_read_tokens, 0) AS cache_read_tokens,
                 l.cache_write_tokens - coalesce(r.cache_write_tokens, 0) AS cache_write_tokens,
                 l.cost_usd - coalesce(r.cost_usd, 0) AS cost_usd, l.turns - coalesce(r.turns, 0) AS turns,
                 l.duration_ms - coalesce(r.duration_ms, 0) AS duration_ms
            FROM (SELECT t.id,
                         CASE WHEN k.children THEN k.done ELSE (t.level IS NOT 'milestone' AND s.category = 'done') END AS done,
                         CASE WHEN k.children THEN k.total ELSE (t.level IS NOT 'milestone' AND s.category != 'cancelled') END AS total,
                         k.runs + o.runs AS runs, k.resumed + o.resumed AS resumed,
                         k.input_tokens + o.input_tokens AS input_tokens, k.output_tokens + o.output_tokens AS output_tokens,
                         k.cache_read_tokens + o.cache_read_tokens AS cache_read_tokens,
                         k.cache_write_tokens + o.cache_write_tokens AS cache_write_tokens,
                         k.cost_usd + o.cost_usd AS cost_usd, k.turns + o.turns AS turns, k.duration_ms + o.duration_ms AS duration_ms
                    FROM tasks t JOIN stages s ON s.id = t.stage_id,
                         (SELECT count(*) AS children, coalesce(sum(r.done), 0) AS done, coalesce(sum(r.total), 0) AS total,
                                 coalesce(sum(r.runs), 0) AS runs, coalesce(sum(r.resumed), 0) AS resumed,
                                 coalesce(sum(r.input_tokens), 0) AS input_tokens, coalesce(sum(r.output_tokens), 0) AS output_tokens,
                                 coalesce(sum(r.cache_read_tokens), 0) AS cache_read_tokens,
                                 coalesce(sum(r.cache_write_tokens), 0) AS cache_write_tokens,
                                 total(r.cost_usd) AS cost_usd, coalesce(sum(r.turns), 0) AS turns,
                                 coalesce(sum(r.duration_ms), 0) AS duration_ms
                            FROM tasks c LEFT JOIN task_rollup r ON r.task_id = c.id
                           WHERE c.parent_id = NEW.task_id AND c.deleted_at IS NULL) AS k,
                         (SELECT count(*) AS runs, coalesce(sum(resumed), 0) AS resumed,
                                 coalesce(sum(input_tokens), 0) AS input_tokens, coalesce(sum(output_tokens), 0) AS output_tokens,
                                 coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens,
                                 coalesce(sum(cache_write_tokens), 0) AS cache_write_tokens,
                                 total(cost_usd) AS cost_usd, coalesce(sum(turns), 0) AS turns,
                                 coalesce(sum(duration_ms), 0) AS duration_ms
                            FROM runs WHERE task_id = NEW.task_id AND input_tokens IS NOT NULL) AS o
                   WHERE t.id = NEW.task_id) AS l
            LEFT JOIN task_rollup r ON r.task_id = l.id) AS d
   WHERE (d.done OR d.total OR d.runs OR d.resumed OR d.input_tokens OR d.output_tokens OR d.cache_read_tokens
          OR d.cache_write_tokens OR d.cost_usd OR d.turns OR d.duration_ms)
     AND task_rollup.task_id IN (
           WITH RECURSIVE up(id) AS (
             SELECT parent_id FROM tasks WHERE id = NEW.task_id AND deleted_at IS NULL AND parent_id IS NOT NULL
             UNION
             SELECT t.parent_id FROM up JOIN tasks t ON t.id = up.id WHERE t.deleted_at IS NULL AND t.parent_id IS NOT NULL)
           SELECT id FROM up);

  -- Then the task's own row, worked out the same way.
  INSERT INTO task_rollup (task_id, children, done, total, runs, resumed, input_tokens, output_tokens,
                           cache_read_tokens, cache_write_tokens, cost_usd, turns, duration_ms)
  SELECT t.id, k.children,
         CASE WHEN k.children THEN k.done ELSE (t.level IS NOT 'milestone' AND s.category = 'done') END,
         CASE WHEN k.children THEN k.total ELSE (t.level IS NOT 'milestone' AND s.category != 'cancelled') END,
         k.runs + o.runs, k.resumed + o.resumed, k.input_tokens + o.input_tokens, k.output_tokens + o.output_tokens,
         k.cache_read_tokens + o.cache_read_tokens, k.cache_write_tokens + o.cache_write_tokens,
         k.cost_usd + o.cost_usd, k.turns + o.turns, k.duration_ms + o.duration_ms
    FROM tasks t JOIN stages s ON s.id = t.stage_id,
         (SELECT count(*) AS children, coalesce(sum(r.done), 0) AS done, coalesce(sum(r.total), 0) AS total,
                 coalesce(sum(r.runs), 0) AS runs, coalesce(sum(r.resumed), 0) AS resumed,
                 coalesce(sum(r.input_tokens), 0) AS input_tokens, coalesce(sum(r.output_tokens), 0) AS output_tokens,
                 coalesce(sum(r.cache_read_tokens), 0) AS cache_read_tokens,
                 coalesce(sum(r.cache_write_tokens), 0) AS cache_write_tokens,
                 total(r.cost_usd) AS cost_usd, coalesce(sum(r.turns), 0) AS turns,
                 coalesce(sum(r.duration_ms), 0) AS duration_ms
            FROM tasks c LEFT JOIN task_rollup r ON r.task_id = c.id
           WHERE c.parent_id = NEW.task_id AND c.deleted_at IS NULL) AS k,
         (SELECT count(*) AS runs, coalesce(sum(resumed), 0) AS resumed,
                 coalesce(sum(input_tokens), 0) AS input_tokens, coalesce(sum(output_tokens), 0) AS output_tokens,
                 coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens,
                 coalesce(sum(cache_write_tokens), 0) AS cache_write_tokens,
                 total(cost_usd) AS cost_usd, coalesce(sum(turns), 0) AS turns,
                 coalesce(sum(duration_ms), 0) AS duration_ms
            FROM runs WHERE task_id = NEW.task_id AND input_tokens IS NOT NULL) AS o
   WHERE t.id = NEW.task_id
      ON CONFLICT (task_id) DO UPDATE
     SET children = excluded.children, done = excluded.done, total = excluded.total, runs = excluded.runs,
         resumed = excluded.resumed, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
         cost_usd = excluded.cost_usd, turns = excluded.turns, duration_ms = excluded.duration_ms
   WHERE children != excluded.children OR done != excluded.done OR total != excluded.total OR runs != excluded.runs
      OR resumed != excluded.resumed OR input_tokens != excluded.input_tokens OR output_tokens != excluded.output_tokens
      OR cache_read_tokens != excluded.cache_read_tokens OR cache_write_tokens != excluded.cache_write_tokens
      OR cost_usd != excluded.cost_usd OR turns != excluded.turns OR duration_ms != excluded.duration_ms;
END;

-- A new task: its own row, then its parent, which has one more child.
CREATE TRIGGER tasks_rollup_insert AFTER INSERT ON tasks
BEGIN
  INSERT INTO task_rollup_refresh (task_id) VALUES (NEW.id), (NEW.parent_id);
END;

-- A new stage or level can make a leaf count differently.
CREATE TRIGGER tasks_rollup_stage AFTER UPDATE OF stage_id, level ON tasks
  WHEN OLD.stage_id IS NOT NEW.stage_id OR OLD.level IS NOT NEW.level
BEGIN
  INSERT INTO task_rollup_refresh (task_id) VALUES (NEW.id);
END;

-- Reparented, deleted or brought back: the parent it left and the one it joined.
CREATE TRIGGER tasks_rollup_parent AFTER UPDATE OF parent_id, deleted_at ON tasks
  WHEN OLD.parent_id IS NOT NEW.parent_id OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO task_rollup_refresh (task_id) SELECT OLD.parent_id UNION SELECT NEW.parent_id;
END;

CREATE TRIGGER tasks_rollup_delete AFTER DELETE ON tasks
BEGIN
  INSERT INTO task_rollup_refresh (task_id) VALUES (OLD.parent_id);
END;

-- A run's usage, or the task it counts toward, coming, changing or going.
CREATE TRIGGER runs_rollup_insert AFTER INSERT ON runs
  WHEN NEW.task_id IS NOT NULL AND NEW.input_tokens IS NOT NULL
BEGIN
  INSERT INTO task_rollup_refresh (task_id) VALUES (NEW.task_id);
END;

CREATE TRIGGER runs_rollup_update AFTER UPDATE OF task_id, input_tokens, output_tokens, cache_read_tokens,
                                              cache_write_tokens, cost_usd, turns, duration_ms, resumed ON runs
  WHEN OLD.task_id IS NOT NULL OR NEW.task_id IS NOT NULL
BEGIN
  INSERT INTO task_rollup_refresh (task_id) SELECT OLD.task_id UNION SELECT NEW.task_id;
END;

CREATE TRIGGER runs_rollup_delete AFTER DELETE ON runs
  WHEN OLD.task_id IS NOT NULL AND OLD.input_tokens IS NOT NULL
BEGIN
  INSERT INTO task_rollup_refresh (task_id) VALUES (OLD.task_id);
END;

-- A stage that becomes done or cancelled, or stops being, recounts its tasks.
CREATE TRIGGER stages_rollup_category AFTER UPDATE OF category ON stages
  WHEN OLD.category IS NOT NEW.category
BEGIN
  INSERT INTO task_rollup_refresh (task_id) SELECT id FROM tasks WHERE stage_id = NEW.id AND deleted_at IS NULL;
END;

-- Every task once, in any order (see above).
INSERT INTO task_rollup_refresh (task_id) SELECT id FROM tasks;
