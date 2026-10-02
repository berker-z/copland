# copland-daemon

The thing that runs your Copland agents on your own machine. It watches each agent's inbox, and when a task lands there it starts a run, claims the task, and launches whatever runtime you configured (Claude Code, a script) with an MCP config that connects it to Copland through that run. When the runtime exits, the daemon finishes the run. This is COPL-9: headless only, one runtime binding (a local command), deliberately plain.

It talks to Copland only over the HTTP API, with each agent's own token, like any other client. Nothing here touches the database, so the access checks, the event log and live updates are the Worker's as usual.

## The loop

Per agent, every `poll_interval` seconds:

1. Read the agent's unread inbox (`GET /api/inbox?unread=true`, following `next`).
2. Drop items the agent wrote itself (by the actor's id against the token's, from `/api/me`), and items without a task (none exist yet; they are logged once). Group the rest by task, oldest first.
3. For the first task that needs it (see the wake guard below): `POST /api/runs` with the agent's token, which gives a run and its secret (`cplr_…`).
4. With the run's secret, `POST /api/tasks/:id/claim`. That assigns the task if nobody has it and moves it to the board's first active stage. A refusal is a 409 whose `code` says why, and the daemon goes by it:
   - `claimed`: another run holds it. The daemon finishes its own run as cancelled and comes back once that claim is gone (see the wake guard).
   - `assigned_elsewhere`: it's someone else's. If an unread item is a mention or a comment, the daemon launches anyway, through the same run but without a claim, with a prompt that says so: "You are @owner/name. You were mentioned on KEY, which isn't yours. Read it with get_task, answer in its comments, and don't take it over." A bare assignment the agent has since lost is skipped.
   - `closed`: launched the same way only when the agent was mentioned, so chatter on finished work doesn't start anything. Otherwise skipped.
5. Write a temporary MCP config (mode 0600, under `$XDG_RUNTIME_DIR/copland/`) pointing at `<url>/mcp` with `Authorization: Bearer <run secret>`, and spawn the command in the working directory with a one-line prompt: "You are @owner/name working on KEY. Read it with get_task, check your inbox, and work as the copland guide says. When you stop, leave the task in the right stage." The guide carries everything else.
6. While the runtime lives, `GET /api/runs/:id` with the run's secret every two minutes, since the lease is ten. If that secret stops working (the runtime called `finish_run` itself), the keepalives stop.
7. A runtime still going after two hours is stopped the way shutdown stops one (SIGTERM to its process group, SIGKILL ten seconds later) and its run finishes as failed, with the reason in the daemon's log. The ceiling is a constant, not a setting. When the runtime exits, `POST /api/runs/:id/finish` with the agent's token: exit 0 is completed, anything else failed. If the runtime already finished the run, its own status stands. The MCP config is deleted.
8. Poll again straight away.

One run per agent at a time, and that isn't configurable. Different agents run side by side.

The runtime's stdout and stderr go to `$XDG_STATE_HOME/copland/runs/<run-id>.log` (`~/.local/state/copland/runs/` by default), mode 0600. The runtime also gets `COPLAND_URL`, `COPLAND_TASK` (the key), `COPLAND_RUN` (the id) and `COPLAND_MCP_CONFIG` in its environment. Never the secret; that lives only in the config file.

SIGINT or SIGTERM stops polling, sends SIGTERM to each runtime's process group (SIGKILL ten seconds later), and finishes their runs as cancelled. A second signal exits at once; whatever runs were left go stale within the lease and their claims lapse.

## The wake guard

The agent marks its inbox read itself, over the MCP, because only it knows what it dealt with. The daemon never marks anything read, so it needs its own way of not relaunching forever on items a run has already seen:

- After a run on a task (a failed one, or one stopped at the ceiling, included), or a refused claim, it remembers the unread items it had for that task and the task's `updatedAt` as the run left it.
- On later polls, if every unread item for that task is one it remembers and the task's `updatedAt` hasn't moved, it leaves the task alone.
- A newer inbox item for the task, or any change to the task, wakes it again.
- A claim refused because another run holds the task is remembered as held. On each poll the daemon reads the task (its summary carries the live claim) and tries again once there is no claim, as long as the agent still has unread items there. While the claim is live, nothing else about the task wakes it.
- Once a task has nothing unread, its memory is dropped.

This applies to failed runs too, so a runtime that crashes on start doesn't get relaunched every 30 seconds. The memory is in-process: restart the daemon and it launches once more for whatever is still unread.

## Config

`~/.config/copland/daemon.toml` (`$XDG_CONFIG_HOME/copland/daemon.toml`), or `--config <file>`. Unknown keys are refused.

```toml
poll_interval = 30   # seconds; optional, 30 by default

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

`copland-daemon --check` reads the config, checks it, asks each instance who the token is and prints what it would run. It fails on a token it can't use: a read-only one (runs and claims are writes), or a run's secret (`cplr_…`) given in place of the agent's own token. The daemon checks the same at startup, through `/api/me`'s `access`, and stops watching that agent with an error; when no agent is left it exits. `COPLAND_LOG=debug` shows each poll's decisions and keepalives.

## Building

It's a Cargo workspace: `core` is a library with the loop, and `cli` is the `copland-daemon` binary. The split is for COPL-33, a GPUI window that will sit on top of the same loop: `Daemon::subscribe()` hands out the daemon's state (each agent's phase, last poll, unread count, last run) as a `tokio::sync::watch` receiver, which the headless binary ignores and a window would draw.

```sh
cd daemon
cargo build --release      # target/release/copland-daemon
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

TLS is rustls with ring, so there is no OpenSSL and no cmake to find; on NixOS plain `cargo` builds it. `--headless` is accepted and is the only mode for now.

## Testing it against a local Copland

Run `npm run dev` at the repo root, make an agent and a board in the app (or through `/api/agents`, `PUT /api/agents/:id/boards/:boardId` and `POST /api/tokens` with `agentId`), and point a config at `http://localhost:5173`. A stub runtime is enough to see the loop: a shell script that reads the URL and the `Authorization` header out of the MCP config file and calls `tools/call` with curl. Set `XDG_STATE_HOME` and `XDG_RUNTIME_DIR` to a scratch directory to keep its logs out of your real ones.

## Known gaps

- Two daemons running the same agent work fine against each other (claims keep them off the same task), but each launches its own run on a restart for whatever is unread.
- No backoff beyond the poll interval for a runtime that keeps failing on new items.
- A launch to answer on someone else's task wakes on plain comments too, once the agent has taken part there. Two agents answering each other in one thread would keep each other going; nothing stops that yet beyond the agent marking its inbox read.
