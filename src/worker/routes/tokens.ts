/* ============================================================================
   Personal API tokens and connected apps, as settings shows them.
   ----------------------------------------------------------------------------
   Everyone manages their own: make a token for a tool, see what is connected
   and when it was last used, revoke. Only from a browser session: a token
   cannot list, mint or revoke tokens, so a leaked one cannot entrench itself.
   Personal, like the vault: writes notify only the owner's other tabs.

   A token can also be made for one of your agents (`agentId`), and then it
   is that agent. GET lists only your own; an agent's are in GET /api/agents.
   Revoking takes either.
   ========================================================================== */

import type { ApiTokenScope, CreatedToken, Viewer } from "@/domain/types";
import type { Env } from "../env";
import { badRequest, forbidden, json, notFound, readJson } from "../http";
import type { Changes } from "../live";
import { createPersonalToken, listTokens, revokeToken } from "../tokens";

/** How long a new personal token lasts; null is "until revoked". */
const DAYS = [30, 90, 365, null] as const;

function requireBrowser(viewer: Viewer): void {
  if (viewer.access) throw forbidden("Tokens are managed from the app itself, not with a token");
}

/** The principal a token is for: me, or one of my live agents. */
async function principalFor(db: D1Database, viewer: Viewer, agentId: unknown): Promise<string> {
  if (agentId === undefined || agentId === null) return viewer.user.id;
  if (typeof agentId !== "string") throw badRequest("`agentId` must be a string");
  const mine = await db
    .prepare(`SELECT 1 FROM users WHERE id = ?1 AND owner_id = ?2 AND disabled_at IS NULL`)
    .bind(agentId, viewer.user.id)
    .first();
  if (!mine) throw notFound("No such agent");
  return agentId;
}

/** GET /api/tokens: mine, personal and connected apps alike. */
export async function getTokens(env: Env, viewer: Viewer): Promise<Response> {
  requireBrowser(viewer);
  return json(await listTokens(env.DB, viewer.user.id));
}

/** POST /api/tokens { name, scope, days, agentId? }: the secret is in this response and nowhere else, ever. */
export async function postToken(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  requireBrowser(viewer);
  const body = await readJson(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw badRequest("Give the token a name, e.g. \"laptop, Claude Code\"");
  if (name.length > 60) throw badRequest("`name` is longer than 60 characters");
  if (body.scope !== "read" && body.scope !== "write") throw badRequest("`scope` must be read or write");
  const scope: ApiTokenScope = body.scope;
  const days = body.days === undefined ? 90 : body.days;
  if (!(DAYS as readonly unknown[]).includes(days)) throw badRequest("`days` must be 30, 90, 365 or null");
  const principal = await principalFor(env.DB, viewer, body.agentId);
  const created: CreatedToken = await createPersonalToken(env.DB, principal, {
    name,
    scope,
    days: days as number | null,
  });
  changes.notify([viewer.user.id], principal === viewer.user.id ? "tokens" : "agents");
  return json(created, { status: 201 });
}

/** DELETE /api/tokens/:id: revoke one of mine or my agents'; the next request with it is a 401. */
export async function deleteToken(env: Env, viewer: Viewer, id: string, changes: Changes): Promise<Response> {
  requireBrowser(viewer);
  if (!(await revokeToken(env.DB, viewer.user.id, id))) throw notFound("No such token");
  changes.notify([viewer.user.id], "tokens", "agents");
  return json(await listTokens(env.DB, viewer.user.id));
}
