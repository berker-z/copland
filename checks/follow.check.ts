/* ============================================================================
   Parents follow their children (src/domain/tasks.ts, followUp).
   ----------------------------------------------------------------------------
   Run: npm run check. The rule the Worker applies in the same write as a
   task change, and the browser applies to its cache: worked through on a
   small board, without a database.
   ========================================================================== */

import { followUp } from "../src/domain/tasks.ts";

type Cat = "backlog" | "todo" | "active" | "blocked" | "done" | "cancelled";
const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

/* A board like COPL's: no cancelled stage. */
const COPL = (["backlog", "todo", "active", "blocked", "done"] as Cat[]).map((c) => ({ id: c, category: c }));
const FULL = (["backlog", "todo", "active", "blocked", "done", "cancelled"] as Cat[]).map((c) => ({ id: c, category: c }));

interface T {
  id: string;
  parentId: string | null;
  stageId: string;
}
const task = (id: string, parentId: string | null, stageId: string): T => ({ id, parentId, stageId });

/** Moves as "id:to" in order, after `child` changed. */
function run(tasks: T[], child: string, stages = FULL, extra: Array<{ parentId: string | null; childId: string }> = []) {
  const parentId = tasks.find((x) => x.id === child)?.parentId ?? null;
  return followUp(tasks, stages, [{ parentId, childId: child }, ...extra])
    .map((m) => `${m.id}:${m.to}`)
    .join(" ");
}

/* epic E > story S > tasks a, b */
const chain = (e: string, s: string, a: string, b: string) => [
  task("E", null, e),
  task("S", "E", s),
  task("a", "S", a),
  task("b", "S", b),
];

t("a task going active takes its story and epic with it", run(chain("todo", "todo", "active", "todo"), "a") === "S:active E:active");
t("blocked counts as under way", run(chain("backlog", "backlog", "blocked", "todo"), "a") === "S:active E:active");
t("a parent already active is left alone", run(chain("active", "active", "active", "todo"), "a") === "");
t("a parent blocked by hand is not pulled back to active", run(chain("blocked", "blocked", "active", "todo"), "a") === "");
t("everything delivered closes story and epic", run(chain("active", "active", "done", "done"), "a") === "S:done E:done");
t("one child still ready holds the parent open", run(chain("active", "active", "done", "todo"), "a") === "");
t("a parked child does not hold the parent open", run(chain("active", "active", "done", "backlog"), "a") === "S:done E:done");
t("the parked child stays where it is", followUp(chain("active", "active", "done", "backlog"), FULL, [{ parentId: "S", childId: "a" }]).every((m) => m.id !== "b"));
t("only parked children: the parent is left alone", run(chain("todo", "todo", "backlog", "backlog"), "a") === "");
t("done plus cancelled closes as done", run(chain("active", "active", "done", "cancelled"), "a") === "S:done E:done");
t("all cancelled leaves the parent alone", run(chain("active", "active", "cancelled", "cancelled"), "a") === "");
t("a cancelled parent stays cancelled when the rest is done", run(chain("active", "cancelled", "done", "done"), "a") === "");
t("a reopened child going active reopens story and epic", run(chain("done", "done", "active", "done"), "a") === "S:active E:active");
t("a child back in todo under a done parent reopens it to todo", run(chain("done", "done", "todo", "done"), "a") === "S:todo E:todo");
t("a parked child under a done parent leaves it done", run(chain("done", "done", "backlog", "done"), "a") === "");
t("a todo child does not pull a parked parent into todo", run(chain("backlog", "backlog", "todo", "todo"), "a") === "");
t("a parent whose children are all todo is not demoted from active", run(chain("active", "active", "todo", "todo"), "a") === "");
t("a board without the stage a rule needs leaves the parent", run(chain("active", "active", "done", "done"), "a", COPL.filter((s) => s.category !== "done")) === "");
t("a board without cancelled (COPL) still closes on done", run(chain("active", "active", "done", "done"), "a", COPL) === "S:done E:done");
t("a parent with no children left is left alone", followUp([task("P", null, "active")], FULL, [{ parentId: "P", childId: "gone" }]).length === 0);
t("no parent, nothing to do", run([task("a", null, "active")], "a") === "");

/* Reparenting: the old parent loses its last open child, the new one gains an active one. */
{
  const tasks = [task("old", null, "active"), task("new", null, "todo"), task("x", "old", "done"), task("a", "new", "active")];
  const moves = followUp(tasks, FULL, [
    { parentId: "old", childId: "a" },
    { parentId: "new", childId: "a" },
  ]).map((m) => `${m.id}:${m.to}`).join(" ");
  t("reparenting re-checks both the old and the new parent", moves === "old:done new:active");
}

/* Loops in the parent chain end, and settle. */
{
  const loop = [task("A", "B", "todo"), task("B", "A", "todo"), task("c", "A", "active")];
  const moves = followUp(loop, FULL, [{ parentId: "A", childId: "c" }]);
  t("a parent loop ends", moves.length <= 2 && moves.every((m) => m.to === "active"));
  const self = [task("A", "A", "todo")];
  t("a task that is its own parent ends", followUp(self, FULL, [{ parentId: "A", childId: "A" }]).length === 0);
  const ring = Array.from({ length: 50 }, (_, i) => task(`r${i}`, `r${(i + 1) % 50}`, i % 2 ? "done" : "todo"));
  t("a long ring ends", followUp(ring, FULL, [{ parentId: "r1", childId: "r0" }]).length < 1000);
}

/* The input is not touched. */
{
  const tasks = chain("todo", "todo", "active", "todo");
  followUp(tasks, FULL, [{ parentId: "S", childId: "a" }]);
  t("followUp does not change the tasks it is given", tasks[0].stageId === "todo" && tasks[1].stageId === "todo");
}

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} parent-follows-children checks passed`);
if (failed) process.exit(1);
