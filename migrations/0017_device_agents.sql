-- ============================================================================
-- Device login: the box can say which agents it is asking for (COPL-55).
-- ----------------------------------------------------------------------------
-- A box that already runs some agents asks for one more from its agents
-- screen ("run it here"). It names that agent when it starts the request
-- (POST /api/device/start { agents }), and the /device page ticks exactly
-- those of the person's agents to begin with; the person can still change
-- it. Only a hint for the page: approving still takes the agents the person
-- ticks, checked against their own as before.
--
-- wanted_agents: JSON array of agent handles or user ids, as the box sent
-- them; null when it named none (the page then ticks every agent that isn't
-- paused, as before).
-- ============================================================================

ALTER TABLE device_requests ADD COLUMN wanted_agents TEXT;
