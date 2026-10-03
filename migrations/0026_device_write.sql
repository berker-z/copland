-- ============================================================================
-- Device login: the box can ask for a read-and-write token for the person
-- (COPL-109).
-- ----------------------------------------------------------------------------
-- The box's own token is read-only, which is all it needs to show your
-- agents' work. Messaging an agent from the box (POST /api/messages) and
-- marking your inbox read are writes, so the box asks for one more token the
-- first time you try: POST /api/device/start { write: true }. The /device
-- page then says it is a read-and-write token for you, and approving mints
-- that one token and nothing else. The box keeps it in a file of its own,
-- beside the read-only one, which it goes on using for everything else.
--
-- wants_write: 1 for such a request, 0 for every other.
-- ============================================================================

ALTER TABLE device_requests ADD COLUMN wants_write INTEGER NOT NULL DEFAULT 0;
