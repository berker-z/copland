-- ============================================================================
-- api_tokens.agent becomes api_tokens.client.
-- ----------------------------------------------------------------------------
-- The column predates agents (0007): it holds the MCP client that last
-- introduced itself with the token ("claude-code"), not an agent principal.
-- Since agents exist, a token answering "agent": null read as "this token is
-- not the agent's". Renamed so "agent" only ever means an agent principal
-- (docs/AGENT-IDENTITIES.md: principal, credential, client). Not to be
-- confused with client_id, the OAuth app a connection was issued to.
-- ============================================================================

ALTER TABLE api_tokens RENAME COLUMN agent TO client;
