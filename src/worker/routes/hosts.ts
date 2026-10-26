/* ============================================================================
   Where each agent runs (COPL-135; migrations/0036_agent_hosts.sql,
   domain/hosts.ts).
   ----------------------------------------------------------------------------
     PUT /api/hosts/self   { hostname, version, capabilities } → { host }

   An agent's daemon reports the machine it runs on, with the agent's own
   token, at startup and whenever any of it changes: the hostname, the box's
   version, and its capabilities (the runtimes on its PATH and logged in; for
   each board repo, whether this machine can clone and push). One row per
   agent and hostname, replaced on each report; the first report's time is
   kept. Only an agent's own token reports: a session, a person's token and a
   run's secret are refused (a run reports nothing about the machine; its
   launcher names the host on POST /api/runs instead). The body is checked
   and bounded (parseHostReport), and an agent keeps at most MAX_HOSTS: a
   new one past that drops the one quiet the longest.

   The owner reads them on the agent's page (GET /api/agents, agentHosts
   below), each with whether a socket from it is live right now, and the
   flag for one agent live on two hosts at once (live.ts liveHosts).
   ========================================================================== */

import { liveOnTwoHosts, MAX_HOSTS, parseHostReport, type HostCapabilities } from "@/domain/hosts";
import type { AgentHost, Viewer } from "@/domain/types";
import type { Env } from "../env";
import { badRequest, forbidden, json, nowIso, readJson } from "../http";
import { liveHosts, type Changes } from "../live";

interface HostRow {
  user_id: string;
  hostname: string;
  version: string;
  capabilities: string;
  first_reported_at: string;
  last_reported_at: string;
}

const toHost = (row: HostRow, live: boolean): AgentHost => ({
  hostname: row.hostname,
  version: row.version,
  capabilities: JSON.parse(row.capabilities) as HostCapabilities,
  firstReportedAt: row.first_reported_at,
  lastReportedAt: row.last_reported_at,
  live,
});

/** PUT /api/hosts/self: the agent's daemon says where it runs. See the header. */
export async function putOwnHost(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  const access = viewer.access;
  if (!access || !viewer.agent) throw forbidden("A host is reported by an agent's daemon, with the agent's own token");
  if (access.runId) throw forbidden("A run's secret reports no host; its launcher names it on POST /api/runs");
  const parsed = parseHostReport(await readJson(request));
  if (!parsed.ok) throw badRequest(parsed.problem);
  const { hostname, version, capabilities } = parsed.report;
  const db = env.DB;
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO agent_hosts (user_id, hostname, version, capabilities, first_reported_at, last_reported_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT (user_id, hostname) DO UPDATE SET
           version = excluded.version, capabilities = excluded.capabilities, last_reported_at = excluded.last_reported_at`,
      )
      .bind(viewer.user.id, hostname, version, JSON.stringify(capabilities), now),
    /* Bounded: past MAX_HOSTS, the ones quiet the longest go. */
    db
      .prepare(
        `DELETE FROM agent_hosts WHERE user_id = ?1 AND hostname NOT IN
           (SELECT hostname FROM agent_hosts WHERE user_id = ?1 ORDER BY last_reported_at DESC, hostname LIMIT ?2)`,
      )
      .bind(viewer.user.id, MAX_HOSTS),
  ]);
  /* The agent's page is its owner's. */
  changes.notify([viewer.agent.owner.id], "agents");
  const row = await db
    .prepare(`SELECT * FROM agent_hosts WHERE user_id = ?1 AND hostname = ?2`)
    .bind(viewer.user.id, hostname)
    .first<HostRow>();
  if (!row) throw new Error("Host upsert reported success but no row");
  const { live: _live, ...host } = toHost(row, false);
  return json({ host });
}

/**
 * An owner's agents' hosts, by agent: what each reported, the latest first,
 * with whether it is live now, and whether the agent is live on two hosts at
 * once. One read for the rows and one hub call per agent (liveHosts). A host
 * live but never reported (a daemon that names its socket but hasn't
 * reported yet) counts for the flag without a row of its own.
 */
export async function agentHosts(
  env: Env,
  ownerId: string,
  agentIds: string[],
): Promise<Map<string, { hosts: AgentHost[]; liveOnTwoHosts: boolean }>> {
  const [{ results }, live] = await Promise.all([
    env.DB.prepare(
      `SELECT h.* FROM agent_hosts h JOIN users u ON u.id = h.user_id
        WHERE u.owner_id = ?1 ORDER BY h.last_reported_at DESC, h.hostname`,
    )
      .bind(ownerId)
      .all<HostRow>(),
    liveHosts(env, agentIds),
  ]);
  return new Map(
    agentIds.map((id) => {
      const on = live.get(id) ?? [];
      return [
        id,
        {
          hosts: results.filter((r) => r.user_id === id).map((r) => toHost(r, on.includes(r.hostname))),
          liveOnTwoHosts: liveOnTwoHosts(on),
        },
      ];
    }),
  );
}
