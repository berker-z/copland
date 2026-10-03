/* ============================================================================
   API tokens: signing in without a browser.
   ----------------------------------------------------------------------------
   A token is another way of being a user (migrations/0002_api_access.sql):
   the Worker resolves it to the same user, with the same board roles, that a
   session would, plus a scope (read or write) and a label for the history
   ("Claude Code"): the MCP client that last introduced itself with the
   token (api_tokens.client, migrations/0010_token_client.sql), else the
   token's name.

   Secrets are "cpl_" + 32 random bytes; only their SHA-256 is stored, the
   same as session cookies. A token whose user has been disabled stops
   resolving at once, because the lookup joins on a live user row.

   The history label rides in an AsyncLocalStorage for the length of the
   request (viaContext), so repo/tasks.ts eventStatement can stamp every
   event the request writes without each route passing it along.

   A run's secret ("cplr_", routes/runs.ts) is a token too: it resolves
   through the token that started the run, so it has exactly that token's
   principal and scope, plus the run, which rides along in viaContext the
   same way and lands on every event as run_id. It stops resolving the
   moment the run ends, or that token is revoked or expires.

   A token can also have an interactive run (repo/runs.ts interactiveRun):
   a chat session's, made by its first claim without a run's secret. The
   lookup brings it along while it is live, so every request with the token
   renews it and its claims and stamps it on the events, the same as a run's
   secret would; it is never a credential of its own.
   ========================================================================== */

import { AsyncLocalStorage } from "node:async_hooks";
import { clientLabel } from "@/domain/clients";
import { RUN_LEASE_MS } from "@/domain/runs";
import type { ApiAccess, ApiToken, ApiTokenScope, Viewer } from "@/domain/types";
import { HttpError, nowIso, randomToken, sha256Hex } from "./http";
import { INTERACTIVE_RUN_OF_TOKEN, interactiveSince, runTouchStatements } from "./repo/runs";
import { findUserById, type UserRow } from "./repo/users";

export const TOKEN_PREFIX = "cpl_";
/** A run's secret. Not "cpl_…", so a lookup knows which table to ask. */
export const RUN_PREFIX = "cplr_";

/** OAuth access tokens are short-ish; the refresh token keeps the connection. */
export const OAUTH_ACCESS_SECONDS = 7 * 24 * 3600;
export const OAUTH_REFRESH_SECONDS = 90 * 24 * 3600;

const viaContext = new AsyncLocalStorage<{ via: string; runId: string | null }>();

/** Run fn as a token's request: its events say what made them, and which run. */
export function asAccess<T>(access: ApiAccess, fn: () => T): T {
  return viaContext.run({ via: access.via, runId: access.runId ?? access.interactiveRunId ?? null }, fn);
}

/** What made the current request's changes, when it was not the web app. */
export function currentVia(): string | null {
  return viaContext.getStore()?.via ?? null;
}

/** The request just made its token's interactive run (a first claim): the events it writes from here on carry it. */
export function enterRun(runId: string): void {
  const store = viaContext.getStore();
  if (store && !store.runId) store.runId = runId;
}

/** The run the current request came through, if any. */
export function currentRun(): string | null {
  return viaContext.getStore()?.runId ?? null;
}

const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

export function bearerFrom(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

/** A read-only token may look at everything its user may, and change nothing. */
export function requireWriteScope(viewer: Viewer, method: string): void {
  if (viewer.access?.scope === "read" && method !== "GET" && method !== "HEAD") {
    throw new HttpError(403, "This token is read-only; it cannot change anything");
  }
}

interface TokenRow {
  id: string;
  user_id: string;
  kind: "personal" | "oauth";
  name: string;
  scope: ApiTokenScope;
  client: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

const TOKEN_COLUMNS = `t.id, t.user_id, t.kind, t.name, t.scope, t.client, t.created_at, t.last_used_at, t.expires_at`;

function toToken(row: TokenRow): ApiToken {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    scope: row.scope,
    client: row.client,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}

/** The label the history shows: the client that introduced itself, else the token's name. */
function viaLabel(row: Pick<TokenRow, "client" | "name">): string {
  return row.client ? clientLabel(row.client) : row.name;
}

/** A presented secret → its live, unexpired token (or running run) and a live user, or null. */
export async function tokenAccess(
  db: D1Database,
  secret: string,
): Promise<{ user: UserRow; access: ApiAccess } | null> {
  if (secret.startsWith(RUN_PREFIX)) return runAccess(db, secret);
  if (!secret.startsWith(TOKEN_PREFIX)) return null;
  const row = await db
    .prepare(
      `SELECT ${TOKEN_COLUMNS}, ${INTERACTIVE_RUN_OF_TOKEN} AS interactive_run_id
         FROM api_tokens t JOIN users u ON u.id = t.user_id AND u.disabled_at IS NULL
        WHERE t.token_hash = ?1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?2)`,
    )
    .bind(await sha256Hex(secret), nowIso(), interactiveSince())
    .first<TokenRow & { interactive_run_id: string | null }>();
  if (!row) return null;
  const user = await findUserById(db, row.user_id);
  if (!user) return null;
  return {
    user,
    access: {
      tokenId: row.id,
      kind: row.kind,
      scope: row.scope,
      via: viaLabel(row),
      ...(row.interactive_run_id ? { interactiveRunId: row.interactive_run_id } : {}),
    },
  };
}

/**
 * Which of these tokens would still resolve: not revoked or expired, its
 * user live, and for an agent's, the agent not paused and its owner live
 * (as agentContext requires). The live hub asks before each broadcast, so a
 * socket opened with a token stops hearing once the token would be refused.
 */
export async function liveTokenIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const marks = ids.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT t.id FROM api_tokens t
         JOIN users u ON u.id = t.user_id AND u.disabled_at IS NULL
         LEFT JOIN agents a ON a.user_id = u.id
         LEFT JOIN users o ON o.id = u.owner_id
        WHERE t.id IN (${marks}) AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?1)
          AND (u.kind <> 'agent'
               OR (a.user_id IS NOT NULL AND a.paused_at IS NULL AND o.kind = 'person' AND o.disabled_at IS NULL))`,
    )
    .bind(nowIso(), ...ids)
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

/**
 * A run's secret: the run must be running and heard from within the lease
 * (a stale run's secret is dead, so a run that is never finished does not
 * leave a live credential behind), and the token that started it
 * still good (not revoked, not expired, its user live). What it resolves to
 * is that token's, with the run added.
 */
async function runAccess(db: D1Database, secret: string): Promise<{ user: UserRow; access: ApiAccess } | null> {
  const row = await db
    .prepare(
      `SELECT ${TOKEN_COLUMNS}, r.id AS run_id, r.client AS run_client
         FROM runs r
         JOIN api_tokens t ON t.id = r.token_id AND t.user_id = r.user_id
         JOIN users u ON u.id = r.user_id AND u.disabled_at IS NULL
        WHERE r.token_hash = ?1 AND r.kind = 'supervised' AND r.status = 'running' AND r.last_seen_at > ?3
          AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?2)`,
    )
    .bind(await sha256Hex(secret), nowIso(), new Date(Date.now() - RUN_LEASE_MS).toISOString())
    .first<TokenRow & { run_id: string; run_client: string | null }>();
  if (!row) return null;
  const user = await findUserById(db, row.user_id);
  if (!user) return null;
  return {
    user,
    access: {
      tokenId: row.id,
      kind: row.kind,
      scope: row.scope,
      via: row.run_client ? clientLabel(row.run_client) : viaLabel(row),
      runId: row.run_id,
    },
  };
}

/**
 * What a request with a token keeps fresh, to run under waitUntil:
 * last_used_at at most every five minutes (a busy agent should not write per
 * call), and for a run, the secret's or the token's interactive one, its
 * last_seen_at and its claims (repo/runs.ts).
 */
export function touchStatements(db: D1Database, access: ApiAccess): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE api_tokens SET last_used_at = ?2
          WHERE id = ?1 AND (last_used_at IS NULL OR last_used_at < ?3)`,
      )
      .bind(access.tokenId, nowIso(), inSeconds(-5 * 60)),
    ...(access.runId ? runTouchStatements(db, access.runId, "supervised") : []),
    ...(access.interactiveRunId ? runTouchStatements(db, access.interactiveRunId, "interactive") : []),
  ];
}

/**
 * The MCP client's own name ("claude-code"), from its initialize call. A
 * run's goes on the run, and only when whoever started it did not say.
 */
export async function setClient(db: D1Database, access: ApiAccess, client: string): Promise<void> {
  const name = client.trim().slice(0, 60);
  if (access.runId) {
    await db.prepare(`UPDATE runs SET client = ?2 WHERE id = ?1 AND client IS NULL`).bind(access.runId, name).run();
    return;
  }
  await db.prepare(`UPDATE api_tokens SET client = ?2 WHERE id = ?1`).bind(access.tokenId, name).run();
}

export async function mint(prefix = TOKEN_PREFIX): Promise<{ secret: string; hash: string }> {
  const secret = prefix + randomToken();
  return { secret, hash: await sha256Hex(secret) };
}

export async function createPersonalToken(
  db: D1Database,
  userId: string,
  fields: { name: string; scope: ApiTokenScope; days: number | null },
): Promise<{ secret: string; token: ApiToken }> {
  const { secret, hash } = await mint();
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO api_tokens (id, user_id, kind, name, scope, token_hash, expires_at)
       VALUES (?1, ?2, 'personal', ?3, ?4, ?5, ?6)`,
    )
    .bind(id, userId, fields.name, fields.scope, hash, fields.days === null ? null : inSeconds(fields.days * 24 * 3600))
    .run();
  const token = (await listTokens(db, userId)).find((t) => t.id === id);
  if (!token) throw new Error("Token insert reported success but no row");
  return { secret, token };
}

/** Everything this user has handed out that still works (or can still refresh). */
export async function listTokens(db: D1Database, userId: string): Promise<ApiToken[]> {
  const { results } = await db
    .prepare(
      `SELECT ${TOKEN_COLUMNS} FROM api_tokens t
        WHERE t.user_id = ?1 AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > ?2
               OR (t.refresh_expires_at IS NOT NULL AND t.refresh_expires_at > ?2))
        ORDER BY t.created_at DESC`,
    )
    .bind(userId, nowIso())
    .all<TokenRow>();
  return results.map(toToken);
}

export async function revokeToken(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db
    /* Mine, or one of my agents'. */
    .prepare(
      `UPDATE api_tokens SET revoked_at = ?3
        WHERE id = ?1 AND revoked_at IS NULL
          AND (user_id = ?2 OR user_id IN (SELECT id FROM users WHERE owner_id = ?2))`,
    )
    .bind(id, userId, nowIso())
    .run();
  return result.meta.changes > 0;
}

/** One personal token, by the request that came with it (DELETE /api/tokens/self). */
export async function revokeOwnToken(db: D1Database, tokenId: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE api_tokens SET revoked_at = ?2 WHERE id = ?1 AND kind = 'personal' AND revoked_at IS NULL`)
    .bind(tokenId, nowIso())
    .run();
  return result.meta.changes > 0;
}

/* ---------------------------------------------------------------- OAuth --- */

export interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: ApiTokenScope;
}

export async function issueOAuthTokens(
  db: D1Database,
  grant: { userId: string; clientId: string; clientName: string; scope: ApiTokenScope },
): Promise<IssuedTokens> {
  const access = await mint();
  const refresh = await mint();
  await db
    .prepare(
      `INSERT INTO api_tokens
         (id, user_id, kind, name, scope, token_hash, refresh_hash, client_id, expires_at, refresh_expires_at)
       VALUES (?1, ?2, 'oauth', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      crypto.randomUUID(),
      grant.userId,
      grant.clientName,
      grant.scope,
      access.hash,
      refresh.hash,
      grant.clientId,
      inSeconds(OAUTH_ACCESS_SECONDS),
      inSeconds(OAUTH_REFRESH_SECONDS),
    )
    .run();
  return {
    access_token: access.secret,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_SECONDS,
    refresh_token: refresh.secret,
    scope: grant.scope,
  };
}

/**
 * Rotate: a refresh token is used once. The connection (the row) stays, so
 * settings lists one "Claude" however many times it refreshed.
 */
export async function refreshOAuthTokens(
  db: D1Database,
  refreshSecret: string,
  clientId: string,
): Promise<IssuedTokens | null> {
  const row = await db
    .prepare(
      `SELECT t.id, t.scope FROM api_tokens t
         JOIN users u ON u.id = t.user_id AND u.disabled_at IS NULL
        WHERE t.refresh_hash = ?1 AND t.client_id = ?2 AND t.kind = 'oauth'
          AND t.revoked_at IS NULL AND t.refresh_expires_at > ?3`,
    )
    .bind(await sha256Hex(refreshSecret), clientId, nowIso())
    .first<{ id: string; scope: ApiTokenScope }>();
  if (!row) return null;
  const access = await mint();
  const refresh = await mint();
  /* Guarded on the old refresh hash: two refreshes racing with the same
     token, and only one of them gets new secrets. */
  const result = await db
    .prepare(
      `UPDATE api_tokens
          SET token_hash = ?2, refresh_hash = ?3, expires_at = ?4, refresh_expires_at = ?5
        WHERE id = ?1 AND refresh_hash = ?6`,
    )
    .bind(
      row.id,
      access.hash,
      refresh.hash,
      inSeconds(OAUTH_ACCESS_SECONDS),
      inSeconds(OAUTH_REFRESH_SECONDS),
      await sha256Hex(refreshSecret),
    )
    .run();
  if (result.meta.changes === 0) return null;
  return {
    access_token: access.secret,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_SECONDS,
    refresh_token: refresh.secret,
    scope: row.scope,
  };
}
