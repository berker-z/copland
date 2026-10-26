/* ============================================================================
   Review first is a person's call (COPL-192): reviewFirst on POST
   /api/boards/:id/tasks and PATCH /api/tasks/:id in
   src/worker/routes/tasks.ts, and review_first on the MCP's create_task and
   update_task.
   ----------------------------------------------------------------------------
   Run: npm run check. The routes run for real (checks/worker.ts) on the
   migrations in an in-memory node:sqlite, and the tools through handleMcp
   on them. An agent's call with reviewFirst is refused whole, setting it or
   clearing it, so a person's choice stands; the same call without it works.
   A person sets and clears it, in the browser or with a token.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { Task, Viewer } from "../src/domain/types.ts";
import type { ApiCall } from "../src/worker/mcp.ts";

const { Changes } = await import("../src/worker/live.ts");
const { getTask, patchTask, postTask } = await import("../src/worker/routes/tasks.ts");
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
    ('tk-sam', 'sam', 'personal', 'sam', 'write', 'h-sam', NULL);
  INSERT INTO boards (id, name, key, created_by) VALUES ('b1', 'B', 'BB', 'sam');
  INSERT INTO board_members (board_id, user_id, role) VALUES ('b1', 'sam', 'owner'), ('b1', 'dev', 'editor');
  INSERT INTO stages (id, board_id, name, position, category) VALUES
    ('todo', 'b1', 'todo', 0, 'todo'), ('doing', 'b1', 'doing', 1, 'active'), ('done', 'b1', 'done', 2, 'done');
`);
const env = { DB: d1(db) } as unknown as Parameters<typeof patchTask>[1];
const person = (id: string) => ({ id, kind: "person" as const, email: `${id}@x.test`, handle: id, avatar: null, isAdmin: false, ownerId: null });
const access = (tokenId: string) => ({ tokenId, scope: "write" as const, kind: "personal" as const, client: null });
/* sam in the browser, sam with a token, and sam's agent dev with its own. */
const sam: Viewer = { user: person("sam") };
const samToken = { user: person("sam"), access: access("tk-sam") } as unknown as Viewer;
const dev = {
  user: { id: "dev", kind: "agent", email: null, handle: "sam/dev", avatar: null, isAdmin: false, ownerId: "sam" },
  agent: { owner: person("sam"), grants: [], workFrom: "owner", description: "" },
  access: access("tk-dev"),
} as unknown as Viewer;

const req = (method: string, body: unknown) => new Request("https://x.test/", { method, body: JSON.stringify(body) });
const changes = new Changes();
const create = async (viewer: Viewer, body: Record<string, unknown>) =>
  (await (await postTask(req("POST", body), env, viewer, "b1", changes)).json()) as Task;
const patch = async (viewer: Viewer, id: string, body: Record<string, unknown>) =>
  (await (await patchTask(req("PATCH", body), env, viewer, id, changes)).json()) as Task;
/** "ok", or the refusal's status and message. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (error) {
    const err = error as { status?: number; message: string };
    return `${err.status ?? "?"} ${err.message}`;
  }
}
const row = (id: string) => db.prepare(`SELECT title, review_first FROM tasks WHERE id = ?`).get(id) as { title: string; review_first: number };
const count = () => (db.prepare(`SELECT count(*) AS n FROM tasks`).get() as { n: number }).n;

/* People set it and clear it. */
const a = await create(sam, { title: "a", reviewFirst: true });
t("a person creates a task review first in the browser", a.reviewFirst && row(a.id).review_first === 1);
t("a person clears it", !(await patch(sam, a.id, { reviewFirst: false })).reviewFirst);
t("a person sets it with a token", (await patch(samToken, a.id, { reviewFirst: true })).reviewFirst);
t("and creates one with a token", (await create(samToken, { title: "b", reviewFirst: true })).reviewFirst);

/* An agent does neither. */
const before = count();
const made = await outcome(() => create(dev, { title: "c", reviewFirst: true }));
t("an agent's create with reviewFirst is refused, saying only a person sets it", /^403 Agents cannot set reviewFirst[^:]*: only a person/.test(made));
t("and makes no task", count() === before);
t("an agent's create with reviewFirst false is refused too", (await outcome(() => create(dev, { title: "c", reviewFirst: false }))).startsWith("403 "));
const c = await create(dev, { title: "c" });
t("an agent's create without it works, and the task is not review first", !c.reviewFirst && row(c.id).title === "c");

t("an agent can't set it on a task", (await outcome(() => patch(dev, c.id, { reviewFirst: true }))).startsWith("403 ") && row(c.id).review_first === 0);
t(
  "nor clear one a person set, and nothing else in that call is written",
  (await outcome(() => patch(dev, a.id, { reviewFirst: false, title: "renamed" }))).startsWith("403 ") &&
    row(a.id).review_first === 1 &&
    row(a.id).title === "a",
);
t("passing the value it already has is refused all the same", (await outcome(() => patch(dev, a.id, { reviewFirst: true }))).startsWith("403 "));
t("the same change without it works, and the person's choice stands", (await patch(dev, a.id, { title: "renamed" })).title === "renamed" && row(a.id).review_first === 1);

/* The MCP, on the same routes. */
const api = (viewer: Viewer): ApiCall => async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  try {
    requireWriteScope(viewer, method);
    const r = (b: unknown) => new Request("https://x.test/", { method, body: JSON.stringify(b ?? {}) });
    let res: Response | null = null;
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/api/boards") res = await getBoards(env, viewer);
    else if (method === "GET" && (m = /^\/api\/boards\/([^/?]+)$/.exec(path))) res = await getBoard(env, viewer, m[1]);
    else if (method === "POST" && (m = /^\/api\/boards\/([^/]+)\/tasks$/.exec(path))) res = await postTask(r(body), env, viewer, m[1], changes);
    else if (method === "GET" && (m = /^\/api\/tasks\/([^/?]+)$/.exec(path))) res = await getTask(env, viewer, m[1]);
    else if (method === "PATCH" && (m = /^\/api\/tasks\/([^/]+)$/.exec(path))) res = await patchTask(r(body), env, viewer, m[1], changes);
    if (!res) throw new Error(`no route ${method} ${path}`);
    return (await res.json()) as T;
  } catch (error) {
    const err = error as { message: string; status?: number; code?: string };
    throw new CallError(err.message, err.status ?? 500, err.code ?? null);
  }
};
const tool = async (viewer: Viewer, name: string, args: Record<string, unknown>) => {
  const request = new Request("https://x.test/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const out = (await (await handleMcp(request, viewer, api(viewer), async () => {}, "https://x.test")).json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return { text: out.result.content[0].text, error: out.result.isError === true };
};

const mcpBefore = count();
const viaCreate = await tool(dev, "create_task", { board: "BB", title: "d", review_first: true });
t("create_task with review_first from an agent is refused, saying only a person sets it", viaCreate.error && /only a person/.test(viaCreate.text) && count() === mcpBefore);
t("create_task without it works for the agent", !(await tool(dev, "create_task", { board: "BB", title: "d" })).error && count() === mcpBefore + 1);
const viaUpdate = await tool(dev, "update_task", { task: a.key, review_first: false, title: "again" });
t("update_task with review_first from an agent is refused whole", viaUpdate.error && /only a person/.test(viaUpdate.text) && row(a.id).review_first === 1 && row(a.id).title === "renamed");
t("update_task without it works for the agent", !(await tool(dev, "update_task", { task: a.key, title: "again" })).error && row(a.id).title === "again");
const bySam = await tool(samToken, "update_task", { task: c.key, review_first: true });
t("a person's update_task sets it", !bySam.error && row(c.id).review_first === 1);
t("and a person's create_task too", !(await tool(samToken, "create_task", { board: "BB", title: "e", review_first: true })).error);

/* --------------------------------------------------------------- report -- */

const failed = cases.filter(([, pass]) => !pass);
for (const [name, pass] of cases) if (!pass) console.error(`FAIL ${name}`);
console.log(`${cases.length - failed.length}/${cases.length} review first checks passed`);
if (failed.length) process.exit(1);
