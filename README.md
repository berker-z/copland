# copland

A personal dashboard and project tracker that runs on your own Cloudflare account. Calendar, notes, crypto prices and the moon up top; boards and tasks underneath, which you can share with friends.

It's the successor to [nord-dash](https://github.com/berker-z/nord-dash) (the look, the panes, the themes) built on the backend of a task tracker I wrote for work (the Worker, sign-in, live updates). The name is Copland OS from Serial Experiments Lain, since nord-dash was already "the Wired".

**Status:** early, but usable locally. The backbone works: sign-in, invites, per-user settings, the encrypted key vault, and live updates between tabs and between people. Every nord-dash pane is ported: calendar and agenda (Google or any ICS link), tasks, markets, notepad, and the statusline weather. The tracker has boards you can share, a kanban with drag and drop, a list view, a Gantt you can drag bars on, labels, comments, editable stages, and planning (epics, milestones, parent tasks, dependencies) on boards that switch it on. It works on a phone (a swipeable board, long-press to move a task) and installs to the home screen. Claude and other AI assistants can connect over MCP. See [TODO.md](TODO.md).

## How it fits together

One Cloudflare Worker serves everything. The React app is static assets on the same Worker; `/api/*`, `/auth/*`, and the MCP server and its OAuth (`/mcp`, `/oauth/*`, `/.well-known/*`) go to the Worker code. There is no separate backend.

- **D1** (Cloudflare's SQLite) holds users, sessions, settings, boards and tasks. Schema in [migrations/](migrations/).
- **A Durable Object per user** holds that user's open tabs as WebSockets. After a write succeeds, the Worker tells the affected users' hubs which topics changed, and their tabs refetch. Your settings change reaches your other tabs; a task moved on a shared board reaches everyone on the board. Messages carry topic names only, never data, so a refetch still goes through the normal access checks.
- **Google** is used for sign-in (OpenID Connect with PKCE, done server-side; sessions are our own cookie, stored hashed) and, separately and optionally, for calendars. Connecting a calendar is a second consent asking for calendar scopes; the Worker keeps the refresh token encrypted and calls Google itself, so the browser never holds a Google token. Calendars can also come from any ICS link, which the Worker fetches and expands (repeating events, exceptions, time zones). People go by a handle they choose (`@sam`, unique on the instance), made from their Google name when the account is created; the name itself is not kept, and a picture is one they upload, not Google's.
- **API keys** people add in settings (CoinGecko) are encrypted with AES-GCM under a Worker secret and never sent back to the browser. The Worker calls those services on the user's behalf. CoinGecko answers are cached for fifteen minutes, since the free plan is rate limited. Services that need no key (Binance prices, Open-Meteo weather and city search) are called straight from the browser.

Data comes in two kinds. Personal things (settings, keys, notes, calendar connections) are only ever visible to their owner. Boards have members with roles (owner, editor, viewer), and every board route checks membership first. Your private todo list is just a board with one member, your inbox; a project with a friend is the same thing with two.

The code is split by runtime: `src/worker` runs on Cloudflare, `src/app`, `src/features`, `src/lib` and `src/ui` run in the browser, and `src/domain` is plain TypeScript both sides import (types, settings shapes, live topics). Three tsconfigs keep them from sharing globals by accident.

## Connecting an AI assistant

Copland has an MCP server at `/mcp`, so Claude (or anything else that speaks MCP) can read and change your boards: "what's due this week?", "move LNCH-4 to done", "put a passport renewal in my inbox for the 20th". Settings › access has the URL, the steps and what is connected as you.

- **claude.ai and the Claude app:** Settings › Connectors, add a custom connector with `https://<your-host>/mcp`, press connect. You sign in to Copland if you aren't already, see a consent page, and pick who it connects as (you, one of your agents, or a new agent) and read and write or read only.
- **Claude Code:** `claude mcp add --transport http copland https://<your-host>/mcp`, then `/mcp` inside Claude Code to sign in the same way.
- **Anything else:** make a personal token in settings (`cpl_…`, shown once) and send it as `Authorization: Bearer <token>`. The same token works on `/api` directly, for scripts.

Whatever connects as you acts as you and nothing more: it gets your role on each board, and a task's history says "berker-z via Claude Code". The tools don't touch the database. They call the app's own API routes in-process as you (`src/worker/mcp.ts`), so the access checks, validation, event log and live updates are the same ones the browser goes through. A read-only token is refused on any write, on `/mcp` and `/api` alike. `/mcp` only takes tokens, never the session cookie, so another site can't drive it through your open tab.

The OAuth side (`src/worker/oauth.ts`) is the minimum MCP clients need: protected-resource and authorization-server metadata, dynamic client registration, public clients with PKCE only, and refresh tokens that rotate on use. Tokens of both kinds live in `api_tokens` as hashes, and stop working the moment their owner is disabled. Settings lists them with when each was last used, and revokes them.

### Agents

An assistant can also be an agent: a name of its own like `berker-z/codex`, made in settings › agents or right on the consent page. Tasks are assigned to it, history says what it did, and it starts with nothing. You put it on the boards it should work on, never above your own role or editor, choose whether anyone but you can give it work, and tick which of your own notes and calendar it may read. Pause it and its tokens stop; delete it and its name is free again while its history stays. The design is in [docs/AGENT-IDENTITIES.md](docs/AGENT-IDENTITIES.md), and where it is all going in [docs/DIRECTION.md](docs/DIRECTION.md).

Anyone, person or agent, has an inbox. Being given a task by someone else, or `@mentioned` in a comment, lands there: in the /inbox pane on your dashboard, where you can open or dismiss each item, and through the MCP's `inbox` tool for an agent. Mentions are matched against the board's members when the comment is written and kept by id, so renaming someone never moves a mention.

`src/worker/mcpCoverage.ts` says, for every API route, which tools use it or why none do. `npm run check` fails when a route has no entry, so a new route can't quietly leave the MCP behind.

## One instance, several people

The first person to sign in on a fresh instance gets in without an invite and is its admin. After that, the `SIGNUP` var decides who gets an account:

- `invite` (default): admins make invite links in settings. A board owner adding someone who isn't here yet gets a link too, which brings them straight onto that board.
- `open`: anyone with a Google account.
- `closed`: nobody new. This is the setting for a copy that's just for you: sign in first, and the door shuts behind you.

Admins make other people admins (or stop them being one) and disable accounts in settings › instance. There is always at least one admin; the last one can't step down. Being an admin is about the instance, not your data: it doesn't let anyone read other people's boards or notes.

If you lock yourself out anyway, `npm run admin -- you@example.com` makes an existing account an admin directly in D1. It needs Wrangler logged in to the instance's Cloudflare account, which is the real proof that it's yours.

## Running it locally

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in VAULT_KEY and DEV_USER_EMAIL
npm run db:migrate
npm run dev
```

With `DEV_USER_EMAIL` set, localhost requests without a session act as that user (created as an admin the first time), so you don't need Google set up to work on it. It is ignored for any host other than localhost.

## Deploying your own

You need a Cloudflare account and a Google Cloud project for the sign-in client.

1. `npx wrangler login`, into the account you want this on.
2. `npx wrangler d1 create copland` and put the `database_id` it prints into `wrangler.jsonc`.
3. In Google Cloud, create an OAuth client (type "Web application") with the redirect URI `https://<your-worker-host>/auth/callback`. Put its client id in `GOOGLE_CLIENT_ID` in `wrangler.jsonc`.
4. Set `SIGNUP` in `wrangler.jsonc`.
5. Secrets:
   ```sh
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   openssl rand -base64 32 | npx wrangler secret put VAULT_KEY
   ```
   Keep a copy of the vault key. Lose it and every saved API key has to be entered again.
6. `npm run deploy`, which builds, applies migrations to the remote database and deploys. Then sign in straight away: the first account is the admin.
7. Optional: deploy on every push to main. `.github/workflows/deploy.yml` runs the same `npm run deploy`. Make a Cloudflare API token from the "Edit Cloudflare Workers" template, add Account › D1 › Edit, and save it in the GitHub repo as the `CLOUDFLARE_API_TOKEN` secret, with your account id (`npx wrangler whoami`) as `CLOUDFLARE_ACCOUNT_ID`.

Both sign-in and the calendar connection come back to the same `/auth/callback`, so the OAuth client needs one redirect URI per host. For calendars, enable the Google Calendar API in the same Google Cloud project. Sign-in only asks for name and email, which needs no verification from Google. The calendar scopes are "sensitive": until the app is verified, people see an "unverified app" warning and click through it, and there is a 100-user cap, which is fine for friends. Publish the consent screen (In production) either way; while it is in Testing, Google expires refresh tokens after 7 days.

## License

MIT
