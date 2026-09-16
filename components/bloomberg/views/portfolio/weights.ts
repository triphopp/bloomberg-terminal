/**
 * Position weight — what share of the portfolio one holding is.
 *
 * Denominator is NAV INCLUDING CASH: equity market value + option market value
 * + idle cash, all in the display currency, scoped to the selected account
 * ("all" = every account). So every position's weight plus the cash weight
 * sums to 100%, and selling something moves weight into CASH instead of making
 * the other rows jump.
 *
 * Options get two numbers because either one alone misleads:
 * - `weight` from premium market value — the money actually sitting in the
 *   position. A far-OTM call can be 0.3% of NAV.
 * - `exposure` from delta notional — the stock-equivalent risk. That same call
 *   can carry 8% of NAV of market exposure. Signed: short delta is negative.
 *
 * Pure — no React, no fetch. Tests: `npm run test:views`.
 */

export interface NavInputs {
  /** Market value of each open equity position (display currency). null = unpriced. */
  equityValues: (number | null | undefined)[];
  /** Market value of each open option lot (display currency). */
  optionValues: (number | null | undefined)[];
  /** Idle cash for the same scope, or null when the summary has not loaded. */
  cash: number | null | undefined;
}

export interface NavBreakdown {
  equity: number;
  options: number;
  cash: number;
  nav: number;
  /** Positions left out because they had no market value — the NAV is partial. */
  unpriced: number;
  cashKnown: boolean;
}

const finite = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

export function navBreakdown({ equityValues, optionValues, cash }: NavInputs): NavBreakdown {
  let equity = 0;
  let options = 0;
  let unpriced = 0;
  for (const v of equityValues) {
    if (finite(v)) equity += v;
    else unpriced += 1;
  }
  for (const v of optionValues) {
    if (finite(v)) options += v;
    else unpriced += 1;
  }
  const cashKnown = finite(cash);
  const c = cashKnown ? (cash as number) : 0;
  return { equity, options, cash: c, nav: equity + options + c, unpriced, cashKnown };
}

/** value ÷ NAV in percent; null when either side is unusable. */
export function weightPct(value: number | null | undefined, nav: number): number | null {
  if (!finite(value) || !(nav > 0)) return null;
  return (value / nav) * 100;
}

/** "12.3%", "0.42%" below 1%, "<0.01%" for dust, "—" for null. */
export function fmtWeight(pct: number | null): string {
  if (pct == null) return "—";
  const a = Math.abs(pct);
  const sign = pct < 0 ? "-" : "";
  if (a > 0 && a < 0.01) return `${sign}<0.01%`;
  return `${sign}${a < 1 ? a.toFixed(2) : a.toFixed(1)}%`;
}
