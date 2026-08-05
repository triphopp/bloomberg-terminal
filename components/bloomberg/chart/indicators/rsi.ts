/**
 * RSI (Relative Strength Index) Indicator
 *
 * Pane indicator. Oscillator bounded 0–100.
 * Default period: 14
 */

import type { ChartIndicator, IndicatorFactory, IndicatorSeriesOutput, OhlcvBar } from "../types";
import type { RsiState } from "./rsiInverse";

/**
 * RSI plus the smoothing state that produced it.
 *
 * The value alone is not enough for anything that has to run the indicator
 * backwards: RSI is `100 · avgGain / (avgGain + avgLoss)`, so the series
 * preserves the ratio and discards the magnitude. Recovering "what close would
 * put RSI at 70 tomorrow" needs `avgLoss` on its own, not just the ratio, so
 * the state travels with the series rather than being recomputed later — a
 * second pass would have to reproduce this exact seed and data window to agree.
 */
function calcRSIState(closes: number[], period: number): (RsiState | null)[] {
  if (closes.length < period + 1) return new Array(closes.length).fill(null);

  const result: (RsiState | null)[] = new Array(period).fill(null);
  let avgGain = 0;
  let avgLoss = 0;

  // Initial average
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  // A window with no down bars pins RSI at 100. The old seed substituted a
  // finite RS of 100 and pushed it through the formula, landing on 99.0099 —
  // one bar reading a whole point below what every later bar in the same state
  // reports. Short-circuit here the way the smoothed loop below does.
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  result.push({ rsi, avgGain, avgLoss });

  // Smoothed
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    result.push({ rsi, avgGain, avgLoss });
  }

  return result;
}

export { calcRSIState };

export const createRSI: IndicatorFactory = (overrides = {}) => {
  const period = (overrides.period as number) ?? 14;

  const indicator: ChartIndicator = {
    id: `rsi-${period}`,
    name: `RSI (${period})`,
    category: "momentum",
    type: "pane",
    description: `${period}-period Relative Strength Index`,
    minBars: period + 1,
    params: [
      {
        key: "period",
        label: "Period",
        type: "number",
        default: period,
        min: 2,
        max: 100,
        step: 1,
      },
      {
        key: "overbought",
        label: "Overbought",
        type: "number",
        default: 70,
        min: 50,
        max: 95,
        step: 5,
      },
      { key: "oversold", label: "Oversold", type: "number", default: 30, min: 5, max: 50, step: 5 },
    ],
    config: { period, overbought: 70, oversold: 30 },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const p = config.period as number;
      const ob = config.overbought as number;
      const os = config.oversold as number;
      const closes = data.map((d) => d.close);
      const rsiStates = calcRSIState(closes, p);
      const scaleId = `rsi-${p}`;

      const rsiLine = data
        .map((d, i) => ({ time: d.time, value: rsiStates[i]?.rsi as number }))
        .filter((d) => d.value != null);

      const times = rsiLine.map((d) => d.time);

      return [
        {
          id: `rsi-${p}-line`,
          label: `RSI ${p}`,
          type: "line",
          color: "#ab47bc",
          lineWidth: 1,
          data: rsiLine,
          priceScaleId: scaleId,
        },
        {
          id: `rsi-${p}-ob`,
          label: `OB ${ob}`,
          type: "line",
          color: "#ef5350",
          lineWidth: 1,
          data: times.map((t) => ({ time: t, value: ob })),
          priceScaleId: scaleId,
        },
        {
          id: `rsi-${p}-os`,
          label: `OS ${os}`,
          type: "line",
          color: "#26a69a",
          lineWidth: 1,
          data: times.map((t) => ({ time: t, value: os })),
          priceScaleId: scaleId,
        },
        {
          id: `rsi-${p}-mid`,
          label: "50",
          type: "line",
          color: "#555",
          lineWidth: 1,
          data: times.map((t) => ({ time: t, value: 50 })),
          priceScaleId: scaleId,
        },
      ];
    },
  };

  return indicator;
};
