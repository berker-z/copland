/* ============================================================================
   Agents: principals that act for a person (docs/AGENT-IDENTITIES.md).
   ----------------------------------------------------------------------------
   An agent is a users row (kind 'agent', owner_id its person) with a row in
   `agents` for what only agents have. It never signs in; it is reached only
   through its tokens, which resolve here to the agent plus who it acts for.

   An agent works only while its owner does: a disabled owner, or a paused
   agent, and its tokens stop resolving at once.
   ========================================================================== */

import { AGENT_GRANTS, type AgentGrant, type Viewer } from "@/domain/types";
import { findUserById, rowToUser, type UserRow } from "./users";

/** Who an agent acts for and what of theirs it may reach, or null when it may not act at all. */
export async function agentContext(db: D1Database, agent: UserRow): Promise<NonNullable<Viewer["agent"]> | null> {
  if (agent.kind !== "agent" || !agent.owner_id) return null;
  const [row, owner, grants] = await Promise.all([
    db
      .prepare(`SELECT paused_at, work_from FROM agents WHERE user_id = ?1`)
      .bind(agent.id)
      .first<{ paused_at: string | null; work_from: "owner" | "members" }>(),
    findUserById(db, agent.owner_id),
    db.prepare(`SELECT name FROM agent_grants WHERE agent_id = ?1`).bind(agent.id).all<{ name: string }>(),
  ]);
  if (!row || row.paused_at || !owner || owner.disabled_at || owner.kind !== "person") return null;
  return {
    owner: rowToUser(owner),
    workFrom: row.work_from,
    grants: grants.results.map((g) => g.name).filter((n): n is AgentGrant => (AGENT_GRANTS as readonly string[]).includes(n)),
  };
}

/**
 * The agents among these users, with their owner and who may assign them work.
 * People in the list are not returned; they take work from anyone on the board.
 */
export async function agentsAmong(
  db: D1Database,
  userIds: string[],
): Promise<{ id: string; ownerId: string; workFrom: "owner" | "members" }[]> {
  if (userIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT u.id, u.owner_id, a.work_from FROM users u JOIN agents a ON a.user_id = u.id
        WHERE u.id IN (${userIds.map((_, i) => `?${i + 1}`).join(",")})`,
    )
    .bind(...userIds)
    .all<{ id: string; owner_id: string; work_from: "owner" | "members" }>();
  return results.map((r) => ({ id: r.id, ownerId: r.owner_id, workFrom: r.work_from }));
}
