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
