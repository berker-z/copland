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

   The one exception to "only from a browser": DELETE /api/tokens/self, where
   the token a request came with revokes itself and nothing else. It is how a
   box signs out. It can only take access away, never reach another token, so
   a read-only token may call it too (runApi lets it past requireWriteScope),
   and so may an agent's.
   ========================================================================== */

import type { ApiTokenScope, CreatedToken, Viewer } from "@/domain/types";
import type { Env } from "../env";
import { badRequest, forbidden, json, notFound, readJson } from "../http";
import { personOf } from "../access";
import type { Changes } from "../live";
import { createPersonalToken, listTokens, revokeOwnToken, revokeToken } from "../tokens";

/** How long a new personal token lasts; null is "until revoked". */
const DAYS = [30, 90, 365, null] as const;

/** The one token route a token may call, on itself; runApi checks it before the scope. */
export const SELF_REVOKE_PATH = "/api/tokens/self";

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

/**
 * DELETE /api/tokens/self: the API token this request came with is revoked,
 * and the next request with it is a 401. Nothing else can be named, so it
 * cannot reach another token. A session has no token to revoke (settings ›
 * tokens does that), a run's secret is refused because it resolves through
 * the token that started the run (finishing the run is how a run ends), and
 * so is an OAuth connection, whose refresh token would outlive it.
 */
export async function deleteOwnToken(env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  const access = viewer.access;
  if (!access) throw badRequest("Only a token can revoke itself; a browser session signs out instead");
  if (access.runId) throw forbidden("A run's secret can't revoke the token that started its run; finish the run");
  if (access.kind !== "personal") throw forbidden("An app connection is disconnected in settings, not by itself");
  if (!(await revokeOwnToken(env.DB, access.tokenId))) throw notFound("No such token");
  changes.notify([personOf(viewer)], "tokens", "agents");
  return json({ revoked: access.tokenId });
}
