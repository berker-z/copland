/* ============================================================================
   Personal routes: who am I, my settings, my vault. Nothing here is visible
   to anyone else, so every write notifies only its author's other tabs.
   ========================================================================== */

import { isSettingKey, isVaultName, parseSetting, settingsProblem, type Settings } from "@/domain/settings";
import type { Me, Viewer } from "@/domain/types";
import type { Env } from "../env";
import { badRequest, json, readJson } from "../http";
import type { Changes } from "../live";
import { readSettings } from "../repo/settings";
import { inboxIdFor, signupMode } from "../repo/users";
import { listVault, removeVault, sealVault } from "../vault";

/**
 * GET /api/me. An agent has no inbox of its own; its "inbox" is its owner's,
 * when the owner has added it there.
 */
export async function getMe(env: Env, viewer: Viewer): Promise<Response> {
  if (viewer.agent) {
    const inbox = await inboxIdFor(env.DB, viewer.agent.owner.id);
    const onIt = await env.DB.prepare(`SELECT 1 FROM board_members WHERE board_id = ?1 AND user_id = ?2`)
      .bind(inbox, viewer.user.id)
      .first();
    const me: Me = { user: viewer.user, inboxId: onIt ? inbox : null, signup: signupMode(env), owner: viewer.agent.owner };
    return json(me);
  }
  const me: Me = {
    user: viewer.user,
    inboxId: await inboxIdFor(env.DB, viewer.user.id),
    signup: signupMode(env),
  };
  return json(me);
}

/* -------------------------------------------------------------- settings -- */

export async function getSettings(env: Env, viewer: Viewer): Promise<Response> {
  return json(await readSettings(env.DB, viewer.user.id));
}

/**
 * PATCH /api/settings { key: value, ... }: each key validated, then the
 * result as a whole (a widget switched on without the setting it needs),
 * all written together.
 */
export async function patchSettings(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  const body = await readJson(request);
  const entries = Object.entries(body);
  if (entries.length === 0) throw badRequest("Nothing to update");

  const parsed = entries.map(([key, raw]) => {
    if (!isSettingKey(key)) throw badRequest(`Unknown setting \`${key}\``);
    const value = parseSetting(key, raw);
    if (value === undefined) throw badRequest(`Invalid value for \`${key}\``);
    return [key, value] as const;
  });
  const after: Settings = { ...(await readSettings(env.DB, viewer.user.id)), ...Object.fromEntries(parsed) };
  const problem = settingsProblem(after);
  if (problem) throw badRequest(problem);

  const statements = parsed.map(([key, value]) => {
    return env.DB.prepare(
      `INSERT INTO settings (user_id, key, value, updated_at)
       VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(viewer.user.id, key, JSON.stringify(value));
  });
  await env.DB.batch(statements);
  changes.notify([viewer.user.id], "settings");
  return getSettings(env, viewer);
}

/* ----------------------------------------------------------------- vault -- */

export async function getVault(env: Env, viewer: Viewer): Promise<Response> {
  return json(await listVault(env, viewer.user.id));
}

export async function putVault(
  request: Request,
  env: Env,
  viewer: Viewer,
  name: string,
  changes: Changes,
): Promise<Response> {
  if (!isVaultName(name)) throw badRequest(`Unknown key \`${name}\``);
  const { secret } = await readJson(request);
  if (typeof secret !== "string" || !secret.trim() || secret.length > 500) {
    throw badRequest("`secret` must be a non-empty string");
  }
  await sealVault(env, viewer.user.id, name, secret.trim());
  changes.notify([viewer.user.id], "vault");
  return json(await listVault(env, viewer.user.id));
}

export async function deleteVault(env: Env, viewer: Viewer, name: string, changes: Changes): Promise<Response> {
  if (!isVaultName(name)) throw badRequest(`Unknown key \`${name}\``);
  await removeVault(env, viewer.user.id, name);
  changes.notify([viewer.user.id], "vault");
  return json(await listVault(env, viewer.user.id));
}
