/* ============================================================================
   Runs per runtime account (COPL-234, part of COPL-231): POST /api/runs with
   { account, account_cap } in src/worker/routes/runs.ts.
   ----------------------------------------------------------------------------
   Run: npm run check. The route runs for real (checks/worker.ts) on the
   migrations in an in-memory node:sqlite. A daemon sends the account it
   hashed and its cap; Copland counts the live runs on that account across
   the owner and all their agents (and so all their machines), refuses one
   past the cap with 409 account_full naming how many are going and where,
   and never lets two starts racing for the last slot both get it. Another
   person's runs on an account of the same name never count, and nor do
   runs that ended or went quiet past the lease.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { Run, Viewer } from "../src/domain/types.ts";

const { postRun } = await import("../src/worker/routes/runs.ts");
const { Changes } = await import("../src/worker/live.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const db = sqlite();
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam'), ('kim', 'kim@x.test', 'kim');
  INSERT INTO users (id, email, handle, kind, owner_id) VALUES
    ('dev', 'dev@agents.invalid', 'sam/dev', 'agent', 'sam'),
    ('ops', 'ops@agents.invalid', 'sam/ops', 'agent', 'sam'),
    ('bot', 'bot@agents.invalid', 'kim/bot', 'agent', 'kim');
  INSERT INTO agents (user_id, name, work_from) VALUES ('dev', 'dev', 'owner'), ('ops', 'ops', 'owner'), ('bot', 'bot', 'owner');
  INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash) VALUES
    ('sam-pat', 'sam', 'personal', 'laptop', 'write', 'h1'),
    ('dev-pat', 'dev', 'personal', 'box', 'write', 'h2'),
    ('ops-pat', 'ops', 'personal', 'box', 'write', 'h3'),
    ('bot-pat', 'bot', 'personal', 'box', 'write', 'h4');
`);
const env = { DB: d1(db) } as unknown as Parameters<typeof postRun>[1];

const user = (id: string, kind: "person" | "agent" = "person", ownerId: string | null = null) => ({
  id,
  kind,
  email: `${id}@x.test`,
  handle: ownerId ? `${ownerId}/${id}` : id,
  avatar: null,
  isAdmin: false,
  ownerId,
});
const access = (tokenId: string) => ({ tokenId, kind: "personal" as const, scope: "write" as const, via: "box" });
const agentViewer = (id: string, owner: string): Viewer => ({
  user: user(id, "agent", owner),
  access: access(`${id}-pat`),
  agent: { owner: user(owner), grants: [], workFrom: "owner", description: "" },
});
const dev = agentViewer("dev", "sam");
const ops = agentViewer("ops", "sam");
const bot = agentViewer("bot", "kim");
const samToken: Viewer = { user: user("sam"), access: access("sam-pat") };

type Answer = { status: number; code?: string; message?: string; run?: Run };
const start = async (viewer: Viewer, body: unknown): Promise<Answer> => {
  try {
    const res = await postRun(new Request("http://x/api/runs", { method: "POST", body: JSON.stringify(body) }), env, viewer, new Changes());
    return { status: res.status, run: ((await res.json()) as { run: Run }).run };
  } catch (error) {
    const e = error as { status?: number; code?: string; message?: string };
    return { status: e.status ?? 500, code: e.code, message: e.message };
  }
};
const ACCOUNT = "claude-code:3f2a91c04d5e6b7a";
const on = (host: string, cap = 2, account = ACCOUNT) => ({ client: "claude", host, account, account_cap: cap });
const live = () =>
  (db.prepare(`SELECT count(*) AS n FROM runs WHERE account = ? AND status = 'running' AND user_id != 'bot'`).get(ACCOUNT) as { n: number }).n;

/* What it takes. */
t("an account that isn't one is refused", (await start(dev, on("laptop", 2, "a b"))).status === 400 && (await start(dev, on("laptop", 2, ""))).status === 400);
t("an account past 64 characters is refused", (await start(dev, on("laptop", 2, "a".repeat(65)))).status === 400);
t("a cap that isn't a whole number from 1 is refused", (await start(dev, on("laptop", 0))).status === 400 && (await start(dev, on("laptop", 1.5))).status === 400);
t("a cap without an account is refused", (await start(dev, { client: "claude", account_cap: 2 })).status === 400);
t("nothing was started by a refused start", live() === 0);
const old = await start(dev, { client: "claude", host: "laptop" });
t("an older daemon's start, with neither, works as before", old.status === 201 && old.run?.account === null);

/* The count. */
const first = await start(dev, on("laptop"));
t("a run on an account is started and says it, in short", first.status === 201 && first.run?.account === "3f2a91");
t("the account is kept on the run as sent", (db.prepare(`SELECT account FROM runs WHERE id = ?`).get(first.run!.id) as { account: string }).account === ACCOUNT);
const second = await start(ops, on("desktop"));
t("another agent of the same owner on another machine takes the next slot", second.status === 201);
const full = await start(dev, on("laptop"));
t("past the cap, across the owner's agents and machines, it is refused as account_full", full.status === 409 && full.code === "account_full");
t("the refusal says how many are going and on which hosts", /^2 runs going on account 3f2a91 \(laptop, desktop\)/.test(full.message ?? ""));
t("the refused start left no run", live() === 2);
t("the owner's own token counts on the same account", (await start(samToken, on("laptop"))).code === "account_full");
t("a daemon with a higher cap may start one more", (await start(samToken, on("laptop", 3))).status === 201 && live() === 3);
t("another person's runs on an account of the same name never count", (await start(bot, on("server"))).status === 201);
t("a different account of the owner's has slots of its own", (await start(dev, on("laptop", 2, "codex:aa11"))).status === 201);
t("a start without a cap is never refused, and counts", (await start(dev, { client: "claude", account: ACCOUNT })).status === 201 && live() === 4);

/* Live means running and within the lease. */
db.exec(`UPDATE runs SET status = 'completed' WHERE account = '${ACCOUNT}' AND user_id IN ('dev', 'ops', 'sam')`);
t("ended runs free their slots", (await start(dev, on("laptop"))).status === 201);
db.exec(`UPDATE runs SET last_seen_at = '2026-01-01T00:00:00.000Z' WHERE account = '${ACCOUNT}' AND status = 'running' AND user_id = 'dev'`);
t("a run gone quiet past the lease no longer counts", (await start(ops, on("desktop"))).status === 201);
t("so a second fits beside it", (await start(dev, on("laptop"))).status === 201);
const quiet = await start(dev, on("laptop"));
t("and the next, at the cap again, is refused", quiet.code === "account_full" && /^2 runs going/.test(quiet.message ?? ""));

/* Two racing for the last slot. */
db.exec(`UPDATE runs SET status = 'completed' WHERE account = '${ACCOUNT}'`);
await start(dev, on("laptop"));
const raced = await Promise.all([start(dev, on("laptop")), start(ops, on("desktop"))]);
t("two daemons racing for the last slot: one gets it", raced.filter((r) => r.status === 201).length === 1);
t("and the other is refused", raced.filter((r) => r.code === "account_full").length === 1 && live() === 2);

const failed = cases.filter(([, pass]) => !pass);
for (const [name, pass] of cases) console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
if (failed.length) {
  console.error(`\n${failed.length} of ${cases.length} failed`);
  process.exit(1);
}
console.log(`\n${cases.length} checks passed`);
