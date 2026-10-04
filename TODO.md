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
- [ ] Widgets (COPL-29) not yet seen in a browser: the /boards line for
      someone with only an inbox, the phone `⋯` menu with the moon on, and
      the inbox bell on a real phone.
- [ ] The dashboard map (COPL-30) was driven with synthetic pointer events
      in desktop Chrome and a 390px iframe, not with a real finger: drag a
      pane by its grip on a phone, and check the page still scrolls when a
      finger lands on a block elsewhere. A layout saved under COPL-29 keeps
      its three columns, so an empty third one now shows as a gap until
      the column count is set to 2.
- [ ] /wired (COPL-54) was checked in desktop Chrome, headless Chrome and
      a 390px iframe, with tasks moved by curl. Not yet on a real phone, and
      not with the daemon driving it. A claim that lapses sends no live
      update, so the pane only notices on its one-minute poll.
- [ ] Board notes and docs (COPL-27) were tested through the API and `/mcp`,
      not in a browser: open the book icon on a board, write notes, drop a
      .md and a PDF, open both, describe one, delete one, and look at it as
      a viewer.
- [ ] Runs and claims (COPL-7, COPL-8) were tested through the API and `/mcp`;
      in the browser only the card marker and the history line were looked
      at. The runs list on an agent's settings page hasn't been seen.
- [ ] Interactive runs (COPL-69) were tested through the API and `/mcp`
      with plain node calls, and the card marker and the runs list looked at
      in Chrome. The Claude Code hook in `.claude/settings.json` has not run
      for real: after deploying, reload Claude Code in this repo and check
      that a claim from a chat session stays live across twenty minutes of
      non-Copland tool use, that the hook adds nothing to the conversation,
      and how much latency the synchronous round trip adds per tool use.
- [ ] Device login (COPL-47) was tested with curl and a node script
      against the dev server, and once end to end with `copland-box --setup`
      against the dev server, approved on `/device` in Chrome, through to
      the live view. Not yet the sign-in detour (localhost is always the dev
      user): open a `/device?code=` link signed out on the live site and
      check it comes back with the code.
- [ ] Messaging from the box (COPL-109): the server half was run with curl
      against the dev server (the write ask, its refusals, approve, poll with
      `scope: "write"`, sending and marking read with it, the read-only token
      refused on both) and the `/device` page in headless Chrome; the box
      half is tested as units (the config, the write token's file and key,
      the bell's message rows, the compose line). Not yet in the window: press
      `m` on an agent, approve the write token on `/device`, send a message,
      see the agent's reply in the bell and mark it read, then revoke the
      token in settings and check the next `m` asks again.
- [ ] The box's setup writes a Codex command (`box/src/runtime.rs`) that
      has never run against Copland: check that `codex exec` reaches the
      MCP with the run's secret and may call its tools without asking. Paste
      (ctrl+v) in setup's address field was only tested as editing logic,
      not against a real Wayland clipboard.
- [ ] The box's bell and menu (COPL-64, COPL-65) were tested end to end on
      Hyprland with mako against a dev server: notifications, their click,
      every panel, compact, stopping a run and signing out. Not yet: another
      notification server (dunst, GNOME, KDE) and its handling of the default
      action, compact on a compositor other than Hyprland, the autostart
      entry actually starting the box at a real login, and macOS, which sends
      no notifications yet (`box/src/notify.rs`).
- [ ] Boards from before migration 0012 got a backlog stage but no blocked
      one, so agents there can only comment when they need an answer. Add a
      blocked stage by hand in board settings where agents work.

## Later

- [ ] The daemon (COPL-9) beyond headless: the GPUI window on the same
      loop (COPL-33) is `copland-box`, drawing all four poles from
      `/api/wired` with your own token (`owner_token_file`) and packaged in
      `daemon/flake.nix`. Release builds (COPL-56) come from
      `.github/workflows/box-release.yml` on a `box-v*` tag: Linux x86_64
      and aarch64 tarballs, an unsigned macOS arm64 app, and the Nix
      package pushed to Cachix. Not yet run on GitHub; the cache, its
      secret and its key in `flake.nix` are still to set up, and the Mac
      build has never run on a Mac (its coding sandbox, Seatbelt, is
      checked by CI on macos-14 only, COPL-140). Still to do: a second runtime (Codex) to prove the binding, and
      backoff for a runtime that keeps failing. Known gaps are in
      daemon/README.md.
- [ ] Data export: everything a person has, as one download from settings.
- [ ] Mail (v0.2): IMAP/JMAP first, narrow read-only grants for agents.
- [ ] Code work (COPL-72): repos on boards are done (docs/GITHUB.md). Coding runs
      in a sandboxed worktree per task, dependencies before claims and review
      first are done (COPL-74). The daemon also pulls ready work
      (COPL-86). Leads plan epics and stories into tasks
      (COPL-87). Drift between parallel work is
      measured and gates merges (COPL-75). A run that dies puts its task back
      in todo, or blocked after three in a row (COPL-97), from the finish or
      the Worker's five-minute cron. A conflict
      the agent can't resolve becomes a sibling integration task (COPL-98).
      Still to do (epic COPL-96): showing
      overlaps between tasks still being worked on, before any PR exists, so
      a lead can sequence them (COPL-99; the Worker stores each task's
      changed files, COPL-102; summaries, a route and the MCP's
      `overlap` read which open tasks share them, COPL-104; the daemon
      reports them, COPL-103; the card and task modal show it, COPL-105).
      The box (`daemon/box`) doesn't show overlap yet: a marker on its task
      rows would read the same `overlap` summary field. The cron, its housekeeping and the put-back have run
      against the dev server only (`/cdn-cgi/handler/scheduled`); the installed
      box 0.2.0 still finishes runs as plain cancelled on shutdown, which now
      parks their tasks in backlog, until a box release sends `interrupted`.
- [ ] Invite a friend for real and share a board; watch live updates between two people
- [ ] A time zone setting, so "today" and "overdue" in the MCP stop meaning UTC
- [ ] More MCP tools from the `not yet` entries in `src/worker/mcpCoverage.ts`
      (attaching links, history, creating boards, calendar writes)
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
- Images on comments (COPL-117, COPL-118): `POST /api/tasks/:id/comments`
  takes `attachments: [key]`, the thread shows them as thumbnails that open
  full size, the comment box takes them by paste, drop or picker, and
  `get_task` shows them
- Agents attach screenshots (COPL-119): `comment_on_task` takes
  `images: [{ name, data }]`, PNG or JPEG as base64, sniffed from the bytes,
  5 MB each, and uploads them in-process before posting
- Message claims, the server half (COPL-124, for COPL-123): a run claims
  the messages it takes, `POST` and `DELETE /api/messages/:id/claim`, on
  the task claims' lease in `message_claims` (migration 0028). One live
  claim per message, only the recipient's, another run's refused (409
  `claimed`), renewed by the run's calls, released by finishing, the sweep,
  a release, or marking the message read or dismissing it; a read message
  is refused (409 `read`). Inbox message items carry `claim`. MCP:
  `claim_message`, `release_message`, and `inbox` shows `claimed_by` and
  `run`. `daemon/core/src/api.rs` has the calls and fields
  (checks/messageClaims.check.ts)
- Message runs, the daemon half (COPL-127, for COPL-123): every message,
  about a task or not, goes to a message run, which claims each before it
  launches and leaves out any another run claimed first; a batch left
  empty launches nothing. Task runs handle only their own task's comments
  and mentions, and their prompts say so instead of "check your inbox".
  The message prompt names the task a message is about and reads "on
  <name>" as one of the agent's boards. Tested live with two daemons on one
  agent token and four messages: each was in exactly one run
- Access checks count nothing (COPL-133, for COPL-131): `requireBoard` and
  `boardsFor` read only membership and role (`BoardAccess`); the member and
  open task counts are `GET /api/boards`'s alone (`boardSummariesFor`), and
  `GET /api/boards/:id`'s `board` no longer carries them. The open count
  reads a partial index of open tasks (`tasks_open`, migration 0029). Rows
  read locally: `/api/inbox` 770 to 19, `/api/wired` 771 to 20, a board
  route's access check about 125 to 1 (checks/access.check.ts)
- Comments reach the run working on the task (COPL-139, for COPL-130):
  `POST /api/runs/current/news` tells a run, once each, the unread comments
  and mentions on the tasks it has claimed since it started
  (`runs.heard_until`, migration 0031). The MCP's `heartbeat`, given the
  Claude Code hook's event, returns them as the hook's
  `additionalContext`, so they arrive at the run's next step; the box's
  setup puts that hook in the Claude Code command. The guide has every run
  read the task again before it integrates or moves it to done, and the
  task modal tells a commenter when the run will see the comment
  (checks/runNews.check.ts)
- MCP server with OAuth and personal tokens, its tools, a coverage check
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
- A task is a link (COPL-63): `/b/BOARD?task=KEY` opens the board with
  that task's modal over it, cold, on reload or shared; the key ignores
  case and filters, and one the board lacks leaves a one-line notice.
  Opening a task adds one history entry, so Back closes it, and closing or
  switching tasks never adds more (COPL-67). The task modal
  copies the link anywhere, and over the dashboard its key goes there.
  The MCP's task summaries and inbox items carry it as `url`, and a ticket
  in the box opens it. Built from the key alone (`taskPath`), since a key
  is always its board's key and a number
- Swimlanes by epic (COPL-39): `?group=epic` ("by epic" next to the views)
  gives the kanban a lane per epic under one sticky row of stage headers;
  tasks sit in their nearest epic's lane, the rest in "no epic". Lanes fold
  (remembered per browser), filters apply inside them, and dragging a task
  straight under an epic into another lane reparents it; deeper tasks move
  with their parent. On a phone the lanes are sections inside each column.
  Rules in `src/features/board/lanes.ts`
- Parents follow their children (COPL-40): a child under way moves its
  parent to active, everything not parked in backlog closed with something
  done moves it to done, a child back in todo reopens a closed parent, and
  it carries up to the epic. Done in the Worker in the same batch as the
  change, logged as "following KEY", mirrored in the browser's optimistic
  cache, and reported to agents as `also_moved`; the guide no longer tells
  them to move parents by hand. Stage edits (recategorising or deleting a
  stage) don't re-check parents
- The notepad on the MCP (COPL-41): `list_notes` (names and excerpts, no
  contents), `read_note`, `write_note` (create, replace, or `append`; pass
  `base_updated` from `read_note` to refuse if the note changed since) and
  `delete_note`. An agent reaches its owner's notes through the `notes:read`
  and `notes:write` grants and the guide says which it holds; with
  `notes:write` alone it can only add new notes
- A trust order for agents (COPL-43): the guide quotes board notes as the
  board's conventions, context rather than authority, and ranks what an
  agent reads (owner and its own description, Copland's rules, the user's
  request, board notes, docs, briefs, comments, outside content). Lower-trust
  text never widens permissions, touches identity or credentials, or puts
  the owner's notes or calendar where others can read them
- Inbox paging (COPL-42): `GET /api/inbox` takes `unread=true`, `limit`
  (up to 200) and a `cursor`, and answers with `next`. Newest first, ties
  broken by id, so nothing repeats or goes missing between pages, and
  marking read while paging skips nothing. The MCP's `inbox` filters on
  the server and returns `next`; before this, fifty read items hid every
  older unread one. The pane and the bell load fifty and have an "older"
  row for the rest. Migration 0014 reindexes inbox_items for it
- The level pill (COPL-46): three dots at the right of every card, list row,
  Gantt label and lane header say where a task sits (task `··●`, story
  `·●●`, epic `●●●`, a diamond for a milestone; every task has one);
  the level filter chips carry it too. The leftmost filled dot is the
  level's hue (epic cyan, story green, task blue, milestone magenta;
  COPL-81). `src/ui/LevelPill.tsx`
- A parent's progress (COPL-90): `3/7` before the level pill on a card
  with children and in an epic's lane header (desktop and phone), and a
  `progress` row in the task modal (`3 of 7 done`). Leaf tasks done out of
  those not cancelled, from `progress()` (COPL-89), over the whole board so
  filters don't change it. The lane header's card count reads `· 4 shown`
- Runs and claims (COPL-7, COPL-8): `POST /api/runs` with a token gives a
  run and its own secret, which acts as the same principal and scope and
  stamps `run_id` on events ("via Codex · run 8f31"). One ten-minute lease:
  a quiet run reads as stale and its claims lapse. One live
  claim per task (`claim_task`): assigns an unassigned task, moves it to
  active, parents follow, and two racing runs can't both win. Released by
  finishing, closing, unassigning, pausing. MCP: `claim_task`,
  `release_task`, `finish_run`, `whoami` shows the run. Migration 0015.
  Interactive runs (COPL-69): a claim with a plain token makes that token's
  interactive run, kept alive by any call with it and in Claude Code by a
  hook calling `heartbeat` (`.claude/settings.json`); fifteen-minute
  lease. Everyone claims; moving to blocked releases. Migration 0018
- The daemon, headless (COPL-9): `daemon/`, a Rust workspace (`core` is the
  loop, `cli` the `copland-daemon` binary). Per agent in
  `~/.config/copland/daemon.toml`: poll the unread inbox, start a run, claim
  with its secret, launch the command (Claude Code `-p` with a temporary
  MCP config carrying the run secret) in its working directory, keep the run
  alive, finish it on exit (0 completed, else failed; cancelled on
  SIGINT/SIGTERM). A wake guard keeps it from relaunching on items a run
  already saw. Tested locally with a curl stub and one real Claude Code run
- The daemon proof's gaps (COPL-49 to COPL-53): a claim refusal carries a
  `code` (closed, assigned_elsewhere, claimed). The daemon comes back to a
  task once the run that held it ends, launches without a claim to answer
  a mention on someone else's task, stops a runtime at a fixed two-hour
  ceiling (run failed), tells its own inbox items apart by actor id, and
  refuses a read-only token at startup and in `--check` (`/api/me` now
  says the token's `access`).
- /wired (COPL-54): the utility-pole scene from
  `docs/research/wired-prototype.html` as a pane, on by default alone in
  the left column, showing your agents' work from `GET /api/wired`:
  todo, doing (a live claim, or active with no run on it, dimmer), blocked,
  and done in the last 24 hours. Beads slide between poles when the data
  changes; reduced motion gets a still picture. The poles stand in one
  row, blocked half a span past doing and done a span past it, every list
  under its pole and trimmed to fit its width. The default layout is now
  three columns: wired; boards, tasks, inbox; agenda, calendar, notepad.
  Saved layouts are left alone
- Device login, the server side (COPL-47): a box asks with
  `POST /api/device/start`, shows an `ABCD-EFGH` code, and polls
  `POST /api/device/poll` with the device code only it holds. The person
  approves on `/device` in the app (never with a token), ticking which
  agents it may run. That mints a read-only token for them ("<host> box")
  and a read and write one per agent ("<host>"), ordinary tokens shown as
  "Copland box" in settings and revocable there. The secrets wait sealed
  under VAULT_KEY and are handed over once; an approval nobody collects in
  ten minutes loses its tokens. Per-IP and pending caps on the two open
  routes. Migration 0016
- The box's agents screen (COPL-55): `a` in the live view lists every
  agent of yours (from `/api/wired`), what runs here with its runtime,
  folder and state, and what doesn't. Change an agent's runtime, stop
  running it here, or bring one here through a device login that names it
  (`agents` on `POST /api/device/start`, which `/device` pre-ticks;
  migration 0017). `daemon.toml` is edited in place with a backup and the
  daemon reloads without a restart: an agent in a run finishes it under
  its old binding first (`Daemon::reload`, daemon/README.md).
- The daemon wakes on live updates (COPL-62): `/api/live` takes a Bearer
  token as well as a tab's cookie, and puts the socket in the token's
  principal's own hub, so an agent hears only what is sent to it. A run's
  secret is refused, and a socket whose token is revoked, or whose agent
  is paused, closes at the next message for it. Each agent in the daemon
  keeps one open (`daemon/core/src/live.rs`, no WebSocket crate) and polls
  on an `inbox` topic; the HTTP poll stays, every five minutes while the
  socket is up and every `poll_interval` while it's down. Assignment to
  runtime start went from about 15 s on average (30 s at worst) to half a
  second. The box's `/api/wired` reads follow the owner's socket the same
  way, with a dot in its status line
- Messages, the server half (COPL-106, for COPL-44): `POST /api/messages
  { to, text, taskId?, replyTo? }` puts a short note (at most 1000
  characters) in someone's inbox as a `message` item. A person messages
  their own agents, an agent its owner; anyone else on a board an agent is
  on, only when its owner opened it to members, and that message is
  untrusted. A reply (`replyTo`) goes back to whoever sent the message it
  answers. Agents never message agents, people never message people. A
  message may point at a task both can see, or at none, and a task-less
  one is always shown. Inbox items carry `message { id, text, trusted }`
  and a nullable `task`. MCP: `send_message`, and the guide says how to
  weigh and answer one. The rule is `src/domain/messages.ts`
  (checks/messages.check.ts). Migration 0025 rebuilds inbox_items. The
  daemon wakes on one (COPL-107): every message, about a task or not, gets
  a message run of its own in `workdir` (COPL-127), and one that comes
  during a run waits for the next (daemon/README.md,
  Messages). Sending from the box is COPL-109, below
- Housekeeping on the cron (COPL-112, `src/worker/housekeeping.ts`): expired
  sessions and OAuth codes, runs ended over 30 days ago, tokens revoked or
  expired over 30 days ago that no kept run uses, and the changed-files
  lists of tasks closed or deleted over a week ago, at most 500 rows per
  table per tick. The device-request sweep runs on the cron too. Pinned by
  `checks/housekeeping.check.ts` against the real migrations on node:sqlite
- Messages in the browser (COPL-108, for COPL-44): one line to message an
  agent on its settings page (saying it waits for the next run while one is
  going), a nudge in the task modal's header for your own agents on the
  board, assignees first (`nudgeTargets`, checked in
  checks/messages.check.ts), and in the inbox a message's text (untrusted
  ones styled like comments) with a reply line that answers about the same
  task and marks it read. Shared input: `src/features/inbox/MessageInput.tsx`.
  Checked in headless Chrome against the dev server; not on a phone. The
  nudge is in the task modal only, not on cards
- The /nudge pane (COPL-115, for COPL-44) replaces COPL-108's line on the
  agent's settings page and the nudge in the task modal: a dashboard pane
  (`src/features/inbox/NudgePane.tsx`, on by default under /wired) listing
  whom you may message from `GET /api/messages/recipients` (your own agents
  first, then others' agents open to members on a board you share;
  `recipientsOf` in domain/messages.ts, checked in checks/messages.check.ts),
  each saying when it has a run going. Picking one opens the message input
  under it. `nudgeTargets` is gone. Messages no longer carry a task from the
  browser, only from the MCP and replies. Looked at in headless Chrome at
  desktop width and 390px
- The /nudge pane says whether an agent's box is on (COPL-126, for
  COPL-123), not that it has a run going: `Recipient.connected` is a socket
  in the agent's live hub opened with one of its still-good tokens and heard
  from (opened, or a ping answered) within the daemon's 75 s silence limit
  (`LiveHub.listening`, `connectedPrincipals`, `listeningTokens` checked in
  checks/messages.check.ts). Off, the picked row says nothing reads the
  message until it is. No queue note at the run cap: `max_runs` is the
  daemon's config and the server doesn't know it
- Messages in the box (COPL-109, for COPL-44): `m` on an agent in the
  agents screen opens one line and sends it as you (`POST /api/messages`),
  saying it waits for the next run while one is going here; the bell lists
  your agents' unread messages beside mentions and blocks, opens them, and
  `r` marks one read. Both are writes, so the box asks once for a second,
  read-and-write token of yours through a device login with `write: true`
  (migration 0026; `/device` then lists no agents and says what the token
  can do), kept in `me.write.token` as `owner_write_token_file`; the
  read-only one stays what it reads with. A refused write token is
  forgotten, so the next `m` asks again. Signing out revokes it with the
  rest (`daemon/box/src/write.rs`)
- Agents name a board (COPL-125, for COPL-123): an agent's `create_task`
  without `board` is refused, and `board: "inbox"` is its owner's inbox; a
  person's still defaults to their inbox (`newTaskBoard` in
  src/domain/tasks.ts, checked in checks/mcp.check.ts). The fallback was
  only ever the MCP tool's: `POST /api/boards/:id/tasks` always names one.
  The guide's Inbox text and INSTRUCTIONS say a supervised run on a task
  handles only that task's items, and messages get a run of their own
- /wired draws at 15 fps (COPL-128): the scene's loop (`sync()` in
  src/features/wired/scene.ts) drew on every display frame while the pane
  was on screen, 60 a second or more, even when nothing moved. It now
  draws at most `FPS` (15) times a second, sleeping on a timer between
  frames and taking one animation frame to draw on; `step` still gets the
  real time, so travel and sway keep their speed. The box's current
  flows at the same 15 (`FPS` in daemon/box/src/scene.rs, in place of
  20), its sway stays at 12, and travel is capped at 30 with a timer
  rather than drawn on every display frame
- Opening a task reads its inbox items (COPL-138): the task modal marks
  your unread items on that task read (given, mentioned, commented; never
  a message), one write per opening and none when nothing is unread, from
  the inbox pages already loaded (`readOnOpen` in src/domain/inbox.ts,
  checked in checks/inbox.check.ts; `useReadOnOpen` in
  src/features/inbox/inboxWrite.ts). Before, only clicking the item in the
  inbox did, so a mention read on the task, or opened from the box's bell,
  stayed unread for good and the bell never cleared. Nothing server-side
  changed: agents still mark their own items read through the MCP
