/* ============================================================================
   Where each agent runs (COPL-176, part of COPL-135): PUT /api/hosts/self in
   src/worker/routes/hosts.ts, a run's host on POST /api/runs, and how the
   owner reads them on GET /api/agents and GET /api/messages/recipients.
   ----------------------------------------------------------------------------
   Run: npm run check. The routes run for real (checks/worker.ts) on the
   migrations in an in-memory node:sqlite; the live hubs are a stand-in that
   says which hosts each principal's sockets named. Only an agent's own
   token reports a host, never a session, a person's token or a run's
   secret; a report is checked and bounded, upserts by hostname, and tells
   the owner's tabs. The owner sees each host with whether it is live now,
   and the flag for one agent live on two hosts at once; nobody else sees
   where someone's agent runs.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { Agent, Recipient, Viewer } from "../src/domain/types.ts";
import { MAX_HOSTS, MAX_REPOS, parseHostReport } from "../src/domain/hosts.ts";

const { putOwnHost } = await import("../src/worker/routes/hosts.ts");
const { getAgents } = await import("../src/worker/routes/agents.ts");
const { getRecipients } = await import("../src/worker/routes/messages.ts");
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
  INSERT INTO agents (user_id, name, work_from) VALUES ('dev', 'dev', 'members'), ('ops', 'ops', 'owner'), ('bot', 'bot', 'owner');
  INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash) VALUES
    ('sam-pat', 'sam', 'personal', 'laptop', 'write', 'h1'),
    ('dev-pat', 'dev', 'personal', 'box', 'write', 'h2'),
    ('ops-pat', 'ops', 'personal', 'box', 'write', 'h3');
  INSERT INTO boards (id, key, name, created_by) VALUES ('b', 'BB', 'shared', 'sam');
  INSERT INTO board_members (board_id, user_id, role) VALUES ('b', 'sam', 'owner'), ('b', 'kim', 'editor'), ('b', 'dev', 'editor');
`);

/* The live hubs: which (token, host) each principal's sockets have, as LiveHub.listening says. */
let sockets: Record<string, { tokenId: string; host: string | null }[]> = {};
const LIVE = { idFromName: (name: string) => name, get: (id: string) => ({ listening: async () => sockets[id] ?? [] }) };
const env = { DB: d1(db), LIVE } as unknown as Parameters<typeof putOwnHost>[1];

const user = (id: string, kind: "person" | "agent" = "person", ownerId: string | null = null) => ({
  id,
  kind,
  email: `${id}@x.test`,
  handle: ownerId ? `${ownerId}/${id}` : id,
  avatar: null,
  isAdmin: false,
  ownerId,
});
const sam: Viewer = { user: user("sam") };
const kim: Viewer = { user: user("kim") };
const access = (tokenId: string, runId?: string) => ({ tokenId, kind: "personal" as const, scope: "write" as const, via: "box", ...(runId ? { runId } : {}) });
const agentViewer = (id: string, runId?: string): Viewer => ({
  user: user(id, "agent", "sam"),
  access: access(`${id}-pat`, runId),
  agent: { owner: user("sam"), grants: [], workFrom: "owner", description: "" },
});
const dev = agentViewer("dev");
const ops = agentViewer("ops");
const samToken: Viewer = { user: user("sam"), access: access("sam-pat") };

const capabilities = {
  runtimes: [{ name: "claude", onPath: true, loggedIn: true }],
  repos: [{ repo: "berker-z/copland", clone: true, push: false, detail: "no push access" }],
};
const report = (hostname: string, extra: Record<string, unknown> = {}) => ({ hostname, version: "0.9.0", capabilities, ...extra });
const put = (body: unknown) => new Request("http://x/api/hosts/self", { method: "PUT", body: JSON.stringify(body) });
const status = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 500;
  }
};
const send = (viewer: Viewer, body: unknown, changes = new Changes()) => status(() => putOwnHost(put(body), env, viewer, changes));
const rows = (agent: string) =>
  db.prepare(`SELECT hostname, version, capabilities, first_reported_at, last_reported_at FROM agent_hosts WHERE user_id = ? ORDER BY hostname`).all(agent) as {
    hostname: string;
    version: string;
    capabilities: string;
    first_reported_at: string;
    last_reported_at: string;
  }[];

/* Who may report. */
t("a session can't report a host", (await send(sam, report("laptop"))) === 403);
t("a person's token can't report a host", (await send(samToken, report("laptop"))) === 403);
t("a run's secret can't report a host", (await send(agentViewer("dev", "run-1"), report("laptop"))) === 403);
t("nothing was kept from a refused report", rows("dev").length === 0);

/* What it keeps. */
const told = new Changes();
t("an agent's own token reports its host", (await send(dev, report("Laptop"), told)) === 200);
t("the hostname is kept lowercased, with its version and capabilities", (() => {
  const [row] = rows("dev");
  return row?.hostname === "laptop" && row.version === "0.9.0" && JSON.stringify(JSON.parse(row.capabilities)) === JSON.stringify(capabilities);
})());
t("the report tells the owner's tabs, not the agent's", (() => {
  const events = told.events(null);
  return events.get("sam")?.[0]?.topics.includes("agents") === true && !events.has("dev");
})());
const first = rows("dev")[0].first_reported_at;
db.exec(`UPDATE agent_hosts SET first_reported_at = '2026-01-01T00:00:00.000Z', last_reported_at = '2026-01-01T00:00:00.000Z'`);
t("a second report from the same host replaces it", (await send(dev, report("laptop", { version: "1.0.0" }))) === 200 && rows("dev").length === 1 && rows("dev")[0].version === "1.0.0");
t("and keeps when it first reported", rows("dev")[0].first_reported_at === "2026-01-01T00:00:00.000Z" && rows("dev")[0].last_reported_at >= first);
t("another host is a row of its own", (await send(dev, report("server"))) === 200 && rows("dev").map((r) => r.hostname).join(",") === "laptop,server");
t("hosts are per agent", (await send(ops, report("laptop"))) === 200 && rows("ops").length === 1 && rows("dev").length === 2);

/* What it refuses. */
t("a hostname that isn't one is refused", (await send(dev, report("-x"))) === 400 && (await send(dev, report("a b"))) === 400 && (await send(dev, report(""))) === 400);
t("a hostname past 253 characters is refused", (await send(dev, report("h".repeat(254)))) === 400);
t("no version is refused", (await send(dev, report("laptop", { version: "" }))) === 400);
t("capabilities missing a list are refused", (await send(dev, report("laptop", { capabilities: { runtimes: [] } }))) === 400);
t("a runtime without its flags is refused", (await send(dev, report("laptop", { capabilities: { runtimes: [{ name: "claude" }], repos: [] } }))) === 400);
t("a repo whose push isn't a boolean is refused", (await send(dev, report("laptop", { capabilities: { runtimes: [], repos: [{ repo: "a/b", clone: true, push: "yes" }] } }))) === 400);
t(
  "too many repos are refused",
  (await send(dev, report("laptop", { capabilities: { runtimes: [], repos: Array.from({ length: MAX_REPOS + 1 }, (_, i) => ({ repo: `a/${i}`, clone: true, push: true })) } }))) === 400,
);
t("a refused report changed nothing", rows("dev")[0].version === "1.0.0");
t("a detail is one line, and may be left out", (() => {
  const parsed = parseHostReport(report("x", { capabilities: { runtimes: [], repos: [{ repo: "a/b", clone: true, push: true, detail: " ssh\n key " }, { repo: "c/d", clone: false, push: false }] } }));
  return parsed.ok && parsed.report.capabilities.repos[0].detail === "ssh key" && parsed.report.capabilities.repos[1].detail === null;
})());
t("unknown fields in a capability are dropped", (() => {
  const parsed = parseHostReport(report("x", { capabilities: { runtimes: [{ name: "codex", onPath: true, loggedIn: false, secret: "s" }], repos: [] } }));
  return parsed.ok && JSON.stringify(parsed.report.capabilities.runtimes[0]) === `{"name":"codex","onPath":true,"loggedIn":false}`;
})());

/* Bounded: past MAX_HOSTS the one quiet the longest goes. */
for (let i = 0; i < MAX_HOSTS + 2; i++) {
  db.exec(`UPDATE agent_hosts SET last_reported_at = '2026-01-01T00:00:00.000Z' WHERE user_id = 'ops' AND hostname = 'laptop'`);
  await send(ops, report(`h${String(i).padStart(2, "0")}`));
}
t(`an agent keeps at most ${MAX_HOSTS} hosts`, rows("ops").length === MAX_HOSTS);
t("the one quiet the longest went first", !rows("ops").some((r) => r.hostname === "laptop"));
db.exec(`DELETE FROM agent_hosts WHERE user_id = 'ops'`);

/* A run's host. */
const startRun = (viewer: Viewer, body: unknown) =>
  postRun(new Request("http://x/api/runs", { method: "POST", body: JSON.stringify(body) }), env, viewer, new Changes());
const started = (await (await startRun(dev, { client: "claude", host: "Laptop" })).json()) as { run: { host: string | null } };
t("a run started with a host says it, as a hostname", started.run.host === "laptop");
const plain = (await (await startRun(dev, { client: "claude" })).json()) as { run: { host: string | null } };
t("a run started without one has none", plain.run.host === null);
t("a run's host that isn't a hostname is refused", (await status(() => startRun(dev, { host: "not a host" }))) === 400);

/* What the owner reads. */
const agents = async () => (await (await getAgents(env, sam)).json()) as Agent[];
const of = (list: Agent[], id: string) => list.find((a) => a.user.id === id)!;
db.exec(`UPDATE agent_hosts SET last_reported_at = CASE hostname WHEN 'server' THEN '2026-02-02T00:00:00.000Z' ELSE '2026-02-01T00:00:00.000Z' END WHERE user_id = 'dev'`);
sockets = { dev: [{ tokenId: "dev-pat", host: "laptop" }] };
let list = await agents();
t("the agent's page lists its hosts, the latest report first", of(list, "dev").hosts.map((h) => h.hostname).join(",") === "server,laptop");
t("each says whether it is live now", of(list, "dev").hosts.find((h) => h.hostname === "laptop")?.live === true && of(list, "dev").hosts.find((h) => h.hostname === "server")?.live === false);
t("with its version and capabilities", of(list, "dev").hosts.find((h) => h.hostname === "laptop")?.version === "1.0.0" && of(list, "dev").hosts[0].capabilities.repos[0].push === false);
t("live on one host is no warning", of(list, "dev").liveOnTwoHosts === false);
t("an agent that never reported has no hosts", of(list, "ops").hosts.length === 0 && of(list, "ops").liveOnTwoHosts === false);
sockets = { dev: [{ tokenId: "dev-pat", host: "laptop" }, { tokenId: "dev-pat", host: "server" }] };
list = await agents();
t("live on two hosts at once is flagged", of(list, "dev").liveOnTwoHosts === true && of(list, "dev").hosts.every((h) => h.live));
sockets = { dev: [{ tokenId: "dev-pat", host: "laptop" }, { tokenId: "dev-pat", host: null }] };
t("a socket that named no host doesn't make a second", (await agents()).find((a) => a.user.id === "dev")?.liveOnTwoHosts === false);
sockets = { dev: [{ tokenId: "dev-pat", host: "laptop" }, { tokenId: "dev-pat", host: "desk" }] };
t("a live host that never reported still counts for the flag", of(await agents(), "dev").liveOnTwoHosts === true);
db.exec(`UPDATE api_tokens SET revoked_at = '2026-01-01T00:00:00.000Z' WHERE id = 'dev-pat'`);
t("a revoked token's sockets are live nowhere", (await agents()).find((a) => a.user.id === "dev")?.hosts.every((h) => !h.live) === true);
db.exec(`UPDATE api_tokens SET revoked_at = NULL WHERE id = 'dev-pat'`);
t("a token can't read the agent's page", (await status(() => getAgents(env, samToken))) === 403);
t("kim's agent page has only kim's agent, and none of sam's agents' hosts", ((await (await getAgents(env, kim)).json()) as Agent[]).map((a) => `${a.user.id}:${a.hosts.length}`).join(",") === "bot:0");

/* The nudge pane: the owner sees where their own agent is live; someone else doesn't. */
sockets = { dev: [{ tokenId: "dev-pat", host: "laptop" }, { tokenId: "dev-pat", host: "server" }] };
const recipients = async (viewer: Viewer) => (await (await getRecipients(env, viewer)).json()) as Recipient[];
const samDev = (await recipients(sam)).find((r) => r.user.id === "dev");
t("the owner's pane says the hosts their agent is live on, and warns", samDev?.hosts.join(",") === "laptop,server" && samDev.liveOnTwoHosts === true && samDev.connected);
const kimDev = (await recipients(kim)).find((r) => r.user.id === "dev");
t("someone else's pane says it is connected, never where", kimDev?.connected === true && kimDev.hosts.length === 0 && kimDev.liveOnTwoHosts === false);

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} host checks passed`);
if (failed) process.exit(1);
