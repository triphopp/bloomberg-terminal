/**
 * Dividend growth — how much more (or less) the book is paid, and why.
 *
 * Pure functions over the PORT dividend ledger (`/api/v2/portfolio/dividends`),
 * so every figure on the DIVIDEND GROWTH card can be tested.
 *
 * A payout belongs to the window its PAY date falls in (the cash), like the
 * DIVIDENDS bar chart beside it. The change between two windows is split per
 * asset so the parts add up to the total exactly:
 *
 *   NEW      paid now, nothing in the prior window (bought, or first payout)
 *   STOPPED  paid in the prior window, nothing now (sold, or suspended)
 *   and for an asset paid in both, with N = native total, D = Σ dividend per
 *   unit over the window (one per ex-date), U = N / D, f = base / native:
 *   FX       (f1 − f0) · N0
 *   UNITS    f1 · (U1 − U0) · D1     — held more / fewer shares
 *   DPS      f1 · (D1 − D0) · U0     — the company paid more / less per share
 *
 * Only DPS is the companies raising their dividends; UNITS is money the book
 * put in. Reading the two apart is the point of the card.
 */

export interface DividendRow {
  asset: string;
  ex_date: string;
  pay_date: string;
  amount_per_unit: number;
  total_received: number;
  total_received_base?: number;
  currency: string;
}

export type GrowthMode = "TTM" | "YTD";

/** Inclusive YYYY-MM-DD bounds. */
export interface DateWindow {
  start: string;
  end: string;
}

export type ChangeKind =
  | "NEW"
  | "STOPPED"
  | "DPS_UP"
  | "DPS_DOWN"
  | "UNITS_UP"
  | "UNITS_DOWN"
  | "FX"
  | "SAME";

export interface AssetChange {
  asset: string;
  currency: string;
  /** Base currency. */
  prior: number;
  current: number;
  delta: number;
  /** Native currency, summed over the window's ex-dates. */
  dpsPrior: number | null;
  dpsCurrent: number | null;
  unitsPrior: number | null;
  unitsCurrent: number | null;
  paymentsPrior: number;
  paymentsCurrent: number;
  newEffect: number;
  stoppedEffect: number;
  fxEffect: number;
  unitsEffect: number;
  dpsEffect: number;
  /** The part that explains most of `delta`. */
  kind: ChangeKind;
}

export interface Bridge {
  prior: number;
  newPayers: number;
  stopped: number;
  fx: number;
  units: number;
  dps: number;
  current: number;
}

export interface DividendGrowth {
  mode: GrowthMode;
  current: DateWindow;
  prior: DateWindow;
  totalCurrent: number;
  totalPrior: number;
  /** null when nothing was paid in the prior window. */
  growthPct: number | null;
  payersCurrent: number;
  payersPrior: number;
  /** Assets paid in both windows whose dividend per unit rose / fell / held (±0.5%). */
  dpsRaised: number;
  dpsCut: number;
  dpsHeld: number;
  assets: AssetChange[];
  bridge: Bridge;
  /** Pay date of the first payout in the ledger. */
  firstPayout: string | null;
  /** The prior window starts before the first recorded payout, so it may be
   *  short of what was really paid — growth then reads too high. */
  priorIncomplete: boolean;
}

const DPS_TOLERANCE = 0.005;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Same calendar day `years` earlier/later; 29 Feb falls back to 28 Feb. */
function shiftYears(date: string, years: number): string {
  const y = Number(date.slice(0, 4)) + years;
  const m = Number(date.slice(5, 7));
  const d = Math.min(Number(date.slice(8, 10)), daysIn(y, m));
  return ymd(y, m, d);
}

function nextDay(date: string): string {
  const t = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10))
  );
  const n = new Date(t + 86_400_000);
  return ymd(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate());
}

/** The current window ending at `asOf` and the window a year before it. */
export function growthWindows(
  mode: GrowthMode,
  asOf: string
): { current: DateWindow; prior: DateWindow } {
  if (mode === "YTD") {
    const year = asOf.slice(0, 4);
    const priorEnd = shiftYears(asOf, -1);
    return {
      current: { start: `${year}-01-01`, end: asOf },
      prior: { start: `${priorEnd.slice(0, 4)}-01-01`, end: priorEnd },
    };
  }
  const priorEnd = shiftYears(asOf, -1);
  return {
    current: { start: nextDay(priorEnd), end: asOf },
    prior: { start: nextDay(shiftYears(asOf, -2)), end: priorEnd },
  };
}

const inWindow = (date: string, w: DateWindow) => date >= w.start && date <= w.end;
const baseOf = (r: DividendRow) => r.total_received_base ?? r.total_received;

interface Side {
  native: number;
  base: number;
  /** ex-date → dividend per unit, so two accounts paid on one ex-date count it once. */
  dps: Map<string, number>;
}

function sideOf(rows: DividendRow[]): Side {
  const side: Side = { native: 0, base: 0, dps: new Map() };
  for (const r of rows) {
    side.native += r.total_received;
    side.base += baseOf(r);
    const key = r.ex_date || r.pay_date;
    if (r.amount_per_unit > 0 && !side.dps.has(key)) side.dps.set(key, r.amount_per_unit);
  }
  return side;
}

const sum = (m: Map<string, number>) => {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
};

function assetChange(asset: string, currency: string, p: Side, c: Side): AssetChange {
  const change: AssetChange = {
    asset,
    currency,
    prior: p.base,
    current: c.base,
    delta: c.base - p.base,
    dpsPrior: p.dps.size ? sum(p.dps) : null,
    dpsCurrent: c.dps.size ? sum(c.dps) : null,
    unitsPrior: null,
    unitsCurrent: null,
    paymentsPrior: p.dps.size,
    paymentsCurrent: c.dps.size,
    newEffect: 0,
    stoppedEffect: 0,
    fxEffect: 0,
    unitsEffect: 0,
    dpsEffect: 0,
    kind: "SAME",
  };
  if (p.base === 0 && c.base > 0) {
    change.newEffect = c.base;
    change.kind = "NEW";
    if (change.dpsCurrent) change.unitsCurrent = c.native / change.dpsCurrent;
    return change;
  }
  if (c.base === 0 && p.base > 0) {
    change.stoppedEffect = -p.base;
    change.kind = "STOPPED";
    if (change.dpsPrior) change.unitsPrior = p.native / change.dpsPrior;
    return change;
  }
  const d0 = change.dpsPrior;
  const d1 = change.dpsCurrent;
  if (!d0 || !d1 || p.native <= 0 || c.native <= 0) {
    // No per-unit figure to split by: the whole change is left as units.
    change.unitsEffect = change.delta;
    change.kind = change.delta > 0 ? "UNITS_UP" : change.delta < 0 ? "UNITS_DOWN" : "SAME";
    return change;
  }
  const u0 = p.native / d0;
  const u1 = c.native / d1;
  const f0 = p.base / p.native;
  const f1 = c.base / c.native;
  change.unitsPrior = u0;
  change.unitsCurrent = u1;
  change.fxEffect = (f1 - f0) * p.native;
  change.unitsEffect = f1 * (u1 - u0) * d1;
  change.dpsEffect = f1 * (d1 - d0) * u0;
  const parts: [ChangeKind, number][] = [
    [change.dpsEffect >= 0 ? "DPS_UP" : "DPS_DOWN", change.dpsEffect],
    [change.unitsEffect >= 0 ? "UNITS_UP" : "UNITS_DOWN", change.unitsEffect],
    ["FX", change.fxEffect],
  ];
  const [kind, size] = parts.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a));
  change.kind = Math.abs(size) < 1e-9 ? "SAME" : kind;
  return change;
}

export function dividendGrowth(
  rows: DividendRow[],
  mode: GrowthMode,
  asOf: string
): DividendGrowth {
  const { current, prior } = growthWindows(mode, asOf);
  const paid = rows.filter((r) => r.pay_date && r.total_received > 0);
  const byAsset = new Map<
    string,
    { currency: string; prior: DividendRow[]; current: DividendRow[] }
  >();
  let firstPayout: string | null = null;
  for (const r of paid) {
    if (firstPayout === null || r.pay_date < firstPayout) firstPayout = r.pay_date;
    const side = inWindow(r.pay_date, current)
      ? "current"
      : inWindow(r.pay_date, prior)
        ? "prior"
        : null;
    if (!side) continue;
    const entry = byAsset.get(r.asset) ?? { currency: r.currency, prior: [], current: [] };
    entry[side].push(r);
    byAsset.set(r.asset, entry);
  }

  const assets = [...byAsset.entries()]
    .map(([asset, e]) => assetChange(asset, e.currency, sideOf(e.prior), sideOf(e.current)))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.asset.localeCompare(b.asset));

  const bridge: Bridge = {
    prior: 0,
    newPayers: 0,
    stopped: 0,
    fx: 0,
    units: 0,
    dps: 0,
    current: 0,
  };
  let dpsRaised = 0;
  let dpsCut = 0;
  let dpsHeld = 0;
  for (const a of assets) {
    bridge.prior += a.prior;
    bridge.current += a.current;
    bridge.newPayers += a.newEffect;
    bridge.stopped += a.stoppedEffect;
    bridge.fx += a.fxEffect;
    bridge.units += a.unitsEffect;
    bridge.dps += a.dpsEffect;
    if (a.dpsPrior && a.dpsCurrent && a.prior > 0 && a.current > 0) {
      const r = a.dpsCurrent / a.dpsPrior - 1;
      if (r > DPS_TOLERANCE) dpsRaised++;
      else if (r < -DPS_TOLERANCE) dpsCut++;
      else dpsHeld++;
    }
  }

  return {
    mode,
    current,
    prior,
    totalCurrent: bridge.current,
    totalPrior: bridge.prior,
    growthPct: bridge.prior > 0 ? (bridge.current / bridge.prior - 1) * 100 : null,
    payersCurrent: assets.filter((a) => a.current > 0).length,
    payersPrior: assets.filter((a) => a.prior > 0).length,
    dpsRaised,
    dpsCut,
    dpsHeld,
    assets,
    bridge,
    firstPayout,
    priorIncomplete: firstPayout !== null && prior.start < firstPayout,
  };
}

export interface TtmPoint {
  /** YYYY-MM */
  month: string;
  /** Paid in this month (base). */
  paid: number;
  /** Paid in the 12 months ending with this one (base). */
  ttm: number;
  /** Fewer than 12 months of ledger behind this point: the sum is still filling
   *  in, so a rise here is history being added, not dividends growing. */
  partial: boolean;
}

/** Trailing-twelve-month dividends at each month end, from the first payout to `asOf`. */
export function rollingTtm(rows: DividendRow[], asOf: string): TtmPoint[] {
  const paid = rows.filter((r) => r.pay_date && r.total_received > 0 && r.pay_date <= asOf);
  if (paid.length === 0) return [];
  const byMonth = new Map<string, number>();
  let first = asOf.slice(0, 7);
  for (const r of paid) {
    const m = r.pay_date.slice(0, 7);
    if (m < first) first = m;
    byMonth.set(m, (byMonth.get(m) ?? 0) + baseOf(r));
  }
  const out: TtmPoint[] = [];
  const months: number[] = [];
  let running = 0;
  let y = Number(first.slice(0, 4));
  let m = Number(first.slice(5, 7));
  const last = asOf.slice(0, 7);
  for (;;) {
    const key = `${y}-${pad(m)}`;
    if (key > last) break;
    const v = byMonth.get(key) ?? 0;
    months.push(v);
    running += v;
    if (months.length > 12) running -= months[months.length - 13];
    out.push({ month: key, paid: v, ttm: running, partial: out.length < 11 });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
