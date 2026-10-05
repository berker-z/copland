/* ============================================================================
   Rows read per route (COPL-149): what D1 bills for, held to a budget.
   ----------------------------------------------------------------------------
   Run: npm run check:reads (CI runs it after npm run check). It needs
   workerd, through wrangler's getPlatformProxy, because only D1 itself
   counts rows read (meta.rows_read): node:sqlite can't.

   Two seeds, built in node:sqlite on the real migrations and copied into a
   local D1: boards with a long history (closed tasks with comments, events,
   code links, attachments, runs, inbox items, messages) and a handful of
   open tasks, and the same with twice the history. Each route in
   reads.budgets.ts is called once per seed as the viewer that calls it in
   real life, its statements' rows read summed. A route fails when it reads
   more than its budget on either seed, or, when it is `flat`, when the two
   seeds differ by more than MARGIN: then it reads something that grows
   with history. The table it prints is the route, rows read on each seed,
   the budget, and what failed.
   ========================================================================== */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getPlatformProxy } from "wrangler";
import { BUDGETS } from "./reads.budgets.ts";
import { sqlite } from "./worker.ts";
import type { Viewer } from "../src/domain/types.ts";

const { getBoard, getBoards, getClosed } = await import("../src/worker/routes/boards.ts");
const { getTask, patchTask } = await import("../src/worker/routes/tasks.ts");
const { Changes } = await import("../src/worker/live.ts");
const { getInbox } = await import("../src/worker/routes/inbox.ts");
const { getWired } = await import("../src/worker/routes/wired.ts");
const { getMyWork, getReady } = await import("../src/worker/routes/work.ts");
const { getRecipients } = await import("../src/worker/routes/messages.ts");

/** How far a flat route's two seeds may differ: rows, or a share of the smaller. */
const MARGIN = { rows: 2, share: 0.05 };

/* ------------------------------------------------------------------ seed -- */

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

/**
 * People sam, kim and ada; sam's agent dev, kim's agent bot (work_from
 * members). BIG (sam's, planning, a GitHub repo; kim editor, ada viewer,
 * dev editor), SIDE (kim's; sam, dev, bot editors), and sam's and kim's
 * inboxes (dev on sam's). `scale` multiplies the history and nothing else.
 */
function seed(db: DatabaseSync, scale: number) {
  const insert = (table: string, row: Record<string, SQLInputValue>) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
      ...Object.values(row),
    );
  };
  db.exec(`
    INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam'), ('kim', 'kim@x.test', 'kim'), ('ada', 'ada@x.test', 'ada');
    INSERT INTO users (id, email, handle, kind, owner_id) VALUES
      ('dev', 'dev@agents.invalid', 'sam/dev', 'agent', 'sam'), ('bot', 'bot@agents.invalid', 'kim/bot', 'agent', 'kim');
    INSERT INTO agents (user_id, name, work_from) VALUES ('dev', 'dev', 'owner'), ('bot', 'bot', 'members');
    INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash) VALUES ('tok-dev', 'dev', 'personal', 'box', 'write', 'h-dev');
    INSERT INTO boards (id, key, name, is_inbox, has_planning, created_by) VALUES
      ('big', 'BIG', 'big', 0, 1, 'sam'), ('side', 'SIDE', 'side', 0, 0, 'kim'),
      ('isam', 'SAM', 'inbox', 1, 0, 'sam'), ('ikim', 'KIM', 'inbox', 1, 0, 'kim');
    INSERT INTO inboxes (user_id, board_id) VALUES ('sam', 'isam'), ('kim', 'ikim');
    INSERT INTO board_members (board_id, user_id, role) VALUES
      ('big', 'sam', 'owner'), ('big', 'kim', 'editor'), ('big', 'ada', 'viewer'), ('big', 'dev', 'editor'),
      ('side', 'kim', 'owner'), ('side', 'sam', 'editor'), ('side', 'dev', 'editor'), ('side', 'bot', 'editor'),
      ('isam', 'sam', 'owner'), ('isam', 'dev', 'editor'), ('ikim', 'kim', 'owner');
    INSERT INTO board_repos (id, board_id, repo, connected_by, created_at) VALUES ('repo', 'big', 'sam/big', 'sam', '2026-01-01T00:00:00.000Z');
  `);
  const categories = ["backlog", "todo", "active", "blocked", "done", "cancelled"] as const;
  for (const board of ["big", "side", "isam", "ikim"]) {
    categories.forEach((category, position) => insert("stages", { id: `${board}-${category}`, board_id: board, position, name: category, category }));
    for (let n = 0; n < 4; n++) insert("labels", { id: `${board}-l${n}`, board_id: board, name: `label ${n}` });
  }

  const number: Record<string, number> = {};
  let ids = 0;
  const id = (prefix: string) => `${prefix}${++ids}`;
  type TaskOpts = {
    category: (typeof categories)[number];
    assignees?: string[];
    completed?: string | null;
    level?: string;
    parent?: string | null;
    by?: string;
  };
  const task = (board: string, o: TaskOpts) => {
    const tid = id("t");
    number[board] = (number[board] ?? 0) + 1;
    const created = o.completed ? ago(Date.now() - Date.parse(o.completed) + 3 * DAY) : ago(5 * DAY);
    insert("tasks", {
      id: tid,
      board_id: board,
      number: number[board],
      title: `task ${number[board]}`,
      brief: "Some brief text that says what the work is for.",
      stage_id: `${board}-${o.category}`,
      rank: number[board],
      completed_at: o.completed ?? null,
      parent_id: o.parent ?? null,
      level: o.level ?? "task",
      created_by: o.by ?? "sam",
      created_at: created,
      updated_at: o.completed ?? created,
    });
    for (const user of o.assignees ?? []) insert("task_assignees", { task_id: tid, user_id: user });
    insert("events", { id: id("e"), board_id: board, task_id: tid, actor_id: o.by ?? "sam", kind: "created", created_at: created });
    return tid;
  };
  const comment = (board: string, tid: string, author: string, at: string, mention?: string) => {
    const cid = id("c");
    insert("comments", { id: cid, task_id: tid, author_id: author, text: mention ? `@${mention} have a look` : "a comment", created_at: at });
    if (mention) insert("comment_mentions", { comment_id: cid, user_id: mention });
    return cid;
  };
  const item = (user: string, kind: string, board: string | null, tid: string | null, actor: string, at: string, read: boolean, more: Record<string, SQLInputValue> = {}) =>
    insert("inbox_items", { id: id("i"), user_id: user, kind, board_id: board, task_id: tid, actor_id: actor, created_at: at, read_at: read ? at : null, ...more });
  const run = (status: string, at: string, ended: string | null) => {
    const rid = id("r");
    insert("runs", { id: rid, user_id: "dev", token_id: "tok-dev", token_hash: `h-${rid}`, client: "claude-code", status, started_at: at, last_seen_at: ended ?? ahead(0), ended_at: ended });
    return rid;
  };

  /* History: closed tasks, each with its trail, oldest first. `i` is a
     task's age in tasks (0 the newest), and everything about it follows from
     that, so a larger `scale` adds older history at the same pace rather
     than more of it each day: the last weeks look the same on both seeds.
     The epics are the oldest tasks, and their children all closed weeks ago. */
  const history = (board: string, count: number, people: string[], perTask: number, code: boolean) => {
    const epics: string[] = [];
    let previous: string | null = null;
    const perDay = count / scale / 360;
    for (let k = 0; k < count; k++) {
      const i = count - 1 - k;
      const completed = ago((2 + i / perDay) * DAY + i * 60_000);
      const assignee = people[i % people.length];
      const epic = code && k < 5 * scale;
      const tid = task(board, {
        category: i % 10 === 0 ? "cancelled" : "done",
        completed,
        assignees: [assignee],
        level: epic ? "epic" : "task",
        parent: code && !epic && epics.length && i >= 30 * perDay ? epics[i % epics.length] : null,
        by: people[(i + 1) % people.length],
      });
      if (epic) epics.push(tid);
      insert("task_labels", { task_id: tid, label_id: `${board}-l${i % 4}` });
      if (previous && i % 5 === 0) insert("task_dependencies", { task_id: tid, depends_on_id: previous });
      previous = tid;
      const rid = assignee === "dev" ? run("completed", ago(Date.now() - Date.parse(completed) + DAY), completed) : null;
      for (const kind of ["assigned", "moved", "moved"]) {
        insert("events", { id: id("e"), board_id: board, task_id: tid, actor_id: assignee, kind, created_at: completed, via: rid ? "Claude Code" : null, run_id: rid });
      }
      if (assignee !== people[(i + 1) % people.length]) item(assignee, "assigned", board, tid, people[(i + 1) % people.length], completed, true);
      for (let c = 0; c < perTask; c++) {
        const author = people[(i + c) % people.length];
        const mention = c === 2 ? people[(i + c + 1) % people.length] : undefined;
        const cid = comment(board, tid, author, completed, mention);
        if (mention && mention !== author) item(mention, "mentioned", board, tid, author, completed, true, { comment_id: cid });
        if (assignee !== author && assignee !== mention) item(assignee, "commented", board, tid, author, completed, true, { comment_id: cid });
      }
      if (i % 4 === 0) insert("attachments", { id: id("a"), task_id: tid, name: "spec", kind: "link", url: "https://example.test/spec", added_by: assignee, created_at: completed });
      if (i % 8 === 0) {
        insert("attachments", { id: id("a"), task_id: tid, name: "shot.png", mime: "image/png", size: 1000, kind: "image", key: `k-${tid}`, added_by: assignee, created_at: completed });
      }
      if (code && i % 3 !== 0) {
        const n = number[board];
        insert("task_code", { id: id("k"), task_id: tid, repo_id: "repo", kind: "branch", name: `big-${n}-work`, url: "https://github.test/b", state: "merged", ref: "mentions", updated_at: completed });
        insert("task_code", { id: id("k"), task_id: tid, repo_id: "repo", kind: "pull", name: `${n}`, title: `BIG-${n}`, url: "https://github.test/p", state: "merged", ref: "closes", head_sha: "abc", ci: "success", updated_at: completed });
        if (rid) insert("task_files", { task_id: tid, run_id: rid, base: "abc", files: JSON.stringify(["src/a.ts", "src/b.ts"]), reported_at: completed });
      }
    }
    return previous;
  };
  const lastBig = history("big", 300 * scale, ["sam", "dev", "kim"], 3, true);
  history("side", 100 * scale, ["kim", "sam", "dev", "bot"], 3, false);
  history("isam", 60 * scale, ["sam"], 1, false);
  history("ikim", 20 * scale, ["kim"], 1, false);
  for (let i = 0; i < 40 * scale; i++) {
    const [from, to] = i % 2 ? ["sam", "dev"] : ["dev", "sam"];
    const mid = id("m");
    const at = ago((2 + (i % 300)) * DAY);
    insert("messages", { id: mid, sender_id: from, recipient_id: to, text: "a message", created_at: at });
    item(to, "message", null, null, from, at, true, { message_id: mid });
  }

  /* Today: the open work, the same on both seeds. */
  const epic = task("big", { category: "active", level: "epic", assignees: ["sam"] });
  const ready = task("big", { category: "todo", assignees: ["dev"], parent: epic });
  insert("task_dependencies", { task_id: ready, depends_on_id: lastBig! });
  const live = task("big", { category: "active", assignees: ["dev"], parent: epic });
  const liveKey = `BIG-${number.big}`;
  const waiting = task("big", { category: "todo", assignees: ["dev"], parent: epic });
  insert("task_dependencies", { task_id: waiting, depends_on_id: live });
  task("big", { category: "active", assignees: ["sam"], parent: epic });
  task("big", { category: "blocked", assignees: ["dev"], parent: epic });
  task("big", { category: "backlog", parent: epic });
  task("big", { category: "todo", assignees: ["kim"], parent: epic });
  task("big", { category: "done", assignees: ["dev"], parent: epic, completed: ago(DAY / 2) });
  const now = run("running", ago(DAY / 24), null);
  insert("task_claims", { task_id: live, run_id: now, user_id: "dev", claimed_at: ago(DAY / 24), claimed_until: ahead(DAY / 144) });
  insert("task_files", { task_id: live, run_id: now, base: "abc", files: JSON.stringify(["src/a.ts"]), reported_at: ago(0) });
  insert("task_code", { id: id("k"), task_id: live, repo_id: "repo", kind: "branch", name: "big-live", url: "https://github.test/b", state: "open", ref: "mentions", updated_at: ago(0) });
  insert("task_code", { id: id("k"), task_id: live, repo_id: "repo", kind: "pull", name: "999", title: "live", url: "https://github.test/p", state: "open", ref: "closes", head_sha: "def", ci: "pending", updated_at: ago(0) });
  insert("attachments", { id: id("a"), task_id: live, name: "spec", kind: "link", url: "https://example.test/spec", added_by: "sam", created_at: ago(0) });
  insert("task_labels", { task_id: live, label_id: "big-l0" });
  for (let c = 0; c < 4; c++) {
    const cid = comment("big", live, c % 2 ? "dev" : "kim", ago((4 - c) * 3_600_000), c === 3 ? "sam" : undefined);
    item("sam", c === 3 ? "mentioned" : "commented", "big", live, c % 2 ? "dev" : "kim", ago((4 - c) * 3_600_000), false, { comment_id: cid });
  }
  task("side", { category: "todo", assignees: ["dev"], by: "kim" });
  task("side", { category: "active", assignees: ["bot"], by: "kim" });
  task("side", { category: "todo", assignees: ["sam"], by: "kim" });
  for (let i = 0; i < 4; i++) task("isam", { category: "todo" });
  task("isam", { category: "todo", assignees: ["dev"] });
  const mid = id("m");
  insert("messages", { id: mid, sender_id: "dev", recipient_id: "sam", text: "done for today", created_at: ago(0) });
  item("sam", "message", null, null, "dev", ago(0), false, { message_id: mid });
  item("dev", "assigned", "big", ready, "sam", ago(0), false);

  for (const [board, n] of Object.entries(number)) db.prepare(`UPDATE boards SET next_number = ? WHERE id = ?`).run(n + 1, board);
  return { live: liveKey };
}

/* ------------------------------------------------------- local D1 copy -- */

/** The node:sqlite database, schema and rows, into D1. */
async function copy(from: DatabaseSync, to: D1Database) {
  const schema = from
    .prepare(`SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'index', rowid`)
    .all() as Array<{ name: string; type: string; sql: string }>;
  for (const { sql } of schema) await to.prepare(sql).run();
  /* A table's rows after those of the tables it references (a table rebuilt
     by a later migration comes later in sqlite_master than its referrers). */
  const tables: string[] = [];
  const visit = (name: string) => {
    if (tables.includes(name)) return;
    const refs = from.prepare(`SELECT DISTINCT "table" AS t FROM pragma_foreign_key_list(?)`).all(name) as Array<{ t: string }>;
    for (const { t } of refs) if (t !== name) visit(t);
    tables.push(name);
  };
  for (const { name, type } of schema) if (type === "table") visit(name);
  const statements: D1PreparedStatement[] = [];
  for (const name of tables) {
    const rows = from.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Array<Record<string, SQLInputValue>>;
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    /* D1 binds at most 100 values a statement. */
    const per = Math.max(1, Math.floor(100 / cols.length));
    for (let i = 0; i < rows.length; i += per) {
      const chunk = rows.slice(i, i + per);
      statements.push(
        to
          .prepare(`INSERT INTO "${name}" (${cols.join(", ")}) VALUES ${chunk.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ")}`)
          .bind(...chunk.flatMap((row) => cols.map((c) => row[c]))),
      );
    }
  }
  for (let i = 0; i < statements.length; i += 200) await to.batch(statements.slice(i, i + 200));
}

/** D1 with every statement's rows read added up: first() and raw() go through all(), which reads the same. */
function counting(db: D1Database) {
  let rows = 0;
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
    ({
      inner: stmt,
      bind: (...args: unknown[]) => wrap(stmt.bind(...args)),
      all: async () => {
        const result = await stmt.all();
        rows += result.meta.rows_read;
        return result;
      },
      first: async (column?: string) => {
        const result = await stmt.all<Record<string, unknown>>();
        rows += result.meta.rows_read;
        const row = result.results[0] ?? null;
        return column === undefined ? row : (row?.[column] ?? null);
      },
      run: async () => {
        const result = await stmt.run();
        rows += result.meta.rows_read;
        return result;
      },
      raw: async () => {
        throw new Error("raw() isn't counted; add it to counting() in checks/reads.check.ts");
      },
    }) as unknown as D1PreparedStatement;
  const counted = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (stmts: D1PreparedStatement[]) => {
      const results = await db.batch(stmts.map((s) => (s as unknown as { inner: D1PreparedStatement }).inner));
      for (const r of results) rows += r.meta.rows_read;
      return results;
    },
    exec: () => {
      throw new Error("exec() isn't counted");
    },
  } as unknown as D1Database;
  return { db: counted, take: () => ((n) => ((rows = 0), n))(rows) };
}

/* ---------------------------------------------------------------- routes -- */

const user = (id: string, ownerId: string | null = null): Viewer["user"] => ({
  id,
  kind: ownerId ? "agent" : "person",
  email: ownerId ? null : `${id}@x.test`,
  handle: ownerId ? `${ownerId}/${id}` : id,
  avatar: null,
  isAdmin: false,
  ownerId,
});
const sam: Viewer = { user: user("sam") };
const dev: Viewer = { user: user("dev", "sam"), agent: { owner: user("sam"), grants: [], workFrom: "owner", description: "" } };

type Env = Parameters<typeof getBoards>[0];
/**
 * What a listening tab reads when someone edits one task (COPL-151): the
 * tasks the write's live event names, one GET /api/tasks/:id each, as
 * lib/boardPatch.ts does. Before COPL-151 it was the whole board and the
 * boards list. The write itself is not counted (`skip`), and it comes last
 * in ROUTES so it changes nothing the others read.
 */
async function taskEditHeard(env: Env, live: string, skip: () => void): Promise<Response> {
  const { id } = (await (await getTask(env, sam, live)).json()) as { id: string };
  const changes = new Changes();
  await patchTask(new Request("http://x/", { method: "PATCH", body: JSON.stringify({ title: "edited" }) }), env, sam, id, changes);
  skip();
  const [event] = changes.events(null).get("sam") ?? [];
  if (!event?.tasks?.length || event.version === undefined) return new Response("the edit named no tasks", { status: 500 });
  for (const id of event.tasks) await getTask(env, sam, id);
  return new Response("{}");
}

/** What each route is asked, and by whom: the browser's person, the daemon's agent for ready. */
const ROUTES: Record<string, (env: Env, live: string, skip: () => void) => Promise<Response>> = {
  "GET /api/boards": (env) => getBoards(env, sam),
  "GET /api/boards/:id": (env) => getBoard(env, sam, "big"),
  "GET /api/boards/:id/closed": (env) => getClosed(env, sam, "big", new URL("http://x/api/boards/big/closed")),
  "GET /api/tasks/:id": (env, live) => getTask(env, sam, live),
  "GET /api/inbox": (env) => getInbox(env, sam, new URL("http://x/api/inbox")),
  "GET /api/wired": (env) => getWired(env, sam),
  "GET /api/tasks/ready": (env) => getReady(env, dev),
  "GET /api/tasks/mine": (env) => getMyWork(env, sam),
  "GET /api/messages/recipients": (env) => getRecipients(env, sam),
  "live: one task edit, heard": taskEditHeard,
};

/** Nobody is connected: the Durable Object that would say so isn't here. */
const LIVE = { idFromName: (name: string) => name, get: () => ({ listening: async () => [] }) };

async function measure(scale: number): Promise<Record<string, number>> {
  const dir = mkdtempSync(join(tmpdir(), "copland-reads-"));
  const config = join(dir, "wrangler.jsonc");
  writeFileSync(
    config,
    JSON.stringify({ name: "reads", compatibility_date: "2026-09-01", d1_databases: [{ binding: "DB", database_name: "reads", database_id: "reads" }] }),
  );
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: config, persist: false });
  try {
    const source = sqlite();
    const { live } = seed(source, scale);
    await copy(source, proxy.env.DB);
    const { db, take } = counting(proxy.env.DB);
    const env = { DB: db, LIVE } as unknown as Env;
    const out: Record<string, number> = {};
    for (const [route, call] of Object.entries(ROUTES)) {
      take();
      const response = await call(env, live, take);
      if (!response.ok) throw new Error(`${route} answered ${response.status} on seed ×${scale}`);
      out[route] = take();
    }
    return out;
  } finally {
    await proxy.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

const one = await measure(1);
const two = await measure(2);

let failed = 0;
const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(`${"route".padEnd(32)} ${pad("×1", 7)} ${pad("×2", 7)} ${pad("budget", 7)}`);
for (const route of Object.keys(ROUTES)) {
  const budget = BUDGETS[route];
  const problems: string[] = [];
  if (!budget) problems.push("no budget in reads.budgets.ts");
  else {
    if (Math.max(one[route], two[route]) > budget.rows) problems.push("over budget");
    const allowed = Math.max(MARGIN.rows, Math.min(one[route], two[route]) * MARGIN.share);
    if (budget.flat && Math.abs(two[route] - one[route]) > allowed) problems.push("grows with history");
  }
  if (problems.length) failed++;
  console.log(
    `${problems.length ? "FAIL" : "  ok"}  ${route.padEnd(30)} ${pad(one[route], 6)} ${pad(two[route], 7)} ${pad(budget?.rows ?? "-", 7)}${budget?.flat ? " flat" : "     "}  ${problems.join(", ")}`,
  );
}
for (const route of Object.keys(BUDGETS)) {
  if (!(route in ROUTES)) {
    failed++;
    console.log(`FAIL  ${route}: a budget for a route the check doesn't call`);
  }
}
console.log(`\n${Object.keys(ROUTES).length - failed}/${Object.keys(ROUTES).length} routes within their reads budgets`);
if (failed) process.exit(1);
