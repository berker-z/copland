/* ============================================================================
   Settings › access's list (COPL-159): GET /api/tokens and DELETE
   /api/tokens/:id in src/worker/routes/tokens.ts.
   ----------------------------------------------------------------------------
   Run: npm run check. The routes run for real (checks/worker.ts) on the
   migrations in an in-memory node:sqlite. The list is everything of the
   viewer's that still works, plus the apps connected as their live agents,
   each saying which agent (`as`); an agent's personal tokens, someone
   else's agents' apps and dead tokens stay off it. Revoking an agent's app
   from it works, and only for its owner. An agent's page (listTokens) is
   unchanged: all of the agent's, none of them with an `as`.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { ApiToken, Viewer } from "../src/domain/types.ts";

const { deleteToken, getTokens } = await import("../src/worker/routes/tokens.ts");
const { listTokens } = await import("../src/worker/tokens.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const db = sqlite();
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam'), ('kim', 'kim@x.test', 'kim');
  INSERT INTO users (id, email, handle, kind, owner_id, disabled_at) VALUES
    ('dev', 'dev@agents.invalid', 'sam/dev', 'agent', 'sam', NULL),
    ('old', 'old@agents.invalid', 'sam/old', 'agent', 'sam', '2026-01-01T00:00:00.000Z'),
    ('bot', 'bot@agents.invalid', 'kim/bot', 'agent', 'kim', NULL);
  INSERT INTO agents (user_id, name) VALUES ('dev', 'dev'), ('old', 'old'), ('bot', 'bot');
`);
const token = (id: string, user: string, kind: "personal" | "oauth", o: { created: number; expires?: number | null; refresh?: number; revoked?: boolean }) =>
  db
    .prepare(
      `INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash, expires_at, refresh_expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, 'write', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      user,
      kind,
      kind === "oauth" ? "Claude" : "laptop",
      `h-${id}`,
      o.expires === undefined ? (kind === "oauth" ? at(7) : null) : o.expires === null ? null : at(o.expires),
      kind === "oauth" ? at(o.refresh ?? 90) : null,
      o.revoked ? at(-1) : null,
      at(o.created),
    );
token("sam-pat", "sam", "personal", { created: -5 });
token("sam-app", "sam", "oauth", { created: -4 });
token("dev-app", "dev", "oauth", { created: -3 });
token("dev-pat", "dev", "personal", { created: -2 });
/* An app whose access token lapsed but can still refresh is still connected. */
token("dev-app-stale", "dev", "oauth", { created: -6, expires: -1 });
token("dev-app-gone", "dev", "oauth", { created: -1, revoked: true });
token("dev-app-dead", "dev", "oauth", { created: -7, expires: -1, refresh: -1 });
token("old-app", "old", "oauth", { created: -1 });
token("bot-app", "bot", "oauth", { created: -1 });
token("kim-pat", "kim", "personal", { created: -2 });

const env = { DB: d1(db) } as unknown as Parameters<typeof getTokens>[0];
const changes = { notify: () => {} } as unknown as Parameters<typeof deleteToken>[3];
const who = (id: string): Viewer => ({ user: { id, kind: "person", email: `${id}@x.test`, handle: id, avatar: null, isAdmin: false, ownerId: null } });
const sam = who("sam");
const kim = who("kim");
const status = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 500;
  }
};
const list = async (viewer: Viewer) => (await (await getTokens(env, viewer)).json()) as ApiToken[];
const ids = (tokens: ApiToken[]) => tokens.map((x) => x.id).join(",");

const mine = await list(sam);
t("sam's list is his own and his live agent's apps, newest first", ids(mine) === "dev-app,sam-app,sam-pat,dev-app-stale");
t("his own say nothing about who they act as", mine.filter((x) => x.id.startsWith("sam-")).every((x) => x.as === null));
t("an agent's app says which agent", mine.filter((x) => x.id.startsWith("dev-")).every((x) => x.as === "sam/dev" && x.kind === "oauth"));
t("an agent's personal token stays on its page", !mine.some((x) => x.id === "dev-pat"));
t("a revoked or no longer refreshable app is gone", !mine.some((x) => x.id === "dev-app-gone" || x.id === "dev-app-dead"));
t("a deleted agent's app is gone", !mine.some((x) => x.id === "old-app"));
t("someone else's agent's app is not sam's", !mine.some((x) => x.id === "bot-app"));
t("kim sees hers and her agent's, not sam's", ids(await list(kim)) === "bot-app,kim-pat");

const agentPage = await listTokens(env.DB, "dev");
t("the agent's page still lists all of its tokens", ids(agentPage) === "dev-pat,dev-app,dev-app-stale");
t("and none of them names who it acts as", agentPage.every((x) => x.as === null));

const withToken: Viewer = { ...sam, access: { tokenId: "sam-pat", kind: "personal", scope: "write", via: "laptop" } };
t("a token can't list tokens", (await status(() => getTokens(env, withToken))) === 403);

t("kim can't revoke sam's agent's app", (await status(() => deleteToken(env, kim, "dev-app", changes))) === 404);
const after = (await (await deleteToken(env, sam, "dev-app", changes)).json()) as ApiToken[];
t("sam revokes his agent's app from the list", ids(after) === "sam-app,sam-pat,dev-app-stale");
t("and it is revoked for the agent too", !(await listTokens(env.DB, "dev")).some((x) => x.id === "dev-app"));

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} token list checks passed`);
if (failed) process.exit(1);
