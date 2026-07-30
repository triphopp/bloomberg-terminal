/**
 * Regression Channel — user-selected range, TradingView-style.
 *
 * Unlike every other overlay here, this one is not derived from the data alone:
 * the user picks the two endpoints, because *which* stretch of price you regress
 * is the actual analytical choice. An auto-fitted line over "all visible bars"
 * silently averages across regime changes and produces something nobody would
 * draw by hand.
 *
 * Given a range it fits the centre line by OLS on closes and places two rails
 * around it, in one of two modes:
 *
 *   stddev   — centre ± k·σ(residuals). The TradingView default. Symmetric by
 *              construction, so the rails are equidistant even when the price
 *              action inside is lopsided.
 *   quantile — rails fitted directly as conditional quantiles (τ and 1−τ).
 *              Asymmetric when the data is, and the share of bars outside each
 *              rail is the τ you chose rather than whatever normality implies.
 *
 * Pearson's r is drawn with the channel because the slope alone says nothing
 * about whether a line was worth fitting: r near 0 means the "trend" is a line
 * through noise, and the channel width is then just the range of that noise.
 *
 * The fit uses only bars inside the selection; the channel is then extended to
 * the right edge so the projection is visible. Everything right of the second
 * endpoint is extrapolation and is drawn dashed to say so.
 */

import type { CanvasOverlay, OhlcvBar } from "../types";
import { leastSquares, pearsonR, quantileRegression, residualStdDev } from "./regression";

export type ChannelMode = "stddev" | "quantile";

export interface RegressionSelection {
  /** Bar times of the two clicked endpoints (order-independent). */
  fromTime: string | number;
  toTime: string | number;
}

export interface RegressionChannelOptions {
  mode: ChannelMode;
  /** Rail distance in residual standard deviations ("stddev" mode). */
  stdDevMult: number;
  /** Lower-rail quantile in percent ("quantile" mode); upper rail is 100−τ. */
  tauPct: number;
  /** Extend the channel past the selection to the right edge. */
  extend: boolean;
}

export const DEFAULT_REGRESSION_OPTIONS: RegressionChannelOptions = {
  mode: "stddev",
  stdDevMult: 2,
  tauPct: 10,
  extend: true,
};

/** Minimum bars in a selection for a fit to be meaningful. */
const MIN_SELECTION = 5;

function timeKey(t: OhlcvBar["time"]): string {
  return String(t);
}

export function createRegressionChannelOverlay(
  selection: RegressionSelection | null,
  options: RegressionChannelOptions = DEFAULT_REGRESSION_OPTIONS
): CanvasOverlay {
  return {
    id: "regression-channel",
    name: "Regression Channel",
    mode: "full",
    width: 0,

    draw(ctx, chart, mainSeries, data, isDark, rect) {
      if (!selection || data.length === 0) return;

      // Endpoints are stored as bar times so a data refresh or a timeframe
      // change cannot silently shift the selection to different bars.
      const wantA = timeKey(selection.fromTime);
      const wantB = timeKey(selection.toTime);
      let ia = -1;
      let ib = -1;
      for (let i = 0; i < data.length; i++) {
        const k = timeKey(data[i].time);
        if (ia < 0 && k === wantA) ia = i;
        if (ib < 0 && k === wantB) ib = i;
      }
      if (ia < 0 || ib < 0) return; // selection not present on this timeframe
      const from = Math.min(ia, ib);
      const to = Math.max(ia, ib);
      if (to - from + 1 < MIN_SELECTION) return;

      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = from; i <= to; i++) {
        xs.push(i - from);
        ys.push(data[i].close);
      }

      const centre = leastSquares(xs, ys);
      const r = pearsonR(xs, ys);

      let upperAt: (x: number) => number;
      let lowerAt: (x: number) => number;
      if (options.mode === "quantile") {
        const tau = Math.min(0.49, Math.max(0.01, options.tauPct / 100));
        const lo = quantileRegression(xs, ys, tau);
        const hi = quantileRegression(xs, ys, 1 - tau);
        upperAt = (x) => hi.intercept + hi.slope * x;
        lowerAt = (x) => lo.intercept + lo.slope * x;
      } else {
        const sd = residualStdDev(xs, ys, centre) * options.stdDevMult;
        upperAt = (x) => centre.intercept + centre.slope * x + sd;
        lowerAt = (x) => centre.intercept + centre.slope * x - sd;
      }
      const centreAt = (x: number) => centre.intercept + centre.slope * x;

      // Extrapolation is capped at the length of the fit itself. A 9-bar fit
      // projected across 60 bars diverges wildly and looks authoritative while
      // being nothing of the sort — you cannot forecast further than you fitted.
      const span = to - from;
      const lastIdx = options.extend ? Math.min(data.length - 1, to + span) : to;

      const colors = isDark
        ? { centre: "rgba(255,193,7,0.95)", rail: "rgba(120,144,156,0.85)", bg: "rgba(0,0,0,0.75)" }
        : {
            centre: "rgba(230,145,0,0.95)",
            rail: "rgba(90,110,120,0.85)",
            bg: "rgba(255,255,255,0.85)",
          };

      const timeScale = chart.timeScale();
      /** Project one line across [from, lastIdx], splitting at the selection end. */
      const stroke = (
        at: (x: number) => number,
        color: string,
        width: number,
        dashInside: number[]
      ) => {
        // Inside the selection: the fitted region.
        for (const [a, b, dash] of [
          [from, to, dashInside],
          [to, lastIdx, [3, 3]],
        ] as [number, number, number[]][]) {
          if (b <= a) continue;
          // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts Time union
          const x1 = timeScale.timeToCoordinate(data[a].time as any);
          // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts Time union
          const x2 = timeScale.timeToCoordinate(data[b].time as any);
          const y1 = mainSeries.priceToCoordinate(at(a - from));
          const y2 = mainSeries.priceToCoordinate(at(b - from));
          if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.setLineDash(dash);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.restore();
        }
      };

      stroke(upperAt, colors.rail, 1, []);
      stroke(lowerAt, colors.rail, 1, []);
      stroke(centreAt, colors.centre, 1.5, []);

      // Endpoint handles, so it is obvious what was selected.
      for (const idx of [from, to]) {
        // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts Time union
        const x = timeScale.timeToCoordinate(data[idx].time as any);
        const y = mainSeries.priceToCoordinate(centreAt(idx - from));
        if (x == null || y == null) continue;
        ctx.fillStyle = colors.centre;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Readout: slope per bar, r, and how the rails were placed.
      // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts Time union
      const lx = timeScale.timeToCoordinate(data[from].time as any);
      const ly = mainSeries.priceToCoordinate(centreAt(0));
      if (lx != null && ly != null) {
        const railText =
          options.mode === "quantile"
            ? `q${options.tauPct}/${100 - options.tauPct}`
            : `${options.stdDevMult}σ`;
        const label = `REG  r=${r.toFixed(3)}  slope=${centre.slope.toFixed(4)}/bar  ${railText}  n=${xs.length}`;
        ctx.font = "8px monospace";
        const w = ctx.measureText(label).width;
        const bx = Math.min(Math.max(2, lx), Math.max(2, rect.width - w - 6));
        ctx.fillStyle = colors.bg;
        ctx.fillRect(bx - 2, ly - 16, w + 6, 11);
        ctx.fillStyle = colors.centre;
        ctx.fillText(label, bx + 1, ly - 8);
      }
    },
  };
}
