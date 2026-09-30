# copland

A personal dashboard and project tracker that runs on your own Cloudflare account. Calendar, notes, crypto prices and the moon up top; boards and tasks underneath, which you can share with friends.

It's the successor to [nord-dash](https://github.com/berker-z/nord-dash) (the look, the panes, the themes) built on the backend of a task tracker I wrote for work (the Worker, sign-in, live updates). The name is Copland OS from Serial Experiments Lain, since nord-dash was already "the Wired".

**Status:** early. The backbone works: sign-in, invites, per-user settings, the encrypted key vault, boards with shared membership, and live updates between tabs. Most of the nord-dash panes aren't ported yet and say so on the dashboard. See [TODO.md](TODO.md).

## How it fits together

One Cloudflare Worker serves everything. The React app is static assets on the same Worker; `/api/*` and `/auth/*` go to the Worker code. There is no separate backend.

- **D1** (Cloudflare's SQLite) holds users, sessions, settings, boards and tasks. Schema in [migrations/](migrations/).
- **A Durable Object per user** holds that user's open tabs as WebSockets. After a write succeeds, the Worker tells the affected users' hubs which topics changed, and their tabs refetch. Your settings change reaches your other tabs; a task moved on a shared board reaches everyone on the board. Messages carry topic names only, never data, so a refetch still goes through the normal access checks.
- **Google** is used for sign-in only (OpenID Connect with PKCE, done server-side). Sessions are our own cookie, stored hashed.
- **API keys** people add in settings (CoinGecko, OpenAI) are encrypted with AES-GCM under a Worker secret and never sent back to the browser. The Worker calls those services on the user's behalf.

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

Sign-in only asks Google for your name and email, so the consent screen doesn't need Google's verification. Calendar access will be a separate, optional grant when that pane is ported.

## License

MIT
