/**
 * Folds live quote ticks (backend quote stream) into the three quote shapes the
 * terminal caches: a stock quote (watchlist, chart header), a TICK DATA row
 * (indices, volatility) and an FX pair.
 *
 * LAST and CHG always move TOGETHER from one tick. Yahoo's stream message
 * carries price, change and change % as one print, so the pair can never
 * disagree the way it did when price and change came from two different REST
 * calls polled at different times. When a frame has no change fields, change
 * is derived from the row's own previous close — still one reference, still
 * consistent with the price shown next to it.
 *
 * A tick only arrives for the regular session (the backend drops pre/post), so
 * it also means "this is today's session": `isCurrentSession` is set, which
 * lifts the stale-session dimming the board applies after a close.
 *
 * Every function returns the SAME object when nothing changed, so an idle
 * symbol costs no re-render.
 */

export interface Tick {
  price: number;
  change?: number | null;
  change_pct?: number | null;
  ts?: number;
}

const ok = (t: Tick | undefined): t is Tick => !!t && Number.isFinite(t.price) && t.price > 0;

/** change / change% for a new price, from the tick or from a previous close. */
function moves(t: Tick, prevClose: number | null | undefined) {
  if (t.change != null && t.change_pct != null) return { change: t.change, pct: t.change_pct };
  if (prevClose && prevClose > 0) {
    const change = t.price - prevClose;
    return { change, pct: (change / prevClose) * 100 };
  }
  return null;
}

// ── Stock quote (["stock","quote",SYM]) ──────────────────────────────────────

export interface QuoteLike {
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketPreviousClose?: number | null;
  regularMarketTime?: number;
  isCurrentSession?: boolean | null;
}

export function patchQuote<Q extends QuoteLike>(
  q: Q | undefined,
  t: Tick | undefined
): Q | undefined {
  if (!q || !ok(t) || q.regularMarketPrice === t.price) return q;
  const m = moves(t, q.regularMarketPreviousClose);
  return {
    ...q,
    regularMarketPrice: t.price,
    ...(m ? { regularMarketChange: m.change, regularMarketChangePercent: m.pct } : {}),
    ...(t.ts ? { regularMarketTime: Math.floor(t.ts / 1000) } : {}),
    isCurrentSession: true,
  };
}

// ── TICK DATA row (indices /api/market-data, /api/volatility) ────────────────

export interface RowLike {
  symbol: string;
  value: number;
  change: number;
  pctChange: number;
  ytd?: number;
  ytdCur?: number;
  isCurrentSession?: boolean | null;
}

export function patchRow<R extends RowLike>(r: R, t: Tick | undefined): R {
  if (!ok(t) || r.value === t.price) return r;
  const m = moves(t, r.value - r.change);
  // YTD base = the year's first close, recovered from the row's own value/ytd.
  let ytd = r.ytd;
  if (ytd != null && ytd !== 0 && r.value > 0) {
    const start = r.value / (1 + ytd / 100);
    ytd = start > 0 ? (t.price / start - 1) * 100 : ytd;
  }
  return {
    ...r,
    value: t.price,
    ...(m ? { change: m.change, pctChange: m.pct } : {}),
    ...(ytd != null ? { ytd, ytdCur: ytd } : {}),
    isCurrentSession: true,
  };
}

/** Patch every row array found in `payload[key]` for the given keys. */
export function patchRowGroups<P extends Record<string, unknown>>(
  payload: P | undefined,
  keys: readonly string[],
  ticks: Record<string, Tick>
): P | undefined {
  if (!payload) return payload;
  let changed = false;
  const next: Record<string, unknown> = { ...payload };
  for (const k of keys) {
    const rows = payload[k];
    if (!Array.isArray(rows)) continue;
    const out = (rows as RowLike[]).map((r) => patchRow(r, ticks[r.symbol]));
    if (out.some((r, i) => r !== rows[i])) {
      next[k] = out;
      changed = true;
    }
  }
  return changed ? (next as P) : payload;
}

// ── FX pair (/api/fx?type=overview) ─────────────────────────────────────────

export interface FxLike {
  symbol: string;
  price: number;
  change: number | null;
  pctChange: number | null;
  prevClose: number | null;
}

export function patchFxPairs<P extends { pairs: FxLike[] }>(
  payload: P | undefined,
  ticks: Record<string, Tick>
): P | undefined {
  if (!payload?.pairs) return payload;
  let changed = false;
  const pairs = payload.pairs.map((p) => {
    const t = ticks[p.symbol];
    if (!ok(t) || p.price === t.price) return p;
    changed = true;
    const m = moves(t, p.prevClose);
    return { ...p, price: t.price, ...(m ? { change: m.change, pctChange: m.pct } : {}) };
  });
  return changed ? { ...payload, pairs } : payload;
}
