// NEWS PULSE — the WATCHLIST tab's headlines as a ticker × time grid: who is in
// the news, when, and in what tone, without reading the list. Pure, so it is
// tested on its own (__tests__/news-pulse.test.ts).

import type { Sentiment } from "./types";

export interface PulseArticle {
  symbols: string[];
  published_at: string;
  sentiment: Sentiment;
}

export interface PulseCell {
  n: number;
  pos: number;
  neg: number;
}

export interface PulseRow {
  symbol: string;
  n: number;
  pos: number;
  neg: number;
  /** One per bucket, oldest first. */
  cells: PulseCell[];
}

export interface Pulse {
  /** Start of each bucket (epoch ms), oldest first; the last one ends at `now`. */
  starts: number[];
  bucketMs: number;
  rows: PulseRow[];
  /** Rows left out by `maxRows`. */
  hidden: number;
  /** The largest headline count in one cell — the scale for intensity. */
  maxCell: number;
  /** Headlines older than the window, or with no readable date. */
  outside: number;
}

export interface PulseWindow {
  id: string;
  label: string;
  hours: number;
  bucketHours: number;
}

/** 24 columns each, so the grid keeps its width whatever the window. */
export const PULSE_WINDOWS: PulseWindow[] = [
  { id: "12h", label: "12H", hours: 12, bucketHours: 0.5 },
  { id: "24h", label: "24H", hours: 24, bucketHours: 1 },
  { id: "72h", label: "72H", hours: 72, bucketHours: 3 },
];

const HOUR = 3_600_000;

/**
 * Bucket every headline under each watchlist ticker it names. A headline about
 * two tickers counts on both rows — the grid answers "what was said about X".
 * Rows are the busiest first; a ticker with no headline in the window has no row.
 */
export function buildPulse(
  articles: PulseArticle[],
  opts: { now: number; hours: number; bucketHours: number; maxRows?: number }
): Pulse {
  const bucketMs = opts.bucketHours * HOUR;
  const count = Math.max(1, Math.round(opts.hours / opts.bucketHours));
  const start = opts.now - count * bucketMs;
  const starts = Array.from({ length: count }, (_, i) => start + i * bucketMs);

  const bySymbol = new Map<string, PulseRow>();
  let outside = 0;
  for (const a of articles) {
    const t = Date.parse(a.published_at);
    if (!Number.isFinite(t) || t < start || t > opts.now) {
      outside++;
      continue;
    }
    const i = Math.min(count - 1, Math.floor((t - start) / bucketMs));
    for (const sym of new Set(a.symbols)) {
      let row = bySymbol.get(sym);
      if (!row) {
        row = {
          symbol: sym,
          n: 0,
          pos: 0,
          neg: 0,
          cells: Array.from({ length: count }, () => ({ n: 0, pos: 0, neg: 0 })),
        };
        bySymbol.set(sym, row);
      }
      const cell = row.cells[i];
      cell.n++;
      row.n++;
      if (a.sentiment === "POS") {
        cell.pos++;
        row.pos++;
      } else if (a.sentiment === "NEG") {
        cell.neg++;
        row.neg++;
      }
    }
  }

  const all = [...bySymbol.values()].sort((a, b) => b.n - a.n || a.symbol.localeCompare(b.symbol));
  const rows = opts.maxRows ? all.slice(0, opts.maxRows) : all;
  let maxCell = 0;
  for (const r of rows) for (const c of r.cells) if (c.n > maxCell) maxCell = c.n;
  return { starts, bucketMs, rows, hidden: all.length - rows.length, maxCell, outside };
}

/** Net tone of a cell or row: (pos − neg) / n, null when empty. */
export function netTone(c: PulseCell): number | null {
  return c.n ? (c.pos - c.neg) / c.n : null;
}
