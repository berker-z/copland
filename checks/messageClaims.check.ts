/* ============================================================================
   Message claims (COPL-124): POST and DELETE /api/messages/:id/claim in
   src/worker/routes/runs.ts, the claim on inbox items, and the MCP's
   claim_message and release_message.
   ----------------------------------------------------------------------------
   Run: npm run check. The routes run for real (checks/worker.ts) on the
   migrations in an in-memory node:sqlite: one live claim per message, the
   same run renews, a release or a dead run frees it for the next run, only
   the recipient claims, reading a message ends its claim, and two runs
   racing for one message don't both win.
   ========================================================================== */

import { d1, sqlite } from "./worker.ts";
import type { ApiAccess, MessageClaimed, Viewer } from "../src/domain/types.ts";
import type { ApiCall } from "../src/worker/mcp.ts";

const { deleteMessageClaim, postMessageClaim, postRunFinish } = await import("../src/worker/routes/runs.ts");
const { postInboxDismiss, postInboxRead, readInbox } = await import("../src/worker/routes/inbox.ts");
const { runTouchStatements } = await import("../src/worker/repo/runs.ts");
const { sweepStaleRuns } = await import("../src/worker/deadRuns.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const db = sqlite();
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam'), ('ada', 'ada@x.test', 'ada');
  INSERT INTO users (id, email, handle, kind, owner_id) VALUES ('dev', 'dev@agents.invalid', 'sam/dev', 'agent', 'sam');
  INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash, client) VALUES
    ('tk-dev', 'dev', 'personal', 'box', 'write', 'h-dev', 'claude-code'),
    ('tk-dev2', 'dev', 'personal', 'chat', 'write', 'h-dev2', NULL),
    ('tk-ada', 'ada', 'personal', 'ada', 'write', 'h-ada', NULL),
    ('tk-sam', 'sam', 'personal', 'sam', 'write', 'h-sam', NULL);
  INSERT INTO runs (id, user_id, token_id, token_hash, client) VALUES
    ('r1', 'dev', 'tk-dev', 'rh1', 'claude-code'), ('r2', 'dev', 'tk-dev', 'rh2', 'claude-code'), ('r3', 'dev', 'tk-dev', 'rh3', NULL);
`);
let n = 0;
/** A message from sam to dev, unread in dev's inbox: its id, and its inbox item's. */
const message = () => {
  const id = `m${++n}`;
  db.exec(`INSERT INTO messages (id, sender_id, recipient_id, text) VALUES ('${id}', 'sam', 'dev', 'hi ${n}');
    INSERT INTO inbox_items (id, user_id, kind, message_id, actor_id) VALUES ('i${n}', 'dev', 'message', '${id}', 'sam')`);
  return { id, item: `i${n}` };
};

/* before() runs inside the next batch, ahead of its statements: another request landing between the look and the write. */
let beforeBatch: (() => void) | null = null;
const real = d1(db);
const DB = { prepare: real.prepare, batch: (stmts: D1PreparedStatement[]) => (beforeBatch?.(), (beforeBatch = null), real.batch(stmts)) };
const env = { DB } as unknown as Parameters<typeof postMessageClaim>[0];
const changes = { notify: () => {} } as unknown as Parameters<typeof postMessageClaim>[3];

const person = (id: string, kind: "person" | "agent" = "person"): Viewer["user"] => ({
  id,
  kind,
  email: null,
  handle: id === "dev" ? "sam/dev" : id,
  avatar: null,
  isAdmin: false,
  ownerId: kind === "agent" ? "sam" : null,
});
const access = (tokenId: string, extra: Partial<ApiAccess> = {}): ApiAccess => ({ tokenId, kind: "personal", scope: "write", via: "Claude Code", ...extra });
const run = (runId: string): Viewer => ({ user: person("dev", "agent"), access: access("tk-dev", { runId }) });
const chat: Viewer = { user: person("dev", "agent"), access: access("tk-dev2") };
const ada: Viewer = { user: person("ada"), access: access("tk-ada") };
const sam: Viewer = { user: person("sam"), access: access("tk-sam") };

const claim = async (viewer: Viewer, id: string) => (await (await postMessageClaim(env, viewer, id, changes)).json()) as MessageClaimed;
/** The status and code a call is refused with, or "ok". */
const outcome = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return "ok";
  } catch (error) {
    const e = error as { status?: number; code?: string };
    return `${e.status}${e.code ? ` ${e.code}` : ""}`;
  }
};
const row = (id: string) =>
  db.prepare(`SELECT run_id, claimed_at, claimed_until FROM message_claims WHERE message_id = ?`).get(id) as
    | { run_id: string; claimed_at: string; claimed_until: string }
    | undefined;
const inboxClaim = async (id: string) => (await readInbox(env, run("r1"))).items.find((i) => i.message?.id === id)?.message?.claim ?? null;
const req = (body: unknown) => new Request("https://x.test/", { method: "POST", body: JSON.stringify(body) });

/* One live claim per message. */
const a = message();
const first = await claim(run("r1"), a.id);
t("a run claims a message sent to it", first.messageId === a.id && first.claim.runId === "r1" && first.claim.run === "r1" && first.claim.kind === "supervised");
t("a second run's claim is refused, saying who holds it", (await outcome(() => claim(run("r2"), a.id))) === "409 claimed" && row(a.id)?.run_id === "r1");
const before = row(a.id)!;
db.prepare(`UPDATE message_claims SET claimed_until = ? WHERE message_id = ?`).run(new Date(Date.now() + 60_000).toISOString(), a.id);
const again = await claim(run("r1"), a.id);
t("the same run claiming again renews it, from when it first claimed", again.claim.runId === "r1" && row(a.id)!.claimed_at === before.claimed_at && Date.parse(row(a.id)!.claimed_until) > Date.now() + 5 * 60_000);
t("the inbox says which run holds it", (await inboxClaim(a.id))?.runId === "r1");

/* Only the recipient. */
t("someone else can't claim it: not found", (await outcome(() => claim(ada, a.id))) === "404");
t("not even its sender", (await outcome(() => claim(sam, a.id))) === "404");
t("a message that isn't there is not found", (await outcome(() => claim(run("r1"), "nope"))) === "404");
t("someone else can't release it", (await outcome(() => deleteMessageClaim(env, ada, a.id, changes))) === "404" && !!row(a.id));
t("a claim needs a token", (await outcome(() => claim({ user: person("dev", "agent") }, a.id))) === "403");

/* Release, and the next run takes it. */
await deleteMessageClaim(env, run("r1"), a.id, changes);
t("release ends the claim, and the message is unclaimed in the inbox", !row(a.id) && (await inboxClaim(a.id)) === null);
t("releasing what you don't hold is refused", (await outcome(() => deleteMessageClaim(env, run("r1"), a.id, changes))) === "404");
t("after a release another run claims it", (await claim(run("r2"), a.id)).claim.runId === "r2");

/* A dead run's claim lapses so another run can claim. */
db.prepare(`UPDATE runs SET status = 'failed', ended_at = ? WHERE id = 'r2'`).run(new Date().toISOString());
t("a claim whose run ended no longer shows", (await inboxClaim(a.id)) === null);
t("a dead run's claim is replaced by the next run's", (await claim(run("r3"), a.id)).claim.runId === "r3" && row(a.id)?.run_id === "r3");
db.prepare(`UPDATE message_claims SET claimed_until = ? WHERE message_id = ?`).run(new Date(Date.now() - 1000).toISOString(), a.id);
t("a claim past its lease no longer shows", (await inboxClaim(a.id)) === null);
t("a lapsed claim is replaced by the next run's", (await claim(run("r1"), a.id)).claim.runId === "r1");

/* finish_run releases. */
await postRunFinish(req({ status: "failed" }), env, run("r1"), "r1", changes);
t("finishing the run releases its message claims; the message stays unread", !row(a.id) && (await readInbox(env, chat)).items.some((i) => i.message?.id === a.id && i.readAt === null));

/* The cron's sweep ends a quiet supervised run, and its message goes back to unclaimed. */
db.exec(`INSERT INTO runs (id, user_id, token_id, token_hash, client) VALUES ('r4', 'dev', 'tk-dev', 'rh4', NULL)`);
await claim(run("r4"), a.id);
db.prepare(`UPDATE runs SET last_seen_at = ? WHERE id = 'r4'`).run(new Date(Date.now() - 60 * 60_000).toISOString());
await sweepStaleRuns(env, { waitUntil: () => {} } as unknown as ExecutionContext);
t("a run gone quiet is swept, and its message is unclaimed for the next run", !row(a.id) && (await claim(run("r3"), a.id)).claim.runId === "r3");
await deleteMessageClaim(env, run("r3"), a.id, changes);

/* The lease is renewed by the run's calls. */
const b = message();
await claim(run("r3"), b.id);
db.prepare(`UPDATE message_claims SET claimed_until = ? WHERE message_id = ?`).run(new Date(Date.now() + 2 * 60_000).toISOString(), b.id);
await real.batch(runTouchStatements(env.DB, "r3", "supervised") as never);
t("a call through the run renews its message claims", Date.parse(row(b.id)!.claimed_until) > Date.now() + 5 * 60_000);

/* A chat session gets an interactive run, as claim_task does. */
const c = message();
const viaChat = await claim(chat, c.id);
t("a chat session's claim makes it an interactive run", viaChat.claim.kind === "interactive" && viaChat.claim.runId !== "r3");
t("which another run is then refused by", (await outcome(() => claim(run("r3"), c.id))) === "409 claimed");

/* Reading it ends the claim, and a read message is not claimed again. */
await postInboxRead(req({ ids: [b.item] }), env, run("r3"), changes);
t("marking a message read releases its claim", !row(b.id));
t("a read message is refused", (await outcome(() => claim(run("r3"), b.id))) === "409 read");
await postInboxDismiss(req({ ids: [`i${c.id.slice(1)}`] }), env, chat, changes);
t("dismissing a message releases its claim, and it is not claimed again", !row(c.id) && (await outcome(() => claim(chat, c.id))) === "409 read");
const d = message();
await claim(run("r3"), d.id);
await postInboxRead(req({}), env, run("r3"), changes);
t("marking everything read releases every claim", !row(d.id));

/* Two runs racing for one message. */
const e = message();
beforeBatch = () => {
  db.prepare(`INSERT INTO message_claims (message_id, run_id, user_id, claimed_until) VALUES (?, 'r3', 'dev', ?)`).run(
    e.id,
    new Date(Date.now() + 60_000).toISOString(),
  );
};
const racing = { user: person("dev", "agent"), access: access("tk-dev2") } satisfies Viewer;
t("of two runs racing for a message, the later is refused", (await outcome(() => claim(racing, e.id))) === "409 claimed" && row(e.id)?.run_id === "r3");
const f = message();
beforeBatch = () => void db.prepare(`UPDATE inbox_items SET read_at = ? WHERE message_id = ?`).run(new Date().toISOString(), f.id);
t("a claim racing a mark_read is refused as read", (await outcome(() => claim(run("r3"), f.id))) === "409 read" && !row(f.id));

/* The MCP. */
const { CallError, handleMcp } = await import("../src/worker/mcp.ts");
const { requireWriteScope } = await import("../src/worker/tokens.ts");
const api = (viewer: Viewer): ApiCall => async <T>(method: string, path: string): Promise<T> => {
  try {
    requireWriteScope(viewer, method);
    const claimPath = /^\/api\/messages\/([^/]+)\/claim$/.exec(path);
    if (claimPath && method === "POST") return (await (await postMessageClaim(env, viewer, decodeURIComponent(claimPath[1]), changes)).json()) as T;
    if (claimPath && method === "DELETE") return (await (await deleteMessageClaim(env, viewer, decodeURIComponent(claimPath[1]), changes)).json()) as T;
    if (path.startsWith("/api/inbox?")) return (await readInbox(env, viewer, { unread: true })) as T;
    throw new Error(`no route ${method} ${path}`);
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
const g = message();
const took = await tool(run("r3"), "claim_message", { message: g.id });
t("claim_message claims it for the connection's run", !took.error && JSON.parse(took.text).run === "r3" && JSON.parse(took.text).claimed_by === "@sam/dev");
const h = message();
const listed = JSON.parse((await tool(run("r3"), "inbox", {})).text) as { items: Array<{ message?: { id: string; run?: string; claimed_by?: string } }> };
t("inbox shows the message's claimed_by and run", listed.items.find((i) => i.message?.id === g.id)?.message?.run === "r3");
t("an unclaimed message shows neither", (() => {
  const m = listed.items.find((i) => i.message?.id === h.id)?.message;
  return !!m && m.run === undefined && m.claimed_by === undefined;
})());
const other = await tool(chat, "claim_message", { message: g.id });
t("claim_message says why it refused, in a word", other.error && other.text.startsWith("Not claimed (claimed)"));
const readOnly: Viewer = { user: person("dev", "agent"), access: access("tk-dev2", { scope: "read" }) };
const ro = await tool(readOnly, "claim_message", { message: g.id });
t("a read-only connection can't claim", ro.error && ro.text.includes("read-only"));
t("release_message lets it go", !(await tool(run("r3"), "release_message", { message: g.id })).error && !row(g.id));
const gone = await tool(run("r3"), "release_message", { message: g.id });
t("release_message refuses what you don't hold", gone.error && gone.text.includes("no claim"));

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} message claim checks passed`);
if (failed) process.exit(1);
