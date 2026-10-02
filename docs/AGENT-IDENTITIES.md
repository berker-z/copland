# Agents as their own identities

An agent is a job you've given a name, like `berker-z/codex` or `berker-z/scout`. It isn't a product: the same Claude Code can be your reviewer one day and your scout the next, depending on which credential it holds.

Steps 1 to 3 are built: the foundation (schema, tokens, access, the MCP's view), settings › agents, and choosing an agent when connecting an app. What is left is under Steps.

## Four layers

| Layer | What it is | Lifetime | Where |
|---|---|---|---|
| Principal | who acts: `berker-z`, `berker-z/codex` | long; it gets assignments and appears in history | `users` (`kind` is person or agent) |
| Credential | how a program proves it is that principal | rotated, revoked, refreshed | `api_tokens.user_id` |
| Client | the program doing the work | per connection | `api_tokens.client`, shown as "via" |
| Run | one working session | minutes | not yet |

Merging the first two ("each token is a user") would turn a rotated token or an OAuth refresh into a new person, orphaning its assignments and history. Merging the first and third ("Claude Code is an agent") would make every Claude the same agent. History reads "berker-z/codex via Codex CLI", and both halves carry information.

## Where agents live

Agents are rows in `users`, because everything an agent needs to be already points at `users(id)`: board members, assignees, comment authors and history actors. `kind = 'agent'` and `owner_id` mark one (`migrations/0007_agents.sql`). Agent-only details go in `agents` (name, description, `work_from`, `paused_at`), and what it may reach of its owner's in `agent_grants`.

`users.email` stays NOT NULL. Making it nullable means rebuilding the table, and in D1 dropping `users` cascades into every table that references it. That was tried on a copy and emptied sessions, memberships, settings and tokens. So an agent's email is `<id>@agent.invalid`, which Google never verifies, so it can't sign in. `rowToUser` reports it as null, email lookups and the admin list are people-only, and invites refuse `.invalid` addresses.

The handle is stored whole (`berker-z/codex`) so every query reading `users.handle` works unchanged. Renaming the owner rewrites their agents' handles in the same batch. Person handles can't contain "/", so the two never collide.

## Authority

- **Boards: membership, capped.** An agent sees only boards it was added to. Its role on each is the lowest of three: its own, its owner's there, and editor. That's worked out on every request in `access.ts`, so when the owner loses a board, the agent does too. Agents never manage boards, since everything that needs the owner role is out of reach. Making boards calls `requirePerson`.
- **The owner's personal data: explicit grants.** Each personal route in `index.ts` is wrapped in `mine(grant)`. A person reaches their own data. An agent reaches its owner's only if it holds the grant, and the route then runs as the owner, unchanged. The grants are `calendar:read`, `notes:read` and `notes:write`. Settings, the vault, tokens, the profile and calendar writes are `mine(null)`: never.
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

An agent opened to members (`work_from = members`) can be directed by anyone on its boards, and it acts with authority derived from its owner's. Whatever an agent reads on a board is untrusted input. The role cap limits what can go wrong, not who steers. That's why the default is owner-only, and why the MCP guide tells an open agent to weigh requests by who made them.

## Steps

1. **Done.** Schema, token resolution with owner and grants, the role cap, `mine(grant)`, the assignment rule, owner rename carrying over to agents, and the MCP speaking as an agent (`whoami` `agent_of`, the guide, no-inbox errors).
2. **Done.** Settings › agents: a page per agent (picture, name, what it's for, boards including your inbox, who gives it work, your data, connect steps, tokens, pause, delete) and one to make a new one. Any member brings their own agent onto a board at most at their own role; board owners can remove it and never make it an owner. What it's for is told to the agent as "Your job" in the MCP guide. Agents show with a bot mark and after people in pickers.
3. **Done.** The consent page asks "connect it as": you, one of your agents, or a new agent named right there. Tokens are made on the agent's page.
4. **Done.** Inbox and mentions: assignments and @mentions become durable events for whoever they name, agent or person, stored by id. An agent reads and acknowledges its inbox over the MCP. Human @mentions come from the same table. Being assigned by someone else and being mentioned land in the inbox (`inbox_items`); mentions resolve against the board's members when the comment is written (`comment_mentions`). People see it as the /inbox pane on the dashboard, where items open their task or get dismissed; agents use the MCP's `inbox` and `mark_read` (which can dismiss too). An item drops out once its reader can no longer see the board.
5. A small daemon that watches an agent's inbox, declares a run and starts the runtime with the run's id in its MCP config. Runs, claims that expire, and an optional `run_id` on events and attachments arrive with it.

Why this order, and what Copland is for, is in [DIRECTION.md](DIRECTION.md).

## Still open

- What "pause" is beyond refusing tokens (for example, showing paused on its assigned cards).
- An optional run id on events, to group "Codex made these 7 changes in one session", and maybe to undo a run.
