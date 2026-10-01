# TODO

Live at https://copland.berkerz.dev (Cloudflare account `berker.zor@gmail.com`,
repo `berker-z/copland`, private for now). `npm run deploy` or
`npx wrangler deploy` after `npm run build`; migrations with
`npm run db:migrate:remote`.

## Next session

### Phones and small screens

Nothing was designed for a phone; the Splits layout was built for a desktop.
Checked at 390px in a desktop browser so far, not yet on a real phone (try
`npm run dev -- --host` and the LAN address, or the live site). The rules
are in docs/DESIGN.md under Touch.

- [x] Statusline: mark, weather, clock and settings; date, moon, themes and
      logout in a `⋯` menu below `sm`.
- [x] Dashboard: one column below `lg`, agenda and tasks first, markets and
      verse last, edge to edge on a phone.
- [ ] Collapsible panes, remembered per pane, if the long phone column wants it.
- [ ] Board screen: kanban columns as a horizontal scroll-snap strip, each
      about 85% of the screen wide so the next one peeks in, with stage chips
      on top to jump. Swiping for free, still the kanban; list view a tap away.
- [ ] Moving tasks on touch: HTML5 drag does not fire on phones. A long-press
      on a card opens a "move to…" sheet of stages. Reordering can wait.
- [ ] Gantt on touch: read-only on phones; bars are small targets and the page
      scrolls under the finger.
- [x] Modals: full-screen sheets below `sm`; the task and new-task forms put
      labels above fields there.
- [x] Tap targets: `tap` on icon buttons, taller bordered buttons on touch.
- [ ] Calendar month grid: day cells are cramped; tap a day works, check it.
- [x] Inputs: 16px on touch so iOS does not zoom on focus.
- [ ] PWA: a manifest (name, the pole icon, theme colour) so "add to home
      screen" opens it like an app. The work tracker has one to borrow.

### Still unverified on the live site

- [ ] Calendar events: create, edit, delete an event from the agenda against a
      real Google calendar (the flow works locally and accounts connect).
- [ ] Connect Claude over MCP (settings › integrations) and try
      "what's on my plate?" and "what's on my calendar this week?".
- [ ] Verse pane with a new OpenAI key (nord-dash's is revoked).

### Small things noticed

- [ ] Modals have an odd bottom margin nord-dash's did not. Recheck: the
      frame now caps itself at the wrapper (`max-h-full`) and the callers'
      `max-h-[90vh]` is gone, which may have been it. Other suspects: the
      footer's `bg-bar/60` strip, or Tailwind 4's defaults differing from
      nord-dash's Tailwind 3 in `ModalFrame`. Compare side by side and hunt.
- [ ] Bring gnaw into Copland (`~/Projects/taskblob`; the product is gnaw,
      the folder stays taskblob). gnaw is a jar of physics creatures, one per
      task: they grow while they wait, sleep until their deadline, squirm once
      it passes, float away when set free, and a big one pops into small ones
      when split. Its task model already maps onto Copland's: deadline to
      `dueDate`, set free to a done stage, split to subtasks (`parentId`).
      The likely shape is a `/jar` pane, or a "jar" view next to kanban/list/
      gantt, that draws a board's tasks (the inbox first) as creatures, reads
      and writes through Copland's task routes, and drops gnaw's own auth
      (better-auth) and D1 sync. It is phone-shaped already, so it belongs
      with the phone work. Read its docs/HANDOFF.md and docs/ROADMAP.md first.
- [ ] The `/tasks` pane shows only the inbox. Decide whether it should also show
      tasks assigned to you on shared boards (like the MCP's `my_work`).
- [ ] Old test data in the local dev database (LNCH board and such); harmless.

## Later

- [ ] @mentions and notifications on shared boards
- [ ] Invite a friend for real and share a board; watch live updates between two people
- [ ] Layout as a setting (which panes, which column) instead of the fixed grid
- [ ] A time zone setting, so "today" and "overdue" in the MCP stop meaning UTC
- [ ] More MCP tools from the `not yet` entries in `src/worker/mcpCoverage.ts`
      (attaching links, labels, notes, history, creating boards, calendar writes)
- [ ] Portfolio at the root of berkerz.dev
- [ ] Open source it: make the repo public, a "Deploy to Cloudflare" button if it
      can provision D1, R2 and the Durable Object, and a README pass for people
      who are not me

## Done

- Backbone: one Worker, D1, per-user live hubs, Google sign-in, invites, `SIGNUP` modes
- Personal settings, encrypted vault for API keys, themes, the statusline
- Every nord-dash pane: calendar and agenda (several Google accounts, ICS
  links), tasks, markets (coins and CoinGecko extras from settings), notepad
  with autosave and live sync, verse, weather with city search
- Tracker: boards shared with roles, inbox per user, kanban with drag and
  drop, list and Gantt views, new-task form (start today, +1d/+3d/+1w),
  quick add, labels, comments, history, editable stages and board keys,
  planning (levels, parents, dependencies), attachments (images, files,
  links) checked per board
- MCP server with OAuth and personal tokens, 13 tools, a coverage check
- Deployed at copland.berkerz.dev with a published Google consent screen,
  privacy and terms pages, the pole mark and favicon
