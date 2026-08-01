/**
 * Alert labels for the phase-3 indicator subset (plan §12 phase 3): RSI,
 * MACD, EMA, RVOL, and the Bollinger family. Attached to their
 * IndicatorRegistryEntry in ./index.ts via the `alertLabels` field.
 *
 * Every `build()` here only uses Operand/Comparator shapes the backend
 * evaluator (backend/alerts/eval.py) already understands — no new AST
 * concepts introduced. Indicator ids/params/outputs must match what
 * backend/alerts/operands.py resolves, since that's what actually runs a
 * label once it reaches /api/alerts/scan.
 */

import type { IndicatorOperand, RuleNode } from "../../../../lib/alerts/ast.ts";
import type { AlertLabel } from "../../../../lib/alerts/labels.ts";

const th = (key: string, label: string, def: number, min: number, max: number) => ({
  key,
  label,
  type: "number" as const,
  default: def,
  min,
  max,
});

// ── RSI ──────────────────────────────────────────────────────────────────────

function rsiOperand(ind: Record<string, number>): IndicatorOperand {
  return { src: "indicator", id: "rsi", params: { period: ind.period }, output: "rsi" };
}

export const RSI_LABELS: AlertLabel[] = [
  {
    concept: "oversold",
    calibrations: ["static", "adaptive"],
    params: [th("th", "Threshold", 30, 1, 50)],
    build: ({ indParams, labelParams, calibration }): RuleNode => {
      const rsi = rsiOperand(indParams);
      if (calibration.mode === "adaptive") {
        return {
          op: "cmp",
          left: { src: "pctRank", of: rsi, window: calibration.window },
          cmp: "lte",
          right: { src: "const", value: 0.1 },
        };
      }
      return { op: "cmp", left: rsi, cmp: "lte", right: { src: "const", value: labelParams.th } };
    },
  },
  {
    concept: "overbought",
    calibrations: ["static", "adaptive"],
    params: [th("th", "Threshold", 70, 50, 99)],
    build: ({ indParams, labelParams, calibration }): RuleNode => {
      const rsi = rsiOperand(indParams);
      if (calibration.mode === "adaptive") {
        return {
          op: "cmp",
          left: { src: "pctRank", of: rsi, window: calibration.window },
          cmp: "gte",
          right: { src: "const", value: 0.9 },
        };
      }
      return { op: "cmp", left: rsi, cmp: "gte", right: { src: "const", value: labelParams.th } };
    },
  },
  {
    concept: "exitingOversold",
    calibrations: ["static"],
    params: [th("th", "Threshold", 30, 1, 50)],
    build: ({ indParams, labelParams }): RuleNode => ({
      op: "cmp",
      left: rsiOperand(indParams),
      cmp: "crossesAbove",
      right: { src: "const", value: labelParams.th },
    }),
  },
  {
    concept: "exitingOverbought",
    calibrations: ["static"],
    params: [th("th", "Threshold", 70, 50, 99)],
    build: ({ indParams, labelParams }): RuleNode => ({
      op: "cmp",
      left: rsiOperand(indParams),
      cmp: "crossesBelow",
      right: { src: "const", value: labelParams.th },
    }),
  },
  {
    concept: "aboveMid",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: rsiOperand(indParams),
      cmp: "gt",
      right: { src: "const", value: 50 },
    }),
  },
];

// ── MACD ─────────────────────────────────────────────────────────────────────

function macdHistOperand(ind: Record<string, number>): IndicatorOperand {
  return {
    src: "indicator",
    id: "macd",
    params: { fast: ind.fast, slow: ind.slow, signal: ind.signal },
    output: "hist",
  };
}

export const MACD_LABELS: AlertLabel[] = [
  {
    // MACD line crossing above signal == histogram crossing above 0 — same event,
    // cheaper to express as a zero-cross of the histogram we already resolve.
    concept: "bullCross",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: macdHistOperand(indParams),
      cmp: "crossesAbove",
      right: { src: "const", value: 0 },
    }),
  },
  {
    concept: "bearCross",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: macdHistOperand(indParams),
      cmp: "crossesBelow",
      right: { src: "const", value: 0 },
    }),
  },
  {
    concept: "aboveZero",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: macdHistOperand(indParams),
      cmp: "gt",
      right: { src: "const", value: 0 },
    }),
  },
  {
    concept: "accelerating",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      // histogram today > histogram 1 bar ago, in either polarity — "growing
      // further from zero" needs abs(), which the AST doesn't have, so this
      // reads as "rising" rather than "growing regardless of sign". Good
      // enough for the common bullish-momentum-building case.
      op: "cmp",
      left: macdHistOperand(indParams),
      cmp: "gt",
      right: { ...macdHistOperand(indParams), offset: 1 },
    }),
  },
];

// ── EMA ──────────────────────────────────────────────────────────────────────

function emaOperand(ind: Record<string, number>): IndicatorOperand {
  return { src: "indicator", id: "ema", params: { period: ind.period }, output: "value" };
}

export const EMA_LABELS: AlertLabel[] = [
  {
    concept: "priceAbove",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: { src: "price", field: "close" },
      cmp: "gt",
      right: emaOperand(indParams),
    }),
  },
  {
    concept: "priceBelow",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: { src: "price", field: "close" },
      cmp: "lt",
      right: emaOperand(indParams),
    }),
  },
  {
    concept: "bullCross",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: { src: "price", field: "close" },
      cmp: "crossesAbove",
      right: emaOperand(indParams),
    }),
  },
  {
    concept: "bearCross",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: { src: "price", field: "close" },
      cmp: "crossesBelow",
      right: emaOperand(indParams),
    }),
  },
  {
    concept: "risingSlope",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: emaOperand(indParams),
      cmp: "gt",
      right: { ...emaOperand(indParams), offset: 1 },
    }),
  },
  {
    concept: "fallingSlope",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: emaOperand(indParams),
      cmp: "lt",
      right: { ...emaOperand(indParams), offset: 1 },
    }),
  },
];

// ── SMA — same shape as EMA, different smoothing under the hood ─────────────

function smaOperand(ind: Record<string, number>): IndicatorOperand {
  return { src: "indicator", id: "sma", params: { period: ind.period }, output: "value" };
}

export const SMA_LABELS: AlertLabel[] = [
  {
    concept: "priceAbove",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: { src: "price", field: "close" },
      cmp: "gt",
      right: smaOperand(indParams),
    }),
  },
  {
    concept: "priceBelow",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: { src: "price", field: "close" },
      cmp: "lt",
      right: smaOperand(indParams),
    }),
  },
  {
    concept: "bullCross",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: { src: "price", field: "close" },
      cmp: "crossesAbove",
      right: smaOperand(indParams),
    }),
  },
  {
    concept: "bearCross",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: { src: "price", field: "close" },
      cmp: "crossesBelow",
      right: smaOperand(indParams),
    }),
  },
];

// ── Stochastic ───────────────────────────────────────────────────────────────

function stochKOperand(ind: Record<string, number>): IndicatorOperand {
  return {
    src: "indicator",
    id: "stochastic",
    params: { kPeriod: ind.kPeriod, dPeriod: ind.dPeriod, smooth: ind.smooth },
    output: "k",
  };
}

function stochDOperand(ind: Record<string, number>): IndicatorOperand {
  return {
    src: "indicator",
    id: "stochastic",
    params: { kPeriod: ind.kPeriod, dPeriod: ind.dPeriod, smooth: ind.smooth },
    output: "d",
  };
}

export const STOCHASTIC_LABELS: AlertLabel[] = [
  {
    concept: "oversold",
    calibrations: ["static"],
    params: [th("th", "Threshold", 20, 1, 50)],
    build: ({ indParams, labelParams }): RuleNode => ({
      op: "cmp",
      left: stochKOperand(indParams),
      cmp: "lte",
      right: { src: "const", value: labelParams.th },
    }),
  },
  {
    concept: "overbought",
    calibrations: ["static"],
    params: [th("th", "Threshold", 80, 50, 99)],
    build: ({ indParams, labelParams }): RuleNode => ({
      op: "cmp",
      left: stochKOperand(indParams),
      cmp: "gte",
      right: { src: "const", value: labelParams.th },
    }),
  },
  {
    concept: "bullCross",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: stochKOperand(indParams),
      cmp: "crossesAbove",
      right: stochDOperand(indParams),
    }),
  },
  {
    concept: "bearCross",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: stochKOperand(indParams),
      cmp: "crossesBelow",
      right: stochDOperand(indParams),
    }),
  },
];

// ── RVOL ─────────────────────────────────────────────────────────────────────

function rvolOperand(ind: Record<string, number>): IndicatorOperand {
  return { src: "indicator", id: "rvol", params: { lookback: ind.lookback }, output: "rvol" };
}

export const RVOL_LABELS: AlertLabel[] = [
  {
    concept: "spike",
    calibrations: ["static"],
    params: [th("th", "Threshold", 2, 1.2, 10)],
    build: ({ indParams, labelParams }): RuleNode => ({
      op: "cmp",
      left: rvolOperand(indParams),
      cmp: "gte",
      right: { src: "const", value: labelParams.th },
    }),
  },
  {
    concept: "dryUp",
    calibrations: ["static"],
    params: [th("th", "Threshold", 0.5, 0.1, 0.9)],
    build: ({ indParams, labelParams }): RuleNode => ({
      op: "cmp",
      left: rvolOperand(indParams),
      cmp: "lte",
      right: { src: "const", value: labelParams.th },
    }),
  },
];

// ── Bollinger Bands (overlay: upper/middle/lower) ───────────────────────────

function bbBandOperand(
  ind: Record<string, number>,
  output: "upper" | "middle" | "lower"
): IndicatorOperand {
  return {
    src: "indicator",
    id: "bollinger",
    params: { period: ind.period, stdDev: ind.stdDev },
    output,
  };
}

export const BOLLINGER_LABELS: AlertLabel[] = [
  {
    concept: "pierceUpper",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: { src: "price", field: "close" },
      cmp: "gt",
      right: bbBandOperand(indParams, "upper"),
    }),
  },
  {
    concept: "pierceLower",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: { src: "price", field: "close" },
      cmp: "lt",
      right: bbBandOperand(indParams, "lower"),
    }),
  },
  {
    concept: "reclaim",
    calibrations: ["static"],
    build: ({ indParams }): RuleNode => ({
      op: "cmp",
      left: { src: "price", field: "close" },
      cmp: "crossesAbove",
      right: bbBandOperand(indParams, "middle"),
    }),
  },
];

// ── Bollinger %B ─────────────────────────────────────────────────────────────

function bbPercentBOperand(ind: Record<string, number>): IndicatorOperand {
  return {
    src: "indicator",
    id: "bollinger-b",
    params: { period: ind.period, stdDev: ind.stdDev },
    output: "b",
  };
}

export const BOLLINGER_B_LABELS: AlertLabel[] = [
  {
    concept: "extremeHigh",
    calibrations: ["static"],
    params: [th("th", "Threshold", 1, 0.8, 1.5)],
    build: ({ indParams, labelParams }): RuleNode => ({
      op: "cmp",
      left: bbPercentBOperand(indParams),
      cmp: "gte",
      right: { src: "const", value: labelParams.th },
    }),
  },
  {
    concept: "extremeLow",
    calibrations: ["static"],
    params: [th("th", "Threshold", 0, -0.5, 0.2)],
    build: ({ indParams, labelParams }): RuleNode => ({
      op: "cmp",
      left: bbPercentBOperand(indParams),
      cmp: "lte",
      right: { src: "const", value: labelParams.th },
    }),
  },
];

// ── BB Width ─────────────────────────────────────────────────────────────────

function bbWidthOperand(ind: Record<string, number>): IndicatorOperand {
  return {
    src: "indicator",
    id: "bb-width",
    params: { period: ind.period, stdDev: ind.stdDev },
    output: "width",
  };
}

export const BB_WIDTH_LABELS: AlertLabel[] = [
  {
    // Squeeze has no meaningful ABSOLUTE threshold — a "narrow" band width
    // depends entirely on the symbol's own typical volatility, so this label
    // only offers adaptive calibration (plan §8.5.2's own example).
    concept: "compression",
    calibrations: ["adaptive"],
    build: ({ indParams, calibration }): RuleNode => {
      const window = calibration.mode === "adaptive" ? calibration.window : 120;
      return {
        op: "cmp",
        left: { src: "pctRank", of: bbWidthOperand(indParams), window },
        cmp: "lte",
        right: { src: "const", value: 0.1 },
      };
    },
  },
  {
    concept: "expansion",
    calibrations: ["adaptive"],
    build: ({ indParams, calibration }): RuleNode => {
      const window = calibration.mode === "adaptive" ? calibration.window : 120;
      return {
        op: "cmp",
        left: { src: "pctRank", of: bbWidthOperand(indParams), window },
        cmp: "gte",
        right: { src: "const", value: 0.9 },
      };
    },
  },
];
