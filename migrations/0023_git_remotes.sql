-- ============================================================================
-- Code without GitHub (COPL-95; docs/GITHUB.md).
-- ----------------------------------------------------------------------------
-- A board's code was only a GitHub repo, through the App. It can also be any
-- git remote the agents' machines can clone, with no App, webhooks or PRs:
--
--   kind     github (the App: webhooks, PRs, code on tasks) or git (a remote)
--   remote   what to clone, for kind git: a URL, or a path on the agents'
--            machines. Copland never touches it; daemons clone it with their
--            owners' credentials. For github it is built from repo.
--
-- `repo` stays the name shown: "owner/name" for GitHub, the remote without
-- its scheme and ".git" for the rest.
-- ============================================================================

ALTER TABLE board_repos ADD COLUMN kind TEXT NOT NULL DEFAULT 'github' CHECK (kind IN ('github', 'git'));
ALTER TABLE board_repos ADD COLUMN remote TEXT;
