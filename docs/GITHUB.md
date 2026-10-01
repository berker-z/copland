# GitHub on boards (undecided)

Notes for later. Nothing here is built. The idea is that a board knows about the repos its work happens in, so a PR that mentions `LNCH-4` shows up on LNCH-4, and merging it can close the task.

These are the choices, roughly in order of how much they cost.

## Which way things flow

The cheap version is GitHub to Copland only. GitHub tells us about PRs, commits and issues, and we update tasks. Only one side writes, so nothing can conflict.

Copland writing to GitHub too (make a branch or an issue from a task, comment on the PR when the task moves) means holding a token that can write to your repos.

Full two-way sync, where an issue and a task are the same thing, is the expensive one. You need a rule for who wins when both sides edit a title, a mapping between fields that don't line up (stages vs open/closed, labels, assignees who aren't Copland users), and a way to stop updates echoing back and forth. Easy to get wrong, and tasks live in Copland anyway.

## How we connect

A plain repo webhook with a shared secret is the floor. Paste a URL and a secret into the repo's settings, and the Worker checks GitHub's signature on every delivery. It works for private repos, needs no registration, and a fork of Copland gets it for free. But it can only receive, and every repo is set up by hand.

A GitHub App installs once on an account or org, you pick repos from a list, and it can read and write as `copland[bot]`. The catch is that every Copland instance has to register its own App and keep a private key, which is friction for the deploy-your-own story in the README.

OAuth with your own token reads your repos fine and can show live PR state, but anything it writes shows as you, and it stops working when you leave a repo.

The App and OAuth only earn their keep if Copland writes to GitHub.

## How code finds a task

Task keys in text: `LNCH-4` in a branch name, PR title or body, or commit message. Free if keys are a habit.

Pasting a PR URL into the task already works today (it's a link attachment), just without live status.

Keys only resolve within the board that owns the webhook. Otherwise any public repo that mentions `LNCH-4` could touch your board.

## What an event does

At minimum it annotates: a PR link on the task, a line in its history, a status badge.

It could also move tasks. `fixes LNCH-4` in a merged PR moves it to done, and maybe opening a PR moves it to doing. Stages are editable and "done" means different things on different boards, so this probably wants a per-board mapping from PR state to stage.

New GitHub issues could become tasks on the board. That's where a one-way bridge starts sliding into sync.

## Where PR status comes from

Either store whatever the webhooks send (open, merged, closed, title), which needs no token and has no rate limits but knows nothing from before the hook existed, or fetch from GitHub when a task is viewed, which is always right but needs a token for private repos and has to watch the rate limit.

## Who did it

GitHub users aren't Copland users. History can say "github:berker-z merged #12", or we can match accounts by email. The MCP already writes "via Claude Code", so showing where something came from has precedent.

## Leaning towards

GitHub to Copland only, over a plain webhook, matching task keys in text. Merges move tasks to done and everything else only annotates. PR status is whatever the webhooks last said. It's all inbound, forks need no setup, nothing can conflict, and a GitHub App can be added later without undoing any of it.

## Still to decide

- Should Copland ever write to GitHub? If not, the webhook is all we need and the App never happens.
- Which events move tasks: merges only, or PR opened → doing as well? Fixed stages, or chosen per board?
- Should new GitHub issues become tasks?
- One repo per board or several? (Several, probably.)
- MCP: a tool for "which PRs touch LNCH-4", or just PR links in what `get_task` already returns?
