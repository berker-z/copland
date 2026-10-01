/* ============================================================================
   The markets pane, from nord-dash's CryptoWidget: Binance prices for the
   coins in settings every 15 seconds, then the CoinGecko extras (market caps,
   NFT floors) the Worker fetches with the user's key every fifteen minutes.

   Without a coingecko key the pane is just Binance, with one quiet line
   saying where the rest would come from.
   ========================================================================== */

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { useMarketExtras, useSettings, useVault } from "@/lib/queries";
import { WidgetFrame } from "@/ui/WidgetFrame";
import { useTickers } from "./binance";

interface Row {
  key: string;
  label: string;
  /** The line under the label: what the number is. */
  unit: string;
  value: string;
  change: number | null;
}

/** 1.23T / 4.56B / 7.89M / 1.00K, as nord-dash had it. */
function compact(num: number): string {
  if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
  return num.toFixed(2);
}

/* Two decimals, except for coins worth less than a cent, which would all
   read $0.00. */
const usd = (price: number) => `$${price >= 0.01 ? price.toFixed(2) : price.toPrecision(3)}`;

function MarketRow({ row }: { row: Row }) {
  const up = row.change !== null && row.change >= 0;
  return (
    <div className="flex items-center justify-between gap-4 border-b border-divider pb-2 mb-2 last:mb-0 px-2 hover:bg-raised transition-colors">
      <div className="min-w-0">
        <div className="leading-none text-bright tracking-wider truncate" title={row.label}>
          {row.label}
        </div>
        <div className="text-muted text-xs mt-1">{row.unit}</div>
      </div>
      <div className="text-right tabular-nums shrink-0">
        <div className="text-bright">{row.value}</div>
        {row.change === null ? (
          <div className="text-faint">--</div>
        ) : (
          <div className={`flex items-center justify-end gap-2 ${up ? "text-green" : "text-red"}`}>
            <span>
              {up ? "+" : ""}
              {row.change.toFixed(2)}%
            </span>
            <span>{up ? "[^]" : "[v]"}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function MarketsPane({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { data: settings = DEFAULT_SETTINGS } = useSettings();
  const { data: vault } = useVault();
  const cgKey = vault?.find((e) => e.name === "coingecko");
  const cgIds = [...settings.coingeckoCoins, ...settings.coingeckoNfts];

  const binance = useTickers(settings.coins);
  const wantsExtras = Boolean(cgKey) && cgIds.length > 0;
  const extras = useMarketExtras(
    [settings.coingeckoCoins, settings.coingeckoNfts, cgKey?.updatedAt ?? null],
    wantsExtras,
  );
  const cg = wantsExtras && extras.data?.configured ? extras.data : null;

  const rows: Row[] = [
    ...(binance.data ?? []).map((t) => ({
      key: `b:${t.symbol}`,
      label: t.symbol,
      unit: "/USDT",
      value: t.price === null ? "no pair" : usd(t.price),
      change: t.change24h,
    })),
    ...(cg?.coins ?? []).map((c) => ({
      key: `c:${c.id}`,
      label: c.symbol,
      unit: "/MCAP",
      value: c.marketCapUsd === null ? "--" : `${compact(c.marketCapUsd)} USD`,
      change: c.change24h,
    })),
    ...(cg?.nfts ?? []).map((n) => ({
      key: `n:${n.id}`,
      label: n.name.toUpperCase(),
      unit: "/FLOOR",
      value: n.floor === null ? "--" : `${n.floor} ${n.currency}`.trim(),
      change: n.change24h,
    })),
  ];

  const syncing = binance.isFetching || extras.isFetching;
  const refresh = () => {
    void binance.refetch();
    /* The Worker answers from its cache inside fifteen minutes, so this costs
       no CoinGecko call. */
    if (wantsExtras) void extras.refetch();
  };
  const lastSync = binance.dataUpdatedAt ? new Date(binance.dataUpdatedAt).toLocaleTimeString("en-GB") : "--:--:--";

  return (
    <WidgetFrame title="/markets">
      <div className="flex flex-col">
        <div className="flex justify-between items-end mb-4 text-muted border-b border-divider pb-2">
          <span className="text-xs">LAST_SYNC: {lastSync}</span>
          <button
            onClick={refresh}
            disabled={syncing}
            className="tap hover:text-accent transition-colors disabled:opacity-50 uppercase text-xs"
          >
            [{syncing ? "SYNCING..." : "REFRESH"}]
          </button>
        </div>

        <div>
          {rows.map((row) => (
            <MarketRow key={row.key} row={row} />
          ))}
        </div>

        {rows.length === 0 && binance.isError && <div className="text-red text-center my-6">! CONNECTION_ERROR !</div>}
        {rows.length === 0 && !binance.isError && !binance.isPending && (
          <div className="text-faint text-center my-6">no coins. add some in settings</div>
        )}

        {cg && cg.errors.length > 0 && (
          <p className="text-xs text-red mt-2" title={cg.errors.join("\n")}>
            ! COINGECKO: {cg.errors[0]}
            {cg.errors.length > 1 && ` (+${cg.errors.length - 1})`}
          </p>
        )}
        {wantsExtras && extras.isError && <p className="text-xs text-red mt-2">! COINGECKO: {extras.error.message}</p>}
        {vault && !cgKey && (
          <button onClick={onOpenSettings} className="text-xs text-faint hover:text-accent text-left mt-2 transition-colors">
            {cgIds.length > 0 ? "coingecko ids need a key: " : "market caps and nft floors: "}
            add a coingecko key in settings
          </button>
        )}
        {cgKey && cgIds.length === 0 && (
          <button onClick={onOpenSettings} className="text-xs text-faint hover:text-accent text-left mt-2 transition-colors">
            coingecko key saved: add coin or nft ids in settings
          </button>
        )}
      </div>
    </WidgetFrame>
  );
}
