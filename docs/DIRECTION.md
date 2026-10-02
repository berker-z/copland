# Where Copland is going

Copland is a dashboard for one person's life that their agents can also work in. Your notes, your calendar, later your mail, and the boards where work gets tracked all live in one place you deploy yourself. Your agents get names in it (`berker-z/dev`, `berker-z/research`), get work assigned to them, and leave a record of what they did, next to you.

It sits between two kinds of product, and borrows one half of each.

Hermes and the other personal agents own the execution. The agent is the product: it runs the loop, holds the memory and the tools, and your data flows through it. That gives it reach into your life. It also means you live inside its runtime, and using Codex for one job and Claude for another means working around it.

Linear and Jira own the work. Tasks, assignment, history and handoffs are good there, and both now treat agents as teammates. But it's a hosted workspace built for teams, the agents are apps installed into someone else's product, and it knows nothing about your calendar or your notes.

Copland takes the personal reach from the first and the work structure from the second. It refuses the part of each that locks you in. It does not run agents, so any runtime can be one of your workers: Claude Code, Codex, a shell script, something that doesn't exist yet. And it isn't a hosted service. It's open source and you deploy it to your own account, so your data stays yours and nothing here depends on Google, Linear or Atlassian staying friendly.

The short version is the one from the research note: Copland owns coordination, not cognition. If a feature helps track work, who does it, what they're allowed to touch and what came out of it, it belongs here. If it makes Copland better at thinking or executing, it belongs in a runtime.

## Not owning the runtime

The obvious cost is that Copland only knows what runtimes tell it. It never sees the process. One rule keeps that workable: Copland enforces everything about authority itself, and only records what runtimes report about progress.

Authority never depends on the runtime. Roles, grants, pausing and the cap at the owner's own role are checked on every call (`src/worker/access.ts`). A runtime can say whatever it likes about its progress; it can't claim permissions it doesn't have.

Progress is reported. A run (one execution of an agent) will be declared from outside, either by whatever launched it or by the agent itself. Any call carrying the run's id counts as a sign of life, and a run that goes quiet shows as stale, last heard so many minutes ago, rather than pretending to know. Claims on tasks will be time-limited, so a run that crashes loses its claim when the time runs out and the task goes back to its agent's queue. Nobody has to notice the crash.

What Copland will never know is how much a run cost, how it reasoned, or whether its work was any good. The record is what the agent leaves behind: comments, attachments, task changes, all under its name. Judging that is the owner's job, same as with any worker.

## Lock-in we still have

Copland runs on Cloudflare: Workers, D1, R2 and a Durable Object for live updates. That's a platform dependency too, just a smaller one than handing your data to a SaaS. Two things keep it honest. D1 is SQLite, so a full export is cheap and should be a button in settings. And the Cloudflare-specific parts stay in a few small modules, so a version that runs on a plain server stays possible.

Integrations go through open protocols where they exist. Calendars already work that way: Google is one source and any ICS link is another. Mail will be IMAP or JMAP first, with Gmail's API at most a convenience.

## What comes next

In order, each useful on its own:

1. An inbox for every principal, person or agent: durable events like "assigned to you" and "mentioned you", read and acknowledged over the MCP. Mentions are stored as ids when the comment is written, so renaming or reusing a handle never moves a mention to someone else.
2. A small daemon that watches an agent's inbox and starts your runtime of choice when work arrives. It declares the run and hands the runtime an MCP config carrying the run's id, so every call is tagged without the model having to remember anything. Runs and claims arrive with it.
3. Data export.
4. Mail, in v0.2. It's the most useful source and the most dangerous one: anyone in the world can put text in front of an agent by sending an email. Mail grants will be narrow (read only, limited to chosen labels or senders), and agents will be told that mail is untrusted input.

The longer research note behind this, with the comparison to Linear, Jira, GitHub, Devin and A2A, is in [research/agent-control-plane.md](research/agent-control-plane.md). How agents work today is in [AGENT-IDENTITIES.md](AGENT-IDENTITIES.md).
