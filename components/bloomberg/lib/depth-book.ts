/**
 * Order-book ladder for STRUCTURE → DEPTH: bids and asks paired row by row,
 * each with the share of the largest resting size on screen (the bar).
 * Pure — no React, no fetch — so the arithmetic is tested on its own.
 */

export interface DepthLevel {
  price: number;
  size: number;
  /** Orders resting at the level, when the feed says; null when it does not. */
  count: number | null;
}

export interface DepthBook {
  symbol: string;
  category: string;
  overnight: boolean;
  bids: DepthLevel[];
  asks: DepthLevel[];
  levels: number;
  depth_requested: number;
  has_counts: boolean;
  quote_time: string | null;
  source: { name: string; endpoint: string; environment: string; retrieved_at: string };
}

export interface DepthRow {
  bid: (DepthLevel & { bar: number }) | null;
  ask: (DepthLevel & { bar: number }) | null;
}

export interface DepthLadder {
  rows: DepthRow[];
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  /** Spread as a share of the mid, in basis points. */
  spreadBps: number | null;
  mid: number | null;
  bidSize: number;
  askSize: number;
  /** (bid − ask) / (bid + ask) over the rows shown: +1 all bids, −1 all asks. */
  imbalance: number | null;
}

export const DEPTH_CHOICES = [5, 10, 20, 50] as const;

/**
 * Symbols the feed covers: US stocks and ETFs, share classes included (BRK.B, BF-B).
 * A two-letter suffix is a foreign listing (PTT.BK). Mirrors `_SYMBOL` in routers/webull.py.
 */
export const isDepthSymbol = (symbol: string | null | undefined): symbol is string =>
  !!symbol && /^[A-Z]{1,5}(?:[.-][ABC])?$/.test(symbol);

export function buildLadder(
  book: Pick<DepthBook, "bids" | "asks">,
  maxRows = Number.POSITIVE_INFINITY
): DepthLadder {
  const bids = book.bids.slice(0, maxRows);
  const asks = book.asks.slice(0, maxRows);
  let largest = 0;
  let bidSize = 0;
  let askSize = 0;
  for (const l of bids) {
    bidSize += l.size;
    if (l.size > largest) largest = l.size;
  }
  for (const l of asks) {
    askSize += l.size;
    if (l.size > largest) largest = l.size;
  }
  const withBar = (l: DepthLevel | undefined) =>
    l ? { ...l, bar: largest > 0 ? l.size / largest : 0 } : null;
  const rows: DepthRow[] = [];
  for (let i = 0; i < Math.max(bids.length, asks.length); i++)
    rows.push({ bid: withBar(bids[i]), ask: withBar(asks[i]) });

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const both = bestBid != null && bestAsk != null;
  const spread = both ? bestAsk - bestBid : null;
  const mid = both ? (bestAsk + bestBid) / 2 : null;
  const total = bidSize + askSize;
  return {
    rows,
    bestBid,
    bestAsk,
    spread,
    spreadBps: spread != null && mid ? (spread / mid) * 10_000 : null,
    mid,
    bidSize,
    askSize,
    imbalance: total > 0 ? (bidSize - askSize) / total : null,
  };
}
