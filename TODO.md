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
      build has never run on a Mac. Still to do: a second runtime (Codex) to prove the binding, and
      backoff for a runtime that keeps failing. Known gaps are in
      daemon/README.md.
- [ ] Data export: everything a person has, as one download from settings.
- [ ] Mail (v0.2): IMAP/JMAP first, narrow read-only grants for agents.
- [ ] Code work (COPL-72): repos on boards are done (docs/GITHUB.md). Coding runs
      in a sandboxed worktree per task, dependencies before claims and review
      first are done (COPL-74). Still to do: starting tasks whose
      dependencies just closed without waiting for the inbox; files each task touches and overlaps between
      tasks (COPL-75); a lead run that breaks work down, and what to do about
      overlaps (COPL-48).
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
  `·●●`, epic `●●●`, a diamond for a milestone, nothing without a level);
  the level filter chips carry it too. `src/ui/LevelPill.tsx`
- Runs and claims (COPL-7, COPL-8): `POST /api/runs` with a token gives a
  run and its own secret, which acts as the same principal and scope and
  stamps `run_id` on events ("via Codex · run 8f31"). One ten-minute lease,
  nothing sweeps: a quiet run reads as stale and its claims lapse. One live
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
