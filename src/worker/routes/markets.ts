/* ============================================================================
   The markets pane's CoinGecko extras: market caps for the coin ids and
   floor prices for the NFT ids in the user's settings.
   ----------------------------------------------------------------------------
   Binance prices need no key and the browser fetches them itself. CoinGecko
   needs one, so the Worker makes the call with the user's vault entry and
   the key never reaches the page (nord-dash put it in the bundle).

   The ids come from the saved settings, not the request: the browser only
   asks "my extras", and cannot make the Worker spend someone's key on
   arbitrary paths.

   CoinGecko's demo plan allows 10k calls a month, and nord-dash polling
   every ten minutes used most of it. Answers are cached for CACHE_SECONDS,
   keyed by the path without the key: this is public market data, so two
   users watching the same coin share one call. Two layers, because the
   Cache API does nothing on a workers.dev hostname: the isolate's memory
   (lost whenever the isolate is), then caches.default (per colo, where it
   works).
   ========================================================================== */

import type { MarketCoin, MarketExtras, MarketNft } from "@/domain/panes";
import type { Viewer } from "@/domain/types";
import type { Env } from "../env";
import { json } from "../http";
import { readSettings } from "../repo/settings";
import { openVault } from "../vault";

const API = "https://api.coingecko.com/api/v3/";
const USER_AGENT = "copland/0.1 (+https://github.com/berker-z/copland)";
const CACHE_SECONDS = 15 * 60;
/* Not an address anything answers on; only a key for caches.default. */
const CACHE_ORIGIN = "https://coingecko.cache.copland.invalid/";
const MEMORY_MAX = 200;

const memory = new Map<string, { at: number; body: unknown }>();

class UpstreamError extends Error {}

/** A CoinGecko GET, from cache when it is fresh enough. */
async function coingecko(path: string, key: string): Promise<unknown> {
  const hit = memory.get(path);
  if (hit && Date.now() - hit.at < CACHE_SECONDS * 1000) return hit.body;

  const cacheKey = new Request(CACHE_ORIGIN + path);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const body: unknown = await cached.json();
    remember(path, body);
    return body;
  }

  /* The header, not the query string: nord-dash put the key in the URL only
     to dodge a CORS preflight, which a Worker does not have. */
  /* CoinGecko refuses requests without a descriptive User-Agent (403), and a
     Worker's fetch sends none by default. */
  const response = await fetch(API + path, {
    headers: { accept: "application/json", "user-agent": USER_AGENT, "x-cg-demo-api-key": key },
  });
  if (!response.ok) throw new UpstreamError(`${path.split("?")[0]}: ${response.status}`);
  const body: unknown = await response.json();
  remember(path, body);
  await caches.default.put(
    cacheKey,
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_SECONDS}` },
    }),
  );
  return body;
}

function remember(path: string, body: unknown): void {
  if (memory.size >= MEMORY_MAX) memory.clear();
  memory.set(path, { at: Date.now(), body });
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown, fallback: string): string => (typeof value === "string" && value ? value : fallback);

async function fetchCoins(ids: string[], key: string): Promise<MarketCoin[]> {
  const body = await coingecko(`coins/markets?vs_currency=usd&ids=${ids.join(",")}`, key);
  if (!Array.isArray(body)) throw new UpstreamError("coins/markets: unexpected answer");
  const byId = new Map(body.map((c: Record<string, unknown>) => [c.id, c]));
  /* In the order the user listed them; an id CoinGecko does not know is
     simply absent from its answer. */
  return ids.flatMap((id) => {
    const coin = byId.get(id);
    if (!coin) return [];
    return [
      {
        id,
        symbol: str(coin.symbol, id).toUpperCase(),
        marketCapUsd: num(coin.market_cap),
        change24h: num(coin.price_change_percentage_24h),
      },
    ];
  });
}

async function fetchNft(id: string, key: string): Promise<MarketNft> {
  const body = (await coingecko(`nfts/${id}`, key)) as Record<string, unknown>;
  const floor = (body.floor_price ?? {}) as Record<string, unknown>;
  const change = (body.floor_price_24h_percentage_change ?? {}) as Record<string, unknown>;
  return {
    id,
    name: str(body.name, id),
    floor: num(floor.native_currency),
    currency: str(body.native_currency_symbol, "").toUpperCase(),
    change24h: num(change.native_currency),
  };
}

/** GET /api/markets/coingecko */
export async function getMarketExtras(env: Env, viewer: Viewer): Promise<Response> {
  const key = await openVault(env, viewer.user.id, "coingecko");
  if (!key) return json({ configured: false, coins: [], nfts: [], errors: [] } satisfies MarketExtras);

  const { coingeckoCoins, coingeckoNfts } = await readSettings(env.DB, viewer.user.id);
  const [coins, ...nfts] = await Promise.allSettled([
    coingeckoCoins.length ? fetchCoins(coingeckoCoins, key) : Promise.resolve([]),
    ...coingeckoNfts.map((id) => fetchNft(id, key)),
  ]);

  /* One failure (a mistyped NFT id is a 404) should not blank the rest. */
  const errors: string[] = [];
  const failed = (reason: unknown) => {
    if (reason instanceof UpstreamError) errors.push(reason.message);
    else {
      console.warn("coingecko fetch failed", reason);
      errors.push("coingecko unreachable");
    }
  };
  const extras: MarketExtras = { configured: true, coins: [], nfts: [], errors };
  if (coins.status === "fulfilled") extras.coins = coins.value as MarketCoin[];
  else failed(coins.reason);
  for (const nft of nfts) {
    if (nft.status === "fulfilled") extras.nfts.push(nft.value as MarketNft);
    else failed(nft.reason);
  }
  return json(extras);
}
