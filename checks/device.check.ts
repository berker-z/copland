/* ============================================================================
   Device login: what a box asks for (src/domain/device.ts, COPL-55, COPL-109).
   ----------------------------------------------------------------------------
   Run: npm run check. What POST /api/device/start accepts in `agents` and `write`, and
   which of the person's agents the /device page ticks to begin with.
   ========================================================================== */

import { MAX_DEVICE_AGENTS, parseWantedAgents, parseWriteAsk, preselectAgents } from "../src/domain/device.ts";

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);
const same = (a: Iterable<string>, b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const wanted = (raw: unknown) => {
  const r = parseWantedAgents(raw);
  return "error" in r ? "error" : r.wanted;
};

/* Parsing: optional, backwards compatible. */
t("missing is no preference", wanted(undefined) === null);
t("null is no preference", wanted(null) === null);
t("empty is no preference", wanted([]) === null);
t("handles keep their case, lose an @, and drop repeats", JSON.stringify(wanted(["@me/Dev", "me/dev", " me/review "])) === JSON.stringify(["me/Dev", "me/review"]));
t("an id passes as it is", JSON.stringify(wanted(["0b5f6a1e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"])) === JSON.stringify(["0b5f6a1e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"]));
t("not a list is refused", wanted("me/dev") === "error");
t("a number in the list is refused", wanted(["me/dev", 3]) === "error");
t("an empty entry is refused", wanted(["@"]) === "error");
t("whitespace inside is refused", wanted(["me/a b"]) === "error");
t("control characters are refused", wanted(["me/a\u0007"]) === "error");
t("an overlong entry is refused", wanted(["x".repeat(101)]) === "error");
t("too many are refused", wanted(Array.from({ length: MAX_DEVICE_AGENTS + 1 }, (_, i) => `me/a${i}`)) === "error");
t("as many as allowed pass", Array.isArray(wanted(Array.from({ length: MAX_DEVICE_AGENTS }, (_, i) => `me/a${i}`))));

/* A write token (COPL-109): its own ask, never with agents. */
const write = (raw: unknown, wanted: string[] | null = null) => {
  const r = parseWriteAsk(raw, wanted);
  return "error" in r ? "error" : r.write;
};
t("no write is the read-only token", write(undefined) === false && write(null) === false && write(false) === false);
t("write: true asks for it", write(true) === true);
t("write that isn't a boolean is refused", write("yes") === "error" && write(1) === "error");
t("write with agents is refused", write(true, ["me/dev"]) === "error");
t("agents without write are fine", write(false, ["me/dev"]) === false);

/* Preselection. */
const mine = [
  { id: "u1", handle: "me/dev", paused: false },
  { id: "u2", handle: "me/review", paused: false },
  { id: "u3", handle: "me/sleepy", paused: true },
];
t("no preference ticks every agent that isn't paused", same(preselectAgents(mine, undefined), ["u1", "u2"]));
t("an empty preference is no preference", same(preselectAgents(mine, []), ["u1", "u2"]));
t("a named agent is the only one ticked", same(preselectAgents(mine, ["me/review"]), ["u2"]));
t("handles match case aside, with or without @", same(preselectAgents(mine, ["@ME/Dev"]), ["u1"]));
t("ids match too", same(preselectAgents(mine, ["u2", "u1"]), ["u1", "u2"]));
t("a paused agent the box asked for is ticked", same(preselectAgents(mine, ["me/sleepy"]), ["u3"]));
t("someone else's agent ticks nothing", same(preselectAgents(mine, ["you/dev"]), []));
t("a bare name is not a handle", same(preselectAgents(mine, ["dev"]), []));

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} device login checks passed`);
if (failed) process.exit(1);
