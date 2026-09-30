/* ============================================================================
   Personal API tokens and connected apps, as settings shows them.
   ----------------------------------------------------------------------------
   Everyone manages their own: make a token for a tool, see what is connected
   and when it was last used, revoke. Only from a browser session: a token
   cannot list, mint or revoke tokens, so a leaked one cannot entrench itself.
   Personal, like the vault: writes notify only the owner's other tabs.
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

/** GET /api/tokens: mine, personal and connected apps alike. */
export async function getTokens(env: Env, viewer: Viewer): Promise<Response> {
  requireBrowser(viewer);
  return json(await listTokens(env.DB, viewer.user.id));
}

/** POST /api/tokens { name, scope, days }: the secret is in this response and nowhere else, ever. */
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
  const created: CreatedToken = await createPersonalToken(env.DB, viewer.user.id, {
    name,
    scope,
    days: days as number | null,
  });
  changes.notify([viewer.user.id], "tokens");
  return json(created, { status: 201 });
}

/** DELETE /api/tokens/:id: revoke one of mine; the next request with it is a 401. */
export async function deleteToken(env: Env, viewer: Viewer, id: string, changes: Changes): Promise<Response> {
  requireBrowser(viewer);
  if (!(await revokeToken(env.DB, viewer.user.id, id))) throw notFound("No such token");
  changes.notify([viewer.user.id], "tokens");
  return json(await listTokens(env.DB, viewer.user.id));
}
