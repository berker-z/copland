/* ============================================================================
   Housekeeping on the cron (src/worker/housekeeping.ts, COPL-112).
   ----------------------------------------------------------------------------
   Run: npm run check. The real migrations on an in-memory node:sqlite
   database behind a small D1 stand-in, then one tick: for each rule a row
   just inside its window stays and one just outside goes, a token a running
   run (or a run still kept) uses is never deleted, and a tick deletes at most
   its batch.
   ========================================================================== */

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { FILES_KEEP_MS, housekeep, housekeepingStatements, RUN_KEEP_MS, TOKEN_KEEP_MS } from "../src/worker/housekeeping.ts";

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

/* Just enough of D1 for the sweep: prepare, bind, and batch as one transaction. */
type Stmt = { sql: string; args: SQLInputValue[] };
function d1(sqlite: DatabaseSync): D1Database {
  const stmt = (sql: string, args: SQLInputValue[] = []) => ({ sql, args, bind: (...a: SQLInputValue[]) => stmt(sql, a) });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: Stmt[]) => {
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => ({ meta: { changes: Number(sqlite.prepare(s.sql).run(...s.args).changes) } }));
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

function fresh(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  return db;
}

const NOW = new Date("2026-10-03T12:00:00.000Z");
const MIN = 60_000;
/** Just inside a window (kept) and just outside it (deleted). */
const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const inside = (keep: number) => at(keep - MIN);
const outside = (keep: number) => at(keep + MIN);
const LATER = new Date(NOW.getTime() + 3600_000).toISOString();

const db = fresh();
const run = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args);
const has = (table: string, column: string, id: string) => db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(id) !== undefined;

run(`INSERT INTO users (id, email, handle) VALUES ('u1', 'a@example.com', 'a')`);
run(`INSERT INTO boards (id, name, key, created_by) VALUES ('b1', 'B', 'BB', 'u1')`);
run(`INSERT INTO stages (id, board_id, name, position, category) VALUES ('s1', 'b1', 'todo', 0, 'todo')`);
run(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ('c1', 'app', '[]')`);

/* Sessions and OAuth codes: gone once expired. */
run(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('s-live', 'u1', ?)`, LATER);
run(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('s-dead', 'u1', ?)`, at(MIN));
const code = (hash: string, expires: string) =>
  run(`INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at) VALUES (?, 'c1', 'u1', 'x', 'x', 'read', ?)`, hash, expires);
code("c-live", LATER);
code("c-dead", at(MIN));

/* Tokens, and the runs that use them. */
const token = (id: string, cols: { revoked?: string; expires?: string; refresh?: string } = {}) =>
  run(
    `INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash, expires_at, refresh_expires_at, revoked_at) VALUES (?, 'u1', 'personal', ?, 'write', ?, ?, ?, ?)`,
    id, id, `h-${id}`, cols.expires ?? null, cols.refresh ?? null, cols.revoked ?? null,
  );
const runRow = (id: string, tokenId: string, status: string, ended: string | null) =>
  run(`INSERT INTO runs (id, user_id, token_id, token_hash, status, ended_at) VALUES (?, 'u1', ?, ?, ?, ?)`, id, tokenId, `rh-${id}`, status, ended);

token("t-live");
token("t-revoked-inside", { revoked: inside(TOKEN_KEEP_MS) });
token("t-revoked-outside", { revoked: outside(TOKEN_KEEP_MS) });
token("t-expired-inside", { expires: inside(TOKEN_KEEP_MS) });
token("t-expired-outside", { expires: outside(TOKEN_KEEP_MS) });
token("t-refreshable", { expires: outside(TOKEN_KEEP_MS), refresh: LATER });
token("t-refresh-dead", { expires: outside(TOKEN_KEEP_MS), refresh: outside(TOKEN_KEEP_MS) });
token("t-running", { revoked: outside(TOKEN_KEEP_MS) });
token("t-recent-run", { revoked: outside(TOKEN_KEEP_MS) });
token("t-old-run", { revoked: outside(TOKEN_KEEP_MS) });

runRow("r-running", "t-running", "running", null);
runRow("r-recent", "t-recent-run", "failed", inside(RUN_KEEP_MS));
runRow("r-old-on-old-token", "t-old-run", "completed", outside(RUN_KEEP_MS));
runRow("r-inside", "t-live", "completed", inside(RUN_KEEP_MS));
runRow("r-outside", "t-live", "cancelled", outside(RUN_KEEP_MS));
runRow("r-running-old", "t-live", "running", null);
run(`UPDATE runs SET started_at = ?, last_seen_at = ? WHERE id = 'r-running-old'`, outside(RUN_KEEP_MS), outside(RUN_KEEP_MS));

/* Tasks and their changed files; one file list and an event point at the run that goes. */
const task = (id: string, n: number, cols: { completed?: string; deleted?: string } = {}) =>
  run(
    `INSERT INTO tasks (id, board_id, number, title, stage_id, rank, created_by, completed_at, deleted_at) VALUES (?, 'b1', ?, ?, 's1', ?, 'u1', ?, ?)`,
    id, n, id, String(n), cols.completed ?? null, cols.deleted ?? null,
  );
const files = (taskId: string, runId: string | null = null) =>
  run(`INSERT INTO task_files (task_id, run_id, base, files, reported_at) VALUES (?, ?, 'abc', '["a.ts"]', ?)`, taskId, runId, NOW.toISOString());
task("k-open", 1);
task("k-closed-inside", 2, { completed: inside(FILES_KEEP_MS) });
task("k-closed-outside", 3, { completed: outside(FILES_KEEP_MS) });
task("k-deleted-inside", 4, { deleted: inside(FILES_KEEP_MS) });
task("k-deleted-outside", 5, { deleted: outside(FILES_KEEP_MS) });
task("k-claimed", 6);
for (const k of ["k-closed-inside", "k-closed-outside", "k-deleted-inside", "k-deleted-outside"]) files(k);
files("k-open", "r-outside");
run(`INSERT INTO task_claims (task_id, run_id, user_id, claimed_until) VALUES ('k-claimed', 'r-outside', 'u1', ?)`, outside(RUN_KEEP_MS));
run(`INSERT INTO events (id, board_id, task_id, actor_id, kind, run_id) VALUES ('e1', 'b1', 'k-open', 'u1', 'task.claimed', 'r-outside')`);

const counts = await housekeep(d1(db), NOW);

t("an unexpired session stays", has("sessions", "token_hash", "s-live"));
t("an expired session goes", !has("sessions", "token_hash", "s-dead"));
t("an unexpired OAuth code stays", has("oauth_codes", "code_hash", "c-live"));
t("an expired OAuth code goes", !has("oauth_codes", "code_hash", "c-dead"));

t("a run ended just inside 30 days stays", has("runs", "id", "r-inside"));
t("a run ended just outside 30 days goes", !has("runs", "id", "r-outside"));
t("a running run stays however old", has("runs", "id", "r-running-old"));
t("a deleted run's claim goes with it", !has("task_claims", "task_id", "k-claimed"));
t("a deleted run's file list stays, with no run", db.prepare(`SELECT run_id FROM task_files WHERE task_id = 'k-open'`).get()?.run_id === null);
t("an event keeps the id of a deleted run", db.prepare(`SELECT run_id FROM events WHERE id = 'e1'`).get()?.run_id === "r-outside");

t("a live token stays", has("api_tokens", "id", "t-live"));
t("a token revoked just inside 30 days stays", has("api_tokens", "id", "t-revoked-inside"));
t("a token revoked just outside 30 days goes", !has("api_tokens", "id", "t-revoked-outside"));
t("a token expired just inside 30 days stays", has("api_tokens", "id", "t-expired-inside"));
t("a token expired just outside 30 days goes", !has("api_tokens", "id", "t-expired-outside"));
t("an expired token that can still refresh stays", has("api_tokens", "id", "t-refreshable"));
t("an expired token whose refresh died too goes", !has("api_tokens", "id", "t-refresh-dead"));
t("a running run's token is never deleted", has("api_tokens", "id", "t-running") && has("runs", "id", "r-running"));
t("a token whose run is still kept stays, and so does the run", has("api_tokens", "id", "t-recent-run") && has("runs", "id", "r-recent"));
t("a token whose runs have all gone goes", !has("api_tokens", "id", "t-old-run") && !has("runs", "id", "r-old-on-old-token"));

t("an open task's files stay", has("task_files", "task_id", "k-open"));
t("a task closed just inside 7 days keeps its files", has("task_files", "task_id", "k-closed-inside"));
t("a task closed just outside 7 days loses them", !has("task_files", "task_id", "k-closed-outside"));
t("a task deleted just inside 7 days keeps its files", has("task_files", "task_id", "k-deleted-inside"));
t("a task deleted just outside 7 days loses them", !has("task_files", "task_id", "k-deleted-outside"));

t("the tick reports what each rule deleted", JSON.stringify(counts) === JSON.stringify([1, 1, 2, 4, 2]));
t("a second tick finds nothing", (await housekeep(d1(db), NOW)).every((n) => n === 0));

/* A tick deletes at most its batch per table; the rest go on the next one. */
const many = fresh();
many.exec(`INSERT INTO users (id, email, handle) VALUES ('u1', 'a@example.com', 'a')`);
for (let i = 0; i < 7; i++) many.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'u1', ?)`).run(`s${i}`, at(MIN));
const batched = async () => (await d1(many).batch(housekeepingStatements(d1(many), NOW, 3)))[0].meta.changes;
t("a tick stops at its batch", (await batched()) === 3 && (await batched()) === 3 && (await batched()) === 1);

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} housekeeping checks passed`);
if (failed) process.exit(1);
