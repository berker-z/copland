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
  "GET /api/live": { skip: "browser: a tab's WebSocket for live updates; tool writes are broadcast to it" },

  /* Boards and tasks, the heart of it. load() in mcp.ts reads the board
     list and each board; loadTask() reads a task by key and its board. */
  "GET /api/boards": {
    tools: ["guide", "whoami", "list_boards", "get_board", "list_tasks", "create_task", "my_work"],
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
      "comment_on_task",
      "delete_task",
      "my_work",
    ],
  },
  "GET /api/tasks/:id": { tools: ["get_task", "update_task", "move_task", "comment_on_task", "delete_task"] },
  "POST /api/boards/:id/tasks": { tools: ["create_task"] },
  /* create_task sets dependencies with a second write: creation takes none. */
  "PATCH /api/tasks/:id": { tools: ["create_task", "update_task", "move_task"] },
  "DELETE /api/tasks/:id": { tools: ["delete_task"] },  "GET /api/tasks/:id/comments": { tools: ["get_task"] },
  "POST /api/tasks/:id/comments": { tools: ["comment_on_task"] },
  "PATCH /api/comments/:id": { skip: "not yet: editing a comment" },
  "DELETE /api/comments/:id": { skip: "not yet: deleting a comment" },
  "GET /api/tasks/:id/events": { skip: "not yet: a task's history" },

  /* Board setup. */
  "POST /api/boards": { skip: "not yet: creating a board" },
  "PATCH /api/boards/:id": { skip: "admin: renaming a board, switching planning" },
  "DELETE /api/boards/:id": { skip: "admin: archiving a board" },
  "POST /api/boards/:id/members": { skip: "admin: adding people, which may mint an invite link" },
  "PATCH /api/boards/:id/members/:userId": { skip: "admin: member roles" },
  "DELETE /api/boards/:id/members/:userId": { skip: "admin: removing members" },
  "POST /api/boards/:id/stages": { skip: "admin: adding stages" },
  "PUT /api/boards/:id/stages/order": { skip: "admin: reordering stages" },
  "PATCH /api/stages/:id": { skip: "admin: editing stages" },
  "DELETE /api/stages/:id": { skip: "admin: deleting stages" },
  "POST /api/boards/:id/labels": { skip: "not yet: creating a label" },
  "PATCH /api/labels/:id": { skip: "admin: renaming and recolouring labels" },
  "DELETE /api/labels/:id": { skip: "admin: deleting labels" },

  /* The dashboard's personal panes. */
  "GET /api/settings": { skip: "browser: dashboard preferences (theme, coins, weather place)" },
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
  /* Attachments. Files are bytes a JSON-RPC tool cannot carry well. */
  "POST /api/uploads": { skip: "browser: raw file bytes, uploaded from the task screen" },
  "GET /api/attachments/attachments/:id": { skip: "browser: file downloads" },
  "POST /api/tasks/:id/attachments": { skip: "not yet: attaching a link to a task" },
  "DELETE /api/tasks/:id/attachments/:attachmentId": { skip: "not yet: removing an attachment" },
  "GET /api/notes": { skip: "not yet: reading the notepad" },
  "POST /api/notes": { skip: "not yet: writing a note" },
  "PATCH /api/notes/:id": { skip: "not yet: editing a note" },
  "DELETE /api/notes/:id": { skip: "not yet: deleting a note" },
  "GET /api/markets/coingecko": { skip: "browser: the markets pane, spending the user's CoinGecko quota" },
  "POST /api/verse": { skip: "browser: the verse pane, spending the user's OpenAI key" },

  /* The instance. */
  "GET /api/admin/users": { skip: "admin: the instance's users" },
  "PATCH /api/admin/users/:id": { skip: "admin: disabling users" },
  "GET /api/admin/invites": { skip: "admin: invite links" },
  "POST /api/admin/invites": { skip: "admin: invite links" },
  "DELETE /api/admin/invites/:id": { skip: "admin: invite links" },

  /* Tokens themselves. */
  "GET /api/tokens": { skip: "browser: token management never goes through a token" },
  "POST /api/tokens": { skip: "browser: token management never goes through a token" },
  "DELETE /api/tokens/:id": { skip: "browser: token management never goes through a token" },
};
