import { rollingVariance } from "./rolling.ts";
import type { IndicatorParam, OhlcvBar } from "./types";

export const BOLLINGER_PERIOD_GRID = Array.from({ length: 19 }, (_, i) => 10 + 5 * i);
export const BOLLINGER_DEVIATION_GRID = Array.from({ length: 11 }, (_, i) => 1 + 0.25 * i);
export const BOLLINGER_FIT_MIN_BARS = 201;
const WARMUP = 100;
const MIN_TRADES = 3;

export const BOLLINGER_FIT_PARAMS: IndicatorParam[] = [
  {
    key: "fitMode",
    label: "Parameters",
    type: "select",
    default: "manual",
    options: [
      { value: "manual", label: "Manual (no fit)" },
      { value: "sharpe", label: "Fit · max Sharpe" },
    ],
  },
  {
    key: "fitCostBps",
    label: "Cost / side (bps)",
    type: "number",
    default: 5,
    min: 0,
    max: 100,
    step: 1,
  },
];

export interface BollingerStats {
  middle: (number | null)[];
  deviation: (number | null)[];
}

/** Population standard deviation, matching the existing chart's BB definition. */
export function calcBollingerStats(data: readonly OhlcvBar[], period: number): BollingerStats {
  const middle: (number | null)[] = Array(data.length).fill(null);
  const deviation: (number | null)[] = Array(data.length).fill(null);
  if (!Number.isInteger(period) || period < 2) return { middle, deviation };
  // O(1) per bar: the Sharpe fit calls this for every period on the grid.
  const closes = new Float64Array(data.length);
  for (let i = 0; i < data.length; i++) closes[i] = data[i].close;
  const { mean, variance } = rollingVariance(closes, period, 0);
  for (let i = period - 1; i < data.length; i++) {
    middle[i] = mean[i];
    deviation[i] = Math.sqrt(variance[i]);
  }
  return { middle, deviation };
}

export function bollingerPercentB(
  price: number,
  middle: number,
  deviation: number,
  k: number
): number {
  const width = 2 * k * deviation;
  return width === 0 ? 0.5 : (price - (middle - k * deviation)) / width;
}

export interface BollingerBacktest {
  /** Unannualized net-return Sharpe, sample SD, zero risk-free/cash rate. */
  sharpe: number | null;
  totalReturn: number;
  trades: number;
  bars: number;
  returns: number[];
}

/**
 * Long/cash breakout: close[t-1] %B > 1 enters at open[t]; <= .5 exits.
 * Existing positions earn overnight gaps, new entries do not. Mark to close
 * every bar, including flat bars; liquidate at the predetermined window end.
 * Each evaluation starts in cash so train positions cannot leak into holdout.
 */
export function evaluateBollingerBreakout(
  data: readonly OhlcvBar[],
  period: number,
  k: number,
  start: number,
  end: number,
  costBps: number,
  stats = calcBollingerStats(data, period)
): BollingerBacktest {
  let invested = false;
  let trades = 0;
  let equity = 1;
  const cost = costBps / 10_000;
  const returns: number[] = [];
  for (let i = start; i < end; i++) {
    const m = stats.middle[i - 1];
    const sd = stats.deviation[i - 1];
    const b = m == null || sd == null ? 0.5 : bollingerPercentB(data[i - 1].close, m, sd, k);
    let factor = invested ? data[i].open / data[i - 1].close : 1;
    if (invested && b <= 0.5) {
      factor *= 1 - cost;
      invested = false;
      trades++;
    } else if (!invested && b > 1) {
      factor *= 1 - cost;
      invested = true;
    }
    if (invested) factor *= data[i].close / data[i].open;
    if (invested && i === end - 1) {
      factor *= 1 - cost;
      invested = false;
      trades++;
    }
    returns.push(factor - 1);
    equity *= factor;
  }
  const count = returns.length;
  const mean = count ? returns.reduce((a, b) => a + b, 0) / count : 0;
  const variance = count > 1 ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (count - 1) : 0;
  const score = variance > 1e-20 ? mean / Math.sqrt(variance) : null;
  return {
    sharpe: score != null && Number.isFinite(score) ? score : null,
    totalReturn: equity - 1,
    trades,
    bars: count,
    returns,
  };
}

export interface BollingerFitCandidate {
  period: number;
  stdDev: number;
  train: BollingerBacktest;
}

export interface BollingerFitResult {
  status: "ok" | "unavailable";
  reason?: string;
  best: BollingerFitCandidate | null;
  holdout: BollingerBacktest | null;
  candidates: number;
  eligible: number;
  trainStart: number;
  split: number;
  end: number;
}

/**
 * Keyed by the CLOSED bars' content, not the array's identity.
 *
 * The search never reads the newest (still-forming) bar, so a live tick cannot
 * change its answer — but every tick hands over a new array, and an identity
 * key (the old WeakMap) missed on every one of them: 209 backtests per tick,
 * ~4 ms at 1Y and ~18 ms at 20Y daily. The key costs one O(N) pass.
 */
const cache = new Map<string, BollingerFitResult>();
const CACHE_MAX = 16;

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

function closedBarsKey(data: readonly OhlcvBar[], costBps: number): string {
  const end = data.length - 1;
  // FNV-1a over everything the search reads from a closed bar — the exact
  // bits of open and close, and the time (validated for order) — in two
  // independent 32-bit lanes, so a collision needs both to collide.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < end; i++) {
    const bar = data[i];
    f64[0] = bar.close;
    a = Math.imul(a ^ u32[0], 0x01000193);
    a = Math.imul(a ^ u32[1], 0x01000193);
    f64[0] = bar.open;
    b = Math.imul(b ^ u32[0], 0x01000193);
    b = Math.imul(b ^ u32[1], 0x01000193);
    const t = bar.time;
    if (typeof t === "number") {
      f64[0] = t;
      a = Math.imul(a ^ u32[0], 0x01000193);
      b = Math.imul(b ^ u32[1], 0x01000193);
    } else {
      for (let c = 0; c < t.length; c++) {
        a = Math.imul(a ^ t.charCodeAt(c), 0x01000193);
        b = Math.imul(b ^ t.charCodeAt(c), 0x811c9dc5);
      }
    }
  }
  return `${costBps}|${end}|${data[0]?.time}|${data[end - 1]?.time}|${a >>> 0}|${b >>> 0}`;
}

/** One search per closed-bar dataset/cost; no trained values in storage. */
export function fitBollingerSharpe(data: readonly OhlcvBar[], costBps = 5): BollingerFitResult {
  const key = closedBarsKey(data, costBps);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // LRU: re-insert as most recent
    cache.set(key, hit);
    return hit;
  }
  const result = search(data, costBps);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, result);
  return result;
}

function search(data: readonly OhlcvBar[], costBps: number): BollingerFitResult {
  // Conservatively omit the newest candle, which may still be forming.
  const end = data.length - 1;
  const split = WARMUP + Math.floor(((end - WARMUP) * 7) / 10);
  const result: BollingerFitResult = {
    status: "unavailable",
    best: null,
    holdout: null,
    candidates: 0,
    eligible: 0,
    trainStart: WARMUP,
    split,
    end,
  };
  if (!Number.isFinite(costBps) || costBps < 0 || costBps > 100) {
    return { ...result, reason: "Cost must be between 0 and 100 bps per side." };
  }
  if (data.length < BOLLINGER_FIT_MIN_BARS) {
    return {
      ...result,
      reason: `Need at least ${BOLLINGER_FIT_MIN_BARS} bars (have ${data.length}). Load a longer history, e.g. 1Y on daily charts.`,
    };
  }
  let previous = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < end; i++) {
    const bar = data[i];
    const time = typeof bar.time === "number" ? bar.time * 1000 : Date.parse(bar.time);
    if (
      !Number.isFinite(time) ||
      time <= previous ||
      !Number.isFinite(bar.open) ||
      bar.open <= 0 ||
      !Number.isFinite(bar.close) ||
      bar.close <= 0
    ) {
      return {
        ...result,
        reason: "Fit needs ordered, unique bars with finite positive open/close prices.",
      };
    }
    previous = time;
  }
  // Statistics for selection see training prices ONLY. Holdout is scored once
  // after the winner is frozen. Every candidate uses the same return dates.
  const trainData = data.slice(0, split);
  for (const period of BOLLINGER_PERIOD_GRID) {
    const stats = calcBollingerStats(trainData, period);
    for (const stdDev of BOLLINGER_DEVIATION_GRID) {
      result.candidates++;
      const train = evaluateBollingerBreakout(
        trainData,
        period,
        stdDev,
        WARMUP,
        split,
        costBps,
        stats
      );
      if (train.trades < MIN_TRADES || train.sharpe == null) continue;
      result.eligible++;
      // Strict comparison makes ties deterministic: smaller n, then smaller k.
      if (!result.best || train.sharpe > (result.best.train.sharpe ?? Number.NEGATIVE_INFINITY)) {
        result.best = { period, stdDev, train };
      }
    }
  }
  if (!result.best)
    return {
      ...result,
      reason:
        "No eligible fit: need at least 3 completed training trades and non-zero return variation. Try a longer history.",
    };
  result.status = "ok";
  result.holdout = evaluateBollingerBreakout(
    data.slice(0, end),
    result.best.period,
    result.best.stdDev,
    split,
    end,
    costBps
  );
  return result;
}

export function resolveBollingerParameters(
  data: readonly OhlcvBar[],
  config: Record<string, unknown>
) {
  const fit =
    config.fitMode === "sharpe" ? fitBollingerSharpe(data, Number(config.fitCostBps ?? 5)) : null;
  return {
    period: fit?.best?.period ?? Number(config.period ?? 20),
    stdDev: fit?.best?.stdDev ?? Number(config.stdDev ?? 2),
    fit,
  };
}
