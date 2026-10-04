-- Open tasks by board (COPL-133). GET /api/boards counts each board's open
-- tasks; tasks_board covers deleted_at but not completed_at, so the count
-- read every task the board ever had. This one holds only the open ones.
CREATE INDEX tasks_open ON tasks(board_id) WHERE deleted_at IS NULL AND completed_at IS NULL;
