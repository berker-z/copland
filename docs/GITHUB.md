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

## Where it shows

On the task, a code row lists its PRs and branches, open first: the state in its colour (open green, draft muted, merged magenta, closed red), `#12` and the title, and CI as a word. A card shows one PR, the first open one or else the latest merged, as its number with a dot for CI.

Through the MCP, a task summary has `code` when there is any (`{ pr, title, repo, state, ci, url }` or `{ branch, ... }`), `get_board` lists the board's `repos`, and the guide tells agents to name their branches after the task. The App and connecting repos are `admin:` in `mcpCoverage.ts`, and the webhook is `private:`.

## What it doesn't do

Webhooks only say what changes. Nothing from before a repo was connected shows up, and a task's code is whatever the last delivery said. GitHub keeps the App's recent deliveries and can redeliver one from the App's settings.

GitHub issues don't become tasks, and nothing on a task goes back to GitHub. Writing would mean asking for write permissions, and full sync (an issue and a task being the same thing) needs rules for who wins an edit and mappings between fields that don't line up. Tasks live in Copland anyway.

Who did something on GitHub isn't recorded. GitHub users aren't Copland users, and the only move the webhook makes is a merge closing a task, which is logged as the connecting admin via GitHub.

## Later

The daemon will make a worktree and a `<key>-<slug>` branch per claim and open the PR when a run finishes (COPL-74), with the machine's own git credentials for now. Agents running somewhere without them could get short-lived installation tokens from the App instead, which needs it to ask for write access. Push events list the files each commit touched, which is where showing two tasks that touch the same files will come from (COPL-75).
