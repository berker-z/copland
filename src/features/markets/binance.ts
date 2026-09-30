/* ============================================================================
   Binance spot prices, straight from the browser. Public, keyless and CORS
   open, so there is no reason to route them through the Worker.
   ========================================================================== */

import { useQuery } from "@tanstack/react-query";

export interface Ticker {
  symbol: string;
  /** Null when Binance has no <symbol>USDT pair (a typo, or a delisting). */
  price: number | null;
  change24h: number | null;
}

const POLL_MS = 15_000;

async function ticker(symbol: string): Promise<Ticker> {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}USDT`);
  if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol}`);
  const json = (await res.json()) as { lastPrice?: string; priceChangePercent?: string };
  const price = Number(json.lastPrice);
  const change = Number(json.priceChangePercent);
  return {
    symbol,
    price: Number.isFinite(price) ? price : null,
    change24h: Number.isFinite(change) ? change : null,
  };
}

/**
 * One request per coin rather than Binance's batch form: the batch fails
 * whole on one unknown symbol, and these symbols are typed in by hand.
 */
async function tickers(coins: string[]): Promise<Ticker[]> {
  const results = await Promise.allSettled(coins.map(ticker));
  if (coins.length > 0 && results.every((r) => r.status === "rejected")) {
    throw new Error("Binance unreachable");
  }
  return results.map((r, i) => (r.status === "fulfilled" ? r.value : { symbol: coins[i], price: null, change24h: null }));
}

export const useTickers = (coins: string[]) =>
  useQuery({
    queryKey: ["markets", "binance", ...coins],
    queryFn: () => tickers(coins),
    refetchInterval: POLL_MS,
    /* Prices from a minute ago beat an empty pane while the next poll runs. */
    placeholderData: (previous) => previous,
  });
