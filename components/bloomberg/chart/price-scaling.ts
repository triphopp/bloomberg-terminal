import type { OhlcvBar } from "./types";

export type PriceRow = { date: string; close: number | null };

/** Yahoo history symbols quoted in USD. The frontend still fetches through /api/stock. */
export function usdPriceSymbol(unit: string): string | null {
  if (unit === "USD") return null;
  if (["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "LTC"].includes(unit)) return `${unit}-USD`;
  return `${unit}USD=X`;
}

function latestRate(rows: PriceRow[], date: string): number | null {
  const day = date.slice(0, 10);
  let rate: number | null = null;
  for (const row of rows) {
    if (row.date.slice(0, 10) > day) break;
    if (row.close != null && Number.isFinite(row.close) && row.close > 0) rate = row.close;
  }
  return rate;
}

/** Convert quote currency to USD, then divide by USD price of the chosen unit. */
export function scaleBars(
  bars: OhlcvBar[],
  sourceCurrency: string,
  unit: string,
  sourceUsd: PriceRow[],
  targetUsd: PriceRow[]
): OhlcvBar[] {
  const source = [...sourceUsd].sort((a, b) => a.date.localeCompare(b.date));
  const target = [...targetUsd].sort((a, b) => a.date.localeCompare(b.date));
  return bars.flatMap((bar) => {
    const date =
      typeof bar.time === "number" ? new Date(bar.time * 1000).toISOString() : String(bar.time);
    const fromRate = sourceCurrency === "USD" ? 1 : latestRate(source, date);
    const toRate = unit === "USD" ? 1 : latestRate(target, date);
    if (!fromRate || !toRate) return [];
    const factor = fromRate / toRate;
    return [
      {
        ...bar,
        open: bar.open * factor,
        high: bar.high * factor,
        low: bar.low * factor,
        close: bar.close * factor,
      },
    ];
  });
}
