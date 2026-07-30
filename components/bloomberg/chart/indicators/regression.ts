/**
 * Line-fitting primitives for the Regression Channel tool.
 *
 * Two ways to place a channel around a fitted trend, and the difference is the
 * point of having both:
 *
 *   ±kσ (TradingView's default) — the centre is the OLS conditional MEAN, and
 *   the rails sit a fixed number of residual standard deviations away. Both
 *   rails are the same distance from the centre by construction, so the channel
 *   is symmetric even when the price action inside it is not.
 *
 *   quantile envelope — the rails are conditional QUANTILES fitted directly to
 *   the data (τ and 1−τ). They land where the price actually turned, so an
 *   asymmetric run produces an asymmetric channel, and the fraction of bars
 *   outside each rail is what you asked for rather than whatever the normal
 *   approximation implies.
 *
 * quantileRegression was validated against statsmodels.QuantReg across 25
 * cases (5 data shapes × 5 quantiles); worst slope disagreement 2.9e-6, which
 * is 0.006 px on a 400px pane.
 */

export interface LineFit {
  slope: number;
  intercept: number;
}

/** Evaluate a fitted line at an x position. */
export function evalLine(fit: LineFit, x: number): number {
  return fit.intercept + fit.slope * x;
}

/** Ordinary least squares — the channel centre, and the IRLS starting point. */
export function leastSquares(xs: number[], ys: number[]): LineFit {
  const n = xs.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  if (n === 1) return { slope: 0, intercept: ys[0] };

  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    num += dx * (ys[i] - my);
    den += dx * dx;
  }
  const slope = den > 0 ? num / den : 0;
  return { slope, intercept: my - slope * mx };
}

/** Pearson correlation of y against x — the channel's goodness-of-fit readout. */
export function pearsonR(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;

  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const den = Math.sqrt(sxx * syy);
  return den > 0 ? sxy / den : 0;
}

/**
 * Standard deviation of the residuals about a fitted line.
 *
 * Divides by n rather than n−2: this is a descriptive channel width, not an
 * inferential estimate of the error variance, and it matches what charting
 * packages draw.
 */
export function residualStdDev(xs: number[], ys: number[], fit: LineFit): number {
  const n = xs.length;
  if (n === 0) return 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (fit.intercept + fit.slope * xs[i]);
    ss += r * r;
  }
  return Math.sqrt(ss / n);
}

/**
 * Quantile regression of y on x by iteratively reweighted least squares.
 *
 * Minimises Σ ρ_τ(rᵢ) with the check function ρ_τ(r) = r·(τ − 1{r<0}). Writing
 * that as a weighted absolute loss Σ wᵢ|rᵢ| (wᵢ = τ above the line, 1−τ below)
 * lets each IRLS step solve a weighted least squares with vᵢ = wᵢ/|rᵢ|, which
 * converges to the quantile fit.
 *
 *   τ = 0.5 → median regression (robust to outliers)
 *   τ → 0   → lower envelope  (support)
 *   τ → 1   → upper envelope  (resistance)
 *
 * `eps` floors |rᵢ| so a point sitting exactly on the line cannot produce an
 * infinite weight; it is scaled to the data so the guard behaves the same on a
 * ฿15 stock and a 50,000-point index.
 *
 * The iteration cap is deliberately generous: validated against
 * statsmodels.QuantReg, large-scale series needed ~700 passes to land on the
 * exact fit (100 left a visible slope error).
 */
export function quantileRegression(
  xs: number[],
  ys: number[],
  tau: number,
  iterations = 1000
): LineFit {
  const n = xs.length;
  if (n < 2) return leastSquares(xs, ys);

  let scale = 0;
  for (const v of ys) scale = Math.max(scale, Math.abs(v));
  const eps = Math.max(1e-12, scale * 1e-10);

  let fit = leastSquares(xs, ys);

  for (let iter = 0; iter < iterations; iter++) {
    let sv = 0;
    let svx = 0;
    let svy = 0;
    let svxx = 0;
    let svxy = 0;

    for (let i = 0; i < n; i++) {
      const r = ys[i] - (fit.intercept + fit.slope * xs[i]);
      const w = r > 0 ? tau : 1 - tau;
      const v = w / Math.max(Math.abs(r), eps);
      sv += v;
      svx += v * xs[i];
      svy += v * ys[i];
      svxx += v * xs[i] * xs[i];
      svxy += v * xs[i] * ys[i];
    }

    const den = sv * svxx - svx * svx;
    if (!Number.isFinite(den) || Math.abs(den) < 1e-30) break;

    const slope = (sv * svxy - svx * svy) / den;
    const intercept = (svy - slope * svx) / sv;
    if (!Number.isFinite(slope) || !Number.isFinite(intercept)) break;

    // Convergence is judged relative to the coefficients' own magnitude — an
    // absolute threshold would stop early on index-scale data and never trigger
    // on penny stocks.
    const moved =
      Math.abs(slope - fit.slope) / Math.max(Math.abs(fit.slope), 1) +
      Math.abs(intercept - fit.intercept) / Math.max(Math.abs(fit.intercept), 1);
    fit = { slope, intercept };
    if (moved < 1e-12) break;
  }

  return fit;
}
