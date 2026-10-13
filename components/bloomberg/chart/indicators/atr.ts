/**
 * ATR accumulation filter: low normalized volatility AND a rising price trend.
 * ATR alone has no direction. The green/red rule is a configurable heuristic,
 * evaluated causally; a still-forming candle may change before its close.
 */
import { type BarColumns, barColumns } from "../columns.ts";
import { columnar } from "../series-columns.ts";
import type { IndicatorFactory, IndicatorParam, OhlcvBar } from "../types";

export const ATR_REGIME_COLORS = {
  accumulate: "#22c55e",
  avoid: "#ef4444",
  unknown: "#78909c",
} as const;

export const ATR_REGIME_PARAMS: IndicatorParam[] = [
  { key: "period", label: "ATR period", type: "number", default: 14, min: 2, max: 200, step: 1 },
  { key: "lookback", label: "Baseline", type: "number", default: 50, min: 5, max: 500, step: 1 },
  {
    key: "maxRatio",
    label: "ATR / base ≤",
    type: "number",
    default: 1,
    min: 0.1,
    max: 3,
    step: 0.1,
  },
  {
    key: "trendPeriod",
    label: "Trend EMA",
    type: "number",
    default: 50,
    min: 2,
    max: 500,
    step: 1,
  },
  {
    key: "slopeBars",
    label: "EMA slope span",
    type: "number",
    default: 5,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: "display",
    label: "Display",
    type: "select",
    default: "percent",
    options: [
      { value: "percent", label: "ATR% of close" },
      { value: "absolute", label: "ATR · price units" },
    ],
  },
];

export interface AtrRegimeConfig {
  period: number;
  lookback: number;
  maxRatio: number;
  trendPeriod: number;
  slopeBars: number;
  display: "percent" | "absolute";
}

export interface AtrRegimePoint {
  time: string | number;
  atr: number | null;
  atrPercent: number | null;
  baselinePercent: number | null;
  thresholdPercent: number | null;
  thresholdAbsolute: number | null;
  ema: number | null;
  lowVolatility: boolean | null;
  uptrend: boolean | null;
  state: "accumulate" | "avoid" | "unknown";
}

/** Runtime windows may exceed picker limits after DAYS → bars conversion. */
export function resolveAtrConfig(config: Record<string, unknown> = {}): AtrRegimeConfig {
  const number = (key: string, fallback: number, integer = true) => {
    const value = Number(config[key] ?? fallback);
    return Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value))
      ? value
      : fallback;
  };
  return {
    period: number("period", 14),
    lookback: number("lookback", 50),
    maxRatio: number("maxRatio", 1, false),
    trendPeriod: number("trendPeriod", 50),
    slopeBars: number("slopeBars", 5),
    display: config.display === "absolute" ? "absolute" : "percent",
  };
}

/** Validate raw user inputs before storing them (runtime config is in bars). */
export function validAtrInputs(config: Record<string, unknown>): boolean {
  return ATR_REGIME_PARAMS.every((param) => {
    const value = config[param.key] ?? param.default;
    if (param.type === "select") return param.options?.some((option) => option.value === value);
    return (
      value !== "" &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= (param.min ?? 0) &&
      value <= (param.max ?? Number.POSITIVE_INFINITY) &&
      (param.step !== 1 || Number.isInteger(value))
    );
  });
}

const STATES = ["accumulate", "avoid", "unknown"] as const;

/**
 * The regime as columns, one slot per bar. NaN stands for "not known yet" in
 * the number columns (none of them can be NaN otherwise: a bar that passes
 * the validity check has finite prices and a positive close); the two flags
 * are 1 / 0 / -1 for true / false / unknown.
 */
export interface AtrRegimeColumns {
  atr: Float64Array;
  atrPercent: Float64Array;
  baselinePercent: Float64Array;
  thresholdPercent: Float64Array;
  thresholdAbsolute: Float64Array;
  ema: Float64Array;
  lowVolatility: Int8Array;
  uptrend: Int8Array;
  /** Index into `STATES`: accumulate · avoid · unknown. */
  state: Uint8Array;
}

const columnsCache = new WeakMap<BarColumns, Map<string, AtrRegimeColumns>>();

/** O(N), cached by immutable bars + settings. No future or full-sample statistics. */
export function atrRegimeColumns(
  bars: BarColumns,
  overrides: Record<string, unknown> = {}
): AtrRegimeColumns {
  const config = resolveAtrConfig(overrides);
  const key = JSON.stringify(config);
  const cached = columnsCache.get(bars)?.get(key);
  if (cached) return cached;
  const { period, lookback, maxRatio, trendPeriod, slopeBars } = config;
  const n = bars.length;
  const { high: highs, low: lows, close: closes } = bars;
  const atrs = new Float64Array(n);
  const atrPercents = new Float64Array(n);
  const baselines = new Float64Array(n);
  const thresholds = new Float64Array(n);
  const thresholdAbsolutes = new Float64Array(n);
  const emas = new Float64Array(n);
  const lowVolatilities = new Int8Array(n);
  const uptrends = new Int8Array(n);
  const states = new Uint8Array(n);
  // NaN = none yet, in every running value below.
  let previousClose = Number.NaN;
  let atr = Number.NaN;
  let ema = Number.NaN;
  let validBars = 0;
  let trSeed = 0;
  let emaSeed = 0;
  let baselineSum = 0;
  let baselineCount = 0;
  for (let i = 0; i < n; i++) {
    const high = highs[i];
    const low = lows[i];
    const close = closes[i];
    const previousAtr = i >= 1 ? atrPercents[i - 1] : Number.NaN;
    const expiredAtr = i - lookback - 1 >= 0 ? atrPercents[i - lookback - 1] : Number.NaN;
    if (!Number.isNaN(previousAtr)) {
      baselineSum += previousAtr;
      baselineCount++;
    }
    if (!Number.isNaN(expiredAtr)) {
      baselineSum -= expiredAtr;
      baselineCount--;
    }
    const baselinePercent =
      baselineCount === lookback ? Math.max(0, baselineSum / lookback) : Number.NaN;
    const valid =
      Number.isFinite(high) &&
      Number.isFinite(low) &&
      Number.isFinite(close) &&
      close > 0 &&
      low > 0 &&
      high >= low &&
      high >= close &&
      low <= close;
    if (valid) {
      const tr = Number.isNaN(previousClose)
        ? high - low
        : Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
      validBars++;
      if (Number.isNaN(atr)) {
        trSeed += tr;
        if (validBars === period) atr = trSeed / period;
      } else atr = (atr * (period - 1) + tr) / period;
      if (Number.isNaN(ema)) {
        emaSeed += close;
        if (validBars === trendPeriod) ema = emaSeed / trendPeriod;
      } else ema += (2 / (trendPeriod + 1)) * (close - ema);
      previousClose = close;
    } else {
      // An unknown candle breaks the recursive history. Reseed both averages;
      // do not turn missing OHLC into a low-volatility accumulation signal.
      previousClose = Number.NaN;
      atr = Number.NaN;
      ema = Number.NaN;
      validBars = 0;
      trSeed = 0;
      emaSeed = 0;
    }
    const atrPercent = Number.isNaN(atr) ? Number.NaN : (100 * atr) / close;
    const thresholdPercent = Number.isNaN(baselinePercent)
      ? Number.NaN
      : baselinePercent * maxRatio;
    const oldEma = i - slopeBars >= 0 ? emas[i - slopeBars] : Number.NaN;
    const uptrend =
      Number.isNaN(ema) || Number.isNaN(oldEma) ? -1 : close > ema && ema > oldEma ? 1 : 0;
    const lowVolatility =
      Number.isNaN(atrPercent) || Number.isNaN(thresholdPercent) || baselinePercent <= 1e-12
        ? -1
        : atrPercent <= thresholdPercent
          ? 1
          : 0;
    atrs[i] = atr;
    atrPercents[i] = atrPercent;
    baselines[i] = baselinePercent;
    thresholds[i] = thresholdPercent;
    thresholdAbsolutes[i] =
      valid && !Number.isNaN(thresholdPercent) ? (thresholdPercent * close) / 100 : Number.NaN;
    emas[i] = ema;
    uptrends[i] = uptrend;
    lowVolatilities[i] = lowVolatility;
    states[i] = lowVolatility === -1 || uptrend === -1 ? 2 : lowVolatility && uptrend ? 0 : 1;
  }
  const result: AtrRegimeColumns = {
    atr: atrs,
    atrPercent: atrPercents,
    baselinePercent: baselines,
    thresholdPercent: thresholds,
    thresholdAbsolute: thresholdAbsolutes,
    ema: emas,
    lowVolatility: lowVolatilities,
    uptrend: uptrends,
    state: states,
  };
  const entries = columnsCache.get(bars) ?? new Map<string, AtrRegimeColumns>();
  if (entries.size >= 8) entries.clear();
  entries.set(key, result);
  columnsCache.set(bars, entries);
  return result;
}

const orNull = (v: number): number | null => (Number.isNaN(v) ? null : v);
const flag = (v: number): boolean | null => (v === -1 ? null : v === 1);

function pointAt(time: string | number, c: AtrRegimeColumns, i: number): AtrRegimePoint {
  return {
    time,
    atr: orNull(c.atr[i]),
    atrPercent: orNull(c.atrPercent[i]),
    baselinePercent: orNull(c.baselinePercent[i]),
    thresholdPercent: orNull(c.thresholdPercent[i]),
    thresholdAbsolute: orNull(c.thresholdAbsolute[i]),
    ema: orNull(c.ema[i]),
    uptrend: flag(c.uptrend[i]),
    lowVolatility: flag(c.lowVolatility[i]),
    state: STATES[c.state[i]],
  };
}

const cache = new WeakMap<readonly OhlcvBar[], Map<string, AtrRegimePoint[]>>();

/** `atrRegimeColumns` as one object per bar, cached by immutable bars + settings. */
export function calcAtrRegime(
  data: readonly OhlcvBar[],
  overrides: Record<string, unknown> = {}
): AtrRegimePoint[] {
  const key = JSON.stringify(resolveAtrConfig(overrides));
  const cached = cache.get(data)?.get(key);
  if (cached) return cached;
  const bars = barColumns(data);
  const columns = atrRegimeColumns(bars, overrides);
  const points: AtrRegimePoint[] = new Array(bars.length);
  for (let i = 0; i < points.length; i++) points[i] = pointAt(bars.times[i], columns, i);
  const entries = cache.get(data) ?? new Map<string, AtrRegimePoint[]>();
  if (entries.size >= 8) entries.clear();
  entries.set(key, points);
  cache.set(data, entries);
  return points;
}

/**
 * The regime of the newest bar alone — what a readout needs, without an
 * object per bar. Shares the chart's own computation when both look at the
 * same bars.
 */
export function latestAtrRegime(
  data: readonly OhlcvBar[],
  overrides: Record<string, unknown> = {}
): AtrRegimePoint | undefined {
  const bars = barColumns(data);
  const last = bars.length - 1;
  return last < 0 ? undefined : pointAt(bars.times[last], atrRegimeColumns(bars, overrides), last);
}

/** Line colours by index; the last entry hides the segment that runs into a gap. */
const LINE_PALETTE = [
  ATR_REGIME_COLORS.accumulate,
  ATR_REGIME_COLORS.avoid,
  ATR_REGIME_COLORS.unknown,
  "transparent",
] as const;
const THRESHOLD_PALETTE = ["#657582", "transparent"] as const;

export const createATR: IndicatorFactory = (overrides = {}) => {
  const config = resolveAtrConfig(overrides);
  const { period, lookback, trendPeriod, slopeBars, maxRatio, display } = config;
  return {
    // A stable pane family preserves its height when display/parameters change.
    id: "atr-regime",
    name: `${display === "percent" ? "ATR%" : "ATR"} (${period})`,
    category: "volatility",
    type: "pane",
    description:
      "Green: ATR% at/below prior baseline × limit, close above a rising EMA. Red: rule not met. Gray: insufficient data or zero baseline.",
    minBars: period,
    params: ATR_REGIME_PARAMS,
    config: { period, lookback, trendPeriod, slopeBars, maxRatio, display },
    ...columnar((bars, settings) => {
      const resolved = resolveAtrConfig(settings);
      const percent = resolved.display === "percent";
      const c = atrRegimeColumns(bars, settings);
      const n = bars.length;
      const { atr, thresholdPercent } = c;

      // Native line rendering skips whitespace and joins valued points.
      // Color belongs to the outgoing segment: hide it before a gap.
      const lineColors = new Uint8Array(n);
      const thresholdValues = new Float64Array(n);
      const thresholdColors = new Uint8Array(n);
      const chosen = percent ? thresholdPercent : c.thresholdAbsolute;
      for (let i = 0; i < n; i++) {
        const gapNext = i + 1 < n && Number.isNaN(atr[i + 1]);
        lineColors[i] = gapNext ? 3 : c.state[i];
        thresholdValues[i] = Number.isNaN(atr[i]) ? Number.NaN : chosen[i];
        thresholdColors[i] =
          gapNext || (i + 1 < n && Number.isNaN(thresholdPercent[i + 1])) ? 1 : 0;
      }

      return [
        {
          id: "atr-regime-line",
          label: percent ? "ATR%" : "ATR",
          type: "line",
          color: ATR_REGIME_COLORS.unknown,
          lineWidth: 2,
          priceScaleId: "atr-regime",
          values: percent ? c.atrPercent : atr,
          from: 0,
          emit: "valued",
          whitespace: true,
          colors: lineColors,
          palette: LINE_PALETTE,
        },
        {
          id: "atr-regime-threshold",
          label: "Low-vol threshold",
          type: "line",
          color: "#657582",
          lineWidth: 1,
          priceScaleId: "atr-regime",
          values: thresholdValues,
          from: 0,
          emit: "valued",
          whitespace: true,
          colors: thresholdColors,
          palette: THRESHOLD_PALETTE,
        },
      ];
    }),
    // Not `causal`: a point's colour depends on whether the NEXT bar is a gap,
    // so a last bar turning invalid recolours the point before it.
  };
};
