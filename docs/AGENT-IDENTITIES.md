# Agents as their own identities (undecided)

Notes for later. Nothing here is built.

## What a token is today

Every token is you. A personal token and an approved OAuth app both resolve to your user row (`src/worker/tokens.ts`), with your board roles and nothing more, narrowed only by scope: read, or read + write. The `agent` column remembers which client last used the token ("claude-code"), and that's what puts "berker via Claude Code" in a task's history.

So an assistant can't be assigned a task, can't be on a board you're not on, can't have less access than you on one board and more on another, and can't be told apart from you except by that "via". For one person and Claude Code that's fine. It stops being fine once agents do work on their own: "Scout picks up anything assigned to it on LNCH" has nowhere to live.

## What an agent identity would be

An agent is a principal of its own. It has a name, an owner (the person who made it and answers for it), board memberships with roles, and its own tokens. It can be assigned tasks, it shows in history as itself ("scout, berker's agent"), and pausing or deleting it kills every token it has.

## The choices

**Where agents live.** As rows in `users` with `kind = 'agent'` and an `owner_id`, or in a table of their own. A user row gets memberships, assignees, history actors and `rowToUser` for free, because everything already speaks user ids. The cost is remembering to keep agents out of the places only people belong: sign-in, the people page, invites, admin. A separate table is tidier and touches every query that joins on users. User rows look like the cheaper path.

**How much an agent can do.** Board owners could add agents like members, with any role, independent of whoever owns the agent. Or an agent's role on a board is capped by its owner's (it never exceeds the owner, and it loses access the moment the owner does). The cap is easier to reason about: an agent can't be a way around someone's own permissions.

**Who makes agents.** Anyone, for themselves? Only admins? And are there instance agents, owned by nobody in particular, like a nightly triage bot? Personal agents first is the obvious start.

**Tokens and OAuth.** Tokens would belong to a principal, a person or an agent. Connecting Claude over OAuth then needs one more question on the consent page: connect as me, or as one of my agents.

**History.** The actor becomes the agent, with the owner beside it. "via" stays, for which client the agent was running in.

**MCP.** `whoami` answers with the agent. `my_work` for an agent is what's assigned to it, which is exactly the loop that makes agents useful: assign, the agent picks it up, its changes show up as its own.

## What it does to settings

Access stays "things that act as you": your tokens and the apps you approved. Agents get a page of their own next to it, each agent with its boards, its tokens and a pause switch. The settings layout already has room for that page under connections.

## Still to decide

- User rows with a kind, or a table of their own?
- Capped by the owner's role, or independent?
- Personal agents only, or instance agents too?
- Does an agent ever get to invite people or make boards, or only work on existing ones?
