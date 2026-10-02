-- ============================================================================
-- Planning on every board.
-- ----------------------------------------------------------------------------
-- Levels, parents and dependencies used to be a per-board switch
-- (boards.has_planning). They are now part of every board, and the app no
-- longer reads or writes the column. It stays rather than being dropped:
-- dropping buys nothing, and code from before this change still reads it.
-- Every existing board, inboxes included, is switched on so that code sees
-- what the new code shows. Boards created from here on keep the column's
-- default (0), which means nothing.
-- ============================================================================

UPDATE boards SET has_planning = 1;
