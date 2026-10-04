/* ============================================================================
   Opening a task reads its inbox items (src/domain/inbox.ts, COPL-138).
   ----------------------------------------------------------------------------
   Run: npm run check. Which of the viewer's items opening a task marks
   read: the unread ones on that task, given, mentioned or commented, and
   never a message, about that task or not.
   ========================================================================== */

import { readOnOpen } from "../src/domain/inbox.ts";
import type { InboxItem } from "../src/domain/types.ts";

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

type Item = Pick<InboxItem, "id" | "kind" | "task" | "readAt">;
const on = (id: string) => ({ id, key: id.toUpperCase(), title: id, boardId: "b", boardName: "b" });
const item = (id: string, kind: InboxItem["kind"], task: string | null, read = false): Item => ({
  id,
  kind,
  task: task ? on(task) : null,
  readAt: read ? "2026-10-05T00:00:00.000Z" : null,
});

const items: Item[] = [
  item("given", "assigned", "t1"),
  item("mention", "mentioned", "t1"),
  item("comment", "commented", "t1"),
  item("message", "message", "t1"),
  item("loose", "message", null),
  item("seen", "mentioned", "t1", true),
  item("elsewhere", "mentioned", "t2"),
  item("elsewhereComment", "commented", "t2"),
];
const ids = (taskId: string) => readOnOpen(items, taskId).join(",");

t("a task's unread assignment, mention and comment are marked", ids("t1") === "given,mention,comment");
t("a message about the task is not", !readOnOpen(items, "t1").includes("message"));
t("a message about nothing is not", !readOnOpen(items, "t1").includes("loose"));
t("an item already read is not sent again", !readOnOpen(items, "t1").includes("seen"));
t("items on other tasks are left alone", ids("t2") === "elsewhere,elsewhereComment");
t("nothing unread on the task is nothing to send", ids("t3") === "" && readOnOpen([], "t1").length === 0);
t("only messages unread is nothing to send", readOnOpen([item("m", "message", "t1")], "t1").length === 0);

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} inbox checks passed`);
if (failed) process.exit(1);
