/* ============================================================================
   A board's read: what it holds and what it leaves to the paged history
   (src/worker/repo/tasks.ts boardTasks and closedTasks, COPL-150).
   ----------------------------------------------------------------------------
   Run: npm run check. The everyday read has the open tasks, the ones closed
   in the last RECENT_CLOSED_DAYS, and the tasks those name as parent (up the
   tree) or depend on, and says whether it left older ones out; the paged
   read has every older closed task once, newest first. What hangs off each
   task comes from grouped queries and must be what was written, and a
   parent's progress, counted in SQL, must be what domain/tasks.ts progress()
   counts over the whole board, closed tasks of any age included.
   ========================================================================== */

import type { SQLInputValue } from "node:sqlite";
import { d1, sqlite } from "./worker.ts";

const { boardTasks, closedTasks, findTask } = await import("../src/worker/repo/tasks.ts");
const { progress, RECENT_CLOSED_DAYS } = await import("../src/domain/tasks.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const db = sqlite();
const insert = (table: string, row: Record<string, SQLInputValue>) => {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(row));
};
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam'), ('kim', 'kim@x.test', 'kim');
  INSERT INTO users (id, email, handle, kind, owner_id) VALUES ('dev', 'dev@agents.invalid', 'sam/dev', 'agent', 'sam');
  INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash) VALUES ('tok', 'dev', 'personal', 'box', 'write', 'h');
  INSERT INTO boards (id, key, name, is_inbox, has_planning, created_by) VALUES ('b', 'BB', 'b', 0, 1, 'sam'), ('o', 'OO', 'o', 0, 0, 'sam');
  INSERT INTO board_repos (id, board_id, repo, connected_by, created_at) VALUES ('repo', 'b', 'sam/b', 'sam', '2026-01-01T00:00:00.000Z');
  INSERT INTO labels (id, board_id, name) VALUES ('l1', 'b', 'one'), ('l2', 'b', 'two');
  INSERT INTO runs (id, user_id, token_id, token_hash, client, status, started_at, last_seen_at)
    VALUES ('run', 'dev', 'tok', 'h-run', 'claude-code', 'running', '2026-10-05T11:00:00.000Z', '2026-10-05T11:59:00.000Z');
`);
const categories = ["backlog", "todo", "active", "blocked", "done", "cancelled"] as const;
type Category = (typeof categories)[number];
for (const board of ["b", "o"]) {
  categories.forEach((category, position) => insert("stages", { id: `${board}-${category}`, board_id: board, position, name: category, category }));
}

let number = 0;
/** A task on board b: open when `closed` is undefined, else closed that many days ago. */
function task(id: string, category: Category, o: { closed?: number; parent?: string; level?: string; deleted?: boolean; rank?: number } = {}) {
  number++;
  insert("tasks", {
    id,
    board_id: "b",
    number,
    title: id,
    stage_id: `b-${category}`,
    rank: o.rank ?? number,
    completed_at: o.closed === undefined ? null : ago(o.closed),
    parent_id: o.parent ?? null,
    level: o.level ?? "task",
    created_by: "sam",
    deleted_at: o.deleted ? ago(1) : null,
  });
}

/* An open epic whose work is mostly long done: progress has to count what the read leaves out. */
task("epic", "active", { level: "epic" });
task("story", "done", { closed: 90, parent: "epic", level: "story" });
task("s1", "done", { closed: 91, parent: "story" });
task("s2", "cancelled", { closed: 92, parent: "story" });
task("e1", "done", { closed: 100, parent: "epic" });
task("e2", "done", { closed: 3, parent: "epic" });
task("e3", "todo", { parent: "epic" });
task("m", "done", { closed: 200, parent: "epic", level: "milestone" });
task("gone", "done", { closed: 2, parent: "epic", deleted: true });
/* A recent task under an old epic under an older one: both come along, so its parent chain resolves. */
task("old-top", "done", { closed: 400, level: "epic" });
task("old-epic", "done", { closed: 300, parent: "old-top", level: "epic" });
task("late", "done", { closed: 1, parent: "old-epic" });
/* An open task waiting on an old one: the old one comes along, and nothing it depends on does. */
task("dep-old", "done", { closed: 60 });
task("dep-older", "done", { closed: 61 });
task("waits", "todo");
insert("task_dependencies", { task_id: "waits", depends_on_id: "dep-old" });
insert("task_dependencies", { task_id: "dep-old", depends_on_id: "dep-older" });
/* Plain history, two of them closed at the same moment. */
for (let i = 0; i < 7; i++) task(`h${i}`, i % 3 ? "done" : "cancelled", { closed: 20 + i });
task("tie-a", "done", { closed: 50 });
task("tie-b", "done", { closed: 50 });
/* Right at the line: one just inside the window, one just outside. */
task("inside", "done", { closed: RECENT_CLOSED_DAYS - 0.01 });
task("outside", "done", { closed: RECENT_CLOSED_DAYS + 0.01 });
/* A loop of parents, and work in it. */
task("la", "active");
task("lb", "active", { parent: "la" });
task("lc", "active", { parent: "lb" });
db.exec(`UPDATE tasks SET parent_id = 'lc' WHERE id = 'la'`);
task("ld", "done", { closed: 30, parent: "lc" });
/* Everything that hangs off a task. */
task("rich", "active", { rank: 0.5 });
insert("task_assignees", { task_id: "rich", user_id: "sam" });
insert("task_assignees", { task_id: "rich", user_id: "dev" });
insert("task_labels", { task_id: "rich", label_id: "l2" });
insert("task_dependencies", { task_id: "rich", depends_on_id: "e3" });
for (let c = 0; c < 3; c++) insert("comments", { id: `c${c}`, task_id: "rich", author_id: "kim", text: "hi", created_at: ago(1) });
insert("task_claims", { task_id: "rich", run_id: "run", user_id: "dev", claimed_at: ago(0.05), claimed_until: "2999-01-01T00:00:00.000Z" });
insert("attachments", { id: "a1", task_id: "rich", name: "spec", kind: "link", url: "https://example.test", added_by: "sam", created_at: ago(1) });
insert("task_code", { id: "k1", task_id: "rich", repo_id: "repo", kind: "pull", name: "7", title: "x", url: "https://github.test/p", state: "open", ref: "closes", updated_at: ago(0) });
insert("task_files", { task_id: "rich", run_id: "run", base: "abc", files: JSON.stringify(["src/a.ts", "src/b.ts"]), reported_at: ago(0) });
insert("task_files", { task_id: "e3", base: "abc", files: JSON.stringify(["src/a.ts"]), reported_at: ago(0) });
insert("task_files", { task_id: "e2", base: "abc", files: JSON.stringify(["src/a.ts"]), reported_at: ago(0) });
/* Another board's tasks never show. */
insert("tasks", { id: "other", board_id: "o", number: 1, title: "other", stage_id: "o-todo", rank: 0, created_by: "sam" });

const D1 = d1(db);
const read = await boardTasks(D1, "b", NOW);
const ids = read.tasks.map((x) => x.id);
const has = (id: string) => ids.includes(id);

/* What the everyday read holds. */
t("open tasks are in it", ["epic", "e3", "waits", "la", "lb", "lc", "rich"].every(has));
t("tasks closed in the last two weeks are in it", ["e2", "late", "inside"].every(has));
t("tasks closed longer ago are not", !["s1", "s2", "story", "e1", "m", "h0", "h6", "tie-a", "outside", "ld", "dep-older"].some(has));
t("an old task an open one depends on is in it", has("dep-old"));
t("what that old task depends on is not", !has("dep-older"));
t("a recent task's old parent and its parent's parent are in it", has("old-epic") && has("old-top"));
t("deleted tasks and other boards' are not", !has("gone") && !has("other"));
t("it is in board order (rank, then number)", eq(ids, [...read.tasks].sort((a, b) => a.rank - b.rank || a.number - b.number).map((x) => x.id)));
t("it says older closed tasks were left out", read.olderClosed === true);

/* What hangs off a task, from the grouped queries. */
const rich = read.tasks.find((x) => x.id === "rich")!;
t("assignees", eq([...rich.assigneeIds].sort(), ["dev", "sam"]));
t("labels", eq(rich.labelIds, ["l2"]));
t("dependencies", eq(rich.dependsOn, ["e3"]) && eq(read.tasks.find((x) => x.id === "waits")!.dependsOn, ["dep-old"]));
t("comment count", rich.commentCount === 3 && read.tasks.find((x) => x.id === "e3")!.commentCount === 0);
t("the live claim", rich.claim?.userId === "dev" && rich.claim.runId === "run" && rich.claim.kind === "supervised");
t("no claim where there is none", read.tasks.find((x) => x.id === "e3")!.claim === null);
t("attachments", eq(rich.attachments.map((a) => a.id), ["a1"]));
t("code", eq(rich.code.map((c) => c.name), ["7"]));
t("overlap among open tasks, not with a closed one's files", eq(rich.overlap, [{ key: `BB-${read.tasks.find((x) => x.id === "e3")!.number}`, files: 1 }]));
t("a closed task overlaps nothing", eq(read.tasks.find((x) => x.id === "e2")!.overlap, []));
const alone = await findTask(D1, "rich");
t("findTask hydrates the same, without overlap", eq({ ...alone, overlap: [] }, { ...rich, overlap: [] }));
t("findTask on a deleted task is null", (await findTask(D1, "gone")) === null);

/* Progress: the domain's count over the whole board, done in SQL. */
const all = db
  .prepare(`SELECT id, parent_id AS parentId, stage_id AS stageId, coalesce(level, 'task') AS level FROM tasks WHERE board_id = 'b' AND deleted_at IS NULL`)
  .all() as Array<{ id: string; parentId: string | null; stageId: string; level: string }>;
const stages = categories.map((c) => ({ id: `b-${c}`, category: c }));
const expected = (id: string) => {
  const p = progress(all, stages, id);
  return p && { children: all.filter((x) => x.parentId === id && x.id !== id).length, ...p };
};
t("progress counts children closed long ago", eq(read.progress.epic, expected("epic")) && read.progress.epic.total === 4 && read.progress.epic.done === 3);
t("progress is on every parent in the read and only on parents", ids.every((id) => eq(read.progress[id], expected(id))));
t("a looped chain is counted once", eq(read.progress.la, expected("la")) && read.progress.la.total === 1);

/* The paged history: every older closed task once, newest first. */
const pages = [];
let before: string | null = null;
do {
  const page = await closedTasks(D1, "b", before, 2, NOW);
  pages.push(page);
  before = page.next;
} while (before !== null && pages.length < 50);
const older = pages.flatMap((p) => p.tasks);
const want = db
  .prepare(`SELECT id FROM tasks WHERE board_id = 'b' AND deleted_at IS NULL AND completed_at < ? ORDER BY completed_at DESC, rowid DESC`)
  .all(ago(RECENT_CLOSED_DAYS)) as Array<{ id: string }>;
t("pages hold every older closed task once, newest first", eq(older.map((x) => x.id), want.map((x) => x.id)));
t("tasks closed at the same moment are both paged", older.some((x) => x.id === "tie-a") && older.some((x) => x.id === "tie-b"));
t("pages are at most the limit and the last says so", pages.every((p) => p.tasks.length <= 2) && pages.at(-1)!.next === null && pages.slice(0, -1).every((p) => p.next !== null));
t("paged tasks are hydrated", older.find((x) => x.id === "story")!.level === "story" && eq(older.find((x) => x.id === "dep-old")!.dependsOn, ["dep-older"]));
t("paged parents carry their progress", eq(pages.flatMap((p) => Object.entries(p.progress)).find(([id]) => id === "story")?.[1], expected("story")));
t("a page with nothing older is empty", eq(await closedTasks(D1, "o", null, 2, NOW), { tasks: [], progress: {}, next: null }));

/* Nothing older left out. */
db.exec(`UPDATE tasks SET completed_at = '${ago(1)}' WHERE board_id = 'b' AND completed_at < '${ago(RECENT_CLOSED_DAYS)}' AND id NOT IN ('dep-old', 'old-epic', 'old-top')`);
t("old tasks it names don't count as left out", (await boardTasks(D1, "b", NOW)).olderClosed === false);
t("a board without history has nothing older", (await boardTasks(D1, "o", NOW)).olderClosed === false);

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok " : "FAIL "}  ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} board read checks passed`);
if (failed) process.exit(1);
