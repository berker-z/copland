# Agents as their own identities (mostly decided)

Notes for the next piece of work. Nothing here is built yet, except that handles already leave room for it.

## What a token is today

Every token is you. A personal token and an approved OAuth app both resolve to your user row (`src/worker/tokens.ts`), with your board roles and nothing more, narrowed only by scope: read, or read + write. The `agent` column remembers which client last used the token ("claude-code"), and that's what puts "berker-z via Claude Code" in a task's history.

So an assistant can't be assigned a task, can't be on a board you're not on, can't have less access than you on one board and more on another, and can't be told apart from you except by that "via". For one person and Claude Code that's fine. It stops being fine once agents do work on their own: "Scout picks up anything assigned to it on LNCH" has nowhere to live.

## What an agent is

An agent is a principal of its own, owned by the person who made it and answers for it. Its handle is `owner/name`, e.g. `berker-z/codex`: the owner is visible to everyone, and two people can both have a `codex`. Person handles can't contain "/" (`src/domain/handle.ts`), so the two never collide.

It has board memberships, its own tokens, a picture, and it can be assigned tasks and mentioned. History shows it as itself, with "via" kept for which client it was running in.

## Decided

- **The agent is the identity; a token is a credential it holds.** Not one identity per token: rotating a token, or an OAuth refresh, must not make a new "person" and orphan its assignments and history. An agent can hold several tokens.
- **Making a token asks who it acts as:** me, one of my agents, or a new agent. The OAuth consent page asks the same. Plain "me" tokens stay, for scripts.
- **Agents are rows in `users`** with `kind = 'agent'` and an `owner_id`. Memberships, assignees, comments and history actors all work unchanged because they already speak user ids. They are kept out of what only people do: sign-in, invites, the admin people list.
- **Capped by the owner.** An agent sees only boards it was added to, and its role there is never more than its owner's. It loses access the moment the owner does. It can't be a way around anyone's own permissions.
- **Only the owner adds their agent to a board.** Not other board owners.
- **Personal agents only**, for now. No instance agents.
- **An explicit capability list.** What an agent may do is a list, not "whatever its role allows". It never makes boards, invites people, or manages tokens; those three are off the list for now. Anything added later is added to the list on purpose.
- **Deleting an agent** kills its tokens and takes it off boards and assignments. History keeps showing "berker-z/codex (deleted)".
- **Pictures:** an agent can have one like anyone, a generic mark until it does. Something generated per agent is an idea for later.

## MCP

`whoami` answers with the agent. `my_work` for an agent is what's assigned to it, which is the loop that makes agents useful: assign, the agent picks it up, its changes show up as its own. `set_handle` has to decide what it means for an agent (rename the agent part only, probably).

## Settings

Access stays "things that act as you": your tokens and the apps you approved. Agents get a page of their own next to it, each agent with its boards, its tokens, its capabilities and a pause switch.

## Still open

- The schema for the capability list: a column of flags, or a table of grants.
- What "pause" is beyond refusing its tokens.
- Whether mentions of an agent notify the agent (a queue it reads), its owner, or both.
