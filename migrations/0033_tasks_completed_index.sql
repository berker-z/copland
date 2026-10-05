-- Recently finished tasks by board (COPL-152). GET /api/wired draws the
-- tasks done in the last day; tasks_open holds only the open ones and
-- tasks_board every task ever, so finding them read the board's history.
CREATE INDEX tasks_completed ON tasks(board_id, completed_at) WHERE deleted_at IS NULL AND completed_at IS NOT NULL;
