# Agents as their own identities

An agent is a job you've given a name, like `berker-z/codex` or `berker-z/scout`. It isn't a product: the same Claude Code can be your reviewer one day and your scout the next, depending on which credential it holds.

Steps 1 to 4 are built, and runs and claims from step 5. The daemon itself is what is left; see Steps.

## Four layers

| Layer | What it is | Lifetime | Where |
|---|---|---|---|
| Principal | who acts: `berker-z`, `berker-z/codex` | long; it gets assignments and appears in history | `users` (`kind` is person or agent) |
| Credential | how a program proves it is that principal | rotated, revoked, refreshed | `api_tokens.user_id` |
| Client | the program doing the work | per connection | `api_tokens.client`, shown as "via" |
| Run | one working session | minutes | `runs`, with a secret of its own; claims in `task_claims` |

Merging the first two ("each token is a user") would turn a rotated token or an OAuth refresh into a new person, orphaning its assignments and history. Merging the first and third ("Claude Code is an agent") would make every Claude the same agent. History reads "berker-z/codex via Codex CLI", and both halves carry information.

## Where agents live

Agents are rows in `users`, because everything an agent needs to be already points at `users(id)`: board members, assignees, comment authors and history actors. `kind = 'agent'` and `owner_id` mark one (`migrations/0007_agents.sql`). Agent-only details go in `agents` (name, description, `work_from`, `paused_at`), and what it may reach of its owner's in `agent_grants`.

`users.email` stays NOT NULL. Making it nullable means rebuilding the table, and in D1 dropping `users` cascades into every table that references it. That was tried on a copy and emptied sessions, memberships, settings and tokens. So an agent's email is `<id>@agent.invalid`, which Google never verifies, so it can't sign in. `rowToUser` reports it as null, email lookups and the admin list are people-only, and invites refuse `.invalid` addresses.

The handle is stored whole (`berker-z/codex`) so every query reading `users.handle` works unchanged. Renaming the owner rewrites their agents' handles in the same batch. Person handles can't contain "/", so the two never collide.

## Authority

- **Boards: membership, capped.** An agent sees only boards it was added to. Its role on each is the lowest of three: its own, its owner's there, and editor. That's worked out on every request in `access.ts`, so when the owner loses a board, the agent does too. Agents never manage boards, since everything that needs the owner role is out of reach. Making boards calls `requirePerson`.
- **The owner's personal data: explicit grants.** Each personal route in `index.ts` is wrapped in `mine(grant)`. A person reaches their own data. An agent reaches its owner's only if it holds the grant, and the route then runs as the owner, unchanged. The grants are `calendar:read`, `notes:read` and `notes:write`. The MCP's tools for them (`list_events`; `list_notes`, `read_note`, `write_note`, `delete_note`) go through those same routes, and the guide tells an agent which it holds. With `notes:write` alone an agent can add notes but not see, change or delete existing ones, since finding a note by name is a read. Settings, the vault, tokens, the profile and calendar writes are `mine(null)`: never.
- **Who gives it work.** Assigning an agent needs its owner, or one of the owner's other agents, unless the owner set `work_from` to `members`. Unassigning, or editing a task someone already assigned to it, needs nothing.
- **Live checks.** A paused agent, or one whose owner is disabled, gets 401 on every token at once (`agentContext` in `repo/agents.ts`).
- **The inbox.** The owner can put their own agents on their inbox from the agent's page, and nobody else's can get there. The agent's `/api/me` then reports it, and the MCP files board-less tasks there.
- **Whose work is whose.** Being on a board, the inbox included, never makes a task an agent's. `GET /api/tasks/mine` (`routes/work.ts`) decides it once, for the /tasks pane and the MCP's `my_work` alike: an agent gets only what is assigned to it. A person gets what is assigned to them plus their inbox tasks assigned to nobody, and what they handed to their own agents comes separately as `delegated`. An agent can still look at its owner's work on purpose, with `list_tasks` and an assignee.

## Decided

- The agent is the identity; a token is a credential it holds, and it can hold several.
- Making a token, or approving on the OAuth consent page, asks who it acts as: me, one of my agents, or a new agent. "Me" tokens stay, for scripts.
- Only the owner adds their agent to a board, the owner's inbox included.
- Personal agents only, no instance agents.
- Agents never make boards, invite people or manage tokens.
- Deleting an agent ends its tokens and takes it off boards and assignments. It is renamed "berker-z/codex (deleted 1a2b)", which is how its comments and history read, and frees "codex" for a new agent that inherits nothing.
- Any member may bring their own agent onto a board, at most at their own role. Board owners can remove it, and can never make it an owner.
- What an agent is for (its description) is told to it in the MCP guide.
- An agent can have a picture, with a generic mark until it does. Something generated per agent is for later.

## The risk to keep in mind

An agent opened to members (`work_from = members`) can be directed by anyone on its boards, and it acts with authority derived from its owner's. Whatever an agent reads on a board is untrusted input. The role cap limits what can go wrong, not who steers. That's why the default is owner-only, and why the MCP guide tells an open agent to weigh requests by who made them. The same goes for a board's notes, which the guide quotes as the board's conventions, context rather than authority, below the owner and the user in the trust order it gives agents: editors write them, and an agent is an editor at most, so an agent can change them (`set_board_notes`). The tool says to do that only when asked, and every change is in the board's event log as `board.notes`. A board's docs are listed in the guide by name and summary only, so nothing a member uploads lands in an agent's context until it calls `read_doc`. (A board's notes have nothing to do with the `notes:*` grants, which are the owner's personal notepad.)

## Steps

1. **Done.** Schema, token resolution with owner and grants, the role cap, `mine(grant)`, the assignment rule, owner rename carrying over to agents, and the MCP speaking as an agent (`whoami` `agent_of`, the guide, no-inbox errors).
2. **Done.** Settings › agents: a page per agent (picture, name, what it's for, boards including your inbox, who gives it work, your data, connect steps, tokens, pause, delete) and one to make a new one. Any member brings their own agent onto a board at most at their own role; board owners can remove it and never make it an owner. What it's for is told to the agent as "Your job" in the MCP guide. Agents show with a bot mark and after people in pickers.
3. **Done.** The consent page asks "connect it as": you, one of your agents, or a new agent named right there. Tokens are made on the agent's page.
4. **Done.** Inbox and mentions: assignments and @mentions become durable events for whoever they name, agent or person, stored by id. An agent reads and acknowledges its inbox over the MCP. Human @mentions come from the same table. Being assigned by someone else and being mentioned land in the inbox (`inbox_items`); mentions resolve against the board's members when the comment is written (`comment_mentions`). People see it as the /inbox pane on the dashboard, where items open their task or get dismissed; agents use the MCP's `inbox` and `mark_read` (which can dismiss too). An item drops out once its reader can no longer see the board.
5. **Runs and claims done; the daemon is next.** A small daemon that watches an agent's inbox, declares a run and starts the runtime with the run's secret in its MCP config. What it needs from Copland is below, under Runs and claims.

Why this order, and what Copland is for, is in [DIRECTION.md](DIRECTION.md).

## Runs and claims

A run is one working session of a principal (`migrations/0015_runs_claims.sql`, `src/worker/routes/runs.ts`). Whatever launches the runtime calls `POST /api/runs` with the principal's own token and gets back a secret, `cplr_…`, that it hands to the runtime instead of the token. That secret resolves through the token that started the run (`tokens.ts`), so it is the same principal with the same scope, plus the run. It never has more: a read-only token can't start a run at all, since starting one is a write, and a run's secret can't start another run or touch token management. It stops working when the run finishes or goes stale (ten minutes without a call, so a run nobody finished leaves no live credential behind), when its token is revoked or expires, and when its agent is paused or its owner disabled. A launcher keeps a quiet runtime alive by calling `GET /api/runs/:id` with the secret. A person can start runs too; a script that wants its changes grouped is the obvious case.

Every call through a run is its sign of life. It moves `last_seen_at` (at most once a minute) and stamps `run_id` on every event the request writes, so history reads "dev via Codex · run 8f31". There is one lease, `RUN_LEASE_MS` in `src/domain/runs.ts`, ten minutes, and nothing sweeps. A running run not heard from for longer than that reads as stale wherever it is shown. Finishing (`POST /api/runs/:id/finish`, completed, failed or cancelled) is the run's own or its principal's; pausing or deleting the agent cancels its runs.

A claim is a run holding a task: one live claim per task, in `task_claims`. Assignment is the durable part ("dev owns this"), the claim the temporary one ("this run is on it now"). `POST /api/tasks/:id/claim` needs a run and the editor role. An unassigned task gets assigned to the claimer; one assigned to the claimer is fine; one assigned only to others is refused, and so is a closed one. The task moves to the board's first active stage unless it is already in one, and its parents follow. Another run's live claim is refused; a lapsed one, or one whose run ended, is replaced. The claim, the assignment and the move are one D1 batch whose second statement fails unless this run ended up holding the claim, so two runs racing for a task can't both win.

A claim is live while `claimed_until` is in the future and its run is running. Any call by the run pushes `claimed_until` a lease ahead, so a run that goes quiet loses its claims when it goes stale, and the task stays assigned for the next run to pick up. Claims are also released when the run finishes, when the task closes or is deleted, when the claimer comes off its assignees (the last statement of every task write), and with `DELETE /api/tasks/:id/claim`. The card says "dev is on this" while a claim is live, and the MCP summary carries `claimed_by` and `run`.

Over the MCP the model works inside a run; it doesn't start one. A session can't switch its own credential mid-connection, so a `start_run` tool would hand the model a secret it has no use for. It gets `claim_task`, `release_task` and `finish_run`, and `whoami` and the guide say whether the connection is a run. Without one, `claim_task` refuses and the guide says to assign yourself and move the task to active instead. Blocked isn't crashed: a run can move its task to blocked, ask its question and finish, and a later run claims the task again once someone answers.

## Still open

- What "pause" is beyond refusing tokens and ending runs (for example, showing paused on its assigned cards).
- Grouping a run's changes in the UI ("Codex made these 7 changes in one session"), and maybe undoing a run. The `run_id` on events is there for it.
- `run_id` on attachments; they carry no history of their own yet.
