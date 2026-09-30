# Working on copland

Rules for anyone, human or AI, changing this repo. The README explains how it fits together.

- Keep `README.md`, `TODO.md` and `docs/DESIGN.md` current with the change that makes them wrong, in the same commit.
- `npm run typecheck` and `npm run build` pass before anything is committed.
- Access is checked in the Worker. Board routes start with `requireBoard` (`src/worker/access.ts`), admin routes with `requireAdmin`. Hiding a button is not a check.
- Personal data (settings, vault, notes, calendar connections) is read and written only by its owner. Nothing personal gets a board-style sharing path.
- A route that changes something calls `changes.notify(userIds, ...topics)` for everyone who should refetch. Personal writes notify the author; board writes notify `boardAudience`.
- Secrets never reach the browser: no `VITE_*` keys, no API keys in responses. Services that need a key are called from the Worker with the user's vault entry.
- Colours only through the role classes in `docs/DESIGN.md`. No hex in components.
- Migrations are forward-only and never edited once applied anywhere.
- This project deploys to berker-z's personal Cloudflare account and GitHub. Never point it at, or copy config from, the Multiplayer (company) account or repos.
