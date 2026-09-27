/**
 * Folds a live quote tick (backend quote stream) into a cached OHLCV history,
 * so the last candle moves with the market and a new candle opens when the
 * tick falls past the last one.
 *
 * Bar dates from /api/stock/history are exchange-local with no zone
 * ("2026-09-25T15:30:00" is 15:30 New York); ticks are UTC. The history
 * payload carries `utc_offset_min` for exactly this — without it a tick cannot
 * be placed and the history is returned untouched.
 *
 * Volume is left alone: the stream reports the day's cumulative volume, not the
 * bar's. The next REST refetch brings the real bar, volume included.
 *
 * Returns the same object when nothing changed.
 */

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LiveHistory {
  quotes: Bar[];
  interval?: string;
  utc_offset_min?: number | null;
}

const INTRADAY_MS: Record<string, number> = {
  "1m": 60_000,
  "2m": 120_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "60m": 3_600_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
};

const localIso = (utcMs: number, offMin: number) =>
  new Date(utcMs + offMin * 60_000).toISOString().slice(0, 19);

export function applyTickToBars<T extends LiveHistory>(
  history: T,
  tick: { price: number; ts?: number },
  now = Date.now()
): T {
  const bars = history.quotes;
  const off = history.utc_offset_min;
  if (!bars?.length || off == null || !Number.isFinite(tick.price) || tick.price <= 0)
    return history;

  const last = bars[bars.length - 1];
  const ts = tick.ts && tick.ts > 0 ? tick.ts : now;
  const p = tick.price;

  const update = (): T => {
    if (last.close === p && last.high >= p && last.low <= p) return history;
    const bar = { ...last, close: p, high: Math.max(last.high, p), low: Math.min(last.low, p) };
    return { ...history, quotes: [...bars.slice(0, -1), bar] };
  };
  const append = (date: string): T => ({
    ...history,
    quotes: [...bars, { date, open: p, high: p, low: p, close: p, volume: 0 }],
  });

  const interval = history.interval ?? "";
  const step = INTRADAY_MS[interval];

  if (step) {
    const lastStart = Date.parse(`${last.date.slice(0, 19)}Z`) - off * 60_000;
    if (!Number.isFinite(lastStart)) return history;
    const k = Math.floor((ts - lastStart) / step);
    if (k < 0) return history; // older than the last bar — a late frame
    if (k === 0) return update();
    return append(localIso(lastStart + k * step, off));
  }

  const tickDay = localIso(ts, off).slice(0, 10);
  const lastDay = last.date.slice(0, 10);
  if (tickDay < lastDay) return history;

  if (interval === "1d" || interval === "") {
    return tickDay === lastDay ? update() : append(tickDay);
  }
  if (interval === "1wk") {
    // Weekly bar dates are the week's first session; a tick inside that week
    // moves it. A new week's bar is left to the refetch — its date is the
    // week's start, which the tick alone does not give.
    const days = (Date.parse(tickDay) - Date.parse(lastDay)) / 86_400_000;
    return days < 7 ? update() : history;
  }
  if (interval === "1mo") {
    return tickDay.slice(0, 7) === lastDay.slice(0, 7) ? update() : history;
  }
  return history;
}
