/* ============================================================================
   Personal settings: the keys, their shapes, and their defaults.
   ----------------------------------------------------------------------------
   Stored one row per key (settings table) as JSON. The Worker refuses a key
   not listed here and a value its parser rejects, so what comes back out is
   always the shape below. A key with no row reads as its default.

   Vault entries (API keys) are not settings: they are write-only from the
   browser and live encrypted in their own table. VAULT_NAMES lists the ones
   the app knows how to use.
   ========================================================================== */

import { THEMES } from "./themes";

export interface Settings {
  theme: string;
  /** Where the weather comes from. Null until someone sets it. */
  location: { name: string; latitude: number; longitude: number } | null;
  /** Binance spot symbols, quoted in USDT: ["BTC", "ETH"]. */
  coins: string[];
}

export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  theme: "nord",
  location: null,
  coins: ["BTC", "ETH", "SOL"],
};

type Parser<T> = (raw: unknown) => T | null;

const SYMBOL = /^[A-Z0-9]{2,12}$/;

const PARSERS: { [K in SettingKey]: Parser<Settings[K]> } = {
  theme: (raw) => (typeof raw === "string" && THEMES.some((t) => t.id === raw) ? raw : null),

  location: (raw) => {
    if (raw === null) return null;
    if (typeof raw !== "object") return null;
    const { name, latitude, longitude } = raw as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || name.length > 80) return null;
    if (typeof latitude !== "number" || latitude < -90 || latitude > 90) return null;
    if (typeof longitude !== "number" || longitude < -180 || longitude > 180) return null;
    return { name: name.trim(), latitude, longitude };
  },

  coins: (raw) => {
    if (!Array.isArray(raw) || raw.length > 20) return null;
    const coins = raw.map((c) => (typeof c === "string" ? c.trim().toUpperCase() : ""));
    if (coins.some((c) => !SYMBOL.test(c))) return null;
    return [...new Set(coins)];
  },
};

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(PARSERS, key);
}

/**
 * The value as stored shape, or undefined when it is not one. Undefined and
 * not null because null is a valid location.
 */
export function parseSetting<K extends SettingKey>(key: K, raw: unknown): Settings[K] | undefined {
  const parsed = PARSERS[key](raw);
  if (parsed === null && !(key === "location" && raw === null)) return undefined;
  return parsed as Settings[K];
}

/* ----------------------------------------------------------------- vault --- */

export const VAULT_NAMES = {
  coingecko: "CoinGecko demo API key: market caps and NFT floors in the markets pane",
  openai: "OpenAI API key: the verse pane",
} as const;

export type VaultName = keyof typeof VAULT_NAMES;

export function isVaultName(name: string): name is VaultName {
  return Object.hasOwn(VAULT_NAMES, name);
}

/** GET /api/vault: which keys are saved, never what they are. */
export interface VaultEntry {
  name: VaultName;
  hint: string;
  updatedAt: string;
}
