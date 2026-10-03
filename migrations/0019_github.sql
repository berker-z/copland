-- ============================================================================
-- GitHub on boards (COPL-73, decided in COPL-76; docs/GITHUB.md).
-- ----------------------------------------------------------------------------
-- github_app    the instance's GitHub App, at most one row. An admin makes it
--               with GitHub's manifest flow; what GitHub hands back (the
--               private key, the webhook secret, the client secret) is kept
--               sealed under VAULT_KEY (context "github_app"). Installing
--               the App on an account picks which repos it sees.
-- board_repos   a repo connected to a board, by an instance admin who owns
--               the board. The App's webhook delivers for every repo it is
--               installed on; a delivery lands on each board the repo is
--               connected to, and acts as connected_by, with whatever role
--               they have on that board at the time.
-- task_code     what the webhook said about a task's code: a branch named
--               with its key, or a PR naming it. `ref` is how it named the
--               task (closes: the branch or a closing keyword; mentions: the
--               title), and only a merged PR that closes moves the task.
--               ci is the head commit's, reset when the head moves.
--
-- Webhooks only say what changes, so nothing before a repo was connected
-- shows up, and a task's code is whatever the last delivery said.
-- ============================================================================

CREATE TABLE github_app (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  html_url TEXT NOT NULL,
  owner_login TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE board_repos (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  connected_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_delivery_at TEXT,
  last_event TEXT,
  UNIQUE (board_id, repo)
);

CREATE INDEX board_repos_repo ON board_repos(repo);

CREATE TABLE task_code (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES board_repos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('branch', 'pull')),
  name TEXT NOT NULL,
  title TEXT,
  url TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'draft', 'merged', 'closed')),
  ref TEXT NOT NULL CHECK (ref IN ('closes', 'mentions')),
  head_sha TEXT,
  ci TEXT CHECK (ci IN ('success', 'failure', 'pending')),
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, repo_id, kind, name)
);

CREATE INDEX task_code_task ON task_code(task_id);
CREATE INDEX task_code_head ON task_code(repo_id, head_sha);
CREATE INDEX task_code_name ON task_code(repo_id, kind, name);
