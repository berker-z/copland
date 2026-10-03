/* ============================================================================
   Run leases by kind, and where a dead run's tasks go (src/domain/runs.ts).
   ----------------------------------------------------------------------------
   Run: npm run check. A supervised run goes stale after RUN_LEASE_MS, an
   interactive one after INTERACTIVE_LEASE_MS; an ended run is never stale.
   A dead supervised run puts its tasks back by how it died (COPL-97).
   ========================================================================== */

import { INTERACTIVE_LEASE_MS, leaseFor, returnTo, RUN_LEASE_MS, runStatus, STRIKES, strikesOf } from "../src/domain/runs.ts";

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const now = Date.parse("2026-10-03T12:00:00.000Z");
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

t("the interactive lease is longer than the supervised one", INTERACTIVE_LEASE_MS > RUN_LEASE_MS);
t("leaseFor picks each kind's", leaseFor("supervised") === RUN_LEASE_MS && leaseFor("interactive") === INTERACTIVE_LEASE_MS);
t("a supervised run quiet for 12 minutes is stale", runStatus("running", ago(12), "supervised", now) === "stale");
t("an interactive run quiet for 12 minutes is running", runStatus("running", ago(12), "interactive", now) === "running");
t("an interactive run quiet for 16 minutes is stale", runStatus("running", ago(16), "interactive", now) === "stale");
t("a supervised run heard from a minute ago is running", runStatus("running", ago(1), "supervised", now) === "running");
t("an ended run keeps its ending however old", runStatus("completed", ago(600), "interactive", now) === "completed");
t("a run a person stopped parks its task", returnTo("cancelled", 0) === "backlog");
t("an interrupted run puts its task back to be picked up", returnTo("interrupted", 0) === "todo");
t("a first and second dead run put the task back", returnTo("failed", 1) === "todo" && returnTo("stale", 2) === "todo");
t("the third dead run in a row waits for a person", returnTo("failed", STRIKES) === "blocked" && returnTo("stale", STRIKES + 1) === "blocked");
t("strikes count failed runs back from the newest", strikesOf(["failed", "failed", "completed", "failed"]) === 2);
t("a completed or cancelled run ends the streak", strikesOf(["completed", "failed"]) === 0 && strikesOf(["failed", "cancelled", "failed"]) === 1);
t("no runs, no strikes", strikesOf([]) === 0);

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} run lease checks passed`);
if (failed) process.exit(1);
