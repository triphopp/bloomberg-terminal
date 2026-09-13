/**
 * ATR accumulation filter: low normalized volatility AND a rising price trend.
 * ATR alone has no direction. The green/red rule is a configurable heuristic,
 * evaluated causally; a still-forming candle may change before its close.
 */
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

const cache = new WeakMap<readonly OhlcvBar[], Map<string, AtrRegimePoint[]>>();

/** O(N), cached by immutable bars + settings. No future or full-sample statistics. */
export function calcAtrRegime(
  data: readonly OhlcvBar[],
  overrides: Record<string, unknown> = {}
): AtrRegimePoint[] {
  const config = resolveAtrConfig(overrides);
  const key = JSON.stringify(config);
  const cached = cache.get(data)?.get(key);
  if (cached) return cached;
  const { period, lookback, maxRatio, trendPeriod, slopeBars } = config;
  const points: AtrRegimePoint[] = [];
  let previousClose: number | null = null;
  let atr: number | null = null;
  let ema: number | null = null;
  let validBars = 0;
  let trSeed = 0;
  let emaSeed = 0;
  let baselineSum = 0;
  let baselineCount = 0;
  for (let i = 0; i < data.length; i++) {
    const { time, high, low, close } = data[i];
    const previousAtr = points[i - 1]?.atrPercent;
    const expiredAtr = points[i - lookback - 1]?.atrPercent;
    if (previousAtr != null) {
      baselineSum += previousAtr;
      baselineCount++;
    }
    if (expiredAtr != null) {
      baselineSum -= expiredAtr;
      baselineCount--;
    }
    const baselinePercent = baselineCount === lookback ? Math.max(0, baselineSum / lookback) : null;
    const valid =
      [high, low, close].every(Number.isFinite) &&
      close > 0 &&
      low > 0 &&
      high >= low &&
      high >= close &&
      low <= close;
    if (valid) {
      const tr =
        previousClose == null
          ? high - low
          : Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
      validBars++;
      if (atr == null) {
        trSeed += tr;
        if (validBars === period) atr = trSeed / period;
      } else atr = (atr * (period - 1) + tr) / period;
      if (ema == null) {
        emaSeed += close;
        if (validBars === trendPeriod) ema = emaSeed / trendPeriod;
      } else ema += (2 / (trendPeriod + 1)) * (close - ema);
      previousClose = close;
    } else {
      // An unknown candle breaks the recursive history. Reseed both averages;
      // do not turn missing OHLC into a low-volatility accumulation signal.
      previousClose = null;
      atr = null;
      ema = null;
      validBars = 0;
      trSeed = 0;
      emaSeed = 0;
    }
    const atrPercent = atr == null ? null : (100 * atr) / close;
    const thresholdPercent = baselinePercent == null ? null : baselinePercent * maxRatio;
    const oldEma = points[i - slopeBars]?.ema;
    const uptrend = ema == null || oldEma == null ? null : close > ema && ema > oldEma;
    const lowVolatility =
      atrPercent == null ||
      thresholdPercent == null ||
      baselinePercent == null ||
      baselinePercent <= 1e-12
        ? null
        : atrPercent <= thresholdPercent;
    const state =
      lowVolatility == null || uptrend == null
        ? "unknown"
        : lowVolatility && uptrend
          ? "accumulate"
          : "avoid";
    points.push({
      time,
      atr,
      atrPercent,
      baselinePercent,
      thresholdPercent,
      thresholdAbsolute:
        valid && thresholdPercent != null ? (thresholdPercent * close) / 100 : null,
      ema,
      uptrend,
      lowVolatility,
      state,
    });
  }
  const entries = cache.get(data) ?? new Map<string, AtrRegimePoint[]>();
  if (entries.size >= 8) entries.clear();
  entries.set(key, points);
  cache.set(data, entries);
  return points;
}

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
    compute(data, settings) {
      const resolved = resolveAtrConfig(settings);
      const percent = resolved.display === "percent";
      const points = calcAtrRegime(data, settings);
      return [
        {
          id: "atr-regime-line",
          label: percent ? "ATR%" : "ATR",
          type: "line",
          color: ATR_REGIME_COLORS.unknown,
          lineWidth: 2,
          priceScaleId: "atr-regime",
          data: points.map((point, index) => {
            const value = percent ? point.atrPercent : point.atr;
            // Native line rendering skips whitespace and joins valued points.
            // Color belongs to the outgoing segment: hide it before a gap.
            const beforeGap = index + 1 < points.length && points[index + 1].atr == null;
            return value == null
              ? { time: point.time }
              : {
                  time: point.time,
                  value,
                  color: beforeGap ? "transparent" : ATR_REGIME_COLORS[point.state],
                };
          }),
        },
        {
          id: "atr-regime-threshold",
          label: "Low-vol threshold",
          type: "line",
          color: "#657582",
          lineWidth: 1,
          priceScaleId: "atr-regime",
          data: points.map((point, index) => {
            const value = percent ? point.thresholdPercent : point.thresholdAbsolute;
            const next = points[index + 1];
            const beforeGap = next && (next.atr == null || next.thresholdPercent == null);
            return value == null || point.atr == null
              ? { time: point.time }
              : { time: point.time, value, color: beforeGap ? "transparent" : "#657582" };
          }),
        },
      ];
    },
  };
};
