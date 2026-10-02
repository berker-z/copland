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
import { badRequest, conflict } from "../http";
import { agentEmail, findUserById, rowToUser, type UserRow } from "./users";

/** Who an agent acts for and what of theirs it may reach, or null when it may not act at all. */
export async function agentContext(db: D1Database, agent: UserRow): Promise<NonNullable<Viewer["agent"]> | null> {
  if (agent.kind !== "agent" || !agent.owner_id) return null;
  const [row, owner, grants] = await Promise.all([
    db
      .prepare(`SELECT paused_at, work_from, description FROM agents WHERE user_id = ?1`)
      .bind(agent.id)
      .first<{ paused_at: string | null; work_from: "owner" | "members"; description: string }>(),
    findUserById(db, agent.owner_id),
    db.prepare(`SELECT name FROM agent_grants WHERE agent_id = ?1`).bind(agent.id).all<{ name: string }>(),
  ]);
  if (!row || row.paused_at || !owner || owner.disabled_at || owner.kind !== "person") return null;
  return {
    owner: rowToUser(owner),
    workFrom: row.work_from,
    description: row.description,
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

export const MAX_AGENTS = 20;

/**
 * Make an agent for this person: closed by default (no boards, no grants,
 * work only from its owner). The name has passed handleProblem; this checks
 * the count and that the owner has no live agent of that name.
 */
export async function createAgent(
  db: D1Database,
  owner: { id: string; handle: string },
  name: string,
  description: string,
): Promise<string> {
  const count = await db.prepare(`SELECT count(*) AS n FROM users WHERE owner_id = ?1 AND disabled_at IS NULL`)
    .bind(owner.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_AGENTS) throw badRequest(`You can have at most ${MAX_AGENTS} agents`);
  const handle = `${owner.handle}/${name}`;
  if (await db.prepare(`SELECT 1 FROM users WHERE handle = ?1`).bind(handle).first()) {
    throw conflict(`You already have an agent called \`${name}\``);
  }
  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare(`INSERT INTO users (id, email, handle, kind, owner_id) VALUES (?1, ?2, ?3, 'agent', ?4)`)
      .bind(id, agentEmail(id), handle, owner.id),
    db.prepare(`INSERT INTO agents (user_id, name, description) VALUES (?1, ?2, ?3)`).bind(id, name, description),
  ]);
  return id;
}

/** True when this is one of the person's live (not deleted) agents. */
export async function isOwnAgent(db: D1Database, ownerId: string, agentId: string): Promise<boolean> {
  return !!(await db
    .prepare(`SELECT 1 FROM users WHERE id = ?1 AND owner_id = ?2 AND kind = 'agent' AND disabled_at IS NULL`)
    .bind(agentId, ownerId)
    .first());
}

/** A person's live agents, for pickers: id and name. */
export async function agentNames(db: D1Database, ownerId: string): Promise<{ id: string; name: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, a.name FROM users u JOIN agents a ON a.user_id = u.id
        WHERE u.owner_id = ?1 AND u.disabled_at IS NULL ORDER BY a.created_at`,
    )
    .bind(ownerId)
    .all<{ id: string; name: string }>();
  return results;
}
