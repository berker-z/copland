/* ============================================================================
   Messages: who may message whom, and what the inbox table allows
   (src/domain/messages.ts, migrations/0025_messages.sql).
   ----------------------------------------------------------------------------
   Run: npm run check. The rule is a pure function, held against every pair
   of principals. The table is checked by applying every migration to an
   in-memory SQLite (node:sqlite) and writing items that must and must not
   go in: a message may point at no task, nothing else may.
   ========================================================================== */

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mayMessage, type MessageParty } from "../src/domain/messages.ts";

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const sam: MessageParty = { id: "sam", kind: "person", ownerId: null };
const ada: MessageParty = { id: "ada", kind: "person", ownerId: null };
const dev: MessageParty = { id: "dev", kind: "agent", ownerId: "sam", workFrom: "owner" };
const open: MessageParty = { id: "open", kind: "agent", ownerId: "sam", workFrom: "members" };
const adas: MessageParty = { id: "adas", kind: "agent", ownerId: "ada", workFrom: "owner" };

const ok = (v: ReturnType<typeof mayMessage>, trusted: boolean) => v.ok && v.trusted === trusted;
const no = (v: ReturnType<typeof mayMessage>) => !v.ok;

t("a person messages their own agent, trusted", ok(mayMessage(sam, dev), true));
t("an agent messages its owner, trusted", ok(mayMessage(dev, sam), true));
t("nobody messages themselves", no(mayMessage(sam, sam)) && no(mayMessage(dev, dev)));
t("people don't message people", no(mayMessage(sam, ada)) && no(mayMessage(sam, ada, { sharesBoard: true })));
t("agents don't message agents, even their owner's other ones", no(mayMessage(dev, open)) && no(mayMessage(dev, adas)));
t("agents don't message agents, even as a reply", no(mayMessage(dev, adas, { reply: true })));
t("an agent doesn't message someone other than its owner", no(mayMessage(dev, ada)) && no(mayMessage(dev, ada, { sharesBoard: true })));
t("someone else can't message an owner-only agent", no(mayMessage(ada, dev)) && no(mayMessage(ada, dev, { sharesBoard: true })));
t("someone else can't message an open agent without a shared board", no(mayMessage(ada, open)));
t("someone else messages an open agent on a shared board, untrusted", ok(mayMessage(ada, open, { sharesBoard: true }), false));
t("the owner's message to an open agent is still trusted", ok(mayMessage(sam, open), true));
t("an agent answers a member who messaged it, untrusted", ok(mayMessage(open, ada, { reply: true }), false));
t("a person answers another's agent that answered them, untrusted", ok(mayMessage(ada, open, { reply: true }), false));
t("an agent answering its owner is trusted", ok(mayMessage(dev, sam, { reply: true }), true));
t("a refusal says why", (() => {
  const v = mayMessage(ada, dev);
  return !v.ok && /owner/.test(v.reason);
})());

/* The table. */
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  db.exec(readFileSync(`migrations/${file}`, "utf8"));
}
db.exec(`INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam'), ('ada', 'ada@x.test', 'ada');
  INSERT INTO messages (id, sender_id, recipient_id, text) VALUES ('m1', 'sam', 'ada', 'hi');`);
const fits = (sql: string) => {
  try {
    db.exec(sql);
    return true;
  } catch {
    return false;
  }
};
const item = (id: string, kind: string, board: string | null, task: string | null, message: string | null) =>
  `INSERT INTO inbox_items (id, user_id, kind, board_id, task_id, message_id, actor_id)
   VALUES ('${id}', 'ada', '${kind}', ${board ? `'${board}'` : "NULL"}, ${task ? `'${task}'` : "NULL"}, ${message ? `'${message}'` : "NULL"}, 'sam')`;
t("a task-less message goes in", fits(item("i1", "message", null, null, "m1")));
t("a message without its text doesn't", !fits(item("i2", "message", null, null, null)));
t("an item of another kind without a task doesn't", !fits(item("i3", "assigned", null, null, null)));
t("an item of another kind can't carry a message", !fits(item("i4", "commented", null, null, "m1")));
t("an unknown kind doesn't", !fits(item("i5", "nudge", null, null, "m1")));
t("the paging indexes are there", (() => {
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'inbox_items'`).all() as { name: string }[]).map((r) => r.name);
  return names.includes("inbox_items_unread") && names.includes("inbox_items_newest");
})());

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} message checks passed`);
if (failed) process.exit(1);
