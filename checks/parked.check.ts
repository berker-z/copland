/* ============================================================================
   A parent with nothing left but parked children is parked (COPL-214):
   followChildren in src/domain/tasks.ts, through PATCH /api/tasks/:id and
   the MCP's move_task.
   ----------------------------------------------------------------------------
   Run: npm run check. The routes run for real (checks/worker.ts) on the
   migrations in an in-memory node:sqlite, and the tools through handleMcp
   on them, the way a client calls them. Parking the last open child moves
   its story and epic to backlog in the same write, reported as also_moved
   and logged on the parent as following the child; picking the child up
   again brings them back. A read-only token moves nothing.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { Viewer } from "../src/domain/types.ts";
import type { ApiCall } from "../src/worker/mcp.ts";

const { Changes } = await import("../src/worker/live.ts");
const { getTask, patchTask } = await import("../src/worker/routes/tasks.ts");
const { getBoard, getBoards } = await import("../src/worker/routes/boards.ts");
const { CallError, handleMcp } = await import("../src/worker/mcp.ts");
const { requireWriteScope } = await import("../src/worker/tokens.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const db = sqlite();
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam');
  INSERT INTO users (id, email, handle, kind, owner_id) VALUES ('dev', 'dev@agents.invalid', 'sam/dev', 'agent', 'sam');
  INSERT INTO agents (user_id, name, work_from) VALUES ('dev', 'dev', 'owner');
  INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash, client) VALUES
    ('tk-dev', 'dev', 'personal', 'box', 'write', 'h-dev', 'claude-code'),
    ('tk-ro', 'sam', 'personal', 'ro', 'read', 'h-ro', NULL);
  INSERT INTO boards (id, name, key, created_by) VALUES ('b1', 'B', 'BB', 'sam');
  INSERT INTO board_members (board_id, user_id, role) VALUES ('b1', 'sam', 'owner'), ('b1', 'dev', 'editor');
  INSERT INTO stages (id, board_id, name, position, category) VALUES
    ('backlog', 'b1', 'backlog', 0, 'backlog'), ('todo', 'b1', 'todo', 1, 'todo'), ('doing', 'b1', 'doing', 2, 'active'),
    ('blocked', 'b1', 'blocked', 3, 'blocked'), ('done', 'b1', 'done', 4, 'done');
  INSERT INTO tasks (id, board_id, number, title, stage_id, parent_id, level, completed_at, created_by) VALUES
    ('E', 'b1', 1, 'epic', 'doing', NULL, 'epic', NULL, 'sam'),
    ('S', 'b1', 2, 'story', 'blocked', 'E', 'story', NULL, 'sam'),
    ('a', 'b1', 3, 'linux', 'done', 'S', 'task', '2026-10-01T00:00:00.000Z', 'sam'),
    ('b', 'b1', 4, 'macos', 'doing', 'S', 'task', NULL, 'sam');
`);
const env = { DB: d1(db) } as unknown as Parameters<typeof patchTask>[1];
const person = (id: string) => ({ id, kind: "person" as const, email: `${id}@x.test`, handle: id, avatar: null, isAdmin: false, ownerId: null });
const dev = {
  user: { id: "dev", kind: "agent", email: null, handle: "sam/dev", avatar: null, isAdmin: false, ownerId: "sam" },
  agent: { owner: person("sam"), grants: [], workFrom: "owner", description: "" },
  access: { tokenId: "tk-dev", scope: "write", kind: "personal", client: null },
} as unknown as Viewer;
const readOnly = { user: person("sam"), access: { tokenId: "tk-ro", scope: "read", kind: "personal", client: null } } as unknown as Viewer;

const changes = new Changes();
const api = (viewer: Viewer): ApiCall => async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  try {
    requireWriteScope(viewer, method);
    const r = (b: unknown) => new Request("https://x.test/", { method, body: JSON.stringify(b ?? {}) });
    let res: Response | null = null;
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/api/boards") res = await getBoards(env, viewer);
    else if (method === "GET" && (m = /^\/api\/boards\/([^/?]+)$/.exec(path))) res = await getBoard(env, viewer, m[1]);
    else if (method === "GET" && (m = /^\/api\/tasks\/([^/?]+)$/.exec(path))) res = await getTask(env, viewer, m[1]);
    else if (method === "PATCH" && (m = /^\/api\/tasks\/([^/]+)$/.exec(path))) res = await patchTask(r(body), env, viewer, m[1], changes);
    if (!res) throw new Error(`no route ${method} ${path}`);
    return (await res.json()) as T;
  } catch (error) {
    const err = error as { message: string; status?: number; code?: string };
    throw new CallError(err.message, err.status ?? 500, err.code ?? null);
  }
};
const move = async (viewer: Viewer, task: string, stage: string) => {
  const request = new Request("https://x.test/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "move_task", arguments: { task, stage } } }),
  });
  const out = (await (await handleMcp(request, viewer, api(viewer), async () => {}, "https://x.test")).json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  const text = out.result.content[0].text;
  const error = out.result.isError === true;
  const also = error ? [] : ((JSON.parse(text) as { also_moved?: Array<{ key: string; stage: string }> }).also_moved ?? []);
  return { error, also: also.map((m) => `${m.key}:${m.stage}`).join(" ") };
};
const stage = (id: string) => (db.prepare(`SELECT stage_id FROM tasks WHERE id = ?`).get(id) as { stage_id: string }).stage_id;

const parked = await move(dev, "BB-4", "backlog");
t("parking the last open child parks the blocked story and the active epic", !parked.error && parked.also === "BB-2:backlog BB-1:backlog");
t("and the rows say so", stage("S") === "backlog" && stage("E") === "backlog");
const logged = db
  .prepare(`SELECT after FROM events WHERE task_id = 'S' AND kind = 'task.updated' ORDER BY rowid DESC LIMIT 1`)
  .get() as { after: string } | undefined;
t("the story's history says it followed the child", !!logged && JSON.parse(logged.after).followed === "BB-4");

const back = await move(dev, "BB-4", "todo");
t("picking the child up again (todo) brings story and epic back to todo", !back.error && back.also === "BB-2:todo BB-1:todo");
const going = await move(dev, "BB-4", "doing");
t("and starting it takes them to active", !going.error && going.also === "BB-2:doing BB-1:doing");

const refused = await move(readOnly, "BB-4", "backlog");
t("a read-only token's move_task is refused and moves nothing", refused.error && stage("b") === "doing" && stage("S") === "doing");

/* --------------------------------------------------------------- report -- */

const failed = cases.filter(([, pass]) => !pass);
for (const [name, pass] of cases) if (!pass) console.error(`FAIL ${name}`);
console.log(`${cases.length - failed.length}/${cases.length} parked parent checks passed`);
if (failed.length) process.exit(1);
