/* ============================================================================
   Device login: the box connects without anyone copying tokens (COPL-47).
   ----------------------------------------------------------------------------
     POST /api/device/start      { client, host, agents? }, no auth
                                 → { deviceCode, userCode, verifyUrl, interval, expiresIn }
     GET  /api/device/:userCode  a person in the app → { client, host, createdAt, status, agents? }
     POST /api/device/approve    a person in the app, { userCode, agentIds }
     POST /api/device/deny       a person in the app, { userCode }
     POST /api/device/poll       { deviceCode }, no auth
                                 → { status: pending | denied | expired }, or once
                                   { status: "approved", url, owner: { handle, token },
                                     agents: [{ handle, token }] }

   The shape of OAuth's device flow (RFC 8628), cut down. The box holds the
   device code, a long secret only it has (only its hash is stored); the
   person gets the short user code from the box's screen and approves it in
   a signed-in tab. The user code is not a credential: approving needs the
   person's session, and a token or an agent is refused on approve, deny and
   the lookup, the way token management refuses them (routes/tokens.ts). So
   nothing a token holder does here ever mints more tokens.

   Approving mints ordinary personal tokens with createPersonalToken, the
   same rows settings makes, so they are listed and revoked there: a
   read-only one for the person ("<host> box", for the box's view of their
   agents' work) and a read-and-write one for each agent they ticked
   ("<host>", so the box can start that agent's runs). They carry the client
   "copland-box", which settings and the history show as "Copland box". The
   secrets are sealed under VAULT_KEY on the request until the box picks them
   up, and the ciphertext is gone the moment it does. Until then the tokens
   expire with the request, so an approval nobody collects dies on its own
   ten minutes in; the sweep below also revokes them. On delivery they lose
   that expiry and last until revoked.

   A box that already runs some agents asks for one more the same way,
   naming it in `agents` (COPL-55): the approval page then ticks exactly
   those of the person's agents to begin with. It is only the page's
   starting point; approving takes what the person ticks, checked as ever.
   Such a box already holds its owner's read-only token, so the approval
   mints only the agents' tokens and `owner` comes back null.

   Two routes take no credentials, so they are limited: a few requests per
   IP every ten minutes, a ceiling on everything pending, and a poll faster
   than once a second answers pending with slow_down rather than doing work.
   Nothing sweeps on a timer; every call here tidies first: expired
   approvals lose their tokens, and requests older than a day are deleted.
   ========================================================================== */

import {
  DEVICE_EXPIRES_IN,
  DEVICE_INTERVAL,
  MAX_DEVICE_AGENTS,
  normalizeUserCode,
  parseWantedAgents,
  USER_CODE_ALPHABET,
  type DeviceRequestInfo,
  type DeviceStatus,
} from "@/domain/device";
import type { Viewer } from "@/domain/types";
import type { Env } from "../env";
import { badRequest, conflict, forbidden, HttpError, json, notFound, nowIso, randomToken, readJson, sha256Hex } from "../http";
import type { Changes } from "../live";
import { createPersonalToken } from "../tokens";
import { seal, unseal, type Sealed } from "../vault";

/** What the box is called in settings and the history (domain/clients.ts says it for people). */
export const BOX_CLIENT = "copland-box";
const DEVICE_PREFIX = "cpld_";

const MAX_CLIENT = 40;
const MAX_HOST = 48;
const MAX_AGENTS = MAX_DEVICE_AGENTS;
/** Starts per IP per window, and requests pending at once on the whole instance. */
const PER_IP = 10;
const IP_WINDOW_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;
/** Faster polls than this get slow_down. */
const MIN_POLL_MS = 1000;
/** Rows are kept this long, then deleted. */
const KEEP_MS = 24 * 3600 * 1000;

interface DeviceRow {
  id: string;
  user_code: string;
  client: string;
  host: string;
  status: "pending" | "approved" | "denied" | "delivered" | "expired";
  user_id: string | null;
  created_at: string;
  expires_at: string;
  payload_cipher: string | null;
  token_ids: string | null;
  last_polled_at: string | null;
  /** JSON array of the agents the box asked for, or null. */
  wanted_agents: string | null;
}

interface Payload {
  /** Null when the box asked for named agents: it already holds a read-only token for its owner. */
  owner: { handle: string; token: string } | null;
  agents: Array<{ handle: string; token: string }>;
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const sealContext = (id: string) => `device:${id}`;

/** What a request is now: one past its time is expired, and so is one already delivered. */
function statusOf(row: DeviceRow): DeviceStatus {
  if (row.status === "denied") return "denied";
  if (row.status === "delivered") return "approved";
  if (row.status === "expired" || row.expires_at <= nowIso()) return "expired";
  return row.status;
}

function info(row: DeviceRow): DeviceRequestInfo {
  const base: DeviceRequestInfo = { client: row.client, host: row.host, createdAt: row.created_at, status: statusOf(row) };
  return row.wanted_agents ? { ...base, agents: JSON.parse(row.wanted_agents) as string[] } : base;
}

/** A short line for the approval page: printable, one line, capped. */
function label(raw: unknown, field: string, max: number): string {
  if (typeof raw !== "string") throw badRequest(`\`${field}\` must be a string`);
  const clean = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  if (!clean) throw badRequest(`\`${field}\` must not be empty`);
  return clean;
}

function userCodeFrom(raw: unknown): string {
  const code = typeof raw === "string" ? normalizeUserCode(raw) : null;
  if (!code) throw badRequest("`userCode` must be a code like ABCD-EFGH");
  return code;
}

/** Eight characters, uniform over the alphabet (bytes past the last full multiple are drawn again). */
function newUserCode(): string {
  const n = USER_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < 8) out += USER_CODE_ALPHABET[b % n];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Approving, denying and looking up are a person's, in the app: never a token, never an agent. */
function requirePersonInApp(viewer: Viewer): void {
  if (viewer.access || viewer.agent) throw forbidden("A box is approved from the app itself, not with a token");
}

const tokenIds = (row: Pick<DeviceRow, "token_ids">): string[] => (row.token_ids ? (JSON.parse(row.token_ids) as string[]) : []);

function revokeStatement(db: D1Database, ids: string[]): D1PreparedStatement {
  return db
    .prepare(`UPDATE api_tokens SET revoked_at = ?2 WHERE id IN (SELECT value FROM json_each(?1)) AND revoked_at IS NULL`)
    .bind(JSON.stringify(ids), nowIso());
}

/**
 * Tidy before anything else: an approval nobody picked up in time loses its
 * tokens (they had already expired with it; this makes them revoked too and
 * drops the sealed secrets), and a day-old request is forgotten.
 */
async function sweep(env: Env, changes: Changes): Promise<void> {
  const db = env.DB;
  const now = nowIso();
  const { results } = await db
    .prepare(`SELECT id, user_id, token_ids FROM device_requests WHERE status = 'approved' AND expires_at <= ?1`)
    .bind(now)
    .all<Pick<DeviceRow, "id" | "user_id" | "token_ids">>();
  const statements = results.flatMap((row) => [
    revokeStatement(db, tokenIds(row)),
    db
      .prepare(`UPDATE device_requests SET status = 'expired', payload_cipher = NULL WHERE id = ?1 AND status = 'approved'`)
      .bind(row.id),
  ]);
  statements.push(db.prepare(`DELETE FROM device_requests WHERE created_at < ?1`).bind(ago(KEEP_MS)));
  await db.batch(statements);
  const owners = results.flatMap((r) => (r.user_id ? [r.user_id] : []));
  if (owners.length) changes.notify(owners, "tokens", "agents");
}

async function findByUserCode(db: D1Database, code: string): Promise<DeviceRow | null> {
  return db.prepare(`SELECT * FROM device_requests WHERE user_code = ?1`).bind(code).first<DeviceRow>();
}

/** The request this person may see: anyone's while it is pending, afterwards only the one who answered it. */
async function visibleRequest(db: D1Database, viewer: Viewer, code: string): Promise<DeviceRow> {
  const row = await findByUserCode(db, code);
  if (!row || (row.user_id && row.user_id !== viewer.user.id)) throw notFound("No such code. Check it against the box, or start again there.");
  return row;
}

function requirePending(row: DeviceRow): void {
  const status = statusOf(row);
  if (status !== "pending") throw conflict(`This code is already ${status}`, status);
}

/* ------------------------------------------------------------------ box --- */

/**
 * POST /api/device/start { client, host, agents? }: no credentials; a code to
 * show and one to keep. `agents` (handles or ids) are what the approval page
 * ticks to begin with, kept with the request; they grant nothing by themselves.
 */
export async function postDeviceStart(request: Request, env: Env, url: URL, changes: Changes): Promise<Response> {
  const body = await readJson(request);
  const client = label(body.client, "client", MAX_CLIENT);
  const host = label(body.host, "host", MAX_HOST);
  const parsed = parseWantedAgents(body.agents);
  if ("error" in parsed) throw badRequest(parsed.error);
  const wanted = parsed.wanted ? JSON.stringify(parsed.wanted) : null;
  await sweep(env, changes);

  const db = env.DB;
  const ipHash = await sha256Hex(`device:${request.headers.get("cf-connecting-ip") ?? "unknown"}`);
  const [fromIp, pending] = await db.batch<{ n: number }>([
    db.prepare(`SELECT COUNT(*) AS n FROM device_requests WHERE ip_hash = ?1 AND created_at > ?2`).bind(ipHash, ago(IP_WINDOW_MS)),
    db.prepare(`SELECT COUNT(*) AS n FROM device_requests WHERE status = 'pending' AND expires_at > ?1`).bind(nowIso()),
  ]);
  if ((fromIp.results[0]?.n ?? 0) >= PER_IP) {
    throw new HttpError(429, "Too many device requests from here; wait a few minutes", "rate_limited");
  }
  if ((pending.results[0]?.n ?? 0) >= MAX_PENDING) {
    throw new HttpError(429, "Too many device requests waiting; try again in a few minutes", "rate_limited");
  }

  const deviceCode = DEVICE_PREFIX + randomToken();
  const deviceHash = await sha256Hex(deviceCode);
  const expiresAt = new Date(Date.now() + DEVICE_EXPIRES_IN * 1000).toISOString();
  /* The user code is unique; a collision (one in billions) just draws again. */
  for (let attempt = 0; ; attempt++) {
    const userCode = newUserCode();
    try {
      await db
        .prepare(
          `INSERT INTO device_requests (id, device_hash, user_code, client, host, expires_at, ip_hash, wanted_agents)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(crypto.randomUUID(), deviceHash, userCode, client, host, expiresAt, ipHash, wanted)
        .run();
      return json({
        deviceCode,
        userCode,
        verifyUrl: `${url.origin}/device?code=${userCode}`,
        interval: DEVICE_INTERVAL,
        expiresIn: DEVICE_EXPIRES_IN,
      });
    } catch (error) {
      if (attempt >= 4 || !String(error).includes("UNIQUE")) throw error;
    }
  }
}

/**
 * POST /api/device/poll { deviceCode }: no credentials but the device code.
 * The secrets come back exactly once: the update that marks the request
 * delivered is guarded on it still being approved, so two polls racing get
 * them once between them, and the ciphertext goes in the same statement.
 */
export async function postDevicePoll(request: Request, env: Env, url: URL, changes: Changes): Promise<Response> {
  const body = await readJson(request);
  if (typeof body.deviceCode !== "string" || !body.deviceCode.startsWith(DEVICE_PREFIX) || body.deviceCode.length > 100) {
    throw badRequest("`deviceCode` must be the code /api/device/start returned");
  }
  await sweep(env, changes);
  const db = env.DB;
  const row = await db
    .prepare(`SELECT * FROM device_requests WHERE device_hash = ?1`)
    .bind(await sha256Hex(body.deviceCode))
    .first<DeviceRow>();
  /* Unknown reads as expired: it was, or it was forgotten after a day. */
  if (!row) return json({ status: "expired" });

  const now = nowIso();
  const tooFast = row.last_polled_at !== null && Date.now() - Date.parse(row.last_polled_at) < MIN_POLL_MS;
  await db.prepare(`UPDATE device_requests SET last_polled_at = ?2 WHERE id = ?1`).bind(row.id, now).run();

  if (row.status === "delivered") return json({ status: "expired" });
  const status = statusOf(row);
  if (status === "pending") return json(tooFast ? { status, slow_down: true } : { status });
  if (status !== "approved" || !row.payload_cipher) return json({ status: status === "approved" ? "expired" : status });

  const payload = JSON.parse(await unseal(env, sealContext(row.id), JSON.parse(row.payload_cipher) as Sealed)) as Payload;
  const taken = await db
    .prepare(
      `UPDATE device_requests SET status = 'delivered', payload_cipher = NULL
        WHERE id = ?1 AND status = 'approved' AND payload_cipher IS NOT NULL AND expires_at > ?2`,
    )
    .bind(row.id, now)
    .run();
  if (taken.meta.changes === 0) return json({ status: "expired" });
  /* Collected: the tokens stop expiring with the request and last until revoked. */
  await db
    .prepare(`UPDATE api_tokens SET expires_at = NULL WHERE id IN (SELECT value FROM json_each(?1)) AND revoked_at IS NULL`)
    .bind(row.token_ids ?? "[]")
    .run();
  if (row.user_id) changes.notify([row.user_id], "tokens", "agents");
  return json({ status: "approved", url: url.origin, owner: payload.owner, agents: payload.agents });
}

/* --------------------------------------------------------------- person --- */

/** GET /api/device/:userCode: what is asking, for the approval page. */
export async function getDevice(env: Env, viewer: Viewer, rawCode: string): Promise<Response> {
  requirePersonInApp(viewer);
  return json(info(await visibleRequest(env.DB, viewer, userCodeFrom(rawCode))));
}

/**
 * POST /api/device/approve { userCode, agentIds }: mint the box's tokens and
 * seal them on the request. agentIds are this person's own live agents; a
 * paused one is allowed (its token works once it is resumed).
 */
export async function postDeviceApprove(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  requirePersonInApp(viewer);
  const body = await readJson(request);
  const code = userCodeFrom(body.userCode);
  const raw = body.agentIds ?? [];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) throw badRequest("`agentIds` must be a list of agent ids");
  const agentIds = [...new Set(raw as string[])];
  if (agentIds.length > MAX_AGENTS) throw badRequest(`At most ${MAX_AGENTS} agents per box`);

  const db = env.DB;
  const row = await visibleRequest(db, viewer, code);
  requirePending(row);

  const { results: agents } = await db
    .prepare(
      `SELECT id, handle FROM users
        WHERE owner_id = ?1 AND kind = 'agent' AND disabled_at IS NULL
          AND id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(viewer.user.id, JSON.stringify(agentIds))
    .all<{ id: string; handle: string }>();
  if (agents.length !== agentIds.length) throw notFound("No such agent");
  const ordered = agentIds.map((id) => agents.find((a) => a.id === id)!);

  /* The same tokens settings makes; then they expire with the request and say they are the box's. */
  /* A box asking for named agents is adding them to its setup and already has its owner's read-only token. */
  const owner = row.wanted_agents ? null : await createPersonalToken(db, viewer.user.id, { name: `${row.host} box`, scope: "read", days: null });
  const minted = [];
  for (const agent of ordered) {
    minted.push({ handle: agent.handle, ...(await createPersonalToken(db, agent.id, { name: row.host, scope: "write", days: null })) });
  }
  const ids = [...(owner ? [owner.token.id] : []), ...minted.map((m) => m.token.id)];
  const payload: Payload = {
    owner: owner ? { handle: viewer.user.handle, token: owner.secret } : null,
    agents: minted.map((m) => ({ handle: m.handle, token: m.secret })),
  };
  const sealed = await seal(env, sealContext(row.id), JSON.stringify(payload));

  const [, approved] = await db.batch([
    db
      .prepare(`UPDATE api_tokens SET expires_at = ?2, client = ?3 WHERE id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(ids), row.expires_at, BOX_CLIENT),
    db
      .prepare(
        `UPDATE device_requests
            SET status = 'approved', user_id = ?2, approved_at = ?3, payload_cipher = ?4, token_ids = ?5
          WHERE id = ?1 AND status = 'pending' AND expires_at > ?3`,
      )
      .bind(row.id, viewer.user.id, nowIso(), JSON.stringify(sealed), JSON.stringify(ids)),
  ]);
  changes.notify([viewer.user.id], "tokens", "agents");
  /* Answered or expired in the meantime: these tokens go nowhere. */
  if (approved.meta.changes === 0) {
    await revokeStatement(db, ids).run();
    throw conflict("This code was answered or expired just now", "expired");
  }
  return json(info((await findByUserCode(db, code))!));
}

/** POST /api/device/deny { userCode }: the box gets "denied" and nothing else. */
export async function postDeviceDeny(request: Request, env: Env, viewer: Viewer): Promise<Response> {
  requirePersonInApp(viewer);
  const body = await readJson(request);
  const code = userCodeFrom(body.userCode);
  const db = env.DB;
  const row = await visibleRequest(db, viewer, code);
  requirePending(row);
  const now = nowIso();
  const result = await db
    .prepare(`UPDATE device_requests SET status = 'denied', user_id = ?2 WHERE id = ?1 AND status = 'pending' AND expires_at > ?3`)
    .bind(row.id, viewer.user.id, now)
    .run();
  if (result.meta.changes === 0) throw conflict("This code was answered or expired just now", "expired");
  return json(info((await findByUserCode(db, code))!));
}
