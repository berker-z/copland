/* ============================================================================
   The MCP drift guard (AGENTS.md, src/worker/mcpCoverage.ts).
   ----------------------------------------------------------------------------
   Run: npm run check. Reads the route table in src/worker/index.ts and the
   tools in src/worker/mcp.ts as text, so it does not pull the Worker into a
   Node script, and holds them against ROUTE_COVERAGE: every route accounted
   for, no stale entries, no tools that do not exist, no tool without a
   route behind it. And the credits are true: each tool's source is scanned
   for the routes it calls (ctx.call directly, or through a helper such as
   load(ctx) or loadTask(ctx)), and those must be exactly the routes that
   name it.

   Plain TypeScript that node runs as it is (type stripping), hence the .ts
   in the import.
   ========================================================================== */

import { readFileSync } from "node:fs";
import { ROUTE_COVERAGE } from "../src/worker/mcpCoverage.ts";
import { newTaskBoard } from "../src/domain/tasks.ts";

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const index = readFileSync("src/worker/index.ts", "utf8");
const routes = new Set(
  [...index.matchAll(/\.on\(\s*"(GET|POST|PATCH|PUT|DELETE)",\s*"(\/api\/[^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`),
);
const mcp = readFileSync("src/worker/mcp.ts", "utf8");

/* The tools are the `name: "…"` entries of the TOOLS array; each tool's
   source runs to the next one's name. */
const toolsStart = mcp.indexOf("const TOOLS");
const toolsText = toolsStart >= 0 ? mcp.slice(toolsStart) : "";
const nameLines = [...toolsText.matchAll(/^[ \t]*name:\s*"([a-z_]+)",?[ \t]*$/gm)];
const toolSource = new Map(
  nameLines.map((m, i) => [m[1], toolsText.slice(m.index, nameLines[i + 1]?.index ?? toolsText.length)]),
);
const tools = new Set(toolSource.keys());

/* The routes a piece of source calls directly: `ctx.call(...)`. */
const CALL = /ctx\.call\b[^(]*\(\s*"(GET|POST|PATCH|PUT|DELETE)",\s*[`"]([^`"]+)[`"]/g;
const directCalls = (src: string) =>
  [...src.matchAll(CALL)].map((m) => `${m[1]} ${m[2].replace(/\$\{[^}]*\}/g, ":param").split("?")[0]}`);

/* Helpers that take the ctx (`async function load(ctx: Ctx, …)`), with the
   calls they make, their own helpers' included. */
const beforeTools = toolsStart >= 0 ? mcp.slice(0, toolsStart) : mcp;
const helperSource = new Map(
  [...beforeTools.matchAll(/^async function (\w+)\(ctx\b/gm)].map((m) => [
    m[1],
    beforeTools.slice(m.index, beforeTools.indexOf("\n}\n", m.index)),
  ]),
);
function callsOf(src: string, seen = new Set<string>()): string[] {
  const calls = directCalls(src);
  for (const [name, body] of helperSource) {
    if (seen.has(name) || !new RegExp(`\\b${name}\\(ctx\\b`).test(src)) continue;
    seen.add(name);
    calls.push(...callsOf(body, seen));
  }
  return calls;
}

/** The route a call lands on: a literal segment beats a parameter, as in the router. */
function routeFor(call: string): string | null {
  const [method, path] = call.split(" ");
  const segs = path.split("/");
  const fits = [...routes].filter((r) => {
    const [rm, rp] = r.split(" ");
    const rs = rp.split("/");
    return rm === method && rs.length === segs.length && rs.every((s, i) => (s.startsWith(":") ? true : s === segs[i]));
  });
  fits.sort((a, b) => (a.match(/\/:/g)?.length ?? 0) - (b.match(/\/:/g)?.length ?? 0));
  return fits[0] ?? null;
}

const calledBy = new Map<string, Set<string>>(); // route -> tools that call it
const unroutedCalls: string[] = [];
for (const [tool, src] of toolSource) {
  for (const call of callsOf(src)) {
    const route = routeFor(call);
    if (!route) unroutedCalls.push(`${tool} → ${call}`);
    else calledBy.set(route, (calledBy.get(route) ?? new Set()).add(tool));
  }
}
const uncredited = [...calledBy].flatMap(([route, ts]) => {
  const c = ROUTE_COVERAGE[route];
  const credited = c && "tools" in c ? c.tools : [];
  return [...ts].filter((x) => !credited.includes(x)).map((x) => `${x} → ${route}`);
});
const overcredited = Object.entries(ROUTE_COVERAGE).flatMap(([route, c]) =>
  "tools" in c ? c.tools.filter((x) => tools.has(x) && !calledBy.get(route)?.has(x)).map((x) => `${x} → ${route}`) : [],
);

const missing = [...routes].filter((r) => !(r in ROUTE_COVERAGE));
const stale = Object.keys(ROUTE_COVERAGE).filter((r) => !routes.has(r));
const named = new Set(Object.values(ROUTE_COVERAGE).flatMap((c) => ("tools" in c ? c.tools : [])));
const unknownTools = [...named].filter((n) => !tools.has(n));
const orphanTools = [...tools].filter((n) => !named.has(n));
const vagueSkips = Object.entries(ROUTE_COVERAGE).filter(
  ([, c]) => "skip" in c && !/^(browser|admin|private|not yet): \S/.test(c.skip),
);

t(`found the route table (${routes.size} routes) and the tools (${tools.size})`, routes.size > 20 && tools.size > 5);
t(`every API route says what the MCP does with it${missing.length ? `: missing ${missing.join(", ")}` : ""}`, missing.length === 0);
t(`no coverage for routes that are gone${stale.length ? `: ${stale.join(", ")}` : ""}`, stale.length === 0);
t(`every tool named in coverage exists${unknownTools.length ? `: ${unknownTools.join(", ")}` : ""}`, unknownTools.length === 0);
t(`every tool is backed by a route${orphanTools.length ? `: ${orphanTools.join(", ")}` : ""}`, orphanTools.length === 0);
t(`found the tools' API calls (${calledBy.size} routes called)`, calledBy.size > 5);
t(`every call a tool makes is a real route${unroutedCalls.length ? `: ${unroutedCalls.join(", ")}` : ""}`, unroutedCalls.length === 0);
t(`coverage credits every route a tool calls${uncredited.length ? `: ${uncredited.join(", ")}` : ""}`, uncredited.length === 0);
t(`coverage credits no tool with a route it does not call${overcredited.length ? `: ${overcredited.join(", ")}` : ""}`, overcredited.length === 0);
t(`every skip says which kind of no${vagueSkips.length ? `: ${vagueSkips.map(([r]) => r).join(", ")}` : ""}`, vagueSkips.length === 0);

/* The guide's finishing rules for work people see (COPL-121), read as text
   from its Code and Leading paragraphs. */
const para = (title: string) => mcp.match(new RegExp(`^- \\*\\*${title}\\.\\*\\*.*$`, "m"))?.[0] ?? "";
const code = para("Code");
const leading = para("Leading");
t(
  "the guide's Code section asks for screenshots of work people see at desktop and 390px on comment_on_task",
  /changes what people see[^.]*review_first or not/.test(code) &&
    /desktop width and at 390px/.test(code) &&
    code.includes("comment_on_task's images") &&
    /If you can't take them, say so/.test(code) &&
    code.includes("daemon/README.md"),
);

/* review_first is a person's call (COPL-192): the guide never has an agent set it or infer it. */
t(
  "the guide's Code section says only a person sets review_first, and that a task without it is merged, UI included",
  code.includes("Only a person sets review_first: never set or clear it yourself") &&
    code.includes("never treat a task as review_first because of what it changes") &&
    /A task without it is yours to integrate once CI is green, work people see included/.test(code) &&
    !/review_first even when nobody set it|set it yourself/.test(code),
);
t(
  "on a task a person marked review_first, the agent opens the PR, comments and ends its run, without waiting or merging main in",
  /If a person set review_first, stop before integrating: push your branch \(on a board with GitHub, open the PR\), comment on the task, and end your run/.test(code) &&
    code.includes("Don't stay waiting for the review, and don't keep merging main into the PR"),
);
t(
  "the guide's Leading section never marks children review_first",
  leading.includes("Never mark a child review_first") &&
    !/is review_first from the start|create_task review_first/.test(leading),
);
const reviewArg = mcp.match(/const REVIEW_FIRST = \{[\s\S]*?\} as const;/)?.[0] ?? "";
t(
  "create_task and update_task share a review_first argument that says an agent's call is refused",
  reviewArg.includes("Only a person sets or clears it: from an agent the whole call is refused") &&
    toolSource.get("create_task")?.includes("review_first: REVIEW_FIRST") === true &&
    toolSource.get("update_task")?.includes("review_first: REVIEW_FIRST") === true,
);

/* Comments that come in while a run works (COPL-139): read the thread again before integrating, and the hook brings them. */
t(
  "the guide's Code section re-reads the task before integrating and before done, and stops for a question from the owner",
  /re-checked\. Then read the task again \(get_task\)[^(]*before you move a task to done/.test(code) &&
    /Never integrate work the thread has just questioned\. \(4\) Integrate/.test(code) &&
    code.indexOf("read the task again") < code.indexOf("(4) Integrate"),
);
t(
  "the guide's runs text says the heartbeat hook brings new comments on the run's claimed tasks",
  /Given its event, that hook also brings you, at your next step, the comments and mentions that came in on the tasks your run has claimed/.test(para("Runs and claims")),
);

/* Notes for other tasks (COPL-191): they go on that task, since no run reads the threads of the tasks it waited on. */
t(
  "the guide's Code section puts what a later or sibling task has to act on on that task, creating it if need be",
  /a later or sibling task has to act on goes on that task, not only in your own thread/.test(code) &&
    /a comment on it \(with an @mention of its assignee when that is someone else\), or into its brief if you lead it/.test(code) &&
    /when that task doesn't exist yet, create it/.test(code) &&
    /never the threads of the tasks it waited on/.test(code),
);
/* Stories are lanes (COPL-237): a lead plans an epic as stories, and a story's run does its tasks in turn. */
t(
  "the guide's Leading section plans an epic as stories that are lanes, and runs a story as one",
  /A story is a lane: one run does its tasks one after another in one worktree, each on its own branch from main/.test(leading) &&
    /tasks that touch the same files go in the same story, stories that share no files run side by side, and a story that needs another's result depends_on it/.test(leading) &&
    leading.includes("Parallelism comes from stories, not tasks") &&
    leading.includes("with no approval step") &&
    /A story you are given with no tasks yet you plan first/.test(leading) &&
    /a task straight under an epic, with no story/.test(leading) &&
    !/An epic or a story[^.]*is led/.test(leading),
);
t(
  "the guide's Code section says a lane makes each task's branch from main as it is then",
  /A story's run \(a lane, see Leading\) starts detached at main instead and makes each task's branch itself/.test(code),
);
t(
  "the guide's Leading section puts what a child has to act on in that child's brief",
  /What you learn that a child has to act on goes into that child's brief[^.]*not only in the parent's thread/.test(leading),
);

/* create_task's board (COPL-125): a person may leave it out, an agent names it. */
const refused = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch (error) {
    return error instanceof Error && error.message.startsWith("Name a board");
  }
};
t("a person's create_task without board goes to their inbox", newTaskBoard(undefined, false) === "inbox" && newTaskBoard("", false) === "inbox");
t("an agent's create_task without board is refused", refused(() => newTaskBoard(undefined, true)) && refused(() => newTaskBoard("", true)) && refused(() => newTaskBoard(null, true)));
t("an agent's create_task with board \"inbox\" goes to the inbox", newTaskBoard("inbox", true) === "inbox");
t("a named board is used as given, by people and agents", newTaskBoard("copland", true) === "copland" && newTaskBoard("COPL", false) === "COPL");
t(
  "create_task calls load with newTaskBoard, never a bare inbox default",
  /load\(ctx, newTaskBoard\(args\.board, !!ctx\.viewer\.agent\)\)/.test(toolSource.get("create_task") ?? "") &&
    !/args\.board \?\? "inbox"/.test(mcp),
);

/* The guide's inbox text (COPL-125): a task's run handles only its task's items. */
const inbox = para("Inbox");
t(
  "the guide says a task's supervised run handles only that task's items and messages get a run of their own",
  /supervised run started for a task handles only that task's items/.test(inbox) && /A message is handled by a run of its own/.test(inbox),
);

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
const backlog = Object.values(ROUTE_COVERAGE).filter((c) => "skip" in c && c.skip.startsWith("not yet")).length;
console.log(`\n${cases.length - failed}/${cases.length} MCP coverage checks passed (${backlog} routes marked "not yet")`);
if (failed) {
  console.log("See AGENTS.md: give the route an entry in src/worker/mcpCoverage.ts, and a tool if assistants should use it.");
  process.exit(1);
}
