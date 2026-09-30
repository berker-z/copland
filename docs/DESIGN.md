# Design System — "Splits"

The dashboard is one continuous terminal surface divided into panes by 1px
hairlines, after tmux. There are no cards: no radii, no shadows, no blur, no
filled widget headers. Global state (clock, weather, session, theme, auth)
lives in a statusline bar fixed to the top of the screen.

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
| `divider` | `gap-px` grid ground, `border-divider` | hairlines between/inside panes |
| `ink` | `text-ink` | primary text |
| `bright` | `text-bright` | emphasized text (titles, prices) |
| `muted` | `text-muted` | secondary text, idle icons/labels |
| `faint` | `border-faint`, `text-faint` | input borders, disabled, rule lines |
| `accent` | `text-accent`, `border-accent` | focus, hover, active pane, links |
| hues | `red orange yellow green magenta blue cyan teal` | data only: errors, gains/losses, account colors, save states |

Themes are `[data-theme="<id>"]` blocks in `src/styles/themes.css` overriding the same
variables. Registry + labels live in `src/domain/themes.ts`; `src/lib/theme.ts` applies
`data-theme` on `<html>` and saves it to the user's settings (cached in localStorage for first paint). The
switcher is in the statusline; each menu row carries its own `data-theme`
attribute so its swatch/colors preview that theme for free.

Shipped themes: `nord` (default), `tokyo-night`, `dracula`, `catppuccin`
(mocha), `gruvbox`, `one-dark`, `solarized`.

**To add a theme:** add one `[data-theme="x"]` block in `src/styles/themes.css` (all 17
variables, RGB triplets) + one entry in `src/domain/themes.ts`. No component changes.

## Visual Language

- Typography: JetBrains Mono, base 14px (`html`), weight 400 everywhere —
  only calendar day numbers in the month grid use `font-medium`. Pane titles
  are `text-lg` with `tracking-[0.14em]` — the largest type on the page;
  labels are `text-label` / `text-meta`.
- Semantics of the hues: green = done/positive, red = danger/negative,
  yellow = dirty/attention, blue = info/widget titles, magenta/orange/teal =
  account & event colors. `accent` is reserved for interactivity (focus,
  hover, active, today) — don't use it as decoration.
- Corners: **square everywhere**. `rounded-full` survives only on spinners
  and event dots.
- Depth: none. Separation comes from `divider` hairlines and `raised` fills.

## Layout

- `App.tsx` renders a `grid lg:grid-cols-3 gap-px` on a `bg-divider` page
  ground; columns are `flex flex-col gap-px`; every pane is `bg-surface` so
  the 1px gaps read as tmux splits. Each column ends with a `bg-surface`
  filler div so it reads as one continuous surface.
- The statusline (`components/ui/StatusLine.tsx`) is fixed to the top,
  `h-11 bg-bar text-base`, `z-[55]` (above the login overlay z-50, below
  modals z-[60]); `main` gets `pt-11` to clear it. Left: `[thewired]` + user.
  Right: theme switcher (menu opens downward), weather, city, moon phase,
  date, clock, logout/locked.
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
  the rule's right end and appear on hover (always visible on mobile).
  Body is `p-4 text-ink`. `bodyStyle`/`bodyClassName` for sizing tweaks.
- `components/ui/ModalFrame.tsx` — square floating pane, `bg-surface` with a
  1px tone border (`default` faint / `info` blue / `danger` red), plain
  backdrop `bg-black/70` (no blur), footer on `bg-bar/60`. ESC + overlay
  click to close.
- `components/ui/StatusLine.tsx` — statusline + theme menu (opens upward).
- `components/ui/Checkbox.tsx` — shared checkbox (checked green, unchecked
  muted, `focus-visible:ring-accent`).

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
- Search-and-pick (the weather city search): a standard input; results as
  flat rows below it (`border-b border-divider`, `hover:bg-raised`), name in
  `text-bright`, detail in `text-muted`, coordinates `text-faint` tabular on
  the right. Picking saves at once; there is no separate save button.
- Verse: the passage is a quote block, `border-l-2 border-yellow` with the
  reference in `text-yellow` uppercase above it.
- Typography utilities in `src/styles/index.css` (`@utility`): `text-label`
  so far; the rest of nord-dash's set (`text-nav`, `text-section`, ...) comes
  over with the widgets that use them. Use these instead of inline weights.
- Settings › integrations: copyable values (the MCP URL, a command, a new
  token's secret) are a `bg-raised border-faint` line with the value in
  `text-yellow` and a copy icon. A token's secret shows once in the same
  green-bordered box as a new invite link. Token rows show scope in
  `text-blue` (read only) or `text-yellow` (read + write); revoke asks once
  more in `text-red`.
- The OAuth consent page (`src/worker/oauth.ts`) is served by the Worker and
  cannot load the app's stylesheet. It is one pane in the modal's shape
  (hairline border, rule under the title, footer on `bar`), with the nord
  theme's role values copied in under the same variable names.
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
