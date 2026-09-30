# TODO

Live at https://copland.berkerz.dev (Cloudflare account `berker.zor@gmail.com`,
repo `berker-z/copland`, private for now). `npm run deploy` or
`npx wrangler deploy` after `npm run build`; migrations with
`npm run db:migrate:remote`.

## Next session

### Phones and small screens

Nothing has been designed for a phone yet; the Splits layout was built for a
desktop. Test on a real phone (and Chrome's device mode) and fix, roughly in
this order:

- [ ] Statusline: too many items for a phone. Collapse theme, moon, date and
      logout into a menu; keep the mark, clock, and settings.
- [ ] Dashboard grid: one column on phones is already the fallback, but the
      order should be deliberate (agenda and tasks first, markets last) and
      panes probably collapsible.
- [ ] Board screen: columns side by side do not fit. Options: swipe between
      stages (one column per screen with a stage switcher), or open on the
      list view on narrow screens. Pick one.
- [ ] Moving tasks on touch: HTML5 drag does not fire on phones. The task
      modal's stage buttons work; consider a long-press menu on a card
      ("move to…") and up/down arrows for order.
- [ ] Gantt on touch: pointer events work, but the bars are small targets and
      the page scrolls under the finger. Probably read-only on phones.
- [ ] Modals: full-screen sheets on phones instead of centred boxes; the task
      modal is long.
- [ ] Tap targets: most buttons are desktop-small (icons at 14px). 40px+ on
      touch (`pointer-coarse:` variants).
- [ ] Calendar month grid: day cells are cramped; tap a day works, check it.
- [ ] Inputs: iOS zooms on focus when font-size < 16px; set 16px on touch.
- [ ] PWA: a manifest (name, the pole icon, theme colour) so "add to home
      screen" opens it like an app. The work tracker has one to borrow.

### Still unverified on the live site

- [ ] Calendar events: create, edit, delete an event from the agenda against a
      real Google calendar (the flow works locally and accounts connect).
- [ ] Connect Claude over MCP (settings › integrations) and try
      "what's on my plate?" and "what's on my calendar this week?".
- [ ] Verse pane with the (rotated) OpenAI key.

### Small things noticed

- [ ] Modals have an odd bottom margin nord-dash's did not. Suspects: the
      `max-h-[90vh]` passed to `ModalFrame` as `className` (added for the long
      task and settings modals; the frame's own wrapper already caps height),
      the footer's `bg-bar/60` strip, or Tailwind 4's defaults differing from
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
- [ ] Rotate the OpenAI and CoinGecko keys that nord-dash shipped in its public
      bundle; revoke the old ones.
- [ ] Turn off `copland.gnaw.workers.dev` (`workers_dev: false`): sign-in does
      not work there anyway, since Google only knows copland.berkerz.dev.
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
