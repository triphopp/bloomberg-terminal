/**
 * RSI (Relative Strength Index) Indicator
 *
 * Pane indicator. Oscillator bounded 0–100.
 * Default period: 14
 */

import type { ChartIndicator, IndicatorFactory, OhlcvBar, IndicatorSeriesOutput } from "../types";

function calcRSI(closes: number[], period: number): (number | null)[] {
  if (closes.length < period + 1) return new Array(closes.length).fill(null);

  const result: (number | null)[] = new Array(period).fill(null);
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

  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(100 - 100 / (1 + rs));

  // Smoothed
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    result.push(rsi);
  }

  return result;
}

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
      { key: "period", label: "Period", type: "number", default: period, min: 2, max: 100, step: 1 },
      { key: "overbought", label: "Overbought", type: "number", default: 70, min: 50, max: 95, step: 5 },
      { key: "oversold", label: "Oversold", type: "number", default: 30, min: 5, max: 50, step: 5 },
    ],
    config: { period, overbought: 70, oversold: 30 },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const p = config.period as number;
      const ob = config.overbought as number;
      const os = config.oversold as number;
      const closes = data.map(d => d.close);
      const rsiValues = calcRSI(closes, p);
      const scaleId = `rsi-${p}`;

      const rsiLine = data
        .map((d, i) => ({ time: d.time, value: rsiValues[i]! }))
        .filter(d => d.value != null);

      const times = rsiLine.map(d => d.time);

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
          data: times.map(t => ({ time: t, value: ob })),
          priceScaleId: scaleId,
        },
        {
          id: `rsi-${p}-os`,
          label: `OS ${os}`,
          type: "line",
          color: "#26a69a",
          lineWidth: 1,
          data: times.map(t => ({ time: t, value: os })),
          priceScaleId: scaleId,
        },
        {
          id: `rsi-${p}-mid`,
          label: "50",
          type: "line",
          color: "#555",
          lineWidth: 1,
          data: times.map(t => ({ time: t, value: 50 })),
          priceScaleId: scaleId,
        },
      ];
    },
  };

  return indicator;
};
