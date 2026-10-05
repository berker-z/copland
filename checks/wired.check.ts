/* ============================================================================
   GET /api/wired (src/worker/routes/wired.ts): which of your agents' tasks
   land on which pole, now that it reads open work and the done window only
   (COPL-152).
   ----------------------------------------------------------------------------
   Run: npm run check. On the migrations in an in-memory node:sqlite: open
   tasks of sam's agents sort onto todo, doing (live when their run holds
   it) and blocked; done ones only inside the window; backlog, cancelled,
   deleted, old done, other people's and their agents' tasks, and boards sam
   isn't on never show; a task with two of sam's agents shows once, as the
   claimer's.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { Viewer, Wired } from "../src/domain/types.ts";

const { getWired } = await import("../src/worker/routes/wired.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const db = sqlite();
/* sam has agents dev and ops, kim has bot. sam is on b1, not on b2. */
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam'), ('kim', 'kim@x.test', 'kim');
  INSERT INTO users (id, email, handle, kind, owner_id) VALUES
    ('dev', 'dev@agents.invalid', 'sam/dev', 'agent', 'sam'), ('ops', 'ops@agents.invalid', 'sam/ops', 'agent', 'sam'),
    ('bot', 'bot@agents.invalid', 'kim/bot', 'agent', 'kim');
  INSERT INTO agents (user_id, name) VALUES ('dev', 'dev'), ('ops', 'ops'), ('bot', 'bot');
  INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash) VALUES ('tok', 'ops', 'personal', 'box', 'write', 'h');
  INSERT INTO boards (id, key, name, created_by) VALUES ('b1', 'BA', 'alpha', 'sam'), ('b2', 'BB', 'beta', 'kim');
  INSERT INTO board_members (board_id, user_id, role) VALUES
    ('b1', 'sam', 'owner'), ('b1', 'dev', 'editor'), ('b1', 'ops', 'editor'), ('b1', 'kim', 'editor'), ('b1', 'bot', 'editor'),
    ('b2', 'kim', 'owner'), ('b2', 'dev', 'editor');
`);
for (const board of ["b1", "b2"]) {
  ["backlog", "todo", "active", "blocked", "done", "cancelled"].forEach((category, position) =>
    db.prepare(`INSERT INTO stages (id, board_id, position, name, category) VALUES (?, ?, ?, ?, ?)`).run(`${board}-${category}`, board, position, category, category),
  );
}
let number = 0;
const task = (title: string, category: string, assignees: string[], o: { completed?: string; deleted?: boolean; board?: string } = {}) => {
  const board = o.board ?? "b1";
  db.prepare(
    `INSERT INTO tasks (id, board_id, number, title, stage_id, rank, created_by, completed_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, 'sam', ?, ?)`,
  ).run(title, board, ++number, title, `${board}-${category}`, number, o.completed ?? null, o.deleted ? ago(0) : null);
  for (const user of assignees) db.prepare(`INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)`).run(title, user);
};
task("waiting", "todo", ["dev"]);
task("claimed", "active", ["dev", "ops"]);
task("loose", "active", ["dev"]);
task("stuck", "blocked", ["ops"]);
task("parked", "backlog", ["dev"]);
task("recent", "done", ["dev"], { completed: ago(2 * HOUR) });
task("old", "done", ["dev"], { completed: ago(48 * HOUR) });
task("dropped", "cancelled", ["dev"], { completed: ago(HOUR) });
task("gone", "todo", ["dev"], { deleted: true });
task("sams", "todo", ["sam"]);
task("kims bots", "todo", ["bot"]);
task("elsewhere", "todo", ["dev"], { board: "b2" });
db.exec(`
  INSERT INTO runs (id, user_id, token_id, token_hash, client, status, started_at, last_seen_at) VALUES ('r1', 'ops', 'tok', 'hr', 'claude-code', 'running', '${ago(HOUR)}', '${ago(0)}');
  INSERT INTO task_claims (task_id, run_id, user_id, claimed_at, claimed_until) VALUES ('claimed', 'r1', 'ops', '${ago(HOUR)}', '${ago(-HOUR)}');
`);

const sam = {
  user: { id: "sam", kind: "person", email: "sam@x.test", handle: "sam", avatar: null, isAdmin: false, ownerId: null },
} as Viewer;
const env = { DB: d1(db) } as unknown as Parameters<typeof getWired>[0];
const wired = (await (await getWired(env, sam)).json()) as Wired;
const keys = (list: Wired["todo"]) => list.map((w) => w.title).join(",");
const all = [...wired.todo, ...wired.doing, ...wired.blocked, ...wired.done];

t("both of sam's agents are listed", wired.agents.map((a) => a.handle).join(",") === "sam/dev,sam/ops");
t("a todo task of an agent is on todo", keys(wired.todo) === "waiting");
t("a claimed task is live doing, first", wired.doing[0]?.title === "claimed" && wired.doing[0].live);
t("an active task no run holds is doing, not live", keys(wired.doing) === "claimed,loose" && !wired.doing[1].live);
t("a blocked task is on blocked", keys(wired.blocked) === "stuck");
t("done inside the window is on done", keys(wired.done) === "recent" && wired.doneCount === 1);
t("a task with two of sam's agents shows once, as the claimer's", all.filter((w) => w.title === "claimed").length === 1 && wired.doing[0].agentId === "ops");
for (const hidden of ["parked", "old", "dropped", "gone", "sams", "kims bots", "elsewhere"]) {
  t(`"${hidden}" does not show`, !all.some((w) => w.title === hidden));
}

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} wired checks passed`);
if (failed) process.exit(1);
