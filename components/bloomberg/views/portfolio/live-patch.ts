/**
 * Folds live quote ticks (routers/stream.py) into a cached open-positions
 * payload.
 *
 * Works in DELTAS against the price the payload already holds, never
 * recomputing a figure from scratch: the backend's unrealized P&L carries
 * entry-date FX on the cost side, and rebuilding it here from price × volume
 * would quietly swap that for today's FX. Moving by (new − old) × volume keeps
 * every accounting choice the backend made and only moves what the price moved.
 * Deltas chain — tick 2 is measured from tick 1's price — and the next REST
 * refetch replaces the lot with the backend's own numbers.
 *
 * Returns the same object when nothing changed, so React Query does not
 * re-render every subscriber for a tick that did not touch this payload.
 */

export interface LiveTick {
  price: number;
  change?: number | null;
  change_pct?: number | null;
  ts?: number;
}

export interface LivePosition {
  yf_symbol?: string | null;
  volume: number;
  price_entry: number;
  current_price?: number | null;
  prev_close?: number | null;
  currency?: string | null;
  pos_currency?: string | null;
  acc_currency?: string | null;
  unrealized_pnl?: number | null;
  unrealized_pnl_thb?: number | null;
  unrealized_pnl_base?: number | null;
  unrealized_pct?: number | null;
  market_value_base?: number | null;
  day_pnl?: number | null;
  day_pnl_thb?: number | null;
  day_pnl_base?: number | null;
  day_pct?: number | null;
  day_stale?: boolean | null;
}

function convert(v: number, from: string, to: string, thbPerUsd: number): number {
  const usd = from === "USD" || from === "USDT";
  if (usd && to === "THB") return v * thbPerUsd;
  if (from === "THB" && to === "USD") return v / thbPerUsd;
  return v;
}

const add = (v: number | null | undefined, d: number) => (v == null ? v : v + d);

export function applyTicks<T extends { positions: LivePosition[]; thb_per_usd: number }>(
  payload: T,
  ticks: Record<string, LiveTick>,
  base: string
): T {
  let changed = false;
  const positions = payload.positions.map((p) => {
    const t = p.yf_symbol ? ticks[p.yf_symbol] : undefined;
    const old = p.current_price;
    if (!t || !Number.isFinite(t.price) || old == null || t.price === old) return p;
    changed = true;

    const ccy = p.currency ?? p.pos_currency ?? p.acc_currency ?? "THB";
    const fx = payload.thb_per_usd;
    const d = (t.price - old) * p.volume;
    const dBase = convert(d, ccy, base, fx);
    const dThb = convert(d, ccy, "THB", fx);

    const next: LivePosition = {
      ...p,
      current_price: t.price,
      unrealized_pnl: add(p.unrealized_pnl, d),
      unrealized_pnl_thb: add(p.unrealized_pnl_thb, dThb),
      unrealized_pnl_base: add(p.unrealized_pnl_base, dBase),
      market_value_base: add(p.market_value_base, dBase),
      unrealized_pct:
        p.price_entry > 0 ? ((t.price - p.price_entry) / p.price_entry) * 100 : p.unrealized_pct,
    };
    // A position whose market has not traded today has no day P&L on purpose
    // (see day_stale); a tick does not invent one — the next refetch does.
    if (!p.day_stale) {
      next.day_pnl = add(p.day_pnl, d);
      next.day_pnl_thb = add(p.day_pnl_thb, dThb);
      next.day_pnl_base = add(p.day_pnl_base, dBase);
      if (p.prev_close && p.prev_close > 0) {
        next.day_pct = ((t.price - p.prev_close) / p.prev_close) * 100;
      }
    }
    return next;
  });
  return changed ? { ...payload, positions } : payload;
}
