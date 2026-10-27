/* ============================================================================
   A parent's progress (src/domain/tasks.ts, progress).
   ----------------------------------------------------------------------------
   Run: npm run check. The one counting the board and the Worker both use:
   leaves done out of leaves not cancelled, worked through on a small board,
   without a database. Then what the Worker reads, task_rollup
   (migrations/0038_task_rollup.sql), kept by triggers on every write: on the
   migrations in node:sqlite, a few hundred random writes of every kind that
   moves it, each followed by every parent's stored row checked against
   progress() and against its subtree's runs summed afresh.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import { progress } from "../src/domain/tasks.ts";

const { progressFor } = await import("../src/worker/repo/tasks.ts");

type Cat = "backlog" | "todo" | "active" | "blocked" | "done" | "cancelled";
const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const STAGES = (["backlog", "todo", "active", "blocked", "done", "cancelled"] as Cat[]).map((c) => ({ id: c, category: c }));

interface T {
  id: string;
  parentId: string | null;
  stageId: string;
  level: string;
}
const task = (id: string, parentId: string | null, stageId: string, level = "task"): T => ({ id, parentId, stageId, level });

/** "done/total", or "none" for undefined. */
function count(tasks: T[], root: string) {
  const p = progress(tasks, STAGES, root);
  return p ? `${p.done}/${p.total}` : "none";
}

t("a task with no children has no progress", count([task("A", null, "todo")], "A") === "none");
t("an unknown task has no progress", count([task("A", null, "todo")], "Z") === "none");

const flat = [task("S", null, "active", "story"), task("a", "S", "done"), task("b", "S", "active"), task("c", "S", "backlog")];
t("flat children: done out of all", count(flat, "S") === "1/3");

/* epic E > stories S1 (a, b), S2 (c), and a task d straight under the epic */
const nested = [
  task("E", null, "active", "epic"),
  task("S1", "E", "done", "story"),
  task("a", "S1", "done"),
  task("b", "S1", "todo"),
  task("S2", "E", "active", "story"),
  task("c", "S2", "done"),
  task("d", "E", "todo"),
];
t("an epic counts the tasks under its stories, not the stories", count(nested, "E") === "2/4");
t("a story counts its own tasks", count(nested, "S1") === "1/2");
t("a leaf has no progress", count(nested, "a") === "none");
t("a story without children counts as a leaf", count([...nested, task("S3", "E", "done", "story")], "E") === "3/5");

t("cancelled leaves are left out", count([...flat, task("x", "S", "cancelled")], "S") === "1/3");
t("all cancelled is 0/0", count([task("S", null, "active"), task("a", "S", "cancelled"), task("b", "S", "cancelled")], "S") === "0/0");
t("a milestone child is not counted", count([...flat, task("m", "S", "done", "milestone"), task("n", "S", "todo", "milestone")], "S") === "1/3");
t("only a milestone child is 0/0", count([task("S", null, "active"), task("m", "S", "done", "milestone")], "S") === "0/0");

/* A loop: a > b > c > a, with a leaf d under c. */
const loop = [task("a", "c", "active"), task("b", "a", "active"), task("c", "b", "active"), task("d", "c", "done")];
t("a looped chain ends and counts its leaves once", count(loop, "a") === "1/1");
t("a task that is its own parent ends", count([task("a", "a", "active"), task("b", "a", "done")], "a") === "1/1");

/* The input is not touched. */
{
  const tasks = nested.map((x) => ({ ...x }));
  progress(tasks, STAGES, "E");
  t("progress does not change the tasks it is given", JSON.stringify(tasks) === JSON.stringify(nested));
}

/* ------------------------------------------------- the stored rollup --- */

const db = sqlite();
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam');
  INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash) VALUES ('tk', 'sam', 'personal', 'box', 'write', 'h');
  INSERT INTO boards (id, name, key, created_by) VALUES ('b', 'B', 'BB', 'sam');
`);
STAGES.forEach((s, i) => db.prepare(`INSERT INTO stages (id, board_id, name, position, category) VALUES (?, 'b', ?, ?, ?)`).run(s.id, s.id, i, s.category));
const DB = d1(db);

/* A small seeded generator, so a failure comes back the same way. */
let state = 208;
const rand = (n: number) => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0), (state >>> 8) % n);
const pick = <X>(xs: X[]) => xs[rand(xs.length)];

interface Row extends T {
  deleted: boolean;
}
const rows = () =>
  (db.prepare(`SELECT id, parent_id, stage_id, level, deleted_at FROM tasks`).all() as Array<Record<string, string | null>>).map(
    (r): Row => ({ id: r.id!, parentId: r.parent_id, stageId: r.stage_id!, level: r.level ?? "task", deleted: r.deleted_at !== null }),
  );

/** What a task's subtree's runs (with its own) sum to, walked afresh over live tasks. */
function runsUnder(all: Row[], root: string) {
  const ids = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of all) if (!t.deleted && t.parentId && ids.has(t.parentId) && !ids.has(t.id)) (ids.add(t.id), (grew = true));
  }
  const runs = db.prepare(`SELECT task_id, input_tokens, cost_usd FROM runs WHERE input_tokens IS NOT NULL`).all() as Array<{ task_id: string | null; input_tokens: number; cost_usd: number | null }>;
  const mine = runs.filter((r) => r.task_id && ids.has(r.task_id));
  return { runs: mine.length, input: mine.reduce((n, r) => n + r.input_tokens, 0), cost: mine.reduce((n, r) => n + (r.cost_usd ?? 0), 0) };
}

/** Every task's stored progress against progress() and its runs: the first that differs, or null. */
async function mismatch(): Promise<string | null> {
  const all = rows();
  const live = all.filter((t) => !t.deleted);
  const stored = await progressFor(DB, live.map((t) => t.id));
  for (const t of live) {
    const want = progress(live, STAGES, t.id);
    const got = stored[t.id];
    const children = live.filter((c) => c.parentId === t.id).length;
    if (!want !== !got) return `${t.id}: progress ${JSON.stringify(want)} but stored ${JSON.stringify(got)}`;
    if (want && got && (want.done !== got.done || want.total !== got.total || got.children !== children)) {
      return `${t.id}: ${want.done}/${want.total} with ${children} children, stored ${got.done}/${got.total} with ${got.children}`;
    }
    if (got) {
      const spent = runsUnder(all, t.id);
      const runs = got.spent?.runs ?? 0;
      const input = got.spent?.inputTokens ?? 0;
      if (runs !== spent.runs || input !== spent.input || Math.abs((got.spent?.costUsd ?? 0) - spent.cost) > 1e-6) {
        return `${t.id}: ${spent.runs} runs, ${spent.input} tokens in, but stored ${runs} and ${input}`;
      }
    }
  }
  return null;
}

let tasks = 0;
let runs = 0;
const live = () => rows().filter((t) => !t.deleted);
/** A parent for `id` that wouldn't put it inside itself, or null. */
function parentFor(id: string | null): string | null {
  const all = live();
  const under = new Set(id ? [id] : []);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of all) if (t.parentId && under.has(t.parentId) && !under.has(t.id)) (under.add(t.id), (grew = true));
  }
  const options = all.filter((t) => !under.has(t.id));
  return options.length && rand(4) ? pick(options).id : null;
}
const levels = ["task", "task", "task", "story", "epic", "milestone"];
const writes: Array<[string, () => void]> = [
  ["add a task", () => {
    tasks++;
    db.prepare(`INSERT INTO tasks (id, board_id, number, title, stage_id, rank, parent_id, level, created_by) VALUES (?, 'b', ?, 't', ?, ?, ?, ?, 'sam')`)
      .run(`t${tasks}`, tasks, pick(STAGES).id, tasks, parentFor(null), pick(levels));
  }],
  ["move a task", () => {
    const t = pick(live());
    if (t) db.prepare(`UPDATE tasks SET stage_id = ? WHERE id = ?`).run(pick(STAGES).id, t.id);
  }],
  ["change a level", () => {
    const t = pick(live());
    if (t) db.prepare(`UPDATE tasks SET level = ? WHERE id = ?`).run(pick(levels), t.id);
  }],
  ["reparent a task", () => {
    const t = pick(live());
    if (t) db.prepare(`UPDATE tasks SET parent_id = ? WHERE id = ?`).run(parentFor(t.id), t.id);
  }],
  /* As DELETE /api/tasks/:id does it: deleted, and its children let go. */
  ["delete a task", () => {
    const t = pick(live());
    if (!t) return;
    db.exec("BEGIN");
    db.prepare(`UPDATE tasks SET deleted_at = '2026-10-27T00:00:00.000Z' WHERE id = ?`).run(t.id);
    db.prepare(`UPDATE tasks SET parent_id = NULL WHERE parent_id = ?`).run(t.id);
    db.exec("COMMIT");
  }],
  ["report a run's usage", () => {
    const t = pick(live());
    if (!t) return;
    runs++;
    db.prepare(`INSERT INTO runs (id, user_id, token_id, token_hash, client, kind, task_id) VALUES (?, 'sam', 'tk', ?, 'claude-code', 'supervised', ?)`).run(`r${runs}`, `h${runs}`, t.id);
    db.prepare(`UPDATE runs SET input_tokens = ?, output_tokens = 1, cache_read_tokens = 0, cache_write_tokens = 0, cost_usd = ? WHERE id = ?`)
      .run(10 + rand(90), rand(3) ? rand(100) / 100 : null, `r${runs}`);
  }],
  ["forget a run", () => {
    const r = db.prepare(`SELECT id FROM runs ORDER BY random() LIMIT 1`).get() as { id: string } | undefined;
    if (r) db.prepare(`DELETE FROM runs WHERE id = ?`).run(r.id);
  }],
  ["change a stage's category", () => {
    const s = pick(STAGES);
    const to = pick(STAGES).category;
    db.prepare(`UPDATE stages SET category = ? WHERE id = ?`).run(to, s.id);
    s.category = to;
  }],
];
for (let i = 0; i < 30; i++) writes[0][1]();
const wrong: string[] = [];
const seen = new Set<string>();
for (let i = 0; i < 400 && wrong.length === 0; i++) {
  const [name, write] = pick(writes);
  write();
  seen.add(name);
  const off = await mismatch();
  if (off) wrong.push(`after ${name} (write ${i}): ${off}`);
}
for (const w of wrong) console.log(`        ${w}`);
t("the stored rollup matches progress() and the runs after every write", wrong.length === 0);
t("every kind of write was tried", seen.size === writes.length);
t("some parents were nested", live().some((x) => x.parentId && live().find((p) => p.id === x.parentId)?.parentId));

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} progress checks passed`);
if (failed) process.exit(1);
