/* ============================================================================
   A story is a lane (COPL-235): one run holds the story and does its tasks.
   ----------------------------------------------------------------------------
   Run: npm run check. The routes and the sweep run for real
   (checks/worker.ts) on the migrations in an in-memory node:sqlite.
   GET /api/tasks/ready (routes/work.ts) offers a story the caller is on
   instead of its tasks, and a story's task to a caller who isn't on the
   story; POST /api/tasks/:id/claim (routes/runs.ts) refuses a story's task
   as `lane` while another run holds the story, and lets the run that holds
   it take its tasks in turn; and when that run dies, deadRuns.ts puts back
   the task it was on and the story, leaves closed tasks closed, and counts
   strikes on each, so a story whose lane dies three times goes to blocked.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { ApiAccess, ReadyTask, Viewer } from "../src/domain/types.ts";

const { getReady } = await import("../src/worker/routes/work.ts");
const { postClaim } = await import("../src/worker/routes/runs.ts");
const { patchTask } = await import("../src/worker/routes/tasks.ts");
const { sweepStaleRuns } = await import("../src/worker/deadRuns.ts");
const { Changes } = await import("../src/worker/live.ts");
const { asAccess } = await import("../src/worker/tokens.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const db = sqlite();
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam');
  INSERT INTO users (id, email, handle, kind, owner_id) VALUES ('dev', 'dev@agents.invalid', 'sam/dev', 'agent', 'sam');
  INSERT INTO agents (user_id, name) VALUES ('dev', 'dev');
  INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash, client) VALUES ('tk', 'dev', 'personal', 'box', 'write', 'h', 'claude-code');
  INSERT INTO boards (id, name, key, created_by) VALUES ('b1', 'B', 'BB', 'sam');
  INSERT INTO board_members (board_id, user_id, role) VALUES ('b1', 'sam', 'owner'), ('b1', 'dev', 'editor');
  INSERT INTO stages (id, board_id, name, position, category) VALUES
    ('todo', 'b1', 'todo', 0, 'todo'), ('doing', 'b1', 'doing', 1, 'active'), ('blocked', 'b1', 'blocked', 2, 'blocked'), ('done', 'b1', 'done', 3, 'done');
  INSERT INTO tasks (id, board_id, number, title, stage_id, rank, level, parent_id, created_by) VALUES
    ('story', 'b1', 1, 'the lane', 'todo', 0, 'story', NULL, 'sam'),
    ('a', 'b1', 2, 'first', 'todo', 1, 'task', 'story', 'sam'),
    ('b', 'b1', 3, 'second', 'todo', 2, 'task', 'story', 'sam'),
    ('c', 'b1', 4, 'third', 'todo', 3, 'task', 'story', 'sam'),
    ('epic', 'b1', 5, 'an epic', 'todo', 4, 'epic', NULL, 'sam'),
    ('e1', 'b1', 6, 'under the epic', 'todo', 5, 'task', 'epic', 'sam'),
    ('other', 'b1', 7, 'sam''s story', 'todo', 6, 'story', NULL, 'sam'),
    ('x', 'b1', 8, 'dev''s task in it', 'todo', 7, 'task', 'other', 'sam'),
    ('loose', 'b1', 9, 'no parent', 'todo', 8, 'task', NULL, 'sam');
  INSERT INTO task_assignees (task_id, user_id) VALUES
    ('story', 'dev'), ('a', 'dev'), ('b', 'dev'), ('c', 'dev'), ('e1', 'dev'), ('other', 'sam'), ('x', 'dev'), ('loose', 'dev');
`);
const LIVE = { idFromName: (n: string) => n, get: () => ({ broadcast: async () => {} }) };
const env = { DB: d1(db), LIVE } as unknown as Parameters<typeof postClaim>[0];
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const sam: Viewer["user"] = { id: "sam", kind: "person", email: null, handle: "sam", avatar: null, isAdmin: false, ownerId: null };
const as = (runId: string): Viewer => ({
  user: { id: "dev", kind: "agent", email: null, handle: "sam/dev", avatar: null, isAdmin: false, ownerId: "sam" },
  agent: { owner: sam, grants: [], workFrom: "members", description: "" },
  access: { tokenId: "tk", kind: "personal", scope: "write", via: "Claude Code", runId } satisfies ApiAccess,
});

const stage = (task: string) => (db.prepare(`SELECT stage_id FROM tasks WHERE id = ?`).get(task) as { stage_id: string }).stage_id;
const ready = async (runId: string) => {
  const body = (await (await getReady(env, as(runId))).json()) as { tasks: ReadyTask[] };
  return body.tasks.map((r) => r.id).sort();
};
/** The status and code a claim is refused with, or "ok". */
const claim = async (runId: string, task: string) => {
  try {
    const viewer = as(runId);
    await asAccess(viewer.access!, () => postClaim(env, viewer, task, new Changes()));
    return "ok";
  } catch (error) {
    const e = error as { status?: number; code?: string; message?: string };
    return `${e.status} ${e.code}`;
  }
};
const startRun = (id: string) =>
  db.prepare(`INSERT INTO runs (id, user_id, token_id, token_hash, client) VALUES (?, 'dev', 'tk', ?, 'claude-code')`).run(id, `rh-${id}`);
/** The run goes quiet past its lease, and the cron sweeps it. */
const dies = async (id: string) => {
  const long = new Date(Date.now() - 60 * 60_000).toISOString();
  db.prepare(`UPDATE runs SET last_seen_at = ? WHERE id = ?`).run(long, id);
  db.prepare(`UPDATE task_claims SET claimed_until = ? WHERE run_id = ?`).run(long, id);
  await sweepStaleRuns(env, ctx);
};

/* Ready: the story is offered, not its tasks; the rest as ever. */
startRun("r1");
startRun("r2");
const offered = await ready("r1");
t("a story the caller is on is offered", offered.includes("story"));
t("its tasks are not offered on their own", !offered.includes("a") && !offered.includes("b") && !offered.includes("c"));
t("a task under a story the caller isn't on is offered, since its daemon won't run that lane", offered.includes("x"));
t("a task under an epic is offered", offered.includes("e1"));
t("a task with no parent is offered", offered.includes("loose"));

/* Claims: the lane's run takes the story, then its tasks one at a time. */
t("a run claims the story", (await claim("r1", "story")) === "ok" && stage("story") === "doing");
const refusal = await (async () => {
  try {
    const viewer = as("r2");
    await asAccess(viewer.access!, () => postClaim(env, viewer, "a", new Changes()));
    return null;
  } catch (error) {
    return error as { status: number; code: string; message: string };
  }
})();
t("another run is refused a story's task with lane", refusal?.status === 409 && refusal.code === "lane");
t("the refusal names the story and the run", !!refusal?.message.includes("BB-1") && !!refusal.message.includes("r1"));
t("the run that holds the story claims its first task", (await claim("r1", "a")) === "ok" && stage("a") === "doing");
t("and its second, holding several claims at once", (await claim("r1", "b")) === "ok");
const held = (db.prepare(`SELECT task_id FROM task_claims WHERE run_id = 'r1' ORDER BY task_id`).all() as Array<{ task_id: string }>).map((r) => r.task_id);
t("one run holds the story and both tasks", held.join(",") === "a,b,story");
t("claiming again a task it holds only renews it", (await claim("r1", "a")) === "ok");
t("a task under a story nobody holds is claimed as ever", (await claim("r2", "x")) === "ok");

/* The lane run closes a, is on b, never got to c, and dies. */
const viewer = as("r1");
await asAccess(viewer.access!, () =>
  patchTask(new Request("https://x.test/", { method: "PATCH", body: JSON.stringify({ stageId: "done" }) }), env, viewer, "a", new Changes()),
);
t("its first task is done, and the story stays under way", stage("a") === "done" && stage("story") === "doing");
await dies("r1");
t("after the lane run dies, the task it closed stays closed", stage("a") === "done");
t("the task it was on goes back to todo", stage("b") === "todo");
t("the story goes back to todo, and parents following doesn't undo it", stage("story") === "todo");
t("the task it never claimed stays in todo", stage("c") === "todo");
t("once the lane is gone, its story's tasks can be claimed", (await claim("r2", "c")) === "ok");

/* Two more lane runs die: three in a row on the story, and it waits for a person. */
db.prepare(`UPDATE tasks SET stage_id = 'todo' WHERE id = 'c'`).run();
db.exec(`DELETE FROM task_claims WHERE task_id = 'c'`);
for (const id of ["r3", "r4"]) {
  startRun(id);
  await claim(id, "story");
  await claim(id, "b");
  await dies(id);
}
t("a story whose lane dies three times in a row goes to blocked", stage("story") === "blocked");
t("and so does the task all three were on", stage("b") === "blocked");

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} lane checks passed`);
if (failed) process.exit(1);
