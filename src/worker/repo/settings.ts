/* ============================================================================
   Reading a user's settings. GET /api/settings answers with this, and routes
   that act on a setting (the CoinGecko ids for the markets pane) read it
   here rather than trusting the browser to send it.
   ========================================================================== */

import { DEFAULT_SETTINGS, isSettingKey, parseSetting, type Settings } from "@/domain/settings";

export async function readSettings(db: D1Database, userId: string): Promise<Settings> {
  const { results } = await db
    .prepare(`SELECT key, value FROM settings WHERE user_id = ?1`)
    .bind(userId)
    .all<{ key: string; value: string }>();
  const settings: Settings = { ...DEFAULT_SETTINGS };
  for (const row of results) {
    /* A row a later version stopped understanding reads as the default. */
    if (!isSettingKey(row.key)) continue;
    const value = parseSetting(row.key, JSON.parse(row.value));
    if (value !== undefined) (settings as unknown as Record<string, unknown>)[row.key] = value;
  }
  return settings;
}
