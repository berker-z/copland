-- ============================================================================
-- Every task has a level (COPL-85).
-- ----------------------------------------------------------------------------
-- What an agent does with a task follows its level: a task is coded, an epic
-- or a story is planned into tasks (COPL-87). So a task without one becomes a
-- task here, and the routes refuse clearing it from now on. The column stays
-- nullable: making it NOT NULL means rebuilding `tasks`, and in D1 that
-- cascades deletes into everything that references it.
-- ============================================================================

UPDATE tasks SET level = 'task' WHERE level IS NULL;
