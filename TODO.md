# TODO

Live at https://copland.berkerz.dev (berker-z's personal Cloudflare account,
repo `berker-z/copland`, public). A push to main deploys
(`.github/workflows/deploy.yml`, which runs `npm run deploy`: check, build,
remote migrations, Worker). By hand: `npm run deploy`.

## Next session

### Phones and small screens

Built and checked at 390px in a desktop browser, which is not a touchscreen:
the touch-only parts (tap sizes, 16px inputs, long press, read-only Gantt)
have only been exercised with synthetic events. The rules are in
docs/DESIGN.md under Touch.

- [ ] Try it on a real phone: `npm run dev -- --host` and the LAN address,
      or the live site after a deploy. Long-press a card, swipe the board,
      open the task sheet with the keyboard up.
- [ ] Install it to the home screen (Android: install app; iOS: share › add
      to home screen) and check sign-in survives the trip to Google and back
      in standalone mode. iOS has been known to open the OAuth page in a
      separate browser and keep the cookie there.
- [ ] Reorder within a stage on touch (the move sheet only changes stage).

### Still unverified on the live site

- [ ] Calendar events: create, edit, delete an event from the agenda against a
      real Google calendar (the flow works locally and accounts connect).
- [ ] Connect Claude over MCP (settings › access, or as an agent) and try
      "what's on my plate?" and "what's on my calendar this week?".

### Small things noticed

- [ ] Bring gnaw into Copland (`~/Projects/taskblob`; the product is gnaw,
      the folder stays taskblob). gnaw is a jar of physics creatures, one per
      task: they grow while they wait, sleep until their deadline, squirm once
      it passes, float away when set free, and a big one pops into small ones
      when split. Its task model already maps onto Copland's: deadline to
      `dueDate`, set free to a done stage, split to subtasks (`parentId`).
      The likely shape is a `/jar` pane, or a "jar" view next to kanban/list/
      gantt, that draws a board's tasks (the inbox first) as creatures, reads
      and writes through Copland's task routes, and drops gnaw's own auth
      (better-auth) and D1 sync. It is phone-shaped already, and the phone
      groundwork (sheets, long press, touch sizing) is in. Read its docs/HANDOFF.md and docs/ROADMAP.md first.
- [ ] Old test data in the local dev database (LNCH board and such); harmless.
- [ ] Board filters (COPL-35): a quick add in a filtered kanban column, or a
      new task that doesn't match, disappears from view as soon as it is
      made. Decide whether quick add should take the scope as its parent.
- [ ] Widgets (COPL-29) not yet seen in a browser: the /boards line for
      someone with only an inbox, the phone `⋯` menu with the moon on, and
      the inbox bell on a real phone.
- [ ] The dashboard map (COPL-30) was driven with synthetic pointer events
      in desktop Chrome and a 390px iframe, not with a real finger: drag a
      pane by its grip on a phone, and check the page still scrolls when a
      finger lands on a block elsewhere. A layout saved under COPL-29 keeps
      its three columns, so an empty third one now shows as a gap until
      the column count is set to 2.
- [ ] Board notes and docs (COPL-27) were tested through the API and `/mcp`,
      not in a browser: open the book icon on a board, write notes, drop a
      .md and a PDF, open both, describe one, delete one, and look at it as
      a viewer.
- [ ] Boards from before migration 0012 got a backlog stage but no blocked
      one, so agents there can only comment when they need an answer. Add a
      blocked stage by hand in board settings where agents work.

## Later

- [ ] Agents, step 5: the daemon that watches an agent's inbox and starts its
      runtime, with runs and claims. Order and reasons: docs/DIRECTION.md.
- [ ] Data export: everything a person has, as one download from settings.
- [ ] Mail (v0.2): IMAP/JMAP first, narrow read-only grants for agents.
- [ ] GitHub on boards: PRs that mention a task key show up on the task, a
      merge can close it. Undecided; the options are in docs/GITHUB.md.
- [ ] Invite a friend for real and share a board; watch live updates between two people
- [ ] A time zone setting, so "today" and "overdue" in the MCP stop meaning UTC
- [ ] More MCP tools from the `not yet` entries in `src/worker/mcpCoverage.ts`
      (attaching links, the notepad, history, creating boards, calendar writes)
- [ ] Portfolio at the root of berkerz.dev
- [ ] Open source it (the repo is public now): a "Deploy to Cloudflare" button if it
      can provision D1, R2 and the Durable Object, and a README pass for people
      who are not me

## Done

- Backbone: one Worker, D1, per-user live hubs, Google sign-in, invites, `SIGNUP` modes
- Personal settings, encrypted vault for API keys, themes, the statusline
- Every nord-dash pane: calendar and agenda (several Google accounts, ICS
  links), tasks, markets (coins and CoinGecko extras from settings), notepad
  with autosave and live sync, weather with city search
- Tracker: boards shared with roles, inbox per user, kanban with drag and
  drop, list and Gantt views, new-task form (start today, +1d/+3d/+1w),
  quick add, labels, comments, history, editable stages and board keys,
  planning (levels, parents, dependencies) on every board, attachments
  (images, files, links) checked per board, board notes and docs that the
  MCP guide lists for agents (COPL-27)
- MCP server with OAuth and personal tokens, 13 tools, a coverage check
- Deployed at copland.berkerz.dev with a published Google consent screen,
  privacy and terms pages, the pole mark and favicon
- Phones: full-screen sheets and bottom sheets, a statusline menu, the
  dashboard in one column with agenda and tasks first, collapsible panes, a
  swipeable kanban with stage chips, long-press "move to…", a read-only
  Gantt on touch, 40px tap targets and 16px inputs on touch, and a manifest
  so it installs like an app
- Admins live in the database: the first account on a fresh instance is the
  admin, admins promote, demote and disable people in settings, the last one
  can't step down, and `npm run admin` is the way back in. `ADMIN_EMAILS` is
  gone, and with it the owner's email from the config
- Settings as pages: a list on the left (dashboard, connections, instance), the
  open page on the right, drill-in on a phone, and panes open it at the page
  they need
- Handles instead of names: unique `@handle`s chosen in settings › profile
  (the Google name only seeds a new account's), uploaded pictures (paste,
  drop or pick, cropped square in the browser) instead of Google's photo,
  shown on assignees, comments and members. The MCP speaks handles and has
  `set_handle`
- Agents, step 1: agents are users rows owned by a person, with their own
  tokens; board access capped at the lowest of theirs, their owner's and
  editor; the owner's notes and calendar only through explicit grants
  (`mine(grant)`); only the owner gives an agent work unless they open it;
  the MCP speaks as the agent
- Agents, steps 2 and 3: settings regrouped by who (you, agents, dashboard,
  instance) with a page per agent; the OAuth consent page connects as you,
  an agent, or a new one; new tokens default to no expiry
- Whose work is whose, in one place: `GET /api/tasks/mine` (yours: assigned to
  you anywhere, plus your inbox's unassigned; and what you delegated to your
  agents). The /tasks pane shows it across boards with a delegated fold, and
  the MCP's `my_work` reads the same route; an agent's work is only its own
- Inbox and @mentions (agents, step 4): being assigned by someone else or
  mentioned in a comment lands in your inbox, person or agent. Mentions
  resolve against the board's members when written and are kept by id; `@`
  in the comment box suggests members. The /inbox pane (open, dismiss); `inbox` and
  `mark_read` on the MCP
- Participants (COPL-24): a new comment reaches a task's creator, assignees,
  commenters and mentioned, so answering in the thread is enough. Tokens'
  `agent` field is now `client` (COPL-22). Open tabs see "new version ·
  reload" after a deploy (COPL-18)
- Share dialog (COPL-26): pick people on the instance or your own agents by
  handle; editors bring their own agents; inviting by email is a link at
  the bottom; settings is its own owner-only gear
- Stage categories agents can act on (migration 0012): backlog (parked),
  todo (ready), active, blocked (waiting on a person), done, cancelled.
  Old backlog stages became todo and boards got a backlog stage in front;
  new tasks land in the first todo stage. The MCP guide tells agents to work
  from todo, leave backlog alone, and @mention plus move to blocked when they
  need input
- Widgets (COPL-29): every pane and statusline item is in a registry
  (`src/domain/widgets.ts`, components in `src/app/widgets.tsx`) and the
  `dashboard` setting says which are on and where. Markets, weather and the
  moon are opt-in in settings › widgets; the weather cannot be on without
  a place. The theme moved to settings › theme, settings and logout are
  icons, panes have real gutters, the inbox bell is back in the statusline
  on every screen (opens the inbox in a modal), and /boards always shows
  "+ new board"
- The dashboard map (COPL-30): settings › widgets is a miniature of the
  dashboard, opened from the customize button in the statusline too. One to
  three columns, chosen; drag panes within and between them, statusline
  readouts along the top, widgets in from a tray to switch on and out to
  switch off; arrow keys, Delete and a ⋯ menu do the same without dragging.
  The dashboard draws exactly the map, empty columns included, and a phone
  reads it left to right
- Board filters (COPL-35..38): a filter bar over kanban, list and Gantt,
  kept in the URL (`level`, `under`, `who`, `label`, `q`, `done=all`), so a
  filtered board is a link. Scope to a task's subtree from a picker or a
  card's `↑ KEY`; closed tasks show only from the last 14 days unless asked.
  The MCP's `list_tasks` takes `under` for a whole subtree
