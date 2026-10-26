/* ============================================================================
   The OAuth consent page: who an app connects as (src/worker/oauth.ts, COPL-158).
   ----------------------------------------------------------------------------
   Run: npm run check. "You" is checked to begin with, the page says what each
   choice is for, the agents sit under that explanation, and a failed post
   keeps what was picked.
   ========================================================================== */

import "./worker.ts";

const { consentPage } = await import("../src/worker/oauth.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

const req = {
  client: { client_id: "c1", client_name: "Claude Code", redirect_uris: ["http://localhost:4567/callback"] },
  redirectUri: "http://localhost:4567/callback",
  state: "s",
  codeChallenge: "x",
  scope: "write" as const,
};
const user = { handle: "me", email: "me@example.com" };
const agents = [{ id: "a1", name: "dev" }];
const html = async (problem: { message: string; as: string; newName: string } | null = null) =>
  consentPage(req, user, agents, new URLSearchParams(), problem).text();

const fresh = await html();
const checked = (h: string) => [...h.matchAll(/name="as" value="([^"]+)" checked/g)].map((m) => m[1]);

t("you is the one checked to begin with", JSON.stringify(checked(fresh)) === JSON.stringify(["me"]));
t("you says it is for an app you talk to yourself", /for an app you talk to yourself/.test(fresh));
t("the page says an agent is for something that works without you", /or as an agent, for something that works without you/.test(fresh));
t("it says a box doesn't come here", /A Copland box doesn't need this page/.test(fresh));
const aside = fresh.indexOf('class="aside"');
t("the agents come after that line, you before it", fresh.indexOf('value="me"') < aside && aside < fresh.indexOf('value="a1"') && aside < fresh.indexOf('value="new"'));
t("the agent is named owner/name", fresh.includes("<strong>me/dev</strong>"));

const again = await html({ message: "That agent is gone; pick again.", as: "new", newName: "codex" });
t("a failed post keeps the pick", JSON.stringify(checked(again)) === JSON.stringify(["new"]) && again.includes('value="codex"'));

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} consent page checks passed`);
if (failed) process.exit(1);
