/* ============================================================================
   Waiting work hears when it can start (COPL-164): unblockedStatement in
   src/worker/repo/inbox.ts, from the task and stage routes.
   ----------------------------------------------------------------------------
   Run: npm run check. The routes run for real (checks/worker.ts) on the
   migrations in an in-memory node:sqlite. A write that closes or deletes the
   last open task a todo task depends on puts an "unblocked" item in each of
   its assignees' inboxes and tells them to refetch it; the agent that closed
   it itself hears it too. Nothing comes while another dependency is open,
   for a task in backlog, a milestone, a closed one, an assignee who left the
   board, or a write that closes nothing. A parent closing by following its
   child counts, and so do a stage turned closing and a stage deleted into a
   closing one.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { Viewer } from "../src/domain/types.ts";

const { Changes } = await import("../src/worker/live.ts");
const { deleteTask, patchTask } = await import("../src/worker/routes/tasks.ts");
const { deleteStage, patchStage } = await import("../src/worker/routes/stages.ts");
const { readInbox } = await import("../src/worker/routes/inbox.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const db = sqlite();
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam'), ('kim', 'kim@x.test', 'kim'), ('zed', 'zed@x.test', 'zed');
  INSERT INTO users (id, email, handle, kind, owner_id) VALUES ('dev', 'dev@agents.invalid', 'sam/dev', 'agent', 'sam');
  INSERT INTO agents (user_id, name, work_from) VALUES ('dev', 'dev', 'owner');
  INSERT INTO boards (id, name, key, created_by) VALUES ('b1', 'B', 'BB', 'sam');
  INSERT INTO board_members (board_id, user_id, role) VALUES ('b1', 'sam', 'owner'), ('b1', 'kim', 'editor'), ('b1', 'dev', 'editor');
  INSERT INTO stages (id, board_id, name, position, category) VALUES
    ('backlog', 'b1', 'backlog', 0, 'backlog'), ('todo', 'b1', 'todo', 1, 'todo'), ('doing', 'b1', 'doing', 2, 'active'),
    ('done', 'b1', 'done', 3, 'done'), ('dropped', 'b1', 'dropped', 4, 'cancelled');
`);
const env = { DB: d1(db) } as unknown as Parameters<typeof patchTask>[1];
const person = (id: string) => ({ id, kind: "person" as const, email: `${id}@x.test`, handle: id, avatar: null, isAdmin: false, ownerId: null });
const sam: Viewer = { user: person("sam") };
const dev: Viewer = {
  user: { id: "dev", kind: "agent", email: null, handle: "sam/dev", avatar: null, isAdmin: false, ownerId: "sam" },
  agent: { owner: person("sam"), grants: [], workFrom: "owner", description: "" },
};

let n = 0;
/** A task on b1: its stage, who it is assigned to, what it depends on, its parent and level. */
function task(stage: string, opts: { assignees?: string[]; dependsOn?: string[]; parent?: string; level?: string } = {}): string {
  const id = `t${++n}`;
  db.prepare(
    `INSERT INTO tasks (id, board_id, number, title, stage_id, parent_id, level, completed_at, created_by)
     VALUES (?1, 'b1', ?2, ?1, ?3, ?4, ?5, ?6, 'sam')`,
  ).run(id, n, stage, opts.parent ?? null, opts.level ?? "task", ["done", "dropped"].includes(stage) ? "2026-01-01T00:00:00.000Z" : null);
  for (const u of opts.assignees ?? []) db.prepare(`INSERT INTO task_assignees (task_id, user_id) VALUES (?1, ?2)`).run(id, u);
  for (const d of opts.dependsOn ?? []) db.prepare(`INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?1, ?2)`).run(id, d);
  return id;
}

/** The unblocked items, as "user:task" sorted, and who was told to refetch their inbox by the write. */
const items = () =>
  (db.prepare(`SELECT user_id, task_id FROM inbox_items WHERE kind = 'unblocked' ORDER BY user_id, task_id`).all() as { user_id: string; task_id: string }[]).map(
    (r) => `${r.user_id}:${r.task_id}`,
  );
async function write(run: (changes: InstanceType<typeof Changes>) => Promise<Response>): Promise<{ added: string[]; told: string[] }> {
  const before = new Set(items());
  const changes = new Changes();
  await run(changes);
  const told = [...changes.events(null)].filter(([, events]) => events.some((e) => e.topics.includes("inbox"))).map(([u]) => u).sort();
  return { added: items().filter((i) => !before.has(i)), told };
}
const req = (method: string, body: unknown) => new Request("https://x.test/", { method, body: JSON.stringify(body) });
const move = (viewer: Viewer, id: string, stageId: string) => write((c) => patchTask(req("PATCH", { stageId }), env, viewer, id, c));
const same = (a: string[], b: string[]) => a.join() === b.join();

/* The laptop's case: an agent's task waits on another, which a merge closes as the person who connected the repo. */
{
  const a = task("doing");
  const b = task("todo", { assignees: ["dev", "kim"], dependsOn: [a] });
  const r = await move(sam, a, "done");
  t("closing what a todo task waits on tells each of its assignees", same(r.added, [`dev:${b}`, `kim:${b}`]));
  t("and tells them to refetch their inbox", same(r.told, ["dev", "kim"]));
  const inbox = await readInbox(env, dev, { unread: true });
  const item = inbox.items.find((i) => i.kind === "unblocked");
  t("the agent reads it as an unblocked item on the task, by whoever closed it", item?.task?.id === b && item.actor.handle === "sam");
  const again = await write((c) => patchTask(req("PATCH", { title: "renamed" }), env, sam, a, c));
  t("changing a closed task again tells nobody", again.added.length === 0);
  const cancelled = await move(sam, a, "dropped");
  t("moving it from done to cancelled (still closed) tells nobody", cancelled.added.length === 0);
}

/* Two dependencies: only the last one closing frees it. */
{
  const a = task("doing");
  const c = task("todo");
  const b = task("todo", { assignees: ["dev"], dependsOn: [a, c] });
  const first = await move(sam, a, "done");
  t("while another dependency is open, nothing comes", first.added.length === 0 && first.told.length === 0);
  const last = await move(sam, c, "dropped");
  t("cancelling the last one frees it as closing does", same(last.added, [`dev:${b}`]));
}

/* The agent closes what its own next task waits on (no PR, a fast-forward). */
{
  const a = task("doing", { assignees: ["dev"] });
  const b = task("todo", { assignees: ["dev"], dependsOn: [a] });
  const r = await move(dev, a, "done");
  t("the agent that closed it itself still hears it, which is what wakes its daemon", same(r.added, [`dev:${b}`]));
}

/* What does not start by itself. */
{
  const a = task("doing");
  task("backlog", { assignees: ["dev"], dependsOn: [a] });
  task("todo", { assignees: ["dev"], dependsOn: [a], level: "milestone" });
  task("doing", { assignees: ["dev"], dependsOn: [a] });
  task("todo", { dependsOn: [a] });
  task("todo", { assignees: ["zed"], dependsOn: [a] });
  const r = await move(sam, a, "done");
  t("backlog, a milestone, work already under way, nobody assigned or an assignee off the board: nothing", r.added.length === 0);
}

/* Deleting the last open dependency frees it too; deleting a closed one changes nothing. */
{
  const a = task("todo");
  const b = task("todo", { assignees: ["kim"], dependsOn: [a] });
  const r = await write((c) => deleteTask(env, sam, a, c));
  t("deleting the last open task it waits on tells its assignees", same(r.added, [`kim:${b}`]) && same(r.told, ["kim"]));
  const shut = task("done");
  task("todo", { assignees: ["kim"], dependsOn: [shut, task("todo")] });
  const gone = await write((c) => deleteTask(env, sam, shut, c));
  t("deleting a closed one tells nobody", gone.added.length === 0);
}

/* A parent that closes by following its last child frees what waits on the parent. */
{
  const parent = task("doing", { level: "story" });
  const child = task("doing", { parent });
  const b = task("todo", { assignees: ["dev"], dependsOn: [parent] });
  const r = await move(sam, child, "done");
  const closed = (db.prepare(`SELECT completed_at FROM tasks WHERE id = ?1`).get(parent) as { completed_at: string | null }).completed_at;
  t("a parent closing with its child frees what waits on the parent", closed !== null && same(r.added, [`dev:${b}`]));
}

/* Stages that close what is in them. */
{
  db.exec(`INSERT INTO stages (id, board_id, name, position, category) VALUES ('review', 'b1', 'review', 5, 'active'), ('ship', 'b1', 'ship', 6, 'active')`);
  const a = task("review");
  const b = task("todo", { assignees: ["kim"], dependsOn: [a] });
  const r = await write((c) => patchStage(req("PATCH", { category: "done" }), env, sam, "review", c));
  t("a stage turned closing frees what waited on its tasks", same(r.added, [`kim:${b}`]) && same(r.told, ["kim"]));
  const back = await write((c) => patchStage(req("PATCH", { category: "active" }), env, sam, "review", c));
  t("turning it open again tells nobody", back.added.length === 0);
  const c2 = task("ship");
  const d = task("todo", { assignees: ["dev"], dependsOn: [c2] });
  const r2 = await write((c) => deleteStage(env, sam, "ship", new URL("https://x.test/?moveTo=done"), c));
  t("a stage deleted into a closing one frees what waited on its tasks", same(r2.added, [`dev:${d}`]) && same(r2.told, ["dev"]));
}

/* --------------------------------------------------------------- report -- */

const failed = cases.filter(([, pass]) => !pass);
for (const [name, pass] of cases) if (!pass) console.error(`FAIL ${name}`);
console.log(`${cases.length - failed.length}/${cases.length} unblocked checks passed`);
if (failed.length) process.exit(1);
