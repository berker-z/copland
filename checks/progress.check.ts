/* ============================================================================
   A parent's progress (src/domain/tasks.ts, progress).
   ----------------------------------------------------------------------------
   Run: npm run check. The one counting the board and the Worker both use:
   leaves done out of leaves not cancelled, worked through on a small board,
   without a database.
   ========================================================================== */

import { progress } from "../src/domain/tasks.ts";

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

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} progress checks passed`);
if (failed) process.exit(1);
