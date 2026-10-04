/* ============================================================================
   Board access (COPL-133): requireBoard and boardsFor in src/worker/access.ts
   read membership without counting anything, and GET /api/boards is the one
   place the counts come back.
   ----------------------------------------------------------------------------
   Run: npm run check. On the migrations in an in-memory node:sqlite: an
   agent's role is the lowest of its own, its owner's and editor, a board its
   owner isn't on and a board nobody added you to are both not found, an
   agent never gets the owner role, and the counts (open tasks: not done,
   not deleted) are on the list and on nothing an access check returns.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { BoardDetail, BoardSummary, Viewer } from "../src/domain/types.ts";

const { boardsFor, requireBoard } = await import("../src/worker/access.ts");
const { getBoard, getBoards } = await import("../src/worker/routes/boards.ts");
const { HttpError } = await import("../src/worker/http.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const db = sqlite();
/* sam owns b1, is a viewer on b2 and not on b3; dev (sam's agent) is an
   owner on all three; ada is on none. b1 has two open tasks, one done and
   one deleted. */
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam'), ('ada', 'ada@x.test', 'ada'), ('kim', 'kim@x.test', 'kim');
  INSERT INTO users (id, email, handle, kind, owner_id) VALUES ('dev', 'dev@agents.invalid', 'sam/dev', 'agent', 'sam');
  INSERT INTO boards (id, key, name, created_by) VALUES ('b1', 'BA', 'alpha', 'sam'), ('b2', 'BB', 'beta', 'kim'), ('b3', 'BC', 'gamma', 'kim');
  INSERT INTO board_members (board_id, user_id, role) VALUES
    ('b1', 'sam', 'owner'), ('b1', 'dev', 'owner'),
    ('b2', 'kim', 'owner'), ('b2', 'sam', 'viewer'), ('b2', 'dev', 'owner'),
    ('b3', 'kim', 'owner'), ('b3', 'dev', 'owner');
  INSERT INTO stages (id, board_id, position, name, category) VALUES ('s1', 'b1', 0, 'todo', 'todo'), ('s2', 'b1', 1, 'done', 'done');
  INSERT INTO tasks (id, board_id, number, title, stage_id, created_by, completed_at, deleted_at) VALUES
    ('t1', 'b1', 1, 'open', 's1', 'sam', NULL, NULL),
    ('t2', 'b1', 2, 'open too', 's1', 'sam', NULL, NULL),
    ('t3', 'b1', 3, 'done', 's2', 'sam', '2026-01-01', NULL),
    ('t4', 'b1', 4, 'deleted', 's1', 'sam', NULL, '2026-01-01');
`);
const DB = d1(db);
const env = { DB } as unknown as Parameters<typeof getBoard>[0];

const user = (id: string, kind: "person" | "agent" = "person"): Viewer["user"] => ({
  id,
  kind,
  email: null,
  handle: id === "dev" ? "sam/dev" : id,
  avatar: null,
  isAdmin: false,
  ownerId: kind === "agent" ? "sam" : null,
});
const sam = { user: user("sam") } as Viewer;
const ada = { user: user("ada") } as Viewer;
const dev = { user: user("dev", "agent"), agent: { owner: user("sam"), grants: [] } } as unknown as Viewer;

const status = async (f: () => Promise<unknown>): Promise<number> => {
  try {
    await f();
    return 200;
  } catch (error) {
    return error instanceof HttpError ? error.status : -1;
  }
};

/* ---------------------------------------------------------- requireBoard -- */

t("a member gets their role", (await requireBoard(DB, sam, "b1")).role === "owner");
t("an agent made owner is capped at editor", (await requireBoard(DB, dev, "b1")).role === "editor");
t("an agent is capped at its owner's role", (await requireBoard(DB, dev, "b2")).role === "viewer");
t("an agent on a board its owner isn't on finds nothing", (await status(() => requireBoard(DB, dev, "b3"))) === 404);
t("a non-member finds nothing", (await status(() => requireBoard(DB, ada, "b1"))) === 404);
t("a board that doesn't exist is the same 404", (await status(() => requireBoard(DB, sam, "nope"))) === 404);
t("an agent below the role needed is refused", (await status(() => requireBoard(DB, dev, "b2", "editor"))) === 403);
t("an agent never manages a board", (await status(() => requireBoard(DB, dev, "b1", "owner"))) === 403);
t("requireBoard counts nothing", !("memberCount" in (await requireBoard(DB, sam, "b1"))));

/* ------------------------------------------------------------- boardsFor -- */

const roles = (bs: Array<{ id: string; role: string }>) => bs.map((b) => `${b.id}:${b.role}`).join(" ");
t("boardsFor: the agent's boards its owner is on, capped", roles(await boardsFor(DB, dev)) === "b1:editor b2:viewer");
t("boardsFor: a person's boards at their roles", roles(await boardsFor(DB, sam)) === "b1:owner b2:viewer");
t("boardsFor: nothing for someone on nothing", (await boardsFor(DB, ada)).length === 0);
t("boardsFor counts nothing", (await boardsFor(DB, sam)).every((b) => !("memberCount" in b) && !("openTaskCount" in b)));

/* ----------------------------------------------------------------- routes -- */

const list = (await (await getBoards(env, dev)).json()) as BoardSummary[];
t("GET /api/boards: the same boards, capped", roles(list) === "b1:editor b2:viewer");
const b1 = list.find((b) => b.id === "b1");
t("GET /api/boards counts members", b1?.memberCount === 2 && list.find((b) => b.id === "b2")?.memberCount === 3);
t("GET /api/boards counts open tasks, not done or deleted ones", b1?.openTaskCount === 2);
const detail = (await (await getBoard(env, dev, "b1")).json()) as BoardDetail;
t("GET /api/boards/:id: the capped role, no counts", detail.board.role === "editor" && !("memberCount" in detail.board));
t("GET /api/boards/:id: a non-member's 404", (await status(() => getBoard(env, ada, "b1"))) === 404);

/* The open count is served by an index of open tasks, not a scan of the board's. */
const plan = db
  .prepare(`EXPLAIN QUERY PLAN SELECT count(*) FROM tasks t WHERE t.board_id = 'b1' AND t.deleted_at IS NULL AND t.completed_at IS NULL`)
  .all()
  .map((r) => String(r.detail))
  .join(" ");
t("the open task count reads tasks_open", plan.includes("tasks_open"));

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} access checks passed`);
if (failed) process.exit(1);
