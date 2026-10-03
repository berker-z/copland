# Design System — "Splits"

The dashboard is one terminal surface split into panes, after tmux, with
the near-black `divider` ground showing in the gutters between them. There
are no cards: no radii, no shadows, no blur, no filled widget headers.
Global state (clock, weather, inbox, session) lives in a statusline bar
fixed to the top of the screen.

## Tokens & Theming

Every color routes through semantic role variables defined in `src/styles/themes.css` as
raw RGB triplets (so Tailwind can apply alpha) and mapped to Tailwind color
names in the `@theme` block of `src/styles/index.css`. **Never use hex values or theme-specific colors
in components — only the role classes below.**

| Role | Class examples | Use |
| --- | --- | --- |
| `surface` | `bg-surface` | pane background |
| `raised` | `bg-raised` | inputs, hover rows, selected states |
| `bar` | `bg-bar` | statusline, filled chrome |
| `divider` | page ground behind the panes, `border-divider` | gutters between panes, hairlines inside them |
| `ink` | `text-ink` | primary text |
| `bright` | `text-bright` | emphasized text (titles, prices) |
| `muted` | `text-muted` | secondary text, idle icons/labels |
| `faint` | `border-faint`, `text-faint` | input borders, disabled, rule lines |
| `accent` | `text-accent`, `border-accent` | focus, hover, active pane, links |
| hues | `red orange yellow green magenta blue cyan teal` | data only: errors, gains/losses, account colors, save states |

Themes are `[data-theme="<id>"]` blocks in `src/styles/themes.css` overriding the same
variables. Registry + labels live in `src/domain/themes.ts`; `src/lib/theme.ts` applies
`data-theme` on `<html>` and saves it to the user's settings (cached in localStorage for first paint). The
switcher is settings › theme (`src/features/settings/Dashboard.tsx`); each
row carries its own `data-theme` attribute so its swatch/colors preview that
theme for free.

Shipped themes: `nord` (default), `tokyo-night`, `dracula`, `catppuccin`
(mocha), `gruvbox`, `one-dark`, `solarized`.

**To add a theme:** add one `[data-theme="x"]` block in `src/styles/themes.css` (all 17
variables, RGB triplets) + one entry in `src/domain/themes.ts`. No component changes.
The daemon's window keeps a copy of the table in `daemon/box/src/theme.rs`; add it there too
(its test reads themes.css and fails when the two differ).

## Visual Language

- Typography: JetBrains Mono, base 14px (`html`), weight 400 everywhere —
  only calendar day numbers in the month grid use `font-medium`. Pane titles
  are `text-lg` with `tracking-[0.14em]` — the largest type on the page;
  labels are `text-label` / `text-meta`.
- Semantics of the hues: green = done/positive, red = danger/negative,
  yellow = dirty/attention, blue = info/widget titles, magenta/orange/teal =
  account & event colors. `accent` is reserved for interactivity (focus,
  hover, active, today) — don't use it as decoration.
- Stages and labels carry a tone (0-7), which `src/ui/tone.ts` maps to the
  hue roles: blue, yellow, magenta, green, red, orange, cyan, teal. A
  stage's colour is its tone, picked by the owner; its category never
  colours anything. New boards follow the hue semantics: backlog cyan, todo
  blue, doing yellow, blocked red, done green.
- Corners: **square everywhere**. `rounded-full` survives only on spinners
  and event dots.
- Depth: none. Separation comes from `divider` hairlines and `raised` fills.

## Layout

- What is on the dashboard and in the statusline comes from the widget
  registry: `src/domain/widgets.ts` lists every pane and statusline item
  (id, name, default on or off, always-on, what it needs), and
  `src/app/widgets.tsx` maps each id to its component. The personal
  `dashboard` setting is the arrangement: `columns`, one to three of them
  (the count is the person's choice), each the panes in it top to bottom,
  and `topbar`, the statusline left to right. A new pane is an entry in
  each file.
- `App.tsx` renders exactly the setting's columns as a
  `grid lg:grid-cols-{n} gap-4` on a `bg-divider` page ground, an empty
  column included (it keeps its width, as on the map); columns are
  `flex flex-col gap-4`; every pane is `bg-surface`. Below `lg` the columns
  are `contents` and the panes stack in one column with `gap-2` between
  them, edge to edge sideways below `sm`, in reading order: the first
  column top to bottom, then the next. By default there are three columns:
  wired alone; boards, tasks, inbox; and agenda, calendar, notepad. Wired
  comes first because with no agents yet it is where making one starts, and
  a phone gets the work before the calendars. Changing the default never
  touches a layout someone has saved. A pane switched on
  by a click rather than a drop lands at the end of the shortest column
  (the rightmost of equals).
- The statusline (`src/features/shell/StatusLine.tsx`) is fixed to the top,
  `h-11 bg-bar text-base`, `z-[55]` (above the login overlay z-50, below
  modals z-[60]); `main` gets `pt-11` to clear it. Left: the pole mark,
  `copland`, your avatar and handle (opens settings › profile), and when
  the Worker answers with a newer build than the tab runs, "new version ·
  reload" in `accent` (a reload icon standing in for the mark on a phone;
  it never reloads by itself). Right, in the setting's order and only when
  on: the readouts (weather, which needs a place; moon phase; date and
  clock), `│`-separated; then icon buttons without separators: the inbox
  bell (unread count beside it in `accent`, quiet `text-muted` with none;
  opens the inbox list in a modal on any screen), customize (opens
  settings › widgets), settings (gear) and log out (`hover:text-red`),
  each with a `title` and `aria-label`. Below `sm` it keeps the mark,
  weather, clock and the icons but customize, and a `⋯` menu holds the
  date, the moon when on, and "customize dashboard".
- Moon phase glyph (`components/ui/MoonPhaseIcon.tsx`): 16px SVG, dark disc
  `fill-bar stroke-faint`, lit region in `currentColor` (`text-ink`). The lit
  shape is limb arc + half-ellipse terminator so it morphs continuously
  rather than snapping between eight icons; waxing lights the right side
  (northern hemisphere). Phase name shows at `lg:` and up in `text-muted`
  with underscores (`waxing_gibbous`); hover title gives name, % lit, day.

## Primitives

- `components/ui/WidgetFrame.tsx` — the pane. Header is a rule line:
  `── /title ────────` with the slash-title embedded (`text-blue`, accent on
  pane hover, matching rule color shift). Controls (resize, collapse) sit at
  the rule's right end and appear on hover (always visible on touch). A
  string title makes the pane collapsible, remembered in localStorage.
  Body is `p-4 text-ink`. `bodyStyle`/`bodyClassName` for sizing tweaks.
- `components/ui/ModalFrame.tsx` — square floating pane from `sm` up,
  a full-screen sheet below it. `bg-surface` with a
  1px tone border (`default` faint / `info` blue / `danger` red), plain
  backdrop `bg-black/70` (no blur). ESC + overlay click to close. No footer:
  a view's actions (edit, `DeleteButton`) are icons in `headerActions` beside
  the X, and a form ends with `FormActions` (cancel, then the action) inside
  the body, as nord-dash did. Something you open opens to read: the task
  modal shows its fields as text, and the pencil beside delete (a tick with
  "done" while editing) switches to the form; Escape leaves the form first,
  then the modal. Its header starts with a link icon for everyone that
  copies the task's own link (a green tick and "copied" for a moment), and
  opened over the dashboard its key is that link, `text-faint` going
  accent on hover. A `?task=` key the board doesn't have shows as one
  `text-yellow` line under the filter bar with an × to drop it.
- `src/features/shell/StatusLine.tsx` — statusline and phone menu; its
  readouts are in `topbar.tsx`, the inbox bell in
  `src/features/inbox/InboxBadge.tsx` (the same `InboxItems` list as the
  /inbox pane; opening an item swaps the modal for the task, closing the
  task comes back to the list). The list loads fifty and ends in a muted
  "older" row while there are more.
- The /boards pane always ends with a `+ new board` row (muted, accent on
  hover) for people; with only the inbox it adds a line saying what a board
  is for. Agents never see it, since only people make boards.
- `src/features/board/ShareModal.tsx` — who is on a board, and adding
  people or your agents by handle (one picker, agents after people). Rows
  are fixed columns: avatar, handle, a fixed-width role, and a fixed
  right-aligned slot for leave/remove that stays even when empty, so every
  row lines up. Inviting by email sits behind a quiet link at the bottom.
- `src/features/board/FilterBar.tsx`: one `bg-surface` row under the board
  header, over every view. A search input in the standard style (`/`
  focuses it, Escape clears it), then chips that read like the view switch
  (`text-accent bg-raised` on, `text-muted` off): levels (each with its
  level pill after the name, `none` without), labels (in their
  tone when on, `text-faint` off), an assignee select, `under…` (a
  search-and-pick dropdown of tasks, those with children first) which
  becomes an `under KEY ×` chip in `text-accent` (`text-red` when the key is
  not on the board), and `+n closed before 14d`. When anything is hidden,
  `n of m shown` and `clear` sit at the right in `text-xs`. On a phone the
  search and a `filters n` toggle stay; the rest folds under them. A card's
  or list row's parent is a `↑ KEY` in `text-muted` (accent on hover) that
  scopes the board to that parent instead of opening the task.
- `src/features/board/LanesView.tsx`: the kanban by epic (`?group=epic`,
  a `by epic` chip after the view switch, styled like it). One sticky row
  of stage headers (the column header style, on `bg-divider`) over lanes
  split by the same 1px gaps. A lane header is a `bg-surface` strip that
  stays at the left while the lanes scroll sideways: a chevron (folds the
  lane, remembered per browser), the epic's key in `text-faint`, its title
  in `text-bright` (`text-muted` struck through when closed; accent on
  hover, opens it), its stage in the stage's tone, the card count in
  `text-muted`, and `under` (scopes the board to the epic). Cells are
  `bg-surface` drop targets; a cell that refuses a drop says why in a
  `text-xs text-muted` line instead of a drop marker. Cards drop the
  `↑ KEY` when the parent is the lane's epic.
- `src/features/board/BoardDocsModal.tsx`: a board's notes and docs, behind
  the book icon in the board header, which everyone on the board sees (the
  gear is owners only, and editors write these). Notes read as plain
  pre-wrapped text with a pencil to edit, and a `n/1000` counter while
  editing. Docs are list rows like attachments: icon, name, size and date,
  then the description or excerpt on a `text-muted` line under it; the
  pencil and the remove X appear on hover. A text doc opens in place as a
  `bg-raised` `<pre>` with a back arrow; anything else opens through the
  attachment route in a new tab.
- `src/ui/LevelPill.tsx` — where a task sits in the plan, at a glance:
  three dots in a 16×6 SVG filled from the right by depth (task `··●`,
  story `·●●`, epic `●●●`), empty ones smaller `fill-faint`. The leftmost
  filled dot carries the level's hue and the others stay `fill-muted`: epic
  `fill-cyan`, story `fill-green`, task `fill-blue`. A milestone is off
  that ladder: one `fill-magenta` diamond in the same footprint. No level, no pill. It carries the level name as
  `title` and `aria-label` (`decorative` hides it where the name is written
  beside it). It always sits at the right: top right of a card on the
  title's first line (the title wraps beside it, never under it), the last
  column of a list row, the right end of a Gantt label, a lane header and
  the `under…` picker, after the stage in the task modal's title.
- `src/features/board/TaskCode.tsx`: a task's code from a connected
  GitHub repo. States use the hues the way GitHub does: open `text-green`,
  draft `text-muted`, merged `text-magenta`, closed `text-red`; CI is a
  word after it (`ci passed` green, `ci failed` red, `ci running`
  yellow). The task modal has a `code` row, PRs as icon, `#12` in
  `text-muted` and the title in `text-ink` (accent on hover, opens GitHub),
  a deleted branch struck through, and the repo in `text-faint` only when
  the task has code from more than one. A card shows one PR on its meta
  line, after files: icon and number in the state's hue and a `•` in the
  CI's; a click opens GitHub, not the task. Board settings › github
  (`RepoEditor.tsx`) lists repos with when GitHub was last heard from in
  `text-muted`, `text-yellow` while it never has, and a two-step
  `disconnect` like archive. For an admin, a select of the App's repos
  and `connect`, then a `text-xs text-muted` line with the install link
  in `text-accent`; for anyone else, one muted line saying an admin
  connects repos. Settings › instance › github (`GithubSection.tsx`) is
  the App: a `create GitHub App` button, or its name, owner, an `install
  on repos` link styled as a button, and a two-step `forget the app`.
- The task modal's `merge` row, shown on a board with a GitHub repo (or when it is already on): a `Checkbox` labelled "review first: the agent opens the PR, a person merges it" in the form, one `text-ink` line in the read view when on, nothing when off. The new task form has the same row and checkbox on a board with a GitHub repo, off by default, and sends it on create.
- An open card with review first says `review` on its meta line, right after the PR badge: `text-muted`, or `text-yellow` while its PR is open (not a draft) and waiting for the person who merges it. Its `title` says what it means. Nothing on a closed task.
- A card a run is working on right now (a live claim, routes/runs.ts) says
  so at the right of its meta line, before the avatars: `dev is on this`
  in `text-muted`, the agent's name without the owner, then in
  `text-faint` what kind of run: `· run 8f31` for a supervised one (the
  daemon's), `· Claude Code` (the client, or `chat`) for an interactive
  one. It truncates rather than overflow a narrow column. The full handle,
  the kind and the run are in `title`. Nothing for a lapsed claim or a closed task. A
  task's history adds `· run 8f31` in `text-faint` after "via", and an
  agent's settings page lists its latest runs, each with its kind in
  `text-faint` and the status in a hue:
  running `text-ink`, stale `text-yellow`, failed `text-red`, completed
  `text-muted`, cancelled `text-faint`.
- `src/features/wired/`: the /wired pane, the one place the app draws
  pixel art. `scene.ts` draws on a canvas in logo pixels (LogoMark's
  16-unit grid: the same rectangles, a 2×2 lamp on each head) and the
  canvas is scaled by a whole number with `image-rendering: pixelated`:
  the largest of 2 to 4 that fits the column. The four poles stand on one
  ground line (blocked half a span past doing, done a whole span past it;
  doing's short wire goes to blocked, its long one sags under blocked's
  arms to done) and every list hangs under its pole on one row: todo
  centred, doing flush right with its pole, blocked centred, done flush
  left. Each list has a width from the scale and shows the longest line
  form all its lines fit: doing drops its timer, then its agent; blocked
  its agent, then the ▲; done its ✓. Colours are the role variables, read with `getComputedStyle` and
  re-read when `<html>` changes theme; nothing is hard-coded. Wires are
  `muted` mixed into `surface`, tinted 30% toward the hue of where they
  lead; poles are `ink` at 55%. Beads (2×2) and lamps take the stage hues:
  todo blue, doing yellow, blocked red (blinking), done green (fading as it
  rides off). Current along a working wire is yellow. The tuning came from
  `docs/research/wired-prototype.html` and is fixed in constants. All text
  is DOM in the app font at 11px: headers `text-faint`, lit in their hue
  when the pole has something; todo keys `text-blue`, doing `text-ink`
  with the agent `text-yellow` and the timer `text-muted`, blocked
  `text-red`, done `text-green` fading with age; a ticket opens its task.
  A `bg-bar` strip under it sums up each agent. Under reduced motion it is
  a still picture, drawn only when the data changes.
- `src/ui/Avatar.tsx` — someone's picture, or their initials in a
  `border-faint text-muted` square when they have none. Square like
  everything else, sized in px to sit on a text line (16 in rows, 18 in
  lists, 72 on the profile page). People are named by handle, lowercase,
  next to it.
- `components/ui/Checkbox.tsx` — shared checkbox (checked green, unchecked
  muted, `focus-visible:ring-accent`).

## Touch

- `pointer-coarse:` is a touch screen, `pointer-fine:` a mouse. Size by
  pointer, layout by width: a tablet is wide and still needs big targets.
- `tap` (in `index.css`) gives an icon button a 40px hit area on touch and
  changes nothing under a mouse. Bordered buttons add `pointer-coarse:py-2.5`.
- Inputs, textareas and selects are 16px on touch (an unlayered rule in
  `index.css`, so it beats `text-xs`); smaller makes iOS zoom on focus.
- Controls that appear on hover are `pointer-fine:opacity-0
  pointer-fine:group-hover:opacity-100`: always visible on touch.
- In code, `useTouch()` and `usePhone()` (`src/ui/useMediaQuery.ts`) are the
  same two questions.
- No HTML5 drag on a touchscreen. A long press (`src/ui/useLongPress.ts`,
  touch pointers only) stands in for it: on a board card it opens MoveSheet,
  a "move to…" list of stages. The Gantt is read-only on touch; a tap opens
  the task. The dashboard map drags with pointer events instead, so it
  works by finger, but only from a block's grip (`touch-none`), leaving
  the rest of the block to scroll the page.
- Short menus pass `fit` to `ModalFrame`: a bottom sheet on a phone instead
  of the full screen.
- The board on a phone: kanban columns are an `85vw` scroll-snap strip with
  stage chips above it; the view switch wraps onto its own row. Grouped
  by epic, each column lists its cards in lane sections under a
  `text-xs` header (key `text-faint`, title `text-muted`; a tap opens the
  epic); a lane with nothing in that stage has no section there.
- An installed app (`public/manifest.webmanifest`, standalone) takes its
  title bar colour from `theme-color`, which follows the theme's `--bar`.

## Usage Patterns

- Inputs/textareas/selects: `bg-raised border border-faint px-3 py-2
  focus:border-accent focus:outline-none text-ink placeholder-muted`. Never
  `border-2`, never rounded.
- Buttons: text-style (`text-muted hover:text-accent`, often bracketed like
  `[ REFRESH ]`) or bordered (`bg-raised border border-faint hover:border-accent
  hover:text-accent`). Filled buttons only for modal primary actions
  (`bg-blue`/`bg-red` + `text-surface`).
- List rows (todos, events, notes): flat, `border-b border-divider`,
  `hover:bg-raised`, tight `py-2`. Row actions hidden until hover.
- Error banners: `text-red border border-red/60 bg-red/10`, uppercase code
  first (e.g. `! TODO_SYNC_FAILED: …`).
- Agenda events: time (muted, tabular) · 2px account-color bar · title
  (`components/calendar/EventItem.tsx`). Month grid: today is an inverse
  accent block (`bg-accent text-divider`); event days get a 4px blue dot.
- Calendar error banner: show the error code in uppercase and, when token
  refresh fails, append a tiny secondary line listing the affected account
  emails.
- Connected Accounts modal: flat list with `divide-divider` separators; each
  account row expands into a checklist of that account's calendars
  (`shown / total` as secondary metadata, shared `Checkbox`, tiny muted role
  labels).
- Re-auth pattern: understated bordered `REAUTH` text button (`border-blue/60
  text-blue`) next to the failing account; same affordance recovers primary
  and linked accounts. Failed connect/reauth reports the actual OAuth cause
  (`CALENDAR_REFRESH_TOKEN_MISSING`, `invalid_grant`), not a generic toast.
- Login auth feedback: GIS load failures surface in the inline auth error
  banner; sign-in button stays disabled while GIS is unavailable or auth is
  pending, with concise uppercase status text; popup-open failures fall back
  to full-page redirect OAuth.
- Notepad: autosized textarea in the standard input style; icon-only header
  actions; save icon color reflects state (`text-yellow` dirty, `text-green`
  saved, `text-blue` saving). The note's name sits left of the icons as a
  `text-label`-style button that turns into an inline input to rename. The
  picker is a `sm` modal of flat rows: name, then a muted one-line snippet.
- Markets rows: label (`text-bright`, tracked) over a muted unit line
  (`/USDT`, `/MCAP`, `/FLOOR`); value right-aligned and tabular, change below
  it in green/red with `[^]`/`[v]`. A `LAST_SYNC` / `[REFRESH]` rule line
  sits above the rows.
- Missing key or setting: say so quietly where the data would be. A pane
  that can still show something adds one `text-xs text-faint` line that
  opens settings on click (`hover:text-accent`); a pane that can show
  nothing without it explains in `text-muted` and offers `[ OPEN_SETTINGS ]`.
- Settings › widgets is a map of the dashboard
  (`src/features/settings/WidgetMap.tsx`, loaded lazily): a
  `border-faint bg-divider` miniature screen with a `bg-bar` strip of
  statusline chips on top and one lane per column under it, and a
  `[1][2][3]` column-count radio above it. A pane is a `bg-surface` block
  with a pane-style rule title (`/name` in `text-blue`, accent on hover),
  a grip, and a little sketch of what it shows in `faint` bars (calendar
  today in `accent`, markets ticks in green/red and the wired poles' lamps in their stage hues, as data). Always-on
  widgets carry a `Lock` in `text-faint`. An empty lane is a dashed
  `outline-faint` box saying "drop panes here". Switched-off widgets sit
  in a dashed tray below: name, kind, description, and a `+`.
  Dragging (pointer events; a mouse anywhere on a block, a finger by the
  grip) draws a ghost of the block tilted 1.5° with an `accent` outline,
  and the map reflows around a dashed `border-accent bg-accent/5` slot
  where it would land, blocks gliding there (160ms FLIP, off under reduced
  motion); the target lane's outline turns `accent`, and the tray turns
  `border-red` with "… is always on" for a widget that cannot go. Each
  block is focusable (`focus-visible:border-accent`): arrow keys move it,
  Delete switches it off, Enter switches a tray block on, and its `⋯`
  menu (hover-revealed under a mouse) does the same by tap. The weather
  dropped in without a place shows as a dashed `yellow` chip while the
  city search opens under the strip; picking a place saves both, and a
  line under the map shows the place with change and clear.
- Search-and-pick (the weather city search): a standard input; results as
  flat rows below it (`border-b border-divider`, `hover:bg-raised`), name in
  `text-bright`, detail in `text-muted`, coordinates `text-faint` tabular on
  the right. Picking saves at once; there is no separate save button.
- Typography utilities in `src/styles/index.css` (`@utility`): `text-label`
  so far; the rest of nord-dash's set (`text-nav`, `text-section`, ...) comes
  over with the widgets that use them. Use these instead of inline weights.
- Settings (`src/features/settings/SettingsModal.tsx`) is pages, not one long
  scroll: a `w-44` list on the left grouped as you, agents, dashboard
  (widgets, theme, calendars, markets, service keys) and instance, the open
  page on the right, `ModalFrame size="xl"` at a fixed
  height so switching pages does not resize it. On a phone the list is its
  own screen and a page opens with a back arrow in the title. A page is a
  `Section` (title, one-line purpose) with `Group`s inside. Panes open
  settings at the page they need (`initial`).
- Settings › assistants: copyable values (the MCP URL, a command, a new
  token's secret) are a `bg-raised border-faint` line with the value in
  `text-yellow` and a copy icon. A token's secret shows once in the same
  green-bordered box as a new invite link. Token rows show scope in
  `text-blue` (read only) or `text-yellow` (read + write); revoke asks once
  more in `text-red`.
- The OAuth consent page (`src/worker/oauth.ts`) is served by the Worker and
  cannot load the app's stylesheet. It is one pane in the modal's shape
  (hairline border, rule under the title, footer on `bar`), with the nord
  theme's role values copied in under the same variable names.
- `/device` (`src/features/device/DeviceScreen.tsx`) is the app's own
  route, under the statusline, so it has the app's theme. One centred pane
  with the login screen's header (`connect_a_box` in `text-blue` on a rule).
  The box's code is the largest thing on it, `text-2xl` spaced out; the
  warning about whose code it is sits in a `border-yellow/60 bg-yellow/10`
  box; the two kinds of token it makes are named in `text-blue` (read only)
  and `text-yellow` (read + write), as on token rows. Agents are a
  `Checkbox` list, paused ones unticked with a muted note. Approve is the
  only `border-accent` button; deny turns red on hover. Without a code it is
  one input and "continue".
- Scrollbars are standardized in `src/styles/index.css` (surface track, faint thumb,
  accent hover); no per-component overrides.

## The mark

The utility pole from Serial Experiments Lain, wires sagging off the right edge
(`src/ui/LogoMark.tsx`, `public/logo.svg`). Drawn on a 16-unit grid: use it at
16px or 32px only, where it is crisp. In the app it is `currentColor` (accent
in the statusline, where it and the "copland" wordmark are the home link);
`--mark-2` on a parent gives the wires a second tone. The favicons
(`public/favicon.svg`, `favicon.png`, `apple-touch-icon.png`) bake in the nord
bar and accent colours.
