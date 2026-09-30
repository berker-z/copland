# Working on copland

Rules for anyone, human or AI, changing this repo. The README explains how it fits together.

- Keep `README.md`, `TODO.md` and `docs/DESIGN.md` current with the change that makes them wrong, in the same commit.
- `npm run typecheck`, `npm run check` and `npm run build` pass before anything is committed. The check is plain TypeScript run by node's type stripping, so it needs Node 22.18 or newer.
- Access is checked in the Worker. Board routes start with `requireBoard` (`src/worker/access.ts`), admin routes with `requireAdmin`. Hiding a button is not a check.
- Personal data (settings, vault, notes, calendar connections) is read and written only by its owner. Nothing personal gets a board-style sharing path.
- A route that changes something calls `changes.notify(userIds, ...topics)` for everyone who should refetch. Personal writes notify the author; board writes notify `boardAudience`.
- Secrets never reach the browser: no `VITE_*` keys, no API keys in responses. Services that need a key are called from the Worker with the user's vault entry.
- Colours only through the role classes in `docs/DESIGN.md`. No hex in components.
- Migrations are forward-only and never edited once applied anywhere.
- An API token is its owner, nothing more. Requests with a Bearer header resolve through `resolveViewer` like any other, read-only tokens are refused on writes in `runApi`, and token management (`/api/tokens`) refuses tokens altogether.
- This project deploys to berker-z's personal Cloudflare account and GitHub. Never point it at, or copy config from, the Multiplayer (company) account or repos.

## Keep the MCP in step

Copland is used through AI assistants as well as the browser, via the MCP server in `src/worker/mcp.ts`. It must not fall behind the app. A change that touches what the app can do, what a field means, or how tasks move also updates the MCP, in the same commit:

1. **Tools.** A capability someone would want to ask an assistant for gets a tool, or a new argument on an existing one. A changed route payload or response means updating the tool that calls it. Tools call the API routes in-process (`ctx.call`), never the database, so access checks and validation stay the routes'.
2. **Coverage.** Every API route has an entry in `src/worker/mcpCoverage.ts`: the tools that call it, or why none do (`browser:`, `admin:`, `private:`, `not yet:`). `npm run check` fails on a route without an entry, a stale entry, a tool no route backs, or credits that don't match what a tool's code calls. The `not yet` entries are the MCP's backlog.
3. **Descriptions.** A tool's description says what it does, what it returns and what it refuses. Concepts an assistant needs (stages and categories, keys, planning, roles) go in the `guide` tool, which is built from live data, and in `INSTRUCTIONS` when they are needed before the first call. Describe a field by the board setting that enables it, never by a board's name.
4. **Test it** through `/mcp` the way a client would: `initialize`, `tools/list`, then `tools/call` for what changed, with a write token and a read-only one.

Tool names, descriptions and the guide are English.
