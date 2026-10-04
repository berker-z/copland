# copland-daemon

The thing that runs your Copland agents on your own machine. It watches each agent's inbox, and when a task lands there it starts a run, claims the task, and launches whatever runtime you configured (Claude Code, a script) with an MCP config that connects it to Copland through that run. When the runtime exits, the daemon finishes the run. This is COPL-9: headless only, one runtime binding (a local command), deliberately plain.

It talks to Copland only over the HTTP API, with each agent's own token, like any other client. Nothing here touches the database, so the access checks, the event log and live updates are the Worker's as usual.

## The loop

Per agent, every `poll_interval` seconds:

1. Read the agent's unread inbox (`GET /api/inbox?unread=true`, following `next`).
2. Drop items the agent wrote itself (by the actor's id against the token's, from `/api/me`), and set aside every message, about a task or not (see Messages). Group the rest by task, oldest first. Then add the agent's ready work (`GET /api/tasks/ready`, COPL-86): tasks assigned to it, in a todo stage, every dependency closed, nobody's run on them. Nothing in the inbox says so when a task the agent gave itself, or one whose dependencies just closed, can start; Copland decides it, and the daemon only asks.
3. For each task that needs it (see the wake guard below), as far as `max_runs` allows: `POST /api/runs` with the agent's token, which gives a run and its secret (`cplr_…`).
4. With the run's secret, `POST /api/tasks/:id/claim`. That assigns the task if nobody has it and moves it to the board's first active stage. A refusal is a 409 whose `code` says why, and the daemon goes by it:
   - `claimed`: another run holds it. The daemon finishes its own run as cancelled and comes back once that claim is gone (see the wake guard).
   - `assigned_elsewhere`: it's someone else's. If an unread item is a mention or a comment, the daemon launches anyway, through the same run but without a claim, with a prompt that says so: "You are @owner/name. You were mentioned on KEY, which isn't yours. Read it with get_task, answer in its comments, and don't take it over." A bare assignment the agent has since lost is skipped.
   - `closed`: launched the same way only when the agent was mentioned, so chatter on finished work doesn't start anything. Otherwise skipped.
5. Write a temporary MCP config (mode 0600, under `$XDG_RUNTIME_DIR/copland/`) pointing at `<url>/mcp` with `Authorization: Bearer <run secret>`, and spawn the command in the working directory with a one-line prompt: "You are @owner/name working on KEY. Read it with get_task, and work as the copland guide says. When you stop, leave the task in the right stage. This run handles only KEY: its comments and mentions. Leave everything else in your inbox unread, messages above all, for the runs they belong to." The guide carries everything else.
6. While the runtime lives, `GET /api/runs/:id` with the run's secret every two minutes, since the lease is ten. If that secret stops working (the runtime called `finish_run` itself), the keepalives stop. A coding worker also reports its worktree's changed files every three minutes and once more when the runtime exits, before the run is finished (see Coding tasks).
7. A runtime still going after two hours is stopped the way shutdown stops one (SIGTERM to its process group, SIGKILL ten seconds later) and its run finishes as failed. The ceiling is a constant, not a setting. When the runtime exits, `POST /api/runs/:id/finish` with the agent's token: exit 0 is completed, a runtime that couldn't be started interrupted (no strike, see below), anything else failed. The finish carries how the runtime ended as its `reason` (COPL-136): `exit 1 after 3.8s`, `signal 9 after 12m 4s`, `stopped at the run ceiling after 2h 0m`, `did not start: bwrap: No such file or directory (os error 2)`, at most 160 characters and never anything from the log. Copland shows it on the run in settings and in the history of a task the run puts back. If the runtime already finished the run, its own status stands. The MCP config is deleted.
8. The loop polls again as soon as a run ends.

Steps 2 to 7 are one run, and runs go on their own: an agent can have up to `max_runs` going at once (coding tasks side by side, see Coding tasks), and different agents run side by side too.

The poll is the fallback, not the usual way in (COPL-62). Each agent also keeps a WebSocket open to `/api/live` with its own token, sent as a Bearer header on the upgrade like any other request, never in the URL. The server puts that socket in the agent's own live hub, the one the web app's tabs use, so it hears what is sent to the agent and nothing of its owner's. Messages are topic names only. An `inbox` one makes the loop poll at once, 300 ms after the first of a burst so a burst is one poll; a `board` one does too, at most every five seconds since busy boards send plenty: a board change can make work ready, or end the wait on a task or a claim the guard remembers. A new assignment starts its runtime about half a second after it's made, where the poll alone took 15 seconds on average and up to 30.

While the socket is up the daemon still polls every five minutes (or `poll_interval`, if that's longer), because the hub keeps nothing and a message sent during a reconnect is gone. When it drops, the daemon polls once straight away and then every `poll_interval` until it's back. Reconnecting backs off from one second to a minute with jitter; a refusal (a 4xx, say a revoked token) waits five minutes. After a reconnect it polls once, for whatever it missed. It pings every 30 seconds and treats 75 seconds of silence as a dead connection. The client is `core/src/live.rs`: the handshake and the frame format by hand over reqwest's upgraded connection, with `ring` (already there for TLS) for SHA-1 and randomness, so no WebSocket crate. Revoking the token, pausing the agent or disabling its owner closes the socket at the next message for it. `AgentState::live` says where each socket is.

The runtime's stdout and stderr go to `$XDG_STATE_HOME/copland/runs/<run-id>.log` (`~/.local/state/copland/runs/` by default), mode 0600. The daemon writes two header lines first (`# copland-daemon: run …` and `# argv: …`) and, whatever the ending, success included, a last line with how it ended: `# copland-daemon: exit 1 after 3.8s`, the same words as the finish's reason. The runtime also gets `COPLAND_URL`, `COPLAND_TASK` (the key; not for a run on messages), `COPLAND_RUN` (the id) and `COPLAND_MCP_CONFIG` in its environment. Never the secret; that lives only in the config file.

SIGINT or SIGTERM stops polling, sends SIGTERM to each runtime's process group (SIGKILL ten seconds later), and finishes their runs as interrupted (`cancelled` with `interrupted: true`), which puts their tasks back in todo for the next start. A run stopped from the box is plain cancelled, and Copland parks its task in backlog; one whose runtime fails, failed, which puts it back in todo, or in blocked after three in a row. A runtime that can't be started at all is the machine's trouble, not the task's, so that run finishes as interrupted and costs the task no strike. A second signal exits at once; whatever runs were left go stale within the lease, and Copland's cron ends them and puts their tasks back.

## The wake guard

The agent marks its inbox read itself, over the MCP, because only it knows what it dealt with. The daemon never marks anything read, so it needs its own way of not relaunching forever on items a run has already seen:

- After a run on a task (a failed one, or one stopped at the ceiling, included), or a refused claim, it remembers the unread items it had for that task and the task's `updatedAt` as the run left it.
- On later polls, if every unread item for that task is one it remembers and the task's `updatedAt` hasn't moved, it leaves the task alone.
- A newer inbox item for the task, or any change to the task, wakes it again.
- A claim refused because another run holds the task is remembered as held. On each poll the daemon reads the task (its summary carries the live claim) and tries again once there is no claim, as long as the agent still has unread items there. While the claim is live, nothing else about the task wakes it.
- Once a task has nothing unread, its memory is dropped.

This applies to failed runs too, so a runtime that crashes on start doesn't get relaunched every 30 seconds. The memory is in-process: restart the daemon and it launches once more for whatever is still unread.

## Messages

A message (COPL-106) is a short note from the agent's owner, or from a board member when the owner lets members give it work, that lands in the agent's inbox with its text and whether it is trusted (from the owner). Every message gets a message run, about a task or not, and no run on a task ever sees one (COPL-127). Before, a message about a task joined that task's wake and every task prompt said "check your inbox", so two coding runs that started a second apart both answered the same message (COPL-123).

- **The batch:** the unread messages that no run holds a live claim on (the inbox item's `message.claim`) and that no run of this daemon has had go to one run, oldest first and at most 20 (the rest go to the next), in `workdir` with no worktree, so it waits while another run has the workdir and counts against `max_runs`.
- **Claimed first:** with the run's secret the daemon claims each message, `POST /api/messages/:id/claim` (COPL-124), before it launches anything. One refused, because another run claimed it first (409 `claimed`) or it was read since the inbox was read (409 `read`), is left out of the batch and logged; a batch left empty finishes its run as cancelled and launches nothing. So two runs, two daemons on one agent token, or a chat session never handle the same message: only what the run holds is in its prompt. The claims end with the run, released by its finish.
- **The prompt** quotes each message, with who sent it, whether it is the owner's request or untrusted, the key of the task it is about when it names one, and its message and inbox item ids. It says to answer each with `send_message { reply_to }`, not a comment, then `mark_read` it; that a message about a task is about that task (read it, comment on it or change it when asked); that "on <name>" names one of the agent's boards, even one called like the app; and to put work that needs more than an answer on the board as a task assigned to the agent, naming its board, which gets a run of its own. It doesn't code. `COPLAND_TASK` is not set, and the run shows in `AgentState::runs` under the task `messages` (`runner::MESSAGES`).
- **Task runs** handle only their own task's comments and mentions; their prompts say so, and to leave the rest of the inbox, messages above all, unread for the runs they belong to.
- **Timing:** nothing is put into a runtime that is already going. A message that comes during a run waits for the next message run. `AgentState::messages` counts the messages that are waiting like that (no run has had them, none is on them and no other run holds them), for the box to say so.

The claim is what keeps two runs apart; the guard still remembers each message a run of this daemon claimed, by inbox item id and whatever the run's ending, because the claim ends with the run: without it, a message the run finished with but left unread would be free again at once and launch run after run. A new message launches one for itself, and a message's memory goes once it is read. Another daemon on the same token remembers nothing of it, so it may take such a message once, after the run that had it is over.

## Config

`~/.config/copland/daemon.toml` (`$XDG_CONFIG_HOME/copland/daemon.toml`), or `--config <file>`. Unknown keys are refused. `copland-box --setup` writes one for you (see "Setting it up" under the box); this is what it writes, and how to write it by hand.

```toml
poll_interval = 30   # seconds while the live socket is down; optional, 30 by default

[[agent]]
url = "https://copland.example.com"
handle = "berker-z/dev"            # for display; the token's own handle is what counts
token_file = "~/.config/copland/dev.token"
workdir = "~/work/dev"
client = "Claude Code"             # optional; history says "via Claude Code"
command = [
  "claude", "-p", "{prompt}",
  "--mcp-config", "{mcp_config}", "--strict-mcp-config",
  "--tools", "",
  "--permission-mode", "dontAsk",
  "--no-session-persistence",
  "--allowedTools",
  "mcp__copland__guide", "mcp__copland__whoami", "mcp__copland__get_task",
  "mcp__copland__list_tasks", "mcp__copland__my_work",
  "mcp__copland__inbox", "mcp__copland__mark_read",
  "mcp__copland__claim_task", "mcp__copland__release_task", "mcp__copland__finish_run",
  "mcp__copland__comment_on_task", "mcp__copland__move_task", "mcp__copland__update_task",
  "mcp__copland__create_task",
]
```

`command` is an argv array, not a shell line, so nothing gets word-split. `{prompt}` and `{mcp_config}` are replaced wherever they appear. The token is an agent's API token (`cpl_…`, made on the agent's page in settings, read and write). Put it in `token_file`; `token = "cpl_…"` inline works too. Either way the daemon warns if the file holding it can be read by anyone but you.

About the Claude Code flags, as of Claude Code 2.1: `--tools ""` takes away every built-in tool (no Bash, no Edit, no file reads), `--strict-mcp-config` ignores your other MCP servers, and `--permission-mode dontAsk` denies whatever isn't in `--allowedTools` instead of waiting for a prompt nobody will answer. `--allowedTools` is variadic, so keep it last. For an agent that should actually write code, give it the built-in tools it needs and a working directory you don't mind it changing. `claude` has to be signed in already (`claude` once, interactively); the daemon doesn't handle that.

### Coding tasks

A task on a board with code, a GitHub repo or a plain git remote (docs/GITHUB.md), is coding work, and an agent with a `code_command` does it in a workspace of its own instead of `workdir` (`core/src/workspace.rs`). The daemon keeps one clone per repo under `code_dir` and makes the task a git worktree beside it, on a branch named after the task:

```text
~/copland/repos/berker-z/copland     the clone, shared by every task and agent here
~/copland/work/COPL-79               COPL-79's worktree, on copl-79-<its title>
```

The worktree belongs to the task, not to a run: a run that crashed, a later run that picks the task up again, and a run fixing what CI found all carry on in the same place on the same branch. A new one starts from the default branch's head as it is right then. If the worktree is gone but the branch is still around, here or on GitHub, it is made again on that branch. Once the task closes, its worktree goes, along with its local branch; the one on GitHub is GitHub's to delete. A run that ends on a closed task removes its own; for a task closed with no run after it, by a person merging its PR or by hand, each agent with a `code_command` sweeps `code_dir/work/` when its loop starts and then every five minutes. It asks Copland about each directory named like a task key and removes the worktree of a task that is closed, or gone from a board the agent is on. It leaves alone a task one of its runs is on, one it can't read (another agent's board answers 404 just like a deleted task does, so a 404 counts as gone only on a board the agent is on), and anything that isn't a worktree named like a key. Agents share `code_dir`, so two sweeps can meet the same closed task; the second finds nothing to do. The clone goes over https, so pushing uses whatever git credential helper the machine has; `gh auth setup-git` is the easy one.

What the run does follows the task's level (COPL-87). A task, a leaf, is a worker's: it gets the worktree above, codes, and opens one PR. An epic or a story, or a task that has children, is a lead's: it gets no worktree but the clone itself, checked out at the default branch's head (detached) and read-only in the sandbox, and is told to plan the work into child tasks with `depends_on` where one needs another's result, assign them, and leave the parent open. Children assigned to the agent start by themselves (they are ready work, step 2), side by side up to `max_runs`, each in its own worktree, and the parent closes when they are done. A milestone runs nothing. The run gets `COPLAND_ROLE` (`worker` or `lead`) besides the variables below, and `COPLAND_INTEGRATE`: `pull-request` on GitHub, `fast-forward` on a plain remote, whose worker is told to fast-forward `main` and close the task itself. A plain remote's clone goes under `repos/git/<host>/<path>`.

`code_command` runs inside bubblewrap (`core/src/sandbox.rs`), whatever the runtime is. Everything is readable and nothing writable except the worktree, the clone's `.git` (where the worktree's commits go), a fresh empty `/tmp`, and what `writable` lists: the runtime's own state and the caches its builds use. The Nix package has bubblewrap built in, by its store path (COPL-137); any other build (cargo, the release tarballs) looks for `bwrap` on PATH, so install bubblewrap for it. Without `bwrap` the run doesn't start: every poll, before it starts a run or claims a task, the daemon looks for the programs its runs need (the command's, and for coding runs `bwrap` and the `code_command`'s) on its own PATH, and leaves waiting the runs that would need a missing one. The agent's line in the box says which: "bwrap not found on PATH: coding runs can't start". When everything is found the log says so, with where `bwrap` is ("bwrap at /nix/store/…" for the Nix package). A box started from a desktop launcher has the launcher's PATH, which may not be your shell's. bubblewrap can't limit hosts, so a coding run reaches the network the way the machine does, and it can push wherever your git credentials can. A runtime's own sandbox can go on top, in its command. The run has a process namespace of its own (`--unshare-pid`), so whatever it started, a dev server it left in the background included, ends when the runtime does, however that ends: it doesn't keep running, or hold its port, after the run.

```toml
code_dir = "~/copland"   # top level; optional, ~/copland by default

[[agent]]
# ...as above, then:
code_command = [
  "claude", "-p", "{prompt}",
  "--mcp-config", "{mcp_config}", "--strict-mcp-config",
  "--permission-mode", "bypassPermissions",
  "--no-session-persistence",
  "--setting-sources", "project",
  "--settings", "{\"sandbox\":{\"enabled\":false}}",
]
writable = ["~/.claude", "~/.claude.json", "~/.cache", "~/.npm", "~/.cargo/registry", "~/.config/.wrangler"]
max_runs = 10            # optional; runs going at once, 10 by default
```

An agent can have several runs going at once, up to `max_runs` (COPL-82). Coding tasks run side by side, each in its own worktree; anything else still shares `workdir`, so only one of those runs at a time. A run that turns out to answer a mention without a claim on a coding task's board also lands in `workdir`, without waiting for it, which is the one way two runs can share it. A task is never in two runs at once, and a reload or shutdown lets every run going finish before the agent hands over. The box shows each run on the scene and in the stop list. A fresh worktree has no `node_modules` or `target`, so a run's first build installs them; sharing them between branches isn't safe, since branches can differ in what they depend on, and npm's and cargo's caches (in `writable`) make it quick.

While a worker runs, the daemon tells Copland which files its task has changed, so open tasks that change the same files show up before either has a PR (COPL-103, docs/GITHUB.md's Overlap). It lists them in the worktree (`workspace::changed_files`): tracked changes against the merge base with `COPLAND_TARGET`, committed or not (`git diff --name-only <merge base>`), plus untracked files git doesn't ignore (`git ls-files --others --exclude-standard`), sorted, deduplicated and capped at 500 the way Copland keeps them. The merge base, not `COPLAND_BASE`: once the agent merges `origin/main` in, a diff from where it started would count everything main changed. With no merge base, `COPLAND_BASE` stands in. Paths Copland would refuse (control characters, backslashes, over 512 characters) are left out. It sends them with `PUT /api/tasks/:id/files` and the run's secret every three minutes (its own clock, so a large repo doesn't run git every keepalive) and once after the runtime exits, before the run is finished, but only when the list differs from the last one sent. A failed report is logged at `warn` and tried at the next tick; it never fails the run. A refusal (the claim is gone: the task closed or moved to blocked, or the runtime finished the run itself) stops the reports for that run. A lead's read-only clone, and a run answering a mention without a claim, report nothing.

Nothing in the daemon is about one runtime. It hands the run the worktree as its working directory, and `COPLAND_REPO`, `COPLAND_WORKDIR`, `COPLAND_BRANCH`, `COPLAND_BASE` (the commit it started from) and `COPLAND_TARGET` (`origin/main`) in its environment. The prompt says which repo, branch and base, and points at the Copland guide's Code section, which says how coding work is finished: commit, push, open a PR with `Fixes COPL-79` in its body, wait for CI, and merge it, unless the task is marked review first. The merge is what closes the task. A runtime started by the daemon still reads its own settings, the ones you use at the keyboard, and those were written for someone sitting there. The Claude Code command above skips Claude's permission prompts (`bypassPermissions`), since nobody is there to answer them and the sandbox is what limits it. But an `ask` rule in your `~/.claude/settings.json` (say, before `git push`) still asks, and in a headless run that is a refusal; and Claude's own sandbox, if you have it on, runs inside ours, where the push fails and the retry outside it asks too. So `--setting-sources project` loads only the repo's checked-in `.claude/settings.json`, not your personal ones (your `CLAUDE.md` still applies), and `--settings` turns Claude's sandbox off, ours being the one that counts. Another runtime needs the same two things in whatever form it takes them: no prompts, and none of its keyboard settings.

Some top-level keys are for the box alone, and the headless daemon ignores them. The menu's settings and boards panels write the first five for you (see "The menu"); a key at its default is left out.

```toml
theme = "nord"                                  # one of Copland's seven themes, or "copland" for yours there
motion = false                                  # a still picture: no sway, current, blinking or travel
notifications = false                           # no desktop notifications (the bell still counts)
compact = true                                  # the status line alone, in a small window
boards = ["COPL", "HOME"]                       # only these boards' tickets on the scene; all by default
owner_token_file = "~/.config/copland/me.token" # your own token, for all four poles (below)
owner_write_token_file = "~/.config/copland/me.write.token" # yours too, read and write: messaging your agents (below)
owner_url = "https://copland.example.com"       # only when the agents are on more than one Copland
```

`owner_token_file` (or `owner_token = "cpl_…"` inline) is a token of yours, the person the agents belong to, made in settings › tokens; read-only is enough and is what to use. It is held to the same rules as the agents' tokens: an API token, never a run's secret, with a warning if the file can be read by anyone but you. It is for one Copland: the agents' `url` when they all share one, else `owner_url`, which a config with agents on more than one instance must give.

`owner_write_token_file` (or `owner_write_token` inline) is a second token of yours, read and write, for what the box writes as you: a message to one of your agents and your inbox marked read (COPL-109). It comes with `owner_token_file` or not at all, and is for the same Copland. You don't make it by hand: the first time you message an agent from the agents screen, the box asks for it with a device login of its own (below), keeps it in `me.write.token` beside the config (0600) and adds the key. The read-only token stays what it reads with; only someone who wants to write from the box holds a write token on disk, and it can do anything you can. One Copland refuses is forgotten (the key and the file go), so the next message asks again.

`copland-daemon --check` reads the config, checks it, asks each instance who the token is and prints what it would run. It fails on a token it can't use: a read-only one (runs and claims are writes), or a run's secret (`cplr_…`) given in place of the agent's own token. The daemon checks the same at startup, through `/api/me`'s `access`, and stops watching that agent with an error; when no agent is left it exits. `COPLAND_LOG=debug` shows each poll's decisions and keepalives.

### Screenshots

A coding run can start Copland's dev server and take screenshots of it in a headless browser, inside the sandbox, to see a UI change before it opens the PR (COPL-120). The daemon needs nothing for it beyond the `writable` above, and `daemon.toml` has no setting for it:

- **The browser** is whichever Chrome or Chromium is on the daemon's `PATH`, which the run inherits (`google-chrome`, or `chromium` from nixpkgs). It isn't in the flake's dev shell: a box from the package doesn't go through that shell, and Chromium is far too big to make everyone building the box download it. Playwright isn't needed; its downloaded browsers don't run on NixOS without nix-ld anyway.
- **Chrome's own sandbox works under ours.** Unprivileged user namespaces nest, so its renderers still get their own user and process namespaces and seccomp, and it needs no `--no-sandbox`.
- **Writable paths:** the profile goes in the run's fresh `/tmp` (`--user-data-dir`), so nothing of the browser's needs to be in `writable`. Chrome still tries `~/.config/google-chrome` and `~/.pki/nssdb`, logs that they are read-only, and carries on. Wrangler keeps local D1 and R2 in the worktree's `.wrangler/`, and its own state in `~/.config/.wrangler`, which the example lists; vite's cache is in `node_modules/.vite`.
- **Ports:** the network is the machine's, so runs side by side share `localhost`. Vite moves to the next free port when 5173 is taken, and the Cloudflare plugin does the same with its inspector port, so read the URL from the log rather than assuming it. The server binds `localhost` only, and ends with the run.

A fresh worktree has no `.dev.vars`; the run writes one (it is gitignored) with a throwaway `VAULT_KEY` and a `DEV_USER_EMAIL`, which signs every localhost request in as that user, and applies the migrations to its own local D1. Then, from the worktree:

```sh
npm ci
printf 'VAULT_KEY=%s\nDEV_USER_EMAIL=dev@example.com\n' "$(head -c 32 /dev/urandom | base64)" > .dev.vars
npm run db:migrate
npx vite > /tmp/dev.log 2>&1 &
until url=$(grep -o -m1 'http://localhost:[0-9]*' /tmp/dev.log); do sleep 1; done
until curl -sf -o /dev/null "$url/api/me"; do sleep 1; done
shot() {
  google-chrome --headless --disable-gpu --no-first-run --disable-crash-reporter --hide-scrollbars \
    --user-data-dir=/tmp/chrome --window-size="$1" --virtual-time-budget=8000 \
    --screenshot="$2" "$url$3" 2>/dev/null
}
shot 1440,900 /tmp/board-desktop.png /b/DEMO
shot 390,844 /tmp/board-390.png /b/DEMO
```

The local database starts empty: the first request makes the dev user, and a board to look at comes from the API (`POST /api/boards`, then `POST /api/boards/:id/tasks`, with `curl` and a JSON body). `--virtual-time-budget` lets the page fetch and render before the shot is taken. 390 is a phone's width, where the board turns into its swipeable mobile layout.

## Building

It's a Cargo workspace: `core` is a library with the loop, and `cli` is the `copland-daemon` binary. `box` is `copland-box`, the same loop with a GPUI window (below). `Daemon::subscribe()` hands out the daemon's state (each agent's phase, last poll, unread count, waiting tasks, messages waiting for a run, last run) as a `tokio::sync::watch` receiver, which the headless binary ignores and the box draws. `Daemon::reload(config)` changes the agents it runs in place (see "The agents screen"); only the box calls it, and the headless daemon still reads its config once, at start. The workspace's `default-members` are `core` and `cli`, so plain `cargo` here builds and checks the headless daemon only, with no GPUI anywhere in its graph.

```sh
cd daemon
cargo build --release      # target/release/copland-daemon
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

TLS is rustls with ring, so there is no OpenSSL and no cmake to find; on NixOS plain `cargo` builds it. `--headless` is accepted and is the only mode `copland-daemon` has; the window is the separate `copland-box` binary.

## The box

`copland-box` is the daemon with a window (COPL-33). It runs the same loop as `copland-daemon`, in the same process, and draws your agents' work as the wired scene, the same one as the web's /wired pane (`src/features/wired/scene.ts` and `WiredPane.tsx`, designed in `docs/research/wired-prototype.html`): four poles on one ground line, todo, doing, blocked half a span on and done a span on, each with its list underneath. Tickets wait on the wire into doing, a run's sits at the doing pole while current runs along its wire, blocked ones take the short span and wait by the blocked pole, and done ones ride the long span that sags under blocked and fade off the edge. The geometry, the default tuning and the per-frame update are a port of the web scene, kept close enough to read side by side; when the web scene's geometry changes, the box's has to follow by hand, and its tests fail until it does (see "Building the box"). All of it is in `box/src/scene.rs`: the layout is the constants and `Layout`/`build_wires` at the top, and `view.rs` places the lists by the web pane's rule (`budgets`).

The scene is drawn on a 170×22 grid at 3 screen pixels per cell, rounded to whole device pixels on scaled outputs. It is composited in software the way the web's canvas is, then painted as one GPUI quad per horizontal run of same-coloured cells, a few hundred quads. The lists and the status line are text in JetBrains Mono when the system has it, else fontconfig's monospace, else DejaVu Sans Mono. No font is bundled. Each list shows the longest form of its lines that all of them fit, as the web does: doing drops the timer, then the agent; blocked the agent, then the mark. At the box's size the full forms fit for ordinary keys and names.

The window is 548×196, or 548×26 in compact mode (below). Its minimum is the compact size, so it can shrink to that when compact is switched on; Wayland has no way to ask for a fixed size, and GPUI 0.2.2 sends only the minimum anyway. When the compositor gives it more anyway (tiling, a rule, a resize), the box draws at the largest whole multiple of its natural size that fits, 6 pixels per cell at twice the size and so on, with the text and gaps scaled to match, and centres the scene in the space. The title and status lines run the full width. Smaller than 548×196 it stays at its natural size and is cut off.

It draws only when something changes: 30 frames a second while a ticket travels or fades (not every display frame, so a high-refresh screen doesn't mean 144 renders a second), 15 while a run's current flows (`FPS` in `scene.rs`, the web scene's cap), 12 while the wires only sway (they move about a cell a second, so it looks the same and costs less), once a second while a run's timer shows with `motion = false`, and otherwise when the daemon's state or the owner's feed changes (and every 30 seconds for the done list's slow fade). GPUI has no reduced-motion setting to follow, so `motion = false` in `daemon.toml` is the switch.

Compact (below) redraws for the scene once a second at most: only the status line shows, and it changes only as a run's timer ticks or a ticket arrives, so the scene catches up on the frames in between (`Scene::catch_up`) instead of being drawn at 12 to 30 a second for nobody. A window that can't be seen draws nothing at all, and the box does nothing to make that so: GPUI draws on Wayland's frame callbacks, Hyprland sends none to a window on another workspace or a hidden special one, so `render` isn't called and no redraw is scheduled. The daemon, the feed and notifications carry on, and the first frame after it shows again picks up from there. Measured on Hyprland 0.56 with the demo (COPL-129), as a share of one core over 30 seconds: the whole box visible 20% (24 frames a second), on another workspace or a hidden special workspace 0% (no frames), compact 29% (25 frames a second) before and 1% (one) after.

What it shows, live, with `owner_token_file`:

- The box reads `GET /api/wired` with your token when your live socket (the same `/api/live`, with the same token) says a board, your boards, your agents or people changed, at most once a second; two seconds after any of its runs starts or ends; and on a clock, every two minutes while the socket is up and every 15 seconds while it's down (a claim that lapses sends nothing, so the clock still matters). The status line ends in a faint `•` while every socket on the box (each agent's and yours) is up, and `◦ polling` while one is down. It is the same data as the web pane, so todo, doing (live claims with their timers, then active tasks no run holds, dimmer and without timer or current), blocked, and done in the last 24 hours with the count in the status line. This runs on the daemon's Tokio runtime (`box/src/feed.rs`) and is handed to the window as a `watch` value, like the daemon's own state.
- The daemon's own runs go over it: a run it has just started shows in doing at once, before the next read says so, and the two are matched by task key.
- When the data changes, each ticket that changed pole travels the wires to its new one, diffed by key; one nothing lists any more fades. The first read is placed as it is, without travel.
- Clicking a ticket opens the task in the browser, `<url>/b/<BOARD>?task=<KEY>` (its board with the task open), the board key being the task key's prefix.
- An agent's token given as `owner_token_file` is refused (the route is a person's own) and the box says so in the status line and stops reading; so does any other refusal. A failed read (the server down) keeps the last picture and says why.

Without `owner_token_file` it draws what the daemon alone knows, and the status line says to add the key: todo is the tasks with unread items for an agent (`AgentState::waiting`, published on every poll), doing is each agent's current run, and done and blocked stay empty. A task the daemon has already run stays in todo there while its items are unread, because that is what the inbox says. With no config it sets itself up (below); with one it can't use (no agents, a refused key) it shows the empty scene and "nothing on the wire" with the reason. `--demo` drives it with the prototype's simulation instead: no config, no server, nothing launched. In the demo `n` adds an item, `a` answers a blocked one and `f` finishes a run; `q` or Esc quits anywhere.

### Setting it up

A box started without a config sets itself up in its window instead (COPL-47); `copland-box --setup` does the same over an existing one, which is kept as `daemon.toml.bak` (or `.bak.2`, …). A config that is there but broken is not replaced by itself: the status line says why and points at `--setup`. `copland-daemon` without a config says to run `copland-box --setup`.

1. **Address.** Type your Copland's address; `https://` is added when there's no scheme, and anything after the host is dropped. `--url <address>` fills it in. Enter connects, ctrl+v pastes, Esc quits. It's a one-line field of the box's own (`setup::LineInput`), since GPUI 0.2.2 has no text input.
2. **Approve.** The box asks `POST /api/device/start` for a code, shows it large, and opens `/device?code=…` in your browser once (`o` opens it again). It polls `POST /api/device/poll` every `interval` seconds, slower when asked to (`slow_down`). Denied or expired says so; `r` tries again, `b` goes back to the address.
3. **Runtimes.** Once approved, the tokens are written at once, since the server hands them over only once: `me.token` (yours, read-only) and `<agent>.token` per agent, beside the config, the directory 0700 and the files 0600, plus a note `daemon.toml.setup` of what still needs saying. A box closed now picks up here next time. It looks on PATH for `claude` and `codex` and reads their `--version` (three seconds at most). Every agent gets the first found, Claude Code before Codex, working in `~/agents/<name>`. ↑↓ picks an agent, space changes its runtime. With none found it says what to install; `r` looks again.
4. **Save.** Enter writes `daemon.toml`, makes the working directories, and starts the daemon in the same window, without a restart.

The commands come from `box/src/runtime.rs`, one template per runtime. Claude Code's is the narrow one above: Copland's MCP tools and nothing else. What agents may do beyond that is not decided yet, and the written config says so; widen a command by hand. Codex has no flag for an MCP config file, so its command is a small `sh` that reads the run's secret out of `{mcp_config}` into `COPLAND_RUN_SECRET`, and runs `codex exec --ephemeral --skip-git-repo-check --ignore-user-config --sandbox read-only` with Copland as an HTTP MCP server reading its bearer token from that variable, kept out of Codex's own shell. That one hasn't been run against Copland yet, and the config says that too.

### The agents screen

The menu's agents panel (`a` in the live view goes straight to it) is the agents screen, in the same window, the poles staying behind it as they do for setup (COPL-55). It lists every agent you have in Copland, from the `agents` that `/api/wired` already sends with your read-only token (paused ones too), so without `owner_token_file` it lists only what this machine runs. Each agent is one of two kinds:

- **Runs here**: its name, runtime (Claude Code or Codex, or "(own)" for a command that isn't one of setup's templates, a widened one say), working folder, and what it is doing: watching, a task it has a run on, an error (a program its runs need that isn't on PATH among them), or "changes after this run". After a run that went wrong it says so in red until the next run: "× COPL-132 exit 1 after 3.8s" (COPL-136). The line under the selected agent then says which run it was, or, for a runtime that died within ten seconds having written nothing, "claude exited at once with no output: check the runtime outside the box", since that is almost always the runtime's setup and not the task. `o`, or a click on that line, opens the run's log. Space (or ← →) cycles the runtime through those found on PATH, marked as a change; Enter saves the changes. `x` twice stops running it here.
- **Not on this machine**: Enter asks Copland for that agent's token with a device login that names it (`agents` on `POST /api/device/start`), so `/device` ticks that agent alone; the box shows the code and opens the page, as setup does. Once approved, it writes `<name>.token` beside the config (another name if that file exists) and an `[[agent]]` table with the first runtime found, working in `~/agents/<name>`. Because the request names agents, the approval makes only their tokens: the box already has the read-only one for you.

`m` messages the selected agent, either kind (COPL-109). It opens one line under the name; Enter sends it with `POST /api/messages` as you, Esc goes back, and ctrl+v pastes. A message holds at most 1000 characters, and the line counts them. When the agent has a run going here, the line says the message waits for its next run, and so does the word after sending: nothing reaches a runtime that is already going (see Messages). Stopping a run and pausing an agent are not messages: `s` on the live view and the pause in Copland. Sending needs your write token, so the first `m` asks for it, with `write: true` on `POST /api/device/start` and no agents: `/device` then says it is a read and write token for you and lists no agents, and approving makes that one token ("<host> box, messages" in settings › access) and nothing else. Once it is saved, the line opens. Without `owner_token_file` there is nothing to ask with, and `m` closes the menu as it does elsewhere.

↑↓ picks an agent, Esc closes the menu, and changes not saved are dropped. Paused agents say so.

Saving edits `daemon.toml` in place (`box/src/edit.rs`): only the changed agent's table, and in it only `client`, `command` and the untested-template note, so comments and hand edits elsewhere stay. The file is checked the way the daemon reads it before anything is written, the old one is kept as `daemon.toml.bak` (or `.bak.2`, …, never over an older backup), and the new one is written whole with mode 0600. Stopping an agent here removes its table and leaves its token file, so the backup still works; the token stays valid until you revoke it in settings › agents. The last agent can't be stopped here (a config without one isn't a config); `--setup` starts over instead.

Then the running daemon takes the new config without a restart (`Daemon::reload`, `core/src/daemon.rs`, the diff in `core/src/reload.rs`). An agent is the same agent across the two when its instance and handle are; one whose command, workdir, client or token changed is rebound, one that's gone is stopped, one that's new is started, and the rest are left alone (all are rebound when `poll_interval` changed). Each agent's loop runs under a supervising task that holds its binding. A rebind or a stop bumps the binding's generation, which the loop looks at only between polls and before starting a run; it is never passed to a runtime. So an idle loop ends at once, and a loop in a run lets the run finish, claim, keepalives, `finish_run` and all, under its old binding, then ends; only then does the supervisor start the agent again with the new one (or drop it). An agent never has two loops, so never two runs. The wake guard's memory goes from the old loop to the new, so a rebind doesn't relaunch on items already handled. If a reload comes between the check and a launch, that one run still uses the old binding; the next one uses the new.

### The menu

≡ at the right of the title bar, or `m`, opens the menu (COPL-65): small panels under the poles, one at a time, their names across the title bar. Click a name or press its number (1 to 6) to switch, Esc or `m` closes it. Everything in a panel works with the keyboard and the mouse alike: clicking a line does what pressing its key would, and so does clicking a key in the status line. `box/src/menu.rs`.

- **needs you**: what the bell counts (below), each line opening its task (a message about no task opens Copland, where your inbox is). `r` marks a mention or a message read, with your write token (`POST /api/inbox/read`; without the token it says how to get one).
- **agents**: the agents screen above.
- **boards**: which boards' tickets the scene shows, from `GET /api/boards` with your token. Space shows or hides one, `a` shows them all again. It is display only: the agents still wake for anything on any board, and the bell still counts blocks on hidden ones. With a filter on, done's count is what is left of the listed ones.
- **settings**: the theme (the seven, then "copland", yours there), motion, notifications, start at login and compact. Space or ← → changes the selected one, and it applies at once.
- **session**: who the box is signed in as, on which Copland, and the tokens it holds. `x` twice signs out (below).
- **about**: this version, and whether a newer box is out. It asks GitHub's releases API for `box-v*` tags on berker-z/copland once, without a credential, keeps the answer in `$XDG_STATE_HOME/copland/release.toml` for twelve hours, and says so plainly when it can't ask. `r` asks again, `o` opens the releases.

Settings and boards are written to `daemon.toml` when the menu closes, once for everything changed, through the same editor as the agents screen (`edit::set_key`): an existing key is replaced where it is, a new one goes after the last top-level key, comments stay, and the old file is kept as `daemon.toml.bak` (`.bak.2`, …). Start at login is a file of its own, written or removed as it is switched: `$XDG_CONFIG_HOME/autostart/copland-box.desktop`, running `copland-box` as found on PATH (a Nix profile's link, which follows upgrades, not the store path behind it), else this binary, with a word in the panel when that is a store path or a build tree. `--config` goes into it when the box was started with one that isn't the default.

Compact shows the status line alone in a 548×26 window, with the bell, ≡ and × at its end; it drags like the title bar. Opening the menu grows the window back for as long as it is open. The box resizes itself (`Window::resize`), and on Hyprland asks for the size over IPC as well (`hyprland::resize`, floating it where it is, without centring), since a rule's `size` would otherwise win. Started compact, it is sized that way even when a rule floats it.

### What needs you

The bell in the title bar (drawn in pixels like the scene) counts what needs you (COPL-64): your agents' tasks in a blocked stage, from `/api/wired`, and unread items in your own inbox that @mention you or are a message from one of your agents (COPL-109, one line each, its text shown), from `GET /api/inbox?unread=true` with your read-only token, read again when your live socket says `inbox`. It is faint at nothing and yellow with the count otherwise. It is a subset of your web inbox, not a copy of it: only mentions, your agents' messages and their blocks, so its count is usually lower than the web's, while what both show is the same state. Opening a need's task on the web reads it: the web marks your unread items on a task read when you open it (messages aside), `inbox` goes out, and the bell drops it within a second. Clicking it, or `b`, opens the needs-you panel.

A desktop notification fires once for each new one, quietly: no sound (the box plays none and asks the notification server not to with `suppress-sound`), nothing for routine moves, and more than three at once are one notification. Clicking it opens the task. On Linux it goes over D-Bus to `org.freedesktop.Notifications` with zbus, which GPUI already brings, so no crate was added. macOS has none yet (a TODO in `box/src/notify.rs`: it needs a signed app). What was said is kept in `$XDG_STATE_HOME/copland/notified.toml`, so a restart repeats nothing; a need that goes away (unblocked, read) is forgotten, so a task blocked again later is said again. The first time, with no such file, whatever is already there is remembered without a burst. The settings panel switches the notifications off (`notifications = false`); the bell counts either way.

### Stopping a run

A ticket in doing that this box is running gets a ■ in front of it. Click it, or press `s` (tab picks the next run when there are several), and the box asks "stop COPL-12's run?"; a second click or `s` within six seconds stops it, anything else keeps it. Stopping is the same as at shutdown, for that run alone: SIGTERM to the runtime's process group, SIGKILL ten seconds later, and the run finishes as cancelled. The wake guard remembers the task's items as after any run, so it isn't started again until something new comes. Underneath it is `Daemon::run_stopper()` (`RunStopper::stop(slot, run)`), which the agent's loop watches during a run.

### Signing out

`x` twice on the session panel signs the box out: it stops the daemon (runs finish as cancelled), revokes every token `daemon.toml` names (your write token too), each with itself through `DELETE /api/tokens/self` (the one token-management call a token may make, on itself only; see AGENTS.md), then deletes the token files, `daemon.toml` with its backups and setup note, and `notified.toml`, and starts setup in the same window with the address filled in. A token it couldn't revoke (the server down, say) is named there, to revoke in settings › tokens. To switch accounts or add one, sign out and set up again; the box holds one at a time.

### Closing it, and its colours

Closing the window, SIGINT or SIGTERM stop the daemon as the headless one stops: runtimes get SIGTERM and their runs finish as cancelled. After a signal the box exits once the runs have finished, whether or not its window is showing (one on a hidden workspace gets no frames, so the quit doesn't wait for one). After signing out, with no daemon left, SIGINT and SIGTERM just exit. The title bar drags the window (GPUI's `start_window_move`).

The colours are Copland's seven themes, copied from `src/styles/themes.css` into `box/src/theme.rs`. They have to be kept in step by hand; a test reads the CSS and fails when they differ. Pick one with `theme = "nord"` at the top of `daemon.toml` (the headless daemon ignores the key) or `--theme` (for that run only), or from the menu. `theme = "copland"` follows the theme you chose in Copland: the box reads `GET /api/settings` with your read-only token (a person's own read, which an agent's token can't make) and again when your live socket says `settings` changed; until it has, and without `owner_token_file`, it is nord.

### Hyprland

Hyprland floats a window by itself when its minimum and maximum size are equal. The box would say so, but GPUI 0.2.2 sends only the minimum size on Wayland (`window_min_size`; `is_resizable` does nothing on Linux), so Hyprland tiles it. Until GPUI can, the box does it over Hyprland's IPC socket (`box/src/hyprland.rs`): once its window shows up in `j/clients` it floats it, sizes it to 548×196 and centres it, by its own pid, so another box or anything else is left alone. A window that is already floating when it appears is left as it is, because then a rule put it there. It tries the Lua dispatchers first (`hl.dsp.window.float` and friends, Hyprland 0.55 and later with `hyprland.lua`) and the old ones (`setfloating`, `resizewindowpixel`, `centerwindow`) when those are refused. The Lua ones were checked on Hyprland 0.56; the old ones weren't. You may see it tiled for a frame or two first.

Keeping it on top and on every workspace still takes a rule: Wayland has no way for a window to ask for that. `copland-box --hyprland-rule` prints one for the box's size, for `hyprland.lua` and for an older `hyprland.conf`, floating and pinned in the bottom-right corner with no border. For the Lua config it is:

```lua
hl.window_rule({
	match = { class = "^(copland-box)$" },
	float = true,
	pin = true,
	size = { 548, 196 },
	move = { "monitor_w-572", "monitor_h-244" },
	border_size = 0,
	rounding = 0,
	no_shadow = true,
})
```

The move puts it 24px from the right and 48px from the bottom. Use constants there, not `window_w`: the rule is evaluated against the size the window would have had tiled, which changes with whatever else is on the workspace. The Lua rule was checked on Hyprland 0.56; the `windowrulev2` lines weren't.

### Getting it

You don't have to compile it. Each `box-vX.Y.Z` tag gets a GitHub release, built by CI (`.github/workflows/box-release.yml`), with a `SHA256SUMS` file covering everything in it:

- **Linux x86_64 and aarch64:** `copland-box-<version>-linux-<arch>.tar.gz` has both binaries, the launcher entry, the icon, an `INSTALL` note and the licence, laid out like `~/.local`. Unpack it and `cp -r bin share ~/.local/` puts the binaries in `~/.local/bin`, `copland-box.desktop` in `~/.local/share/applications` and the icons under `~/.local/share/icons/hicolor`. It's built on Ubuntu 24.04, so it needs glibc 2.39 or newer (the release notes give the exact floor, read from the binaries). The window also needs a Vulkan driver, Wayland or X11, xkbcommon and fontconfig, which a desktop has anyway, and coding runs need bubblewrap (`bwrap`) on the PATH the box is started with: install it from your distribution (`apt install bubblewrap`, `dnf install bubblewrap`). On NixOS use the flake below instead: a plain binary won't find those libraries there.
- **macOS Apple Silicon:** `copland-box-<version>-macos-arm64.zip` is `Copland.app` (the box, with `copland-daemon` beside it in `Contents/MacOS`), and the `.tar.gz` next to it has the bare binaries. Neither is signed or notarized, so macOS refuses to open them at first: right-click the app, Open, and confirm, or `xattr -dr com.apple.quarantine Copland.app`. This build compiles and answers `--version` on CI and has never run on a real Mac. Started from Finder it gets Finder's short `PATH`, so give the runtimes in `daemon.toml` full paths.
- **Nix:** `nix run github:berker-z/copland/box-vX.Y.Z?dir=daemon`, or the flake input below. The release workflow pushes both Linux systems' builds to the `copland` Cachix cache, so with the cache as a substituter (`cachix use copland`) Nix downloads the box instead of building GPUI. The cache's key is in `flake.nix`, so `--accept-flake-config` does the same without cachix.

Windows and Intel Macs get nothing yet.

### Installing it

`daemon/flake.nix` packages both binaries, `copland-box` and `copland-daemon`, built from `Cargo.lock` with [crane](https://github.com/ipetkov/crane) (every crate comes from the lock, offline). Crane splits the build in two: `./daemon#deps` compiles every dependency, GPUI included, from `Cargo.toml` and `Cargo.lock` alone, and the package compiles our three crates on top of that. The dependencies are nearly all of the work and change only with the lock, so after the first build a change to our code rebuilds in a fraction of the time, and the finished package comes from the Cachix cache (see "Getting it"). The x86_64 deps derivation (about 600 MiB) is pushed too, so a new commit only compiles our crates even on a fresh machine; aarch64 pushes only its package. On the free Cachix plan (5 GiB for the whole account, least recently used paths evicted when full) that leaves room for other projects' caches. crane is pinned to a commit in `flake.nix` like nixpkgs, and builds with that nixpkgs. GPUI loads the Vulkan loader, Wayland, X11, xkbcommon and fontconfig at run time, which NixOS doesn't put on a library path, so the package adds them to the box's RPATH. Not `LD_LIBRARY_PATH` in a wrapper: that would leak into everything the box starts, the runtimes and your browser included. bubblewrap is pinned the same way: the build sets `COPLAND_BWRAP` to its store path, which both binaries start coding runs with instead of looking on PATH, so a box started from a desktop launcher runs coding tasks too, and nothing is added to the runtimes' environment. The package also has a desktop entry (`copland-box.desktop`, "Copland", named after the window's app id so docks match the two) and the Copland mark as its icon, the SVG plus PNGs from 32 to 256 pixels.

From a checkout:

```sh
nix run ./daemon                      # the box (same as ./daemon#box)
nix run ./daemon -- --demo            # arguments go after --
nix run ./daemon#daemon -- --check    # the headless daemon
nix build ./daemon                    # ./result/bin/copland-box and copland-daemon
nix profile install ./daemon          # on PATH for good, with the launcher entry
```

Without a checkout it's `nix run github:berker-z/copland?dir=daemon`, and so on. Nix only sees files git tracks, so a new file in `daemon/` needs at least `git add -N` before any of these find it.

On NixOS, take it as a flake input and add the package where you keep your others:

```nix
# flake.nix
inputs.copland = {
  url = "github:berker-z/copland?dir=daemon";
  # Not `follows`: the box is built and tested against its own pinned nixpkgs.
};

# configuration.nix
environment.systemPackages = [ inputs.copland.packages.${pkgs.stdenv.hostPlatform.system}.default ];
# or, with home-manager
home.packages = [ inputs.copland.packages.${pkgs.stdenv.hostPlatform.system}.default ];
```

`nix flake update copland` takes the newest box; nothing else moves it.

Starting it with the session is up to you. With home-manager, a systemd user service:

```nix
systemd.user.services.copland-box = {
  Unit = {
    Description = "Copland box";
    PartOf = [ "graphical-session.target" ];
    After = [ "graphical-session.target" ];
  };
  Service = {
    ExecStart = "${inputs.copland.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/copland-box";
    Restart = "on-failure";
  };
  Install.WantedBy = [ "graphical-session.target" ];
};
```

Two things make or break that. Your compositor has to start `graphical-session.target` and hand the user manager its environment (`WAYLAND_DISPLAY` above all), which Hyprland does under UWSM or with home-manager's `wayland.windowManager.hyprland.systemd.enable`. And the runtimes in `daemon.toml` (`claude`, `codex`) are looked up on the service's `PATH`, not your shell's; NixOS's user manager has the system and per-user profiles on it, but a `claude` from npm or `~/.local/bin` isn't. Give `command` a full path then. If your session has no target, Hyprland's `exec-once = copland-box` does the same job with your session's environment.

The package is Linux only (x86_64 and aarch64). Releases have tarballs for both and a macOS app (see "Getting it").

### Building the box

For working on it, the same flake has a dev shell with GPUI's libraries and `LD_LIBRARY_PATH` set. It brings no Rust toolchain, so cargo is whatever is on your PATH and builds inside and outside the shell share `target/`. nixpkgs is pinned to a rev in the flake itself, and `flake.lock` holds the hash. A binary from `target/` finds its libraries only inside the shell; the package above is the one that runs anywhere.

```sh
cd daemon
nix develop -c cargo build -p copland-box --release   # target/release/copland-box
nix develop -c ./target/release/copland-box --demo
nix develop -c cargo test --workspace
nix develop -c cargo clippy --workspace --all-targets -- -D warnings
```

The package doesn't run the tests: some of the box's read the web app's sources, which are outside its source on purpose. Besides `themes.css` (above), `scene.rs` and `view.rs` read `src/features/wired/scene.ts` and `WiredPane.tsx` with a small arithmetic reader (`box/src/webts.rs`) and check the port against them: every number constant, the eight wires' ends, dips and lengths at a few points of the sway, where beads rest, and the lists' width budgets at the web's scales. They fail naming what differs, and on a new web constant the box doesn't port yet. The box's padding and its zoom are its own and aren't checked.

GPUI is `gpui = "=0.2.2"` from crates.io, the newest published release. Everything under it comes from crates.io too, so that line and `Cargo.lock` pin the whole graph; no git dependencies. Pins move only when something forces it (see AGENTS.md).

### Cutting a release

Releases come from `.github/workflows/box-release.yml`, on a pushed tag `box-vX.Y.Z`:

1. Bump `version` under `[workspace.package]` in `daemon/Cargo.toml` (the box and the CLI both take it from there), run `cargo build` so `Cargo.lock` follows, and commit.
2. `git tag box-vX.Y.Z` on that commit and `git push origin box-vX.Y.Z`.

The workflow first checks the tag against `cargo pkgid` for both binaries and stops if they differ. Then, side by side: release builds on `ubuntu-24.04` and `ubuntu-24.04-arm` (with GPUI's build libraries from apt), one on `macos-14` with Xcode 15.4 selected (GPUI's build script compiles its Metal shaders with `xcrun metal`, which the command line tools alone don't have), and `nix build` of `./daemon#deps` and `./daemon` on both Linux runners, pushing the package, and on x86_64 the deps too, to Cachix. Each build checks `--version` on both binaries. When all of that passes it makes the release with the files, `SHA256SUMS`, and notes from `daemon/release/notes.md`. Rust is pinned in the workflow (`RUST_TOOLCHAIN`) and every action to a commit.

Running the workflow by hand (Actions, box-release, Run workflow) is a dry run: everything is built and packaged and kept as the run's artifacts, but no release is made and nothing is pushed to Cachix, unless you tick "push_cache", which pushes the Nix builds without a release. Give it a tag to check the version against, or nothing.

The packaging is plain scripts in `daemon/release/`, so it can be tried on a laptop: `check-version.sh [tag]`, `package-linux.sh VERSION ARCH target/release OUT` (needs `rsvg-convert` or `resvg`, e.g. `nix shell nixpkgs#resvg -c …`), `package-macos.sh` (on a Mac), and `notes.sh`. `copland-box.desktop` there is also what the flake installs, so the two launchers can't drift.

One-time setup, for the Nix cache only; without it the release still happens and the Nix jobs say they skipped the push:

1. Create a public cache on [cachix.org](https://app.cachix.org), named `copland` or anything else.
2. Make a write auth token for it and add it to the repo as the Actions secret `CACHIX_AUTH_TOKEN`.
3. If the cache isn't called `copland`, set the Actions variable `CACHIX_CACHE` to its name (and use that name in `flake.nix` too).
4. Put the public signing key the cache's page shows (`copland.cachix.org-1:…`) in the `nixConfig` at the top of `daemon/flake.nix`. Done for `copland`.

## Testing it against a local Copland

Run `npm run dev` at the repo root, make an agent and a board in the app (or through `/api/agents`, `PUT /api/agents/:id/boards/:boardId` and `POST /api/tokens` with `agentId`), and point a config at `http://localhost:5173`. A stub runtime is enough to see the loop: a shell script that reads the URL and the `Authorization` header out of the MCP config file and calls `tools/call` with curl. Set `XDG_STATE_HOME` and `XDG_RUNTIME_DIR` to a scratch directory to keep its logs out of your real ones.

## Known gaps

- Two daemons running the same agent work fine against each other (claims keep them off the same task), but each launches its own run on a restart for whatever is unread.
- No backoff beyond the poll interval for a runtime that keeps failing on new items.
- A board with several repos: coding runs work in the first one.
- A launch to answer on someone else's task wakes on plain comments too, once the agent has taken part there. Two agents answering each other in one thread would keep each other going; nothing stops that yet beyond the agent marking its inbox read.
