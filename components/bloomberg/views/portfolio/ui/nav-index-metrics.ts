/** Risk statistics for the observations plotted by the INDEX chart. */
export function runningDrawdownPct(values: (number | null)[]): (number | null)[] {
  let peak = 0;
  return values.map((value) => {
    if (value == null || !Number.isFinite(value) || value <= 0) return null;
    peak = Math.max(peak, value);
    return ((value - peak) / peak) * 100;
  });
}

export function indexRiskMetrics(values: (number | null)[]): {
  maxDrawdownPct: number | null;
  stdAnnualPct: number | null;
} {
  const observations = values.filter(
    (value): value is number => value != null && Number.isFinite(value) && value > 0
  );
  if (observations.length < 2) return { maxDrawdownPct: null, stdAnnualPct: null };

  let peak = observations[0];
  let maxDrawdown = 0;
  const returns: number[] = [];
  for (let i = 1; i < observations.length; i++) {
    const value = observations[i];
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
    returns.push(value / observations[i - 1] - 1);
  }

  if (returns.length < 2) {
    return { maxDrawdownPct: maxDrawdown * 100, stdAnnualPct: null };
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const sampleVariance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return {
    maxDrawdownPct: maxDrawdown * 100,
    stdAnnualPct: Math.sqrt(sampleVariance * 252) * 100,
  };
}
