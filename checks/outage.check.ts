/* ============================================================================
   When Copland is down (COPL-148): a storage failure answers 503
   `storage_unavailable` (src/worker/http.ts), and a finish that lands after
   the cron's sweep ended its run as stale sets the run's ending right
   (routes/runs.ts, deadRuns.ts), so a run cut off by our outage spends no
   strike on its task.
   ----------------------------------------------------------------------------
   Run: npm run check. The routes and the sweep run for real
   (checks/worker.ts) on the migrations in an in-memory node:sqlite.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { ApiAccess, Viewer } from "../src/domain/types.ts";

const { errorResponse, HttpError, storageFailure } = await import("../src/worker/http.ts");
const { postRunFinish } = await import("../src/worker/routes/runs.ts");
const { sweepStaleRuns } = await import("../src/worker/deadRuns.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

/* A storage failure is a 503 with a code; our own query's mistake stays a 500. */
const quota = new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.");
const answer = async (e: unknown) => {
  const r = errorResponse(e);
  return { status: r.status, body: (await r.json()) as { code?: string } };
};
const q = await answer(quota);
t("D1's quota running out answers 503 storage_unavailable", q.status === 503 && q.body.code === "storage_unavailable");
t("so does a D1 failure carried as a cause", storageFailure(new Error("reading the inbox", { cause: new Error("D1_ERROR: Network connection lost.") })));
t("and an overloaded D1", storageFailure(new Error("D1 DB is overloaded. Too many requests queued.")));
t("a constraint our query broke is a 500", (await answer(new Error("D1_ERROR: UNIQUE constraint failed: users.handle: SQLITE_CONSTRAINT"))).status === 500);
t("a missing column is a 500", !storageFailure(new Error("D1_ERROR: no such column: swept_at: SQLITE_ERROR")));
t("anything else is a 500", (await answer(new TypeError("x is undefined"))).status === 500 && !storageFailure("D1"));
t("a refusal is still its own status", (await answer(new HttpError(409, "no", "claimed"))).status === 409);

/* Runs that went quiet, swept, and the finish that comes after. */
const db = sqlite();
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam');
  INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash, client) VALUES ('tk', 'sam', 'personal', 'box', 'write', 'h', 'claude-code');
  INSERT INTO boards (id, name, key, created_by) VALUES ('b1', 'B', 'BB', 'sam');
  INSERT INTO board_members (board_id, user_id, role) VALUES ('b1', 'sam', 'owner');
  INSERT INTO stages (id, board_id, name, position, category) VALUES
    ('todo', 'b1', 'todo', 0, 'todo'), ('doing', 'b1', 'doing', 1, 'active'), ('blocked', 'b1', 'blocked', 2, 'blocked'), ('done', 'b1', 'done', 3, 'done');
  INSERT INTO tasks (id, board_id, number, title, stage_id, rank, created_by) VALUES
    ('t1', 'b1', 1, 'cut off', 'doing', 'a', 'sam'), ('t2', 'b1', 2, 'really dying', 'doing', 'b', 'sam');
  INSERT INTO task_assignees (task_id, user_id) VALUES ('t1', 'sam'), ('t2', 'sam');
`);
/* The live hub, which the sweep tells of what it moved: nobody listening. */
const LIVE = { idFromName: (n: string) => n, get: () => ({ broadcast: async () => {} }) };
const env = { DB: d1(db), LIVE } as unknown as Parameters<typeof postRunFinish>[1];
const changes = { notify: () => {} } as unknown as Parameters<typeof postRunFinish>[4];
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const sam: Viewer = {
  user: { id: "sam", kind: "person", email: null, handle: "sam", avatar: null, isAdmin: false, ownerId: null },
  access: { tokenId: "tk", kind: "personal", scope: "write", via: "Claude Code" } satisfies ApiAccess,
};
const stage = (task: string) => (db.prepare(`SELECT stage_id FROM tasks WHERE id = ?`).get(task) as { stage_id: string }).stage_id;
const runRow = (id: string) => db.prepare(`SELECT status, reason, swept_at FROM runs WHERE id = ?`).get(id) as { status: string; reason: string | null; swept_at: string | null };
const finish = (id: string, body: unknown) =>
  postRunFinish(new Request("https://x.test/", { method: "POST", body: JSON.stringify(body) }), env, sam, id, changes);

let n = 0;
/** A run claims the task (back in doing), then goes quiet past its lease, and the cron sweeps it. */
const quietRun = async (task: string) => {
  const id = `r${++n}`;
  const long = new Date(Date.now() - 60 * 60_000).toISOString();
  db.prepare(`UPDATE tasks SET stage_id = 'doing' WHERE id = ?`).run(task);
  db.prepare(`INSERT INTO runs (id, user_id, token_id, token_hash, client, last_seen_at) VALUES (?, 'sam', 'tk', ?, 'claude-code', ?)`).run(id, `rh-${id}`, long);
  db.prepare(`INSERT INTO task_claims (task_id, run_id, user_id, claimed_until) VALUES (?, ?, 'sam', ?)`).run(task, id, long);
  db.prepare(`INSERT INTO events (id, board_id, task_id, actor_id, kind, run_id, created_at) VALUES (?, 'b1', ?, 'sam', 'task.claimed', ?, ?)`).run(`e-${id}`, task, id, new Date(Date.now() - 1000 + n).toISOString());
  await sweepStaleRuns(env, ctx);
  return id;
};

/* Copland was down: the run on t1 completed, but its finish couldn't land, and the sweep ended it. */
const r1 = await quietRun("t1");
t("the sweep ends a quiet run as failed and says it did", runRow(r1).status === "failed" && runRow(r1).swept_at !== null);
t("and puts its task back in todo", stage("t1") === "todo");
await finish(r1, { status: "completed", interrupted: false, reason: "exit 0 after 41m" });
t("the launcher's finish, landing after, replaces the sweep's failed", runRow(r1).status === "completed" && runRow(r1).reason === "exit 0 after 41m" && runRow(r1).swept_at === null);
t("and moves nothing: the sweep already put the task back", stage("t1") === "todo");
await finish(r1, { status: "failed" });
t("a later finish changes nothing, as for any run already over", runRow(r1).status === "completed");

/* Two more runs die on t1: with r1's strike undone, that is two in a row, not three. */
await quietRun("t1");
await quietRun("t1");
t("a run that really completed is no strike: two dead runs after it don't block the task", stage("t1") === "todo");

/* The same three without the late finish: the third blocks, as before. */
await quietRun("t2");
await quietRun("t2");
await quietRun("t2");
t("three swept runs in a row with no word from their launcher still block", stage("t2") === "blocked");

/* A run its launcher finished is never rewritten by another finish. */
db.exec(`INSERT INTO runs (id, user_id, token_id, token_hash, client) VALUES ('rf', 'sam', 'tk', 'rh-rf', 'claude-code')`);
await finish("rf", { status: "failed", reason: "exit 1 after 3s" });
await finish("rf", { status: "completed" });
t("a launcher's own failed stands against a second finish", runRow("rf").status === "failed" && runRow("rf").swept_at === null);

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} outage checks passed`);
if (failed) process.exit(1);
