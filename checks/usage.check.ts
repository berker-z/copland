/* ============================================================================
   What runs cost (COPL-71): a finish's `usage` (routes/runs.ts, runUsage in
   domain/runs.ts), the task a run counts toward, and the sums on a task and
   on a parent's subtree (repo/tasks.ts).
   ----------------------------------------------------------------------------
   Run: npm run check. The routes run for real (checks/worker.ts) on the
   migrations in an in-memory node:sqlite: a run counts toward the first task
   it claims; its usage is taken once, from whichever finish first sends it,
   even after the runtime finished the run itself; a bad one is refused
   whole; a task sums its own runs and a parent its subtree with itself.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { ApiAccess, Run, RunUsage, Viewer } from "../src/domain/types.ts";

const { postClaim, postRunFinish } = await import("../src/worker/routes/runs.ts");
const { findTask, progressFor, boardTasks } = await import("../src/worker/repo/tasks.ts");
const { runUsage, tokenCount, dollars, usageLine } = await import("../src/domain/runs.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

/* The payload's rules, without a database. */
const full = { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50_000, cacheWriteTokens: 4000, costUsd: 0.42, turns: 7, durationMs: 90_000 };
t("a full usage is taken, resumed false unless said", JSON.stringify(runUsage(full)) === JSON.stringify({ ...full, resumed: false }));
t("cost, turns and duration may be left out", runUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })?.costUsd === null);
t("no usage is null", runUsage(undefined) === null && runUsage(null) === null);
t("a missing token count is refused", runUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 }) === undefined);
t("a negative or fractional count is refused", runUsage({ ...full, inputTokens: -1 }) === undefined && runUsage({ ...full, turns: 1.5 }) === undefined);
t("a cost that isn't a number is refused", runUsage({ ...full, costUsd: "0.42" }) === undefined);
t("an unknown field is refused, never dropped", runUsage({ ...full, model: "x" }) === undefined);
t("a list is refused", runUsage([1, 2]) === undefined);
t("counts read short", tokenCount(312) === "312" && tokenCount(48_200) === "48k" && tokenCount(1_250_000) === "1.3M" && tokenCount(999_999) === "1M");
t("costs read plainly", dollars(0.004) === "<$0.01" && dollars(0.842) === "$0.84" && dollars(12.4) === "$12" && dollars(0) === "$0.00");
t("a run's line has its cost, tokens and turns", usageLine({ ...full, resumed: true }) === "$0.42 · 56k tokens · 7 turns · resumed");

const db = sqlite();
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam'), ('ada', 'ada@x.test', 'ada');
  INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash, client) VALUES
    ('tk', 'sam', 'personal', 'box', 'write', 'h', 'claude-code'), ('tk-ada', 'ada', 'personal', 'box', 'write', 'ha', 'claude-code');
  INSERT INTO boards (id, name, key, created_by) VALUES ('b1', 'B', 'BB', 'sam');
  INSERT INTO board_members (board_id, user_id, role) VALUES ('b1', 'sam', 'owner'), ('b1', 'ada', 'editor');
  INSERT INTO stages (id, board_id, name, position, category) VALUES
    ('todo', 'b1', 'todo', 0, 'todo'), ('doing', 'b1', 'doing', 1, 'active'), ('done', 'b1', 'done', 2, 'done');
  INSERT INTO tasks (id, board_id, number, title, stage_id, rank, parent_id, level, created_by) VALUES
    ('e', 'b1', 1, 'epic', 'todo', 1, NULL, 'epic', 'sam'),
    ('s', 'b1', 2, 'story', 'todo', 2, 'e', 'story', 'sam'),
    ('t1', 'b1', 3, 'one', 'todo', 3, 's', 'task', 'sam'),
    ('t2', 'b1', 4, 'two', 'todo', 4, 'e', 'task', 'sam'),
    ('t3', 'b1', 5, 'three', 'todo', 5, NULL, 'task', 'sam');
  INSERT INTO runs (id, user_id, token_id, token_hash, client, kind) VALUES
    ('r1', 'sam', 'tk', 'rh1', 'claude-code', 'supervised'), ('r2', 'sam', 'tk', 'rh2', 'claude-code', 'supervised'),
    ('r3', 'sam', 'tk', 'rh3', 'claude-code', 'supervised'), ('r4', 'sam', 'tk', 'rh4', 'claude-code', 'supervised'),
    ('r5', 'sam', 'tk', 'rh5', 'claude-code', 'supervised'), ('ra', 'ada', 'tk-ada', 'rha', 'claude-code', 'supervised');
`);
const LIVE = { idFromName: (n: string) => n, get: () => ({ broadcast: async () => {} }) };
const env = { DB: d1(db), LIVE } as unknown as Parameters<typeof postRunFinish>[1];
const heard: string[][] = [];
const changes = {
  notify: () => {},
  board: (_audience: string[], change: { tasks: string[] }) => heard.push(change.tasks),
} as unknown as Parameters<typeof postRunFinish>[4];
const person = (id: string): Viewer["user"] => ({ id, kind: "person", email: null, handle: id, avatar: null, isAdmin: false, ownerId: null });
const as = (user: string, runId: string): Viewer => ({
  user: person(user),
  access: { tokenId: user === "sam" ? "tk" : "tk-ada", kind: "personal", scope: "write", via: "Claude Code", runId } satisfies ApiAccess,
});
const claim = async (runId: string, task: string) => (await postClaim(env, as("sam", runId), task, changes)).status;
const finish = async (runId: string, body: unknown, user = "sam") => {
  try {
    const r = await postRunFinish(new Request("https://x.test/", { method: "POST", body: JSON.stringify(body) }), env, as(user, runId), runId, changes);
    return { status: r.status, run: (await r.json()) as Run };
  } catch (e) {
    return { status: (e as { status?: number }).status ?? 500, run: null };
  }
};
const usage = (n: number, extra: Partial<RunUsage> = {}) => ({
  inputTokens: n,
  outputTokens: n * 2,
  cacheReadTokens: n * 10,
  cacheWriteTokens: n * 3,
  costUsd: n / 1000,
  turns: n / 100,
  durationMs: n * 60,
  ...extra,
});
const taskOf = (run: string) => (db.prepare(`SELECT task_id FROM runs WHERE id = ?`).get(run) as { task_id: string | null }).task_id;

t("claiming", (await claim("r1", "t1")) === 200 && (await claim("r1", "t2")) === 200);
t("a run counts toward the first task it claims, not the next", taskOf("r1") === "t1");

const done = await finish("r1", { status: "completed", usage: usage(100) });
t("a finish takes the usage and answers with it on the run", done.status === 200 && done.run?.usage?.inputTokens === 100 && done.run.usage.costUsd === 0.1);
t("the run names its task", done.run?.task === "BB-3");
t("the task's board hears it, its parents too", heard.some((ids) => ids.includes("t1") && ids.includes("s") && ids.includes("e")));
await finish("r1", { status: "completed", usage: usage(999) });
t("usage is taken once: a later finish's is not", (await finish("r1", { status: "completed" })).run?.usage?.inputTokens === 100);

/* The runtime finished its own run (finish_run, no usage), and its launcher's finish comes after. */
await claim("r2", "t1");
await finish("r2", { status: "completed" });
const late = await finish("r2", { status: "completed", reason: "exit 0 after 4m 2s", usage: usage(200, { resumed: true }) });
t("a run already over still takes its launcher's usage", late.run?.usage?.inputTokens === 200 && late.run.usage.resumed && late.run.status === "completed");

t("a bad usage refuses the whole finish", (await finish("r3", { status: "completed", usage: { inputTokens: 1 } })).status === 400);
t("and the run is still running", (db.prepare(`SELECT status FROM runs WHERE id = 'r3'`).get() as { status: string }).status === "running");

await claim("r3", "t2");
await finish("r3", { status: "failed", usage: usage(300, { costUsd: null }) });
/* A lead's run on the epic itself. */
await claim("r4", "e");
await finish("r4", { status: "completed", usage: usage(400) });
/* A run that claimed nothing (a message run): on no task. */
await finish("r5", { status: "completed", usage: usage(5000) });
t("a run that claimed nothing is on no task", taskOf("r5") === null);
const other = await finish("r5", { status: "completed", usage: usage(100) }, "ada");
t("nobody else's run is reachable", other.status === 404);

const one = await findTask(env.DB, "t1");
t("a task sums its own runs", one?.spent?.runs === 2 && one.spent.inputTokens === 300 && one.spent.cacheReadTokens === 3000 && one.spent.resumed === 1);
t("its cost adds up the runs that said one", Math.abs((one?.spent?.costUsd ?? 0) - 0.3) < 1e-9);
const two = await findTask(env.DB, "t2");
t("a run without a cost counts its tokens, not a cost", two?.spent?.runs === 1 && two.spent.costUsd === 0 && two.spent.outputTokens === 600);
t("a task no run reported on has nothing spent", (await findTask(env.DB, "t3"))?.spent === null);

const progress = await progressFor(env.DB, ["e", "s", "t3"]);
t("a story's progress sums its subtree", progress.s?.spent?.runs === 2 && progress.s.spent.inputTokens === 300);
t("an epic's sums its whole subtree and itself", progress.e?.spent?.runs === 4 && progress.e.spent.inputTokens === 1000 && progress.e.spent.durationMs === 60_000);
t("and still counts its children", progress.e?.children === 2 && progress.e.total === 2);
t("a leaf has no progress", progress.t3 === undefined);
const board = await boardTasks(env.DB, "b1");
t("the board's read carries both", board.tasks.find((x) => x.id === "e")?.spent?.runs === 1 && board.progress.e?.spent?.runs === 4);

/* A deleted task's runs don't count under its parent. */
db.exec(`UPDATE tasks SET deleted_at = '2026-10-26T00:00:00.000Z' WHERE id = 't2'`);
t("a deleted child's runs leave its parent's sum", (await progressFor(env.DB, ["e"])).e?.spent?.runs === 3);

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} usage checks passed`);
if (failed) process.exit(1);
