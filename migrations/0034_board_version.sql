-- A board's version (COPL-151): every write a live event names tasks for
-- bumps it in the same batch, the event carries the new value and the board
-- GET returns it. A tab holding version v patches the tasks an event names
-- only when that event is v + 1; anything else (a missed or merged event)
-- reads the board whole.
ALTER TABLE boards ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
