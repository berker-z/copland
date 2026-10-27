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
   claimer's. Each agent says where it runs (COPL-183): its reported hosts,
   which are live, and live on two at once; a live task its run's host.
   ?tasks= (COPL-211) answers the same for just the tasks named.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { Viewer, Wired, WiredPart } from "../src/domain/types.ts";

const { getWired, MAX_TASKS } = await import("../src/worker/routes/wired.ts");

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
  INSERT INTO runs (id, user_id, token_id, token_hash, client, status, started_at, last_seen_at, host) VALUES ('r1', 'ops', 'tok', 'hr', 'claude-code', 'running', '${ago(HOUR)}', '${ago(0)}', 'laptop');
  INSERT INTO agent_hosts (user_id, hostname, version, capabilities, first_reported_at, last_reported_at) VALUES
    ('ops', 'laptop', '0.3.0', '{"runtimes":[],"repos":[]}', '${ago(2 * HOUR)}', '${ago(HOUR)}'),
    ('ops', 'server', '0.3.0', '{"runtimes":[],"repos":[]}', '${ago(2 * HOUR)}', '${ago(0)}'),
    ('dev', 'old-box', '0.2.0', '{"runtimes":[],"repos":[]}', '${ago(48 * HOUR)}', '${ago(48 * HOUR)}');
  INSERT INTO task_claims (task_id, run_id, user_id, claimed_at, claimed_until) VALUES ('claimed', 'r1', 'ops', '${ago(HOUR)}', '${ago(-HOUR)}');
`);

const sam = {
  user: { id: "sam", kind: "person", email: "sam@x.test", handle: "sam", avatar: null, isAdmin: false, ownerId: null },
} as Viewer;
/* ops's daemon is live on laptop and server at once, both through its token; dev's on nothing. */
const sockets: Record<string, { tokenId: string; host: string | null }[]> = {
  ops: [{ tokenId: "tok", host: "laptop" }, { tokenId: "tok", host: "server" }],
};
const LIVE = { idFromName: (name: string) => name, get: (id: string) => ({ listening: async () => sockets[id] ?? [] }) };
const env = { DB: d1(db), LIVE } as unknown as Parameters<typeof getWired>[0];
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
const [dev, ops] = wired.agents;
t("an agent lists its hosts, the latest first, with which are live", JSON.stringify(ops?.hosts) === JSON.stringify([{ hostname: "server", live: true }, { hostname: "laptop", live: true }]));
t("live on two hosts at once is flagged", ops?.liveOnTwoHosts === true);
t("a host it reported but isn't live on is not live, and one host is no warning", JSON.stringify(dev?.hosts) === JSON.stringify([{ hostname: "old-box", live: false }]) && !dev.liveOnTwoHosts);
t("a live task says its run's host", wired.doing[0]?.host === "laptop");
t("a task no run holds says no host", wired.doing[1]?.host === null && wired.todo[0]?.host === null);
for (const hidden of ["parked", "old", "dropped", "gone", "sams", "kims bots", "elsewhere"]) {
  t(`"${hidden}" does not show`, !all.some((w) => w.title === hidden));
}

/* ?tasks= (COPL-211): the same poles for just the tasks named. */
const part = async (ids: string[]) => (await getWired(env, sam, new URL(`http://x/api/wired?tasks=${ids.join(",")}`))).json() as Promise<WiredPart>;
const some = await part(["claimed", "waiting", "recent", "parked", "elsewhere", "sams", "nope"]);
const partAll = [...some.todo, ...some.doing, ...some.blocked, ...some.done];
t("?tasks= answers only the tasks named, on the poles the whole read puts them", keys(some.todo) === "waiting" && keys(some.doing) === "claimed" && some.doing[0].live && keys(some.done) === "recent" && some.blocked.length === 0);
t("?tasks= says the same of a task as the whole read", JSON.stringify(some.doing[0]) === JSON.stringify(wired.doing[0]) && JSON.stringify(some.todo[0]) === JSON.stringify(wired.todo[0]));
t("?tasks= leaves out backlog, other people's, boards sam isn't on and unknown ids", partAll.length === 3);
t("?tasks= echoes what it was asked, once each, and the done limit", some.tasks.length === 7 && some.doneLimit === 20 && wired.doneLimit === 20);
t("a task says its stage and rank, for re-sorting", wired.todo[0]?.stage === 1 && typeof wired.todo[0]?.rank === "number" && wired.blocked[0]?.stage === 3);
const refused = async (q: string) => {
  try {
    await getWired(env, sam, new URL(`http://x/api/wired?tasks=${q}`));
    return false;
  } catch (e) {
    return (e as { status?: number }).status === 400;
  }
};
t("?tasks= naming nothing is refused", await refused(""));
t(`?tasks= naming more than ${MAX_TASKS} is refused`, await refused(Array.from({ length: MAX_TASKS + 1 }, (_, i) => `t${i}`).join(",")));

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} wired checks passed`);
if (failed) process.exit(1);
