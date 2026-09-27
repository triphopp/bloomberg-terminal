/**
 * House number-format rules (CLAUDE.md → "Number format").
 *
 *  - Any displayed PRICE: at least 2 decimals, never rounded to a whole number
 *    however large — 51,828.60, not 51,829. A board that rounds big prices
 *    shows CHG moving while LAST stands still, and disagrees with the chart.
 *  - Below 1 the price gets up to 4 decimals (a 0.0472 FX cross or a ฿0.47
 *    stock would otherwise read as 0.05).
 *
 * PORT has its own stricter pair in views/portfolio/helpers.ts: `fmtPx`
 * (trade prices, 2–4 dp) and `fmtQty` (volume, up to 7 dp).
 */
// Built once: `n.toLocaleString(locale, opts)` constructs a NumberFormat on
// every call (~25 µs vs ~0.5 µs), and this formats every price cell on every
// tick. Identical output.
const PRICE_2DP = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const PRICE_SUB1 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function fmtPriceStd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return (Math.abs(n) < 1 ? PRICE_SUB1 : PRICE_2DP).format(n);
}

const NUMBER_FORMATS = new Map<string, Intl.NumberFormat>();

/**
 * Cached en-US `Intl.NumberFormat` for a fraction-digit range — the drop-in for
 * `n.toLocaleString("en-US", { minimumFractionDigits, maximumFractionDigits })`,
 * which builds a new formatter on every call (~25 µs vs ~0.5 µs). Omitted
 * bounds keep Intl's defaults, exactly as the toLocaleString call did.
 */
export function numberFormat(min?: number, max?: number): Intl.NumberFormat {
  const key = `${min ?? ""}|${max ?? ""}`;
  let f = NUMBER_FORMATS.get(key);
  if (!f) {
    const opts: Intl.NumberFormatOptions = {};
    if (min !== undefined) opts.minimumFractionDigits = min;
    if (max !== undefined) opts.maximumFractionDigits = max;
    f = new Intl.NumberFormat("en-US", opts);
    NUMBER_FORMATS.set(key, f);
  }
  return f;
}
