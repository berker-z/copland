-- ============================================================================
-- The verse pane is gone, and with it the only use of an OpenAI key. Saved
-- keys would otherwise sit in the vault with no way to see or remove them.
-- ============================================================================

DELETE FROM vault WHERE name = 'openai';
