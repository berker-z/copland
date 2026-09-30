/* ============================================================================
   The vault: API keys people save for their widgets, encrypted at rest.
   ----------------------------------------------------------------------------
   AES-GCM with the VAULT_KEY secret. The associated data is "<user>:<name>",
   so a ciphertext only decrypts in the row it was written for: copying a row
   to another user or another name yields an error, not someone else's key.

   Keys go in from the settings screen and never come back out to a browser.
   The Worker reads them when it calls the service on the user's behalf
   (openVault), which is also what keeps them out of the page's reach.
   ========================================================================== */

import type { VaultEntry, VaultName } from "@/domain/settings";
import type { Env } from "./env";
import { fromBase64, HttpError, toBase64 } from "./http";

let cachedKey: { raw: string; key: CryptoKey } | null = null;

async function vaultKey(env: Env): Promise<CryptoKey> {
  if (!env.VAULT_KEY) throw new HttpError(503, "This instance has no VAULT_KEY set, so it cannot store API keys");
  if (cachedKey?.raw === env.VAULT_KEY) return cachedKey.key;
  const bytes = fromBase64(env.VAULT_KEY);
  if (bytes.length !== 32) throw new HttpError(503, "VAULT_KEY must be 32 bytes, base64");
  const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  cachedKey = { raw: env.VAULT_KEY, key };
  return key;
}

const aad = (userId: string, name: string) => new TextEncoder().encode(`${userId}:${name}`);

export async function sealVault(env: Env, userId: string, name: VaultName, secret: string): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(userId, name) },
    await vaultKey(env),
    new TextEncoder().encode(secret),
  );
  await env.DB.prepare(
    `INSERT INTO vault (user_id, name, iv, ciphertext, hint, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (user_id, name) DO UPDATE SET
       iv = excluded.iv, ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = excluded.updated_at`,
  )
    .bind(userId, name, toBase64(iv), toBase64(new Uint8Array(ciphertext)), secret.slice(-4))
    .run();
}

/** The saved key in plaintext, or null when there is none. Worker-side use only. */
export async function openVault(env: Env, userId: string, name: VaultName): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT iv, ciphertext FROM vault WHERE user_id = ?1 AND name = ?2`)
    .bind(userId, name)
    .first<{ iv: string; ciphertext: string }>();
  if (!row) return null;
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(row.iv), additionalData: aad(userId, name) },
    await vaultKey(env),
    fromBase64(row.ciphertext),
  );
  return new TextDecoder().decode(plain);
}

export async function listVault(env: Env, userId: string): Promise<VaultEntry[]> {
  const { results } = await env.DB.prepare(
    `SELECT name, hint, updated_at FROM vault WHERE user_id = ?1 ORDER BY name`,
  )
    .bind(userId)
    .all<{ name: VaultName; hint: string; updated_at: string }>();
  return results.map((r) => ({ name: r.name, hint: r.hint, updatedAt: r.updated_at }));
}

export async function removeVault(env: Env, userId: string, name: VaultName): Promise<void> {
  await env.DB.prepare(`DELETE FROM vault WHERE user_id = ?1 AND name = ?2`).bind(userId, name).run();
}
