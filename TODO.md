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
- [ ] The `/tasks` pane shows only the inbox. Decide whether it should also show
      tasks assigned to you on shared boards (like the MCP's `my_work`).
- [ ] Old test data in the local dev database (LNCH board and such); harmless.

## Later

- [ ] Agents, step 4: claiming tasks over the MCP, then a claim that expires.
      Step 5 is notifications and @mentions. docs/AGENT-IDENTITIES.md.
- [ ] GitHub on boards: PRs that mention a task key show up on the task, a
      merge can close it. Undecided; the options are in docs/GITHUB.md.
- [ ] @mentions and notifications on shared boards
- [ ] Invite a friend for real and share a board; watch live updates between two people
- [ ] Layout as a setting (which panes, which column) instead of the fixed grid
- [ ] A time zone setting, so "today" and "overdue" in the MCP stop meaning UTC
- [ ] More MCP tools from the `not yet` entries in `src/worker/mcpCoverage.ts`
      (attaching links, labels, notes, history, creating boards, calendar writes)
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
  planning (levels, parents, dependencies), attachments (images, files,
  links) checked per board
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
