# TODO

The plan, roughly in order. Each phase should leave the app working.

## 1. Backbone (done)

- [x] Worker + D1 + per-user live hubs, ported from the work tracker and cut down
- [x] Google sign-in, sessions, `SIGNUP` modes, `ADMIN_EMAILS`
- [x] Invite links (admin), board invites for people not yet on the instance
- [x] Per-user settings (theme, coins, weather location), optimistic writes
- [x] Encrypted vault for API keys
- [x] Boards with members and roles, an inbox per user
- [x] Splits design system, themes, statusline (clock no longer re-renders the whole app)
- [x] Settings modal: markets, weather, API keys, instance admin

## 2. Port the nord-dash panes

- [x] `/markets`: Binance prices for `settings.coins`; CoinGecko extras proxied through the Worker with the user's vault key
- [x] Weather in the statusline from `settings.location` (Open-Meteo), refreshed, not fetched once
- [x] `/notepad` on the `notes` table, with autosave and live sync across devices
- [x] `/bible_qotd` through the Worker with the user's OpenAI key
- [x] `/calendar` and `/daily_agenda`: Google Calendar as a separate grant (create, edit, delete events; Meet links), refresh tokens encrypted server-side, one fetch shared by both panes. ICS links as the no-OAuth option, with repeats, exceptions and time zones.
- [ ] Calendar: verify the Google flow end to end once the OAuth client exists
- [ ] Layout as a setting (which panes, which column), replacing the hardcoded grid

## 3. Tasks

- [x] Task create/update/move/delete routes, optimistic on the client, events logged
- [x] `/tasks` pane on the inbox (the old todo list, but instant)
- [x] Board screen: kanban with drag and drop, task modal; planning fields (level, parent) where `has_planning` is on
- [x] Board screens: list and gantt (drag to move, drag ends to resize); dependencies UI
- [x] "New task" form with everything up front (start defaults to today, +1d / +3d / +1w due buttons, also in the task modal)
- [x] Attachments: images, files and links on tasks (ported from the work tracker), with access checked per board
- [x] Members UI: add by email (invite link for newcomers), roles, leave, rename, archive
- [x] Stage editing (rename, category, colour, add, reorder, delete with somewhere for the tasks) and labels
- [x] Comments (edit and delete your own) and task history
- [ ] @mentions and notifications
- [ ] Touch: HTML5 drag does not work on phones; the task modal's stage buttons do

## 4. Integrations

- [x] MCP server and OAuth for AI assistants (from the work tracker, scoped to the caller's boards)
- [x] Personal API tokens (settings › integrations)
- [x] `npm run check`: every API route says what the MCP does with it
- [ ] More tools from the `not yet` entries in `src/worker/mcpCoverage.ts` (labels, notes, history, creating boards)
- [ ] A time zone setting, so "today" and "overdue" in the MCP stop meaning UTC

## 5. Shipping

- [x] Deployed backbone to my own Cloudflare account (copland.gnaw.workers.dev) and GitHub
- [ ] Custom domain (copland.berkerz.dev?), Google OAuth client, secrets
- [ ] "Deploy to Cloudflare" button, if it can provision D1 and the Durable Object cleanly
- [ ] Publish the Google consent screen so refresh tokens stop expiring after 7 days
