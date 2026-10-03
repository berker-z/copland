/* ============================================================================
   Run leases by kind (src/domain/runs.ts, COPL-69).
   ----------------------------------------------------------------------------
   Run: npm run check. A supervised run goes stale after RUN_LEASE_MS, an
   interactive one after INTERACTIVE_LEASE_MS; an ended run is never stale.
   ========================================================================== */

import { INTERACTIVE_LEASE_MS, leaseFor, RUN_LEASE_MS, runStatus } from "../src/domain/runs.ts";

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

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} run lease checks passed`);
if (failed) process.exit(1);
