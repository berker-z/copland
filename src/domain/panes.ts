/* ============================================================================
   Shapes the dashboard panes' routes send and take: notes and the CoinGecko
   extras for the markets pane. Kept apart from types.ts,
   which is the boards and people side.
   ========================================================================== */

/* ----------------------------------------------------------------- notes --- */

export interface Note {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  /** Set by the Worker on every write; the notepad orders by it and uses it
      to tell a newer copy from the server apart from a stale one. */
  updatedAt: string;
}

export const NOTE_NAME_MAX = 80;
/* D1 rows top out around 2MB; a notepad is nowhere near that. */
export const NOTE_CONTENT_MAX = 200_000;

/* --------------------------------------------------------------- markets --- */

/** A CoinGecko coin, by market cap. */
export interface MarketCoin {
  id: string;
  symbol: string;
  marketCapUsd: number | null;
  change24h: number | null;
}

/** A CoinGecko NFT collection, by floor price in its native currency. */
export interface MarketNft {
  id: string;
  name: string;
  floor: number | null;
  /** "ETH", "SOL"... */
  currency: string;
  change24h: number | null;
}

/** GET /api/markets/coingecko */
export interface MarketExtras {
  /** False when there is no coingecko key in the vault; nothing was fetched. */
  configured: boolean;
  coins: MarketCoin[];
  nfts: MarketNft[];
  /** What failed, one short line each ("nfts/foo: 404"). The rest still shows. */
  errors: string[];
}
