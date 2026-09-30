# copland

A personal dashboard and project tracker that runs on your own Cloudflare account. Calendar, notes, crypto prices and the moon up top; boards and tasks underneath, which you can share with friends.

It's the successor to [nord-dash](https://github.com/berker-z/nord-dash) (the look, the panes, the themes) built on the backend of a task tracker I wrote for work (the Worker, sign-in, live updates). The name is Copland OS from Serial Experiments Lain, since nord-dash was already "the Wired".

**Status:** early, but usable locally. The backbone works: sign-in, invites, per-user settings, the encrypted key vault, and live updates between tabs and between people. Every nord-dash pane is ported: calendar and agenda (Google or any ICS link), tasks, markets, notepad, verse, and the statusline weather. The tracker has boards you can share, a kanban with drag and drop, a list view, a Gantt you can drag bars on, labels, comments, editable stages, and planning (epics, milestones, parent tasks, dependencies) on boards that switch it on. See [TODO.md](TODO.md).

## How it fits together

One Cloudflare Worker serves everything. The React app is static assets on the same Worker; `/api/*` and `/auth/*` go to the Worker code. There is no separate backend.

- **D1** (Cloudflare's SQLite) holds users, sessions, settings, boards and tasks. Schema in [migrations/](migrations/).
- **A Durable Object per user** holds that user's open tabs as WebSockets. After a write succeeds, the Worker tells the affected users' hubs which topics changed, and their tabs refetch. Your settings change reaches your other tabs; a task moved on a shared board reaches everyone on the board. Messages carry topic names only, never data, so a refetch still goes through the normal access checks.
- **Google** is used for sign-in (OpenID Connect with PKCE, done server-side; sessions are our own cookie, stored hashed) and, separately and optionally, for calendars. Connecting a calendar is a second consent asking for calendar scopes; the Worker keeps the refresh token encrypted and calls Google itself, so the browser never holds a Google token. Calendars can also come from any ICS link, which the Worker fetches and expands (repeating events, exceptions, time zones).
- **API keys** people add in settings (CoinGecko, OpenAI) are encrypted with AES-GCM under a Worker secret and never sent back to the browser. The Worker calls those services on the user's behalf. CoinGecko answers are cached for ten minutes, since the free plan is rate limited. Services that need no key (Binance prices, Open-Meteo weather and city search) are called straight from the browser.

Data comes in two kinds. Personal things (settings, keys, notes, calendar connections) are only ever visible to their owner. Boards have members with roles (owner, editor, viewer), and every board route checks membership first. Your private todo list is just a board with one member, your inbox; a project with a friend is the same thing with two.

The code is split by runtime: `src/worker` runs on Cloudflare, `src/app`, `src/features`, `src/lib` and `src/ui` run in the browser, and `src/domain` is plain TypeScript both sides import (types, settings shapes, live topics). Three tsconfigs keep them from sharing globals by accident.

## One instance, several people

The `SIGNUP` var decides who gets an account:

- `invite` (default): admins make invite links in settings. A board owner adding someone who isn't here yet gets a link too, which brings them straight onto that board.
- `open`: anyone with a Google account.
- `closed`: only the emails in `ADMIN_EMAILS`. This is the setting for a copy that's just for you.

`ADMIN_EMAILS` are always admins and can always sign in. That's how the first person gets in on a fresh instance.

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
4. Set `ADMIN_EMAILS` and `SIGNUP` in `wrangler.jsonc`.
5. Secrets:
   ```sh
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   openssl rand -base64 32 | npx wrangler secret put VAULT_KEY
   ```
   Keep a copy of the vault key. Lose it and every saved API key has to be entered again.
6. `npm run deploy`, which builds, applies migrations to the remote database and deploys.

Both sign-in and the calendar connection come back to the same `/auth/callback`, so the OAuth client needs one redirect URI per host. For calendars, enable the Google Calendar API in the same Google Cloud project. Sign-in only asks for name and email, which needs no verification from Google. The calendar scopes are "sensitive": until the app is verified, people see an "unverified app" warning and click through it, and there is a 100-user cap, which is fine for friends. Publish the consent screen (In production) either way; while it is in Testing, Google expires refresh tokens after 7 days.

## License

MIT
