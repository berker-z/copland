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

- [ ] `/markets`: Binance prices for `settings.coins`; CoinGecko extras proxied through the Worker with the user's vault key
- [ ] Weather in the statusline from `settings.location` (Open-Meteo), refreshed, not fetched once
- [ ] `/notepad` on the `notes` table, with autosave and live sync across devices
- [ ] `/bible_qotd` through the Worker with the user's OpenAI key
- [ ] `/calendar` and `/daily_agenda`: Google Calendar as a separate grant, refresh tokens encrypted server-side, one fetch shared by both panes. Read-only ICS URL as the no-OAuth option.
- [ ] Layout as a setting (which panes, which column), replacing the hardcoded grid

## 3. Tasks

- [ ] Task create/update/move/delete routes, optimistic on the client, events logged
- [ ] `/tasks` pane on the inbox (the old todo list, but instant)
- [ ] Board screens: kanban, list, gantt; planning fields where `has_planning` is on
- [ ] Members UI: add by email, roles, leave
- [ ] Comments and mentions on shared boards

## 4. Integrations

- [ ] MCP server and OAuth for AI assistants (from the work tracker, scoped to the caller's boards)
- [ ] Personal API tokens

## 5. Shipping

- [ ] Deploy to my own Cloudflare account and GitHub (not the company ones)
- [ ] "Deploy to Cloudflare" button, if it can provision D1 and the Durable Object cleanly
- [ ] Publish the Google consent screen so refresh tokens stop expiring after 7 days
