# GitHub on boards

A board knows about the repos its work happens in. A branch named `copl-73-github` shows up on COPL-73, so does a PR that names it, with CI on each, and merging a PR that closes a task moves the task to done. It comes in through a GitHub App the instance makes for itself. The App only reads; Copland doesn't write to GitHub. Built in COPL-73.

## The App

Every instance has its own App, at most one. An admin makes it from settings › instance › github with GitHub's manifest flow: Copland posts a description of the App (name, URLs, read-only permissions, four events) to GitHub, you confirm it on github.com, and GitHub sends you back to `/auth/github/callback` with a code. The Worker trades the code for the App's id, private key and webhook secret, keeps them sealed under `VAULT_KEY` (the `github_app` table), and sends you on to install the App on whichever repos it should see. That's the whole setup, and a fork of Copland gets it the same way with nothing to set in Cloudflare.

The App asks for read access to metadata, contents, pull requests, checks and statuses, and subscribes to push, pull_request, check_suite and status. Its webhook URL is `/api/github`, one for every repo it is installed on.

Copland calls GitHub for one thing: the list of repos the App is installed on, which is what a board can be connected to. That needs a JWT signed with the App's key (RS256), traded for a token per installation. Both live for minutes and are never stored. GitHub hands out the key as PKCS#1, which WebCrypto won't import, so `src/worker/pem.ts` wraps it into PKCS#8 when it's stored.

Forgetting the App in settings removes it from Copland only. Delete it on GitHub too. Repos stay connected to their boards and hear nothing until there's an App again.

## Connecting a repo

In a board's settings (the gear), github lists the App's repos that aren't on the board yet. Pick one and connect. Each connected repo says when GitHub last delivered something for it ("heard push 14:17"), and one that has never been heard from says so in yellow.

Only an instance admin who owns the board can connect a repo. The App sees whatever its owner installed it on, private repos included, so if any board owner could connect any repo the App sees, a friend on your instance could attach your private repo to their board and read its PRs. Any owner can disconnect, which also removes everything the repo put on the board's tasks. Agents can do neither, since they are never owners.

A repo can be on several boards. A delivery lands on each of them, matched against that board's keys.

## How code finds a task

By the task's key, and only keys of a board the repo is connected to.

- **A branch** whose name has the key, anywhere (`copl-73-github`, `feature/COPL-73`). It shows on the task until it is deleted, then shows as closed.
- **A PR** whose branch has the key, whose title has it, or whose body has it after a closing keyword (`Fixes COPL-73`, `closes: copl-73`; GitHub's own keywords). A key in the body without a keyword doesn't count, so "see COPL-12" in a description doesn't drag a PR onto COPL-12. A PR edited so it stops naming a task comes off that task.
- **CI** belongs to a commit. A `check_suite` that completes, or a commit `status`, sets the CI of every branch and PR whose head is that commit. Several checks report on one commit and we keep one state for it: the latest report wins, except that a failure stays until there's a new commit, so one green check can't hide another's red. A new head forgets the old CI.

Matching keys is `src/domain/github.ts`, checked by `checks/github.check.ts`. The webhook and the routes are `src/worker/routes/github.ts`, the App is `src/worker/githubApp.ts`, and the tables are `github_app`, `board_repos` and `task_code` (migration 0019).

## What a merge does

Only a merge into the repo's default branch moves anything. Such a PR moves the tasks it closes (by its branch or a closing keyword) to the board's first done stage; a merge into any other branch only shows on the task. A task only named in the title gets the PR linked and stays where it is. A task that's already closed stays where it is too.

The move goes through the same code as a move in the app, as the admin who connected the repo. Their role on the board is checked at the time of the merge, so if they've left it or become a viewer the PR is still linked but the task doesn't move. Parents follow their children and claims end as for any move, and the history says "berker-z via GitHub". Opening a PR doesn't move a task: claiming it already put it in an active stage.

Who merges is up to the task. By default an agent working it merges its own PR once CI is green, with the machine's own git credentials (the App stays read-only), and the merge is what closes the task, so agents never move coding tasks to done themselves. A task with **review first** set (a checkbox under merge in the task, `review_first` through the MCP, migration 0020) stops at the open PR for a person to review and merge. Done means merged, which is also what lets a task that depends on it be claimed (COPL-78).

## Without GitHub

GitHub is optional (COPL-95). A board's owner can give it a plain git remote instead, in the board's settings under code: an https or ssh URL, `user@host:path`, or a path on the agents' machines. Copland stores it and never touches it; the daemons clone it with their owners' own credentials, give tasks worktrees from it as for GitHub, and run leads and workers the same way. What's missing is everything the App did: no webhook, no PRs, no code on tasks, no CI shown. So agents finish by the guide's git procedure, integrate by fast-forwarding `main` (which git refuses once `main` has moved, so they re-check and retry), and move the task to done themselves, since nothing else would close it.

## Drift: merging on stale assumptions

The rule itself is the agent's, and needs no GitHub at all: before integrating, it fetches, looks at what `main` changed since its work started, re-checks its work against that, and integrates; with no PR that's a fast-forward push of `main`, which git refuses once `main` has moved again, so what lands was checked against the `main` it lands on. That procedure is the guide's Code section. What follows is what Copland adds on a board with GitHub: the same measurement from the outside, shown on the task and the PR. It's optional.

Agents work side by side, each on a branch from `main` as it was when it started (COPL-82). If `main` moves under a task in the files that task changes, the task's code may rest on how those files used to be. It still compiles and its tests still pass, and it's quietly wrong. CI can't see that, so Copland makes it a step of its own (COPL-75, `src/worker/drift.ts`).

For each open PR naming a task, Copland compares three things with the App: where the work started (the parent of the PR's first commit), `main` now, and the PR's head. That gives the files `main` changed since the work started, the files the PR changes, and the files in both. It keeps that on the PR's rows (migration 0022) and posts it to GitHub as a commit status, `copland/drift`, on the PR's head:

- **behind**: the branch doesn't have `main`'s latest commits yet. Pending until it takes them in.
- **clean**: nothing the PR changes moved under it. Green.
- **recheck**: `main` changed files the PR changes. Pending until someone re-checks the change against those changes and says so with `revalidate`, for that very `main` commit. If `main` moves again, it's pending again.
- **revalidated**: re-checked against the current `main`. Green.

It's measured when a PR opens or moves, when `main` moves (every open PR on the repo), and when someone asks (`drift`) or revalidates. An overlap of three files or more also makes the task review first, as the person who connected the repo, via GitHub: its author doesn't merge it.

Through the MCP, `drift(task)` measures now and returns everything `main` changed, not only the overlap, because a task can rely on files it never changed; the guide tells agents to skim that list too. `revalidate(task, main, note)` only takes the `main` commit the agent actually looked at, refuses one that `main` has moved past, and posts the note on the task. The guide's Code section is the finishing procedure: tests for the behaviour you add, bring the branch up to date, rerun the checks, `drift`, re-check and `revalidate` when it says so, merge.

Turning it into a hard gate is optional, with branch protection on `main`: `ci` (`.github/workflows/ci.yml`: typecheck, check, build, and the daemon's tests when it changes) and `copland/drift` must be green, and the branch up to date. No runtime can merge past it, whichever one wrote the code. Posting the status needs the App's one write permission, commit statuses; an App made before COPL-93 asks for it in its settings on GitHub. Drift is per file: a change in a function the task calls, in a file it didn't touch, shows up only in `main`'s list, not in the overlap.

## Where it shows

On the task, a code row lists its PRs and branches, open first: the state in its colour (open green, draft muted, merged magenta, closed red), `#12` and the title, and CI as a word. A card shows one PR, the first open one or else the latest merged, as its number with a dot for CI.

Through the MCP, a task summary has `code` when there is any (`{ pr, title, repo, state, ci, url }` or `{ branch, ... }`), `get_board` lists the board's `repos`, and the guide tells agents to name their branches after the task. The App and connecting repos are `admin:` in `mcpCoverage.ts`, and the webhook is `private:`.

## What it doesn't do

Webhooks only say what changes. Nothing from before a repo was connected shows up, and a task's code is whatever the last delivery said. GitHub keeps the App's recent deliveries and can redeliver one from the App's settings.

GitHub issues don't become tasks, and nothing on a task goes back to GitHub. Writing would mean asking for write permissions, and full sync (an issue and a task being the same thing) needs rules for who wins an edit and mappings between fields that don't line up. Tasks live in Copland anyway.

Who did something on GitHub isn't recorded. GitHub users aren't Copland users, and the only move the webhook makes is a merge closing a task, which is logged as the connecting admin via GitHub.

## Later

The daemon makes each coding task a worktree on a `<key>-<slug>` branch, kept across runs, and runs the agent in it sandboxed; the agent pushes, opens the PR and merges with the machine's own git credentials (daemon/README.md, Coding tasks). Agents running somewhere without them could get short-lived installation tokens from the App instead, which needs it to ask for write access. Push events list the files each commit touched, which is where showing two tasks that touch the same files will come from (COPL-75).
