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

It's a Cargo workspace: `core` is a library with the loop, and `cli` is the `copland-daemon` binary. `box` is `copland-box`, the same loop with a GPUI window (below). `Daemon::subscribe()` hands out the daemon's state (each agent's phase, last poll, unread count, waiting tasks, last run) as a `tokio::sync::watch` receiver, which the headless binary ignores and the box draws. The workspace's `default-members` are `core` and `cli`, so plain `cargo` here builds and checks the headless daemon only, with no GPUI anywhere in its graph.

```sh
cd daemon
cargo build --release      # target/release/copland-daemon
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

TLS is rustls with ring, so there is no OpenSSL and no cmake to find; on NixOS plain `cargo` builds it. `--headless` is accepted and is the only mode `copland-daemon` has; the window is the separate `copland-box` binary.

## The box

`copland-box` is the daemon with a window (COPL-33). It runs the same loop as `copland-daemon`, in the same process, and draws the daemon's state as the wired scene from `docs/research/wired-prototype.html`: tickets wait on the wire into todo, a run picks one up at doing while current runs along its wire, and two branches leave doing, up to done and down to blocked. The geometry, the default tuning and the per-frame update are a port of the prototype's script, kept close enough to read side by side. All of it is in `box/src/scene.rs`: the pole and wire layout is the constants and `Layout`/`build_wires` at the top, plus where `draw` puts the poles and where `view.rs` puts the lists.

The scene is drawn on a 152×56 grid at 3 screen pixels per cell, rounded to whole device pixels on scaled outputs. Each frame it is composited in software the way the prototype's canvas is, then painted as one GPUI quad per horizontal run of same-coloured cells, a few hundred quads. The lists and the status line are text in JetBrains Mono when the system has it, else fontconfig's monospace, else DejaVu Sans Mono. No font is bundled.

What it shows, live:

- todo: tasks with unread items for an agent (`AgentState::waiting`, published on every poll), minus any a run is on.
- doing: each agent's current run, with the task key, the agent and how long it has run.
- done and blocked: nothing yet. Those are task stages, and the daemon doesn't read stages. A later step reads them from Copland's API, the same data the web widget uses.

A task the daemon has already run stays in todo while its items are unread, because that is what the inbox says. Without a usable config (no file, no agents, a refused one) the box shows the empty scene and "nothing on the wire" with the reason. `--demo` drives it with the prototype's simulation instead: no config, no server, nothing launched. In the demo `n` adds an item, `a` answers a blocked one and `f` finishes a run; `q` or Esc quits anywhere.

Closing the window, SIGINT or SIGTERM stop the daemon as the headless one stops: runtimes get SIGTERM and their runs finish as cancelled. The title bar drags the window (GPUI's `start_window_move`).

The colours are Copland's seven themes, copied from `src/styles/themes.css` into `box/src/theme.rs`. They have to be kept in step by hand; a test reads the CSS and fails when they differ. Pick one with `theme = "nord"` at the top of `daemon.toml` (the headless daemon ignores the key) or `--theme`. Later it should come from your Copland settings.

### Hyprland

The window is a normal toplevel with app id `copland-box`, no title and no server-side decorations, sized 628×247. Hyprland tiles it unless told otherwise. With the Lua config (Hyprland 0.55 and later):

```lua
hl.window_rule({
	match = { class = "^(copland-box)$" },
	float = true,
	pin = true,
	size = { 628, 247 },
	move = { "monitor_w-652", "monitor_h-295" },
	border_size = 0,
	rounding = 0,
	no_shadow = true,
})
```

The move puts it 24px from the right and 48px from the bottom. Use constants there, not `window_w`: the rule is evaluated against the size the window would have had tiled, which changes with whatever else is on the workspace. With an older `hyprland.conf`:

```
windowrulev2 = float, class:^(copland-box)$
windowrulev2 = pin, class:^(copland-box)$
windowrulev2 = size 628 247, class:^(copland-box)$
windowrulev2 = move 100%-652 100%-295, class:^(copland-box)$
windowrulev2 = noborder, class:^(copland-box)$
windowrulev2 = rounding 0, class:^(copland-box)$
windowrulev2 = noshadow, class:^(copland-box)$
```

The Lua rule was checked on Hyprland 0.56; the `windowrulev2` lines weren't.

### Building the box

GPUI needs native libraries NixOS doesn't put on a library path: the Vulkan loader, Wayland, X11, xkbcommon, fontconfig and freetype. `daemon/flake.nix` has a dev shell with them and `LD_LIBRARY_PATH` set. It brings no Rust toolchain, so cargo is whatever is on your PATH and builds inside and outside the shell share `target/`. nixpkgs is pinned to a rev in the flake itself, and `flake.lock` holds the hash.

```sh
cd daemon
nix develop -c cargo build -p copland-box --release   # target/release/copland-box
nix develop -c ./target/release/copland-box --demo
nix develop -c cargo test --workspace
nix develop -c cargo clippy --workspace --all-targets -- -D warnings
```

The binary runs outside the shell only if the libraries can be found some other way, so start it through `nix develop -c` for now. A Nix package with a wrapper is for later. Nix only sees files git tracks, so a fresh `flake.nix` needs at least `git add -N` before `nix develop` finds it.

GPUI is `gpui = "=0.2.2"` from crates.io, the newest published release. Everything under it comes from crates.io too, so that line and `Cargo.lock` pin the whole graph; no git dependencies. Pins move only when something forces it (see AGENTS.md).

## Testing it against a local Copland

Run `npm run dev` at the repo root, make an agent and a board in the app (or through `/api/agents`, `PUT /api/agents/:id/boards/:boardId` and `POST /api/tokens` with `agentId`), and point a config at `http://localhost:5173`. A stub runtime is enough to see the loop: a shell script that reads the URL and the `Authorization` header out of the MCP config file and calls `tools/call` with curl. Set `XDG_STATE_HOME` and `XDG_RUNTIME_DIR` to a scratch directory to keep its logs out of your real ones.

## Known gaps

- Two daemons running the same agent work fine against each other (claims keep them off the same task), but each launches its own run on a restart for whatever is unread.
- No backoff beyond the poll interval for a runtime that keeps failing on new items.
- A launch to answer on someone else's task wakes on plain comments too, once the agent has taken part there. Two agents answering each other in one thread would keep each other going; nothing stops that yet beyond the agent marking its inbox read.
