// Market data utilities for Bloomberg Terminal clone
import type { MarketItem } from "../types";

/**
 * Check if a security is considered a "mover" based on percentage change
 * @param item Market item to check
 * @param threshold Percentage change threshold (default: 1.5%)
 * @returns Boolean indicating if the security is a significant mover
 */
export function isSignificantMover(item: MarketItem, threshold = 1.5): boolean {
  return Math.abs(item.change) >= threshold;
}

/**
 * Check if a security has high volatility
 * @param item Market item to check
 * @param volatilityData Volatility data for the security (if available)
 * @param threshold Volatility threshold (default: 2.0)
 * @returns Boolean indicating if the security has high volatility
 */
export function hasHighVolatility(
  item: MarketItem,
  volatilityData: Record<string, number> = {},
  threshold = 2.0
): boolean {
  // If we have volatility data for this security, use it
  if (volatilityData[item.id]) {
    return volatilityData[item.id] >= threshold;
  }

  // Otherwise, use a simple heuristic based on price change
  // This is a simplified approach - real systems would use standard deviation of returns
  return Math.abs(item.change) >= threshold;
}

/**
 * Sort market items by absolute percentage change (for movers view)
 * @param items Array of market items
 * @returns Sorted array with biggest movers first
 */
export function sortByAbsoluteChange(items: MarketItem[]): MarketItem[] {
  return [...items].sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}

/**
 * Filter market items to show only significant movers
 * @param items Array of market items
 * @param threshold Percentage change threshold
 * @returns Filtered array with only significant movers
 */
export function filterSignificantMovers(items: MarketItem[], threshold = 1.5): MarketItem[] {
  return items.filter((item) => isSignificantMover(item, threshold));
}

/**
 * Calculate the 10-day average value for a market item
 * @param historicalData 10-day historical data array
 * @returns Average value over the 10-day period
 */
export function calculate10DayAverage(historicalData: number[]): number {
  if (!historicalData || historicalData.length === 0) return 0;
  const sum = historicalData.reduce((acc, val) => acc + val, 0);
  return sum / historicalData.length;
}

/**
 * Estimate the Hurst exponent via rescaled-range (R/S) analysis on log returns.
 * H < 0.5 → mean-reverting, H ~ 0.5 → random walk, H > 0.5 → trending.
 * Returns 0.5 (random walk / neutral) when there isn't enough price history.
 */
export function calcHurst(prices: number[]): number {
  if (prices.length < 32) return 0.5;
  const logR: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) logR.push(Math.log(prices[i] / prices[i - 1]));
  }
  const sizes = [8, 16, 32, 64].filter((s) => s * 4 <= logR.length);
  if (sizes.length < 2) return 0.5;
  const rsArr = sizes.map((n) => {
    const chunks = Math.floor(logR.length / n);
    let rsSum = 0;
    for (let c = 0; c < chunks; c++) {
      const chunk = logR.slice(c * n, (c + 1) * n);
      const mean = chunk.reduce((a, b) => a + b, 0) / n;
      let cum = 0;
      const cumDevs: number[] = [];
      for (const v of chunk) {
        cum += v - mean;
        cumDevs.push(cum);
      }
      const R = Math.max(...cumDevs) - Math.min(...cumDevs);
      const S = Math.sqrt(chunk.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
      rsSum += S > 0 ? R / S : 1;
    }
    return rsSum / chunks;
  });
  const xs = sizes.map(Math.log);
  const ys = rsArr.map(Math.log);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b) / n;
  const my = ys.reduce((a, b) => a + b) / n;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return den > 0 ? Math.max(0.1, Math.min(0.9, num / den)) : 0.5;
}
