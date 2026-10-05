-- Closed tasks by board, newest first (COPL-150). GET /api/boards/:id reads
-- the open tasks (tasks_open) and those closed in the last two weeks, and
-- GET /api/boards/:id/closed pages back through the rest; with only
-- tasks_board, both read every task the board ever closed.
CREATE INDEX tasks_closed ON tasks(board_id, completed_at, id) WHERE deleted_at IS NULL AND completed_at IS NOT NULL;
