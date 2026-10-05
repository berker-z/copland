/* ============================================================================
   What the MCP does with every API route: the drift guard.
   ----------------------------------------------------------------------------
   Every route in src/worker/index.ts has an entry here: the MCP tools that
   use it, or why none do. `npm run check` (checks/mcp.check.ts) fails when a
   route is missing, when an entry names a route that no longer exists, when
   it names a tool that does not exist, when a tool is backed by no route,
   or when the tools named are not exactly the ones whose code calls it.
   So adding or changing an API route forces the question "what should an
   assistant be able to do with this?" (AGENTS.md).

   Skip reasons start with a word that says which kind of no it is:
     browser:  deliberately never through a token (secrets, token management,
               the dashboard's own panes)
     admin:    setup that stays in the app's own screens
     private:  data an assistant should not be handed wholesale
     not yet:  would be useful; the backlog for the next tools
   No imports: the check reads this without pulling in the Worker.
   ========================================================================== */

export type Coverage = { tools: string[] } | { skip: string };

export const ROUTE_COVERAGE: Record<string, Coverage> = {
  /* Identity. */
  "GET /api/me": { tools: ["whoami"] },
  "PATCH /api/me": { tools: ["set_handle"] },
  "PUT /api/me/avatar": { skip: "browser: a picture is cropped and uploaded from the profile page" },
  "DELETE /api/me/avatar": { skip: "browser: goes with uploading one, on the profile page" },
  "GET /api/avatars/:id": { skip: "browser: image bytes for <img> tags; tools show people by handle" },
  "GET /api/live": {
    skip: "browser: a tab's WebSocket for live updates (the daemon's too, with its token); tool writes are broadcast to it",
  },

  /* Agents are set up by their owner, in the app; a token is refused on all of these. */
  "GET /api/agents": { skip: "browser: settings › agents, owner only" },
  "POST /api/agents": { skip: "browser: making an agent is its owner's, in settings or on the OAuth consent page" },
  "PATCH /api/agents/:id": { skip: "browser: an agent never widens itself" },
  "DELETE /api/agents/:id": { skip: "browser: settings › agents" },
  "PUT /api/agents/:id/avatar": { skip: "browser: a picture is cropped and uploaded in settings" },
  "DELETE /api/agents/:id/avatar": { skip: "browser: settings › agents" },
  "PUT /api/agents/:id/boards/:boardId": { skip: "browser: only the owner puts an agent on a board" },
  "DELETE /api/agents/:id/boards/:boardId": { skip: "browser: settings › agents" },

  /* Boards and tasks, the heart of it. load() in mcp.ts reads the board
     list and each board; loadTask() reads a task by key and its board. */
  "GET /api/boards": {
    tools: [
      "guide",
      "whoami",
      "list_boards",
      "get_board",
      "list_tasks",
      "create_task",
      "my_work",
      "create_label",
      "update_label",
      "delete_label",
      "set_board_notes",
      "list_docs",
      "read_doc",
      "write_doc",
      "delete_doc",
    ],
  },
  "GET /api/boards/:id": {
    tools: [
      "guide",
      "get_board",
      "list_tasks",
      "get_task",
      "create_task",
      "update_task",
      "move_task",
      "claim_task",
      "release_task",
      "comment_on_task",
      "delete_task",
      "drift",
      "overlap",
      "revalidate",
      "my_work",
      "create_label",
      "update_label",
      "delete_label",
      "set_board_notes",
      "list_docs",
      "read_doc",
      "write_doc",
      "delete_doc",
    ],
  },
  "GET /api/boards/:id/shell": { skip: "browser: a task modal opened from the inbox or /wired, without the board's tasks; get_board and get_task cover it" },
  "GET /api/boards/:id/closed": {
    tools: [
      "get_board",
      "list_tasks",
      "get_task",
      "update_task",
      "move_task",
      "claim_task",
      "release_task",
      "comment_on_task",
      "delete_task",
      "drift",
      "overlap",
      "revalidate",
    ],
  },
  "GET /api/tasks/:id/drift": { tools: ["drift"] },
  "GET /api/tasks/:id/overlap": { tools: ["overlap"] },
  "POST /api/tasks/:id/revalidate": { tools: ["revalidate"] },
  "GET /api/tasks/ready": { skip: "not yet: what the caller can start now (todo, dependencies closed, unclaimed); the daemon pulls it, an assistant asks my_work" },
  "GET /api/tasks/mine": { tools: ["my_work"] },
  "GET /api/inbox": { tools: ["inbox", "mark_read"] },
  "POST /api/inbox/read": { tools: ["mark_read"] },
  "POST /api/inbox/dismiss": { tools: ["mark_read"] },
  "POST /api/messages": { tools: ["send_message"] },
  "GET /api/messages/recipients": { skip: "browser: the nudge pane's list; an agent messages only its owner, and send_message names whom" },
  "GET /api/tasks/:id": {
    tools: ["get_task", "create_task", "update_task", "move_task", "claim_task", "release_task", "comment_on_task", "delete_task", "drift", "overlap", "revalidate"],
  },
  "POST /api/boards/:id/tasks": { tools: ["create_task"] },
  /* create_task sets dependencies with a second write: creation takes none. */
  "PATCH /api/tasks/:id": { tools: ["create_task", "update_task", "move_task"] },
  "DELETE /api/tasks/:id": { tools: ["delete_task"] },
  "GET /api/tasks/:id/comments": { tools: ["get_task"] },
  "POST /api/tasks/:id/comments": { tools: ["comment_on_task"] },
  "PATCH /api/comments/:id": { skip: "not yet: editing a comment" },
  "DELETE /api/comments/:id": { skip: "not yet: deleting a comment" },
  "GET /api/tasks/:id/events": { skip: "not yet: a task's history" },

  /* Runs and claims. A run is started over HTTP by whatever launches the
     runtime, which hands the runtime the run's secret: the model works inside
     a run, it does not mint one (a session cannot switch its own credential
     anyway). A chat session's interactive run is made by its first
     claim_task instead. whoami reads the current run; finish_run ends it;
     heartbeat is the Claude Code hook's call that keeps it alive and, given
     the hook's event, brings the run what came in on its tasks (COPL-139). */
  "POST /api/runs": {
    skip: "private: starting a run mints a credential; whoever launches the runtime (a daemon, a script) calls it with the principal's token and hands the runtime the secret, so no model holds a token that makes more",
  },
  "GET /api/runs/current": { tools: ["heartbeat"] },
  "POST /api/runs/current/news": { tools: ["heartbeat"] },
  "GET /api/runs/:id": { tools: ["whoami"] },
  "POST /api/runs/:id/finish": { tools: ["finish_run"] },
  "POST /api/tasks/:id/claim": { tools: ["claim_task"] },
  "DELETE /api/tasks/:id/claim": { tools: ["release_task"] },
  "POST /api/messages/:id/claim": { tools: ["claim_message"] },
  "DELETE /api/messages/:id/claim": { tools: ["release_message"] },
  "PUT /api/tasks/:id/files": {
    skip: "private: the daemon reports a task's changed files from its worktree with the run's secret; an agent doesn't report its own list",
  },

  /* A board's notes and docs. The doc list rides on GET /api/boards/:id;
     write_doc creates a text doc or rewrites one by name. Uploading a doc's
     file stays in the browser (POST /api/uploads). */
  "PUT /api/boards/:id/notes": { tools: ["set_board_notes"] },
  "POST /api/boards/:id/docs": { tools: ["write_doc"] },
  "GET /api/boards/:id/docs/:docId": { tools: ["read_doc"] },
  "PATCH /api/boards/:id/docs/:docId": { tools: ["write_doc"] },
  "DELETE /api/boards/:id/docs/:docId": { tools: ["delete_doc"] },

  /* Board setup. */
  "POST /api/boards": { skip: "not yet: creating a board" },
  "PATCH /api/boards/:id": { skip: "admin: renaming a board, changing its key" },
  "DELETE /api/boards/:id": { skip: "admin: archiving a board" },
  "POST /api/boards/:id/members": { skip: "admin: adding people, which may mint an invite link" },
  "GET /api/people": { skip: "browser: the share dialog's handle search; it refuses agents" },
  "PATCH /api/boards/:id/members/:userId": { skip: "admin: member roles" },
  "DELETE /api/boards/:id/members/:userId": { skip: "admin: removing members" },
  "GET /api/boards/:id/repos/available": { skip: "admin: the repos the GitHub App can see, for an instance admin connecting one" },
  "POST /api/boards/:id/repos": { skip: "admin: connecting a GitHub repo, which needs an instance admin who owns the board" },
  "DELETE /api/boards/:id/repos/:repoId": { skip: "admin: disconnecting a GitHub repo" },
  "POST /api/boards/:id/stages": { skip: "admin: adding stages" },
  "PUT /api/boards/:id/stages/order": { skip: "admin: reordering stages" },
  "PATCH /api/stages/:id": { skip: "admin: editing stages" },
  "DELETE /api/stages/:id": { skip: "admin: deleting stages" },
  "POST /api/boards/:id/labels": { tools: ["create_label"] },
  "PATCH /api/labels/:id": { tools: ["update_label"] },
  "DELETE /api/labels/:id": { tools: ["delete_label"] },

  /* The dashboard's personal panes. */
  "GET /api/settings": { skip: "browser: dashboard preferences (theme, which widgets are on, coins, weather place)" },
  "PATCH /api/settings": { skip: "browser: dashboard preferences" },
  "GET /api/vault": { skip: "browser: saved API keys never leave the app" },
  "PUT /api/vault/:name": { skip: "browser: saved API keys" },
  "DELETE /api/vault/:name": { skip: "browser: saved API keys" },
  /* Calendars. Reading is a tool; connecting accounts and feeds happens in the
     browser (Google's consent is a redirect, ICS links are secrets). */
  "GET /api/calendar": { tools: ["list_events"] },
  "GET /api/calendar/events": { tools: ["list_events"] },
  "POST /api/calendar/accounts/:id/sync": { skip: "browser: refreshing a connected account's calendar list" },
  "DELETE /api/calendar/accounts/:id": { skip: "browser: disconnecting a Google account" },
  "POST /api/calendar/ics": { skip: "browser: ICS links are secret addresses" },
  "PATCH /api/calendar/calendars/:id": { skip: "browser: which calendars show, and their colours" },
  "DELETE /api/calendar/calendars/:id": { skip: "browser: removing an ICS feed" },
  "POST /api/calendar/events": { skip: "not yet: creating an event" },
  "PUT /api/calendar/events/:calendarId/:eventId": { skip: "not yet: editing an event" },
  "DELETE /api/calendar/events/:calendarId/:eventId": { skip: "not yet: deleting an event" },
  /* Attachments. Files are bytes a JSON-RPC tool carries badly, with one
     exception: comment_on_task takes small images as base64 and uploads them
     as raw bytes. Other files go up from the task screen and the board's
     docs; write_doc writes text docs without an upload. */
  "POST /api/uploads": { tools: ["comment_on_task"] },
  "GET /api/attachments/attachments/:id": { skip: "browser: file downloads (attachments and board docs); read_doc reads text docs through their own route" },
  "POST /api/tasks/:id/attachments": { skip: "not yet: attaching a link to a task" },
  "DELETE /api/tasks/:id/attachments/:attachmentId": { skip: "not yet: removing an attachment" },
  /* The notepad: the user's own notes, an agent's only with notes:* grants. */
  "GET /api/notes": { tools: ["list_notes", "read_note", "write_note", "delete_note"] },
  "POST /api/notes": { tools: ["write_note"] },
  "PATCH /api/notes/:id": { tools: ["write_note"] },
  "DELETE /api/notes/:id": { tools: ["delete_note"] },
  "GET /api/markets/coingecko": { skip: "browser: the markets pane, spending the user's CoinGecko quota" },
  "GET /api/wired": { skip: "browser: the /wired pane's scene of your agents' work; my_work already lists what was handed to them" },

  /* The instance. */
  "GET /api/admin/users": { skip: "admin: the instance's users" },
  "PATCH /api/admin/users/:id": { skip: "admin: disabling users, making admins" },
  "GET /api/admin/invites": { skip: "admin: invite links" },
  "POST /api/admin/invites": { skip: "admin: invite links" },
  "DELETE /api/admin/invites/:id": { skip: "admin: invite links" },

  /* Tokens themselves. */
  "GET /api/tokens": { skip: "browser: token management never goes through a token" },
  "POST /api/tokens": { skip: "browser: token management never goes through a token" },
  "DELETE /api/tokens/:id": { skip: "browser: token management never goes through a token" },
  "DELETE /api/tokens/self": { skip: "private: a box signing out revokes the token it holds; an assistant has no business ending the credential it is connected with" },

  /* Device login: a box asks, a person approves in the app, the box collects its tokens. */
  "POST /api/device/start": { skip: "private: the box's own unauthenticated first step; it mints nothing and no assistant should be asking to be let in" },
  "POST /api/device/poll": { skip: "private: hands the box its token secrets once, against a device code only the box holds" },
  "GET /api/device/:userCode": { skip: "browser: the /device approval page; tokens are refused" },
  "POST /api/device/approve": { skip: "browser: approving mints tokens, which only a person in the app does" },
  "POST /api/device/deny": { skip: "browser: the /device approval page; tokens are refused" },

  /* GitHub: the repo's webhook, not a person or an assistant. */
  "POST /api/github": { skip: "private: the GitHub App's webhook deliveries, unauthenticated and checked against its secret; what they record reaches assistants as the code in task summaries" },
  "GET /api/admin/github": { skip: "admin: the instance's GitHub App" },
  "POST /api/admin/github/manifest": { skip: "admin: making the GitHub App, a round trip through github.com in the admin's browser" },
  "DELETE /api/admin/github": { skip: "admin: forgetting the GitHub App" },
};
