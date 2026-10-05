/* ============================================================================
   Live events that say which board and tasks changed (COPL-151).
   ----------------------------------------------------------------------------
   Run: npm run check. planBoard (src/domain/live.ts) on its own; then the
   routes for real (checks/worker.ts) on the migrations in an in-memory
   node:sqlite, collecting their events with the Worker's own Changes; then
   a tab's side, lib/boardPatch.ts on a real QueryClient, reading tasks and
   whole boards through those same routes. A burst of task writes patches
   the named tasks in and reads nothing else; a skipped version, a delete,
   anything without its tasks reads the board whole; and the tab ends with
   the board as the server has it.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { BoardDetail, Task, Viewer } from "../src/domain/types.ts";
import type { BoardChange, LiveEvent } from "../src/domain/live.ts";

const { planBoard, PATCH_LIMIT } = await import("../src/domain/live.ts");
const { progress } = await import("../src/domain/tasks.ts");
const { Changes } = await import("../src/worker/live.ts");
const { HttpError } = await import("../src/worker/http.ts");
const { getBoard } = await import("../src/worker/routes/boards.ts");
const { deleteTask, getTask, patchTask, postTask } = await import("../src/worker/routes/tasks.ts");
const { postComment } = await import("../src/worker/routes/comments.ts");
const { deleteClaim } = await import("../src/worker/routes/runs.ts");
const { applyBoardEvents } = await import("../src/lib/boardPatch.ts");
const { QueryClient } = await import("@tanstack/react-query");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

/* ------------------------------------------------------------ planBoard -- */

const ev = (version: number | undefined, tasks?: string[]): BoardChange => ({
  board: "b",
  ...(version === undefined ? {} : { version }),
  ...(tasks ? { tasks } : {}),
});
t("the next version, naming its tasks, patches them", JSON.stringify(planBoard(4, [ev(5, ["a"])])) === JSON.stringify({ kind: "patch", tasks: ["a"], version: 5 }));
t("a run of versions with no gap patches them all, in any order", (() => {
  const p = planBoard(4, [ev(6, ["b"]), ev(5, ["a"]), ev(7, ["a"])]);
  return p.kind === "patch" && p.version === 7 && p.tasks.sort().join() === "a,b";
})());
t("a skipped version reads the board whole", planBoard(4, [ev(6, ["a"])]).kind === "whole");
t("a gap inside a run reads it whole", planBoard(4, [ev(5, ["a"]), ev(7, ["b"])]).kind === "whole");
t("the same version twice reads it whole", planBoard(4, [ev(5, ["a"]), ev(5, ["b"])]).kind === "whole");
t("an event the board already has does nothing", planBoard(5, [ev(4, ["a"]), ev(5, ["b"])]).kind === "none");
t("old ones are dropped, the new rest patched", (() => {
  const p = planBoard(5, [ev(5, ["a"]), ev(6, ["b"])]);
  return p.kind === "patch" && p.tasks.join() === "b";
})());
t("no version (an older Worker, or a write that doesn't bump) reads it whole", planBoard(4, [ev(undefined, ["a"])]).kind === "whole");
t("no tasks (stages, labels, a delete) reads it whole", planBoard(4, [ev(5)]).kind === "whole");
t("a board held without a version reads it whole", planBoard(undefined, [ev(5, ["a"])]).kind === "whole");
t(`more than ${PATCH_LIMIT} tasks reads it whole`, planBoard(0, [ev(1, Array.from({ length: PATCH_LIMIT + 1 }, (_, i) => `t${i}`))]).kind === "whole");
t(`${PATCH_LIMIT} tasks is still a patch`, planBoard(0, [ev(1, Array.from({ length: PATCH_LIMIT }, (_, i) => `t${i}`))]).kind === "patch");

/* -------------------------------------------------------------- Changes -- */

{
  const c = new Changes();
  c.notify(["sam"], "inbox");
  c.board(["sam", "kim"], { board: "b", version: 3, tasks: ["a"], assignees: ["dev"] });
  c.board(["sam"], { board: "c", version: 9, tasks: ["z"] }, "boards");
  const out = c.events("tab1");
  const sam = out.get("sam") ?? [];
  const kim = out.get("kim") ?? [];
  t("one event per board a user hears about", sam.length === 2 && kim.length === 1);
  t("the first carries every topic, the rest only the board", sam[0].topics.sort().join() === "board,boards,inbox" && sam[1].topics.join() === "board");
  t("each says its board, version and tasks", sam[0].board === "b" && sam[0].version === 3 && sam[0].tasks?.join() === "a" && sam[1].board === "c");
  t("and the tab that made it", sam.every((e) => e.tab === "tab1"));
  const m = new Changes();
  m.board(["sam"], { board: "b", version: 3, tasks: ["a"], assignees: ["x"] });
  m.board(["sam"], { board: "b", version: 4, tasks: ["b"], assignees: ["y"] });
  const [merged] = m.events(null).get("sam") ?? [];
  t("two writes to one board in a request: tasks joined, the version dropped (a whole read)", merged.tasks?.join() === "a,b" && merged.version === undefined && merged.assignees?.join() === "x,y");
  const w = new Changes();
  w.board(["sam"], { board: "b", version: 3, tasks: ["a"] });
  w.board(["sam"], { board: "b" });
  t("one of them without tasks: the merge has none", (w.events(null).get("sam") ?? [])[0].tasks === undefined);
  const plain = new Changes();
  plain.notify(["sam"], "settings");
  t("no board: one event, topics only, as before", JSON.stringify(plain.events(null).get("sam")) === JSON.stringify([{ topics: ["settings"], tab: null }]));
}

/* --------------------------------------------------------------- routes -- */

const db = sqlite();
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam'), ('kim', 'kim@x.test', 'kim');
  INSERT INTO users (id, email, handle, kind, owner_id) VALUES ('dev', 'dev@agents.invalid', 'sam/dev', 'agent', 'sam');
  INSERT INTO agents (user_id, name, work_from) VALUES ('dev', 'dev', 'members');
  INSERT INTO boards (id, name, key, created_by) VALUES ('b1', 'B', 'BB', 'sam');
  INSERT INTO board_members (board_id, user_id, role) VALUES ('b1', 'sam', 'owner'), ('b1', 'kim', 'editor'), ('b1', 'dev', 'editor');
  INSERT INTO stages (id, board_id, name, position, category) VALUES
    ('todo', 'b1', 'todo', 0, 'todo'), ('doing', 'b1', 'doing', 1, 'active'), ('done', 'b1', 'done', 2, 'done');
`);
const env = { DB: d1(db) } as unknown as Parameters<typeof postTask>[1];
const who = (id: string): Viewer => ({ user: { id, kind: "person", email: `${id}@x.test`, handle: id, avatar: null, isAdmin: false, ownerId: null } });
const sam = who("sam");
const kim = who("kim");

/** Run a write as `viewer` and answer what kim's tabs hear of it. */
async function heard(write: (changes: InstanceType<typeof Changes>) => Promise<Response>): Promise<{ body: Record<string, unknown>; events: LiveEvent[] }> {
  const changes = new Changes();
  const response = await write(changes);
  return { body: (await response.json()) as Record<string, unknown>, events: changes.events(null).get("kim") ?? [] };
}
const req = (method: string, body: unknown) => new Request("https://x.test/", { method, body: JSON.stringify(body) });
const boardRead = async () => (await (await getBoard(env, sam, "b1")).json()) as BoardDetail;
const version = () => (db.prepare(`SELECT version FROM boards WHERE id = 'b1'`).get() as { version: number }).version;

t("a new board reads at version 0", (await boardRead()).version === 0);

const epic = await heard((c) => postTask(req("POST", { title: "epic", level: "story" }), env, sam, "b1", c));
const epicId = epic.body.id as string;
t("a new task: kim hears it on its board, at the version it made", epic.events.length === 1 && epic.events[0].board === "b1" && epic.events[0].version === 1);
t("naming the task", epic.events[0].tasks?.includes(epicId) === true);
t("and the boards list, whose counts it changes", epic.events[0].topics.includes("boards"));

/* What kim's tab holds from here: the board at version 1. */
const tab = new QueryClient();
const key = ["board", "b1"];
tab.setQueryData(key, await boardRead());
const whole: string[] = [];
const realInvalidate = tab.invalidateQueries.bind(tab);
tab.invalidateQueries = ((filters?: { queryKey?: unknown[] }) => {
  if (JSON.stringify(filters?.queryKey) === JSON.stringify(key)) whole.push("board");
  return realInvalidate(filters);
}) as typeof tab.invalidateQueries;
/* A whole read is the route again, as the refetch would be. */
const readWhole = async () => {
  if (whole.length) tab.setQueryData(key, await boardRead());
};
const reads: string[] = [];
const fetchTask = async (id: string): Promise<Task | null> => {
  reads.push(id);
  try {
    return (await (await getTask(env, kim, id)).json()) as Task;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
};
const held = () => tab.getQueryData<BoardDetail>(key)!;
const apply = (events: LiveEvent[], hidden = false) =>
  applyBoardEvents(
    tab,
    fetchTask,
    "b1",
    events.filter((e) => e.board === "b1").map(({ topics: _t, tab: _b, ...change }) => change as BoardChange),
    hidden,
  );
const same = (a: BoardDetail, b: BoardDetail) =>
  JSON.stringify(a.tasks.map((x) => [x.id, x.stageId, x.title, x.assigneeIds, x.commentCount]).sort()) ===
  JSON.stringify(b.tasks.map((x) => [x.id, x.stageId, x.title, x.assigneeIds, x.commentCount]).sort());

t("the tab holds version 1", held().version === 1);

/* A child under the epic: the parent's progress follows without a whole read. */
const child = await heard((c) => postTask(req("POST", { title: "child", parentId: epicId, stageId: "doing" }), env, kim, "b1", c));
const childId = child.body.id as string;
t("a child names itself and its parent (which moved with it)", ["b1"].includes(child.events[0].board ?? "") && child.events[0].tasks?.includes(childId) === true && child.events[0].tasks?.includes(epicId) === true);
await apply(child.events);
t("the tab patched them in without reading the board", whole.length === 0 && reads.includes(childId));
t("the child is in the cached board", held().tasks.some((x) => x.id === childId));
t("the parent's progress counts it", progress(held().tasks, held().stages, epicId)?.total === 1);
t("the parent moved to doing with its child, on the tab too", held().tasks.find((x) => x.id === epicId)?.stageId === "doing");
t("the tab holds the version the event said", held().version === version());
t("and matches the server", same(held(), await boardRead()));

/* Edits: an assignee, a comment, a release with nothing to let go. */
const assigned = await heard((c) => patchTask(req("PATCH", { assigneeIds: ["dev"] }), env, sam, childId, c));
t("an assignee change names who is on it now", assigned.events[0].assignees?.includes("dev") === true);
t("an edit that moves no stage leaves the boards list alone", !assigned.events[0].topics.includes("boards"));
const unassigned = await heard((c) => patchTask(req("PATCH", { assigneeIds: [] }), env, sam, childId, c));
t("and who was on it before", unassigned.events[0].assignees?.includes("dev") === true);
const said = await heard((c) => postComment(req("POST", { text: "hi" }), env, sam, childId, c));
t("a comment names its task, at the next version", said.events[0].tasks?.join() === childId && said.events[0].version === version());
const before = version();
let refused = false;
try {
  await deleteClaim(env, sam, childId, new Changes());
} catch (error) {
  refused = error instanceof HttpError && error.status === 404;
}
t("releasing a claim nobody holds is refused and leaves no gap in the versions", refused && version() === before);
reads.length = 0;
await apply([...assigned.events, ...unassigned.events, ...said.events]);
t("three writes in one burst: one patch, one read of the task", whole.length === 0 && reads.join() === childId);
t("the comment count shows", held().tasks.find((x) => x.id === childId)?.commentCount === 1);
t("still the server's board", same(held(), await boardRead()) && held().version === version());

/* Closing it: the boards list hears. */
const closed = await heard((c) => patchTask(req("PATCH", { stageId: "done" }), env, kim, childId, c));
t("a new stage tells the boards list", closed.events[0].topics.includes("boards"));
await apply(closed.events);
t("closing patches too (no code on this board)", whole.length === 0 && held().tasks.find((x) => x.id === childId)?.stageId === "done");
t("and its parent followed it to done", held().tasks.find((x) => x.id === epicId)?.stageId === "done" && same(held(), await boardRead()));

/* An event the tab already has: nothing. */
reads.length = 0;
await apply(closed.events);
t("an event heard twice is nothing", whole.length === 0 && reads.length === 0);

/* Delete one and create another in the same burst: the count doesn't change, the content does. */
const doomed = await heard((c) => postTask(req("POST", { title: "doomed" }), env, sam, "b1", c));
await apply(doomed.events);
const doomedId = doomed.body.id as string;
const gone = await heard((c) => deleteTask(env, sam, doomedId, c));
const born = await heard((c) => postTask(req("POST", { title: "born" }), env, sam, "b1", c));
t("a delete names no tasks and tells the boards list", gone.events[0].tasks === undefined && gone.events[0].topics.includes("boards"));
await apply([...gone.events, ...born.events]);
t("a delete in the burst reads the board whole", whole.length === 1);
await readWhole();
whole.length = 0;
t("after which the tab has the new task and not the deleted one", held().tasks.some((x) => x.title === "born") && !held().tasks.some((x) => x.id === doomedId));
t("and is the server's board again, at its version", same(held(), await boardRead()) && held().version === version());

/* A task that 404s when fetched (gone since the event) is dropped. */
{
  const ghost = await heard((c) => postTask(req("POST", { title: "ghost" }), env, sam, "b1", c));
  await apply(ghost.events);
  const ghostId = ghost.body.id as string;
  db.prepare(`UPDATE tasks SET deleted_at = '2026-01-01' WHERE id = ?`).run(ghostId);
  const touch = await heard((c) => patchTask(req("PATCH", { title: "touched" }), env, sam, childId, c));
  /* The same event as if it had named the ghost too. */
  await apply(touch.events.map((e) => ({ ...e, tasks: [...(e.tasks ?? []), ghostId] })));
  t("a named task that is gone (404) is dropped from the board", whole.length === 0 && !held().tasks.some((x) => x.id === ghostId));
  t("and the others patched", held().tasks.find((x) => x.id === childId)?.title === "touched");
}

/* A skipped version: whole. */
{
  const missed = await heard((c) => patchTask(req("PATCH", { title: "missed" }), env, sam, childId, c));
  const next = await heard((c) => patchTask(req("PATCH", { title: "next" }), env, sam, childId, c));
  void missed;
  reads.length = 0;
  await apply(next.events);
  t("an event after a missed one reads the board whole, and no task", whole.length === 1 && reads.length === 0);
  await readWhole();
  whole.length = 0;
  t("which puts it right", held().tasks.find((x) => x.id === childId)?.title === "next" && held().version === version());
}

/* A hidden tab fetches nothing. */
{
  const later = await heard((c) => patchTask(req("PATCH", { title: "later" }), env, sam, childId, c));
  reads.length = 0;
  await apply(later.events, true);
  t("a hidden tab marks the board stale and reads no task", whole.length === 1 && reads.length === 0);
  whole.length = 0;
}

/* --------------------------------------------------------------- report -- */

const failed = cases.filter(([, pass]) => !pass);
for (const [name, pass] of cases) if (!pass) console.error(`FAIL ${name}`);
console.log(`${cases.length - failed.length}/${cases.length} board event checks passed`);
if (failed.length) process.exit(1);
