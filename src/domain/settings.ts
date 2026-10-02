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
  /**
   * CoinGecko coin ids ("milady-cult-coin"), shown by market cap in the
   * markets pane. They need the coingecko vault key, so the Worker fetches
   * them.
   */
  coingeckoCoins: string[];
  /** CoinGecko NFT collection ids ("milady-maker"), shown by floor price. */
  coingeckoNfts: string[];
}

export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  theme: "nord",
  location: null,
  coins: ["BTC", "ETH", "SOL"],
  coingeckoCoins: [],
  coingeckoNfts: [],
};

type Parser<T> = (raw: unknown) => T | null;

const SYMBOL = /^[A-Z0-9]{2,12}$/;
/* CoinGecko ids are lowercase slugs. They end up in a URL the Worker
   fetches, so nothing outside this set gets through. */
const COINGECKO_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/** At most `max` CoinGecko ids, trimmed, lowercased and deduplicated. */
const coingeckoIds =
  (max: number): Parser<string[]> =>
  (raw) => {
    if (!Array.isArray(raw) || raw.length > max) return null;
    const ids = raw.map((c) => (typeof c === "string" ? c.trim().toLowerCase() : ""));
    if (ids.some((c) => !COINGECKO_ID.test(c))) return null;
    return [...new Set(ids)];
  };

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

  /* All the coins are one request; every NFT is a request of its own, so
     that list is kept shorter. */
  coingeckoCoins: coingeckoIds(20),
  coingeckoNfts: coingeckoIds(8),
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
