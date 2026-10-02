# Agents as their own identities

An agent is a job you've given a name, like `berker-z/codex` or `berker-z/scout`. It isn't a product: the same Claude Code can be your reviewer one day and your scout the next, depending on which credential it holds.

Step 1, the foundation, is built: the schema, how an agent's token resolves, access, and the MCP's view of it. Nothing in the app makes agents yet. That's step 2.

## Four layers

| Layer | What it is | Lifetime | Where |
|---|---|---|---|
| Principal | who acts: `berker-z`, `berker-z/codex` | long; it gets assignments and appears in history | `users` (`kind` is person or agent) |
| Credential | how a program proves it is that principal | rotated, revoked, refreshed | `api_tokens.user_id` |
| Client | the program doing the work | per connection | `api_tokens.agent`, shown as "via" |
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
- **The inbox.** The owner will be able to add their own agents to their inbox (step 2; boards refuse inbox members today), and only their own. The agent's `/api/me` already reports the owner's inbox once it is there.

## Decided

- The agent is the identity; a token is a credential it holds, and it can hold several.
- Making a token, or approving on the OAuth consent page, asks who it acts as: me, one of my agents, or a new agent. "Me" tokens stay, for scripts.
- Only the owner adds their agent to a board, the owner's inbox included.
- Personal agents only, no instance agents.
- Agents never make boards, invite people or manage tokens.
- Deleting an agent ends its tokens and takes it off boards and assignments. History keeps "berker-z/codex (deleted)".
- An agent can have a picture, with a generic mark until it does. Something generated per agent is for later.

## The risk to keep in mind

An agent opened to members (`work_from = members`) can be directed by anyone on its boards, and it acts with authority derived from its owner's. Whatever an agent reads on a board is untrusted input. The role cap limits what can go wrong, not who steers. That's why the default is owner-only, and why the MCP guide tells an open agent to weigh requests by who made them.

## Steps

1. **Done.** Schema, token resolution with owner and grants, the role cap, `mine(grant)`, the assignment rule, owner rename carrying over to agents, and the MCP speaking as an agent (`whoami` `agent_of`, the guide, no-inbox errors).
2. Settings › agents: create, describe, pause, delete, grants, `work_from`, its tokens, its boards (and the owner's inbox). Agents show apart from people in the member and assignee pickers.
3. The "act as" choice on the OAuth consent page and when making a personal token.
4. More MCP for agents: claiming a task (assign yourself, move it to an active stage) and, later, a claim that expires (`claimed_until`) so a crashed agent doesn't hold work forever.
5. Notifications: assignments and @mentions queue up for whoever they name, agent or person. An agent reads and acknowledges its queue. Human @mentions come from the same table.

## Still open

- What "pause" is beyond refusing tokens (for example, showing paused on its assigned cards).
- An optional run id on events, to group "Codex made these 7 changes in one session", and maybe to undo a run.
