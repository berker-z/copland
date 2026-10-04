/* ============================================================================
   What a run is told while it works (COPL-139): POST /api/runs/current/news
   in src/worker/routes/runs.ts, the claim's hears, and the MCP's heartbeat.
   ----------------------------------------------------------------------------
   Run: npm run check. The route runs for real (checks/worker.ts) on the
   migrations in an in-memory node:sqlite: only the run's own principal's
   unread comments and mentions, only on tasks the run holds a live claim
   on, only since it started, each once; never another task's, an owner's,
   a message or an assignment. heartbeat with the hook's event hands them to
   Claude Code as additional context, and without one stays empty.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { ApiAccess, RunNews, Viewer } from "../src/domain/types.ts";
import type { ApiCall } from "../src/worker/mcp.ts";

const { getCurrentRun, postRunNews } = await import("../src/worker/routes/runs.ts");
const { findTask } = await import("../src/worker/repo/tasks.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const db = sqlite();
const T0 = "2026-10-05T10:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam'), ('ada', 'ada@x.test', 'ada');
  INSERT INTO users (id, email, handle, kind, owner_id) VALUES ('dev', 'dev@agents.invalid', 'sam/dev', 'agent', 'sam');
  INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash, client) VALUES
    ('tk-dev', 'dev', 'personal', 'box', 'write', 'h-dev', 'claude-code'),
    ('tk-chat', 'dev', 'personal', 'chat', 'write', 'h-chat', NULL);
  INSERT INTO boards (id, name, key, created_by) VALUES ('b1', 'B', 'BB', 'sam');
  INSERT INTO stages (id, board_id, name, position, category) VALUES ('s1', 'b1', 'doing', 0, 'active');
  INSERT INTO tasks (id, board_id, number, title, stage_id, created_by) VALUES
    ('t1', 'b1', 1, 'one', 's1', 'sam'), ('t2', 'b1', 2, 'two', 's1', 'sam'), ('t3', 'b1', 3, 'three', 's1', 'sam');
  INSERT INTO runs (id, user_id, token_id, token_hash, client, started_at) VALUES
    ('r1', 'dev', 'tk-dev', 'rh1', 'claude-code', '${T0}'),
    ('r2', 'dev', 'tk-dev', 'rh2', 'claude-code', '${T0}'),
    ('r3', 'dev', 'tk-dev', 'rh3', 'claude-code', '${T0}');
  INSERT INTO task_claims (task_id, run_id, user_id, claimed_until) VALUES
    ('t1', 'r1', 'dev', '2099-01-01T00:00:00.000Z'),
    ('t2', 'r2', 'dev', '2099-01-01T00:00:00.000Z'),
    ('t3', 'r3', 'dev', '2000-01-01T00:00:00.000Z');
  INSERT INTO messages (id, sender_id, recipient_id, text) VALUES ('m1', 'sam', 'dev', 'a message about one');
`);
let n = 0;
/** A comment on `task` by `by`, landing in `user`'s inbox as `kind` at T0 + `min` minutes: the inbox item's id. */
const item = (user: string, kind: "mentioned" | "commented" | "assigned", task: string, min: number, text: string, read = false) => {
  const id = `i${++n}`;
  const comment = kind === "assigned" ? null : `c${n}`;
  if (comment) db.prepare(`INSERT INTO comments (id, task_id, author_id, text, created_at) VALUES (?, ?, 'sam', ?, ?)`).run(comment, task, text, at(min));
  db.prepare(
    `INSERT INTO inbox_items (id, user_id, kind, board_id, task_id, comment_id, actor_id, via, created_at, read_at) VALUES (?, ?, ?, 'b1', ?, ?, 'sam', NULL, ?, ?)`,
  ).run(id, user, kind, task, comment, at(min), read ? at(min) : null);
  return id;
};

const before = item("dev", "commented", "t1", -5, "from before the run");
const first = item("dev", "commented", "t1", 1, "why is this nix only?");
const second = item("dev", "mentioned", "t1", 2, "@sam/dev read this\nsecond line");
item("dev", "commented", "t1", 3, "already read", true);
const elsewhere = item("dev", "commented", "t2", 4, "on two");
item("sam", "commented", "t1", 5, "in the owner's inbox");
item("dev", "assigned", "t1", 6, "");
db.prepare(`INSERT INTO inbox_items (id, user_id, kind, board_id, task_id, message_id, actor_id, created_at) VALUES ('im', 'dev', 'message', 'b1', 't1', 'm1', 'sam', ?)`).run(at(7));
item("dev", "commented", "t3", 8, "on a lapsed claim");

const env = { DB: d1(db) } as unknown as Parameters<typeof postRunNews>[0];
const agent: Viewer["user"] = { id: "dev", kind: "agent", email: null, handle: "sam/dev", avatar: null, isAdmin: false, ownerId: "sam" };
const access = (tokenId: string, extra: Partial<ApiAccess> = {}): ApiAccess => ({ tokenId, kind: "personal", scope: "write", via: "Claude Code", ...extra });
const run = (runId: string): Viewer => ({ user: agent, access: access("tk-dev", { runId }) });
const news = async (viewer: Viewer) => (await (await postRunNews(env, viewer)).json()) as RunNews;
const heard = (id: string) => (db.prepare(`SELECT heard_until FROM runs WHERE id = ?`).get(id) as { heard_until: string | null }).heard_until;
const hears = async (task: string) => (await findTask(env.DB, task))?.claim?.hears;

t("a run that never asked doesn't hear, and its claim says so", heard("r1") === null && (await hears("t1")) === false);
const told = await news(run("r1"));
t("the run's own task's unread comments and mentions since it started, oldest first", told.items.map((i) => i.id).join(",") === `${first},${second}`);
t("never one from before the run, a read one, another task's, the owner's, an assignment or a message", !told.items.some((i) => i.id === before || i.id === elsewhere || i.id === "im") && told.items.every((i) => i.task === "BB-1"));
t("each item has the task's key, the author, the kind and the comment as it is", told.items[1].task === "BB-1" && told.items[1].by === "sam" && told.items[1].kind === "mentioned" && told.items[1].text === "@sam/dev read this\nsecond line");
t("it names the run", told.run?.id === "r1" && told.run.short === "r1".slice(0, 4) && told.run.kind === "supervised");
t("heard_until moves to the newest item told, and the claim now hears", heard("r1") === at(2) && (await hears("t1")) === true);
t("each is told once", (await news(run("r1"))).items.length === 0 && heard("r1") === at(2));
const third = item("dev", "commented", "t1", 9, "one more");
t("a comment that comes in later is told at the next ask", (await news(run("r1"))).items.map((i) => i.id).join(",") === third && heard("r1") === at(9));
t("another run of the same agent hears only its own task", (await news(run("r2"))).items.map((i) => i.id).join(",") === elsewhere);
const lapsed = await news(run("r3"));
t("a lapsed claim hears nothing, but the run is marked as asking", lapsed.items.length === 0 && heard("r3") === T0);
t("no run: nothing, and nothing written", JSON.stringify(await news({ user: agent, access: access("tk-chat") })) === JSON.stringify({ run: null, items: [] }));
db.exec(`UPDATE runs SET status = 'completed' WHERE id = 'r2'`);
t("an ended run is told nothing", (await news(run("r2"))).run === null);
db.exec(`UPDATE runs SET status = 'running' WHERE id = 'r2'`);

/* The MCP's heartbeat. */
const { CallError, handleMcp } = await import("../src/worker/mcp.ts");
const { requireWriteScope } = await import("../src/worker/tokens.ts");
const calls: string[] = [];
const api = (viewer: Viewer): ApiCall => async <T>(method: string, path: string): Promise<T> => {
  calls.push(`${method} ${path}`);
  try {
    requireWriteScope(viewer, method);
    if (method === "GET" && path === "/api/runs/current") return (await (await getCurrentRun(viewer)).json()) as T;
    if (method === "POST" && path === "/api/runs/current/news") return (await news(viewer)) as T;
    throw new Error(`no route ${method} ${path}`);
  } catch (error) {
    const err = error as { message: string; status?: number; code?: string };
    throw new CallError(err.message, err.status ?? 500, err.code ?? null);
  }
};
const heartbeat = async (viewer: Viewer, args: Record<string, unknown>) => {
  calls.length = 0;
  const request = new Request("https://x.test/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "heartbeat", arguments: args } }),
  });
  const out = (await (await handleMcp(request, viewer, api(viewer), async () => {}, "https://x.test")).json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return { text: out.result.content[0].text, error: out.result.isError === true };
};

const fourth = item("dev", "mentioned", "t1", 10, "@sam/dev stop and answer");
const bare = await heartbeat(run("r1"), {});
t("heartbeat without an event stays empty and tells nothing", !bare.error && bare.text === "" && calls.join() === "GET /api/runs/current" && heard("r1") === at(9));
const beat = await heartbeat(run("r1"), { event: "PostToolUse" });
const out = JSON.parse(beat.text || "{}") as { hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
t("heartbeat with the hook's event answers with Claude Code's hook output for that event", out.hookSpecificOutput?.hookEventName === "PostToolUse");
t(
  "its additional context quotes the comment, names the task and the inbox item, and says to deal with it first",
  !!out.hookSpecificOutput &&
    out.hookSpecificOutput.additionalContext.includes("> @sam/dev stop and answer") &&
    out.hookSpecificOutput.additionalContext.includes("BB-1") &&
    out.hookSpecificOutput.additionalContext.includes(`inbox item ${fourth}`) &&
    out.hookSpecificOutput.additionalContext.includes("before you integrate"),
);
t("the next beat has nothing new and stays empty", (await heartbeat(run("r1"), { event: "PostToolUse" })).text === "");
item("dev", "commented", "t1", 11, "while you were away");
const prompt = JSON.parse((await heartbeat(run("r1"), { event: "UserPromptSubmit" })).text || "{}") as typeof out;
t("on UserPromptSubmit it names that event", prompt.hookSpecificOutput?.hookEventName === "UserPromptSubmit");
item("dev", "commented", "t1", 12, "for an event it doesn't answer");
t("an event it doesn't answer is a plain heartbeat", (await heartbeat(run("r1"), { event: "Stop" })).text === "" && heard("r1") === at(11));
const readOnly: Viewer = { user: agent, access: access("tk-dev", { runId: "r1", scope: "read" }) };
const ro = await heartbeat(readOnly, { event: "PostToolUse" });
t("a read-only connection's heartbeat does nothing, without an error", !ro.error && ro.text === "" && heard("r1") === at(11));
t("a connection with no run asks for nothing", (await heartbeat({ user: agent, access: access("tk-chat") }, { event: "PostToolUse" })).text === "" && calls.join() === "GET /api/runs/current");

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} run news checks passed`);
if (failed) process.exit(1);
