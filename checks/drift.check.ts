/* ============================================================================
   Heavy drift tells the assignee and never makes a task review first
   (COPL-194): driftNotice in src/domain/github.ts and noticeDrift in
   src/worker/drift.ts.
   ----------------------------------------------------------------------------
   Run: npm run check. The rule is a pure function; the notice runs for real
   (checks/worker.ts) on the migrations in an in-memory node:sqlite, on a PR's
   rows as pullRows reads them. Main changing DRIFT_HEAVY of a PR's files puts
   one comment on its task, "via GitHub", which reaches its agent assignee's
   inbox; review_first stays as it was; the same overlap measured again says
   nothing more, and a new overlapping file says it again.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { Drift } from "../src/domain/github.ts";

const { DRIFT_HEAVY, driftNotice } = await import("../src/domain/github.ts");
const { Changes } = await import("../src/worker/live.ts");
const { noticeDrift, pullRows } = await import("../src/worker/drift.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const drift = (o: Partial<Drift>): Drift => ({
  main: "m".repeat(40),
  base: "b".repeat(40),
  behind: 0,
  mainFiles: [],
  taskFiles: [],
  overlap: [],
  revalidated: false,
  ...o,
});
const heavy = ["a.ts", "b.ts", "c.ts"];

/* The rule. */
t("heavy is three files", DRIFT_HEAVY === 3);
t("light overlap says nothing", driftNotice(null, drift({ overlap: ["a.ts", "b.ts"] })) === null);
t("heavy overlap says so, naming the files", !!driftNotice(null, drift({ overlap: heavy }))?.includes("`c.ts`"));
t("it asks for a re-check, not a review", (() => {
  const text = driftNotice(null, drift({ overlap: heavy })) ?? "";
  return text.includes("Re-check before merging") && !/review first/i.test(text);
})());
t("re-checked for this main says nothing", driftNotice(null, drift({ overlap: heavy, revalidated: true })) === null);
t("the same overlap again says nothing", driftNotice(drift({ overlap: heavy }), drift({ overlap: heavy, main: "n".repeat(40) })) === null);
t("a new overlapping file says it again", driftNotice(drift({ overlap: heavy }), drift({ overlap: [...heavy, "d.ts"] })) !== null);
t("crossing into heavy says it", driftNotice(drift({ overlap: ["a.ts", "b.ts"] }), drift({ overlap: heavy })) !== null);

/* The notice, for real. */
const db = sqlite();
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam');
  INSERT INTO users (id, email, handle, kind, owner_id) VALUES ('dev', 'dev@agents.invalid', 'sam/dev', 'agent', 'sam');
  INSERT INTO agents (user_id, name, work_from) VALUES ('dev', 'dev', 'owner');
  INSERT INTO boards (id, name, key, created_by) VALUES ('b1', 'B', 'BB', 'sam');
  INSERT INTO board_members (board_id, user_id, role) VALUES ('b1', 'sam', 'owner'), ('b1', 'dev', 'editor');
  INSERT INTO stages (id, board_id, name, position, category) VALUES ('doing', 'b1', 'doing', 0, 'active');
  INSERT INTO tasks (id, board_id, number, title, stage_id, created_by) VALUES ('t1', 'b1', 1, 'T', 'doing', 'sam');
  INSERT INTO task_assignees (task_id, user_id) VALUES ('t1', 'dev');
  INSERT INTO board_repos (id, board_id, repo, connected_by, created_at) VALUES ('r1', 'b1', 'sam/x', 'sam', '2026-10-26T00:00:00Z');
  INSERT INTO task_code (id, task_id, repo_id, kind, name, url, state, ref, head_sha, updated_at)
    VALUES ('c1', 't1', 'r1', 'pull', '7', 'https://github.com/sam/x/pull/7', 'open', 'closes', 'h', '2026-10-26T00:00:00Z');
`);
const env = { DB: d1(db) } as unknown as Parameters<typeof noticeDrift>[0];
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const comments = () => count(`SELECT count(*) AS n FROM comments WHERE task_id = 't1'`);
const store = (d: Drift) => db.prepare(`UPDATE task_code SET drift = ?1 WHERE id = 'c1'`).run(JSON.stringify(d));
const measure = async (d: Drift) => {
  await noticeDrift(env, await pullRows(env.DB, "sam/x", 7), d, new Changes());
  store(d);
};

await measure(drift({ overlap: ["a.ts"] }));
t("light drift posts nothing", comments() === 0);
await measure(drift({ overlap: heavy }));
t("heavy drift posts one comment", comments() === 1);
t("it comes via GitHub, as whoever connected the repo", count(`SELECT count(*) AS n FROM comments WHERE author_id = 'sam'`) === 1
  && count(`SELECT count(*) AS n FROM inbox_items WHERE via = 'GitHub'`) === 1);
t("it reaches the agent assignee's inbox", count(`SELECT count(*) AS n FROM inbox_items WHERE user_id = 'dev' AND task_id = 't1' AND read_at IS NULL`) === 1);
t("heavy drift doesn't make the task review first", count(`SELECT review_first AS n FROM tasks WHERE id = 't1'`) === 0);
await measure(drift({ overlap: heavy, main: "n".repeat(40) }));
t("main moving elsewhere says nothing more", comments() === 1);
await measure(drift({ overlap: [...heavy, "d.ts"] }));
t("another file of the PR's changing says it again", comments() === 2);
db.exec(`UPDATE tasks SET completed_at = '2026-10-26T01:00:00Z' WHERE id = 't1'`);
await measure(drift({ overlap: [...heavy, "d.ts", "e.ts"] }));
t("a closed task hears nothing", comments() === 2);

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} drift checks passed`);
if (failed) process.exit(1);
