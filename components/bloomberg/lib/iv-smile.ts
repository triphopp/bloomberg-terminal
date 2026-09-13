/** Current-expiry Yahoo IV quotes. IV is a fraction here, percent in chart rows. */
export interface IvSmileOption {
  contractSymbol?: string;
  strike: number;
  impliedVolatility: number;
  openInterest?: number | null;
  openInterestAvailable?: boolean;
  bid?: number | null;
  ask?: number | null;
}

export interface IvSmileChain {
  symbol: string;
  spot: number;
  expiry: string;
  expirations: string[];
  calls: IvSmileOption[];
  puts: IvSmileOption[];
  freshness?: {
    source: string;
    fetched_at?: string;
    delay_minutes?: number;
    is_realtime?: boolean;
  };
}

export interface IvSmilePoint {
  strike: number;
  callIV: number | null;
  putIV: number | null;
}

export interface IvSmileOiPoint {
  strike: number;
  callOI: number | null;
  putOI: number | null;
}

/** OI is independent of IV/quote quality. Deduplicate contracts, never expiries. */
export function buildIvSmileOi(
  chain: Pick<IvSmileChain, "calls" | "puts" | "spot">,
  rangePercent = 25
) {
  const rows = new Map<number, IvSmileOiPoint>();
  const stats = {
    call: { known: 0, missing: 0, total: 0 },
    put: { known: 0, missing: 0, total: 0 },
  };
  for (const [side, options] of [
    ["call", chain.calls],
    ["put", chain.puts],
  ] as const) {
    const contracts = new Map<string, IvSmileOption>();
    for (const option of options) {
      if (!Number.isFinite(option.strike) || option.strike <= 0) continue;
      if (
        rangePercent > 0 &&
        Number.isFinite(chain.spot) &&
        chain.spot > 0 &&
        Math.abs(option.strike / chain.spot - 1) > rangePercent / 100 + 1e-10
      )
        continue;
      contracts.set(option.contractSymbol || `${side}:${option.strike}`, option);
    }
    for (const option of contracts.values()) {
      const row = rows.get(option.strike) ?? { strike: option.strike, callOI: null, putOI: null };
      rows.set(option.strike, row);
      const oi = option.openInterest;
      if (
        option.openInterestAvailable === false ||
        typeof oi !== "number" ||
        !Number.isSafeInteger(oi) ||
        oi < 0
      ) {
        stats[side].missing++;
        continue;
      }
      stats[side].known++;
      stats[side].total += oi;
      const key = side === "call" ? "callOI" : "putOI";
      row[key] = (row[key] ?? 0) + oi;
    }
  }
  const callTotal = stats.call.known ? stats.call.total : null;
  const putTotal = stats.put.known ? stats.put.total : null;
  const missing = stats.call.missing + stats.put.missing;
  return {
    points: [...rows.values()].sort((a, b) => a.strike - b.strike),
    callTotal,
    putTotal,
    missing,
    available: stats.call.known + stats.put.known > 0,
    putCallRatio:
      missing === 0 && callTotal != null && callTotal > 0 && putTotal != null
        ? putTotal / callTotal
        : null,
  };
}

export const SMILE_TENOR_MONTHS = [1, 3, 5, 7, 9] as const;
export type SmileSide = "both" | "otm" | "call" | "put";
export type SmileFitMode = "observed" | "raw_svi";
export interface SviSample {
  strike: number;
  ivPercent: number;
}
export interface RawSviParameters {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}
export interface RawSviFit {
  status: "ok" | "unavailable";
  reason: string | null;
  parameters: RawSviParameters | null;
  rmseIvPct: number | null;
  usedPoints: number;
  minStrike: number | null;
  maxStrike: number | null;
  referencePrice: number;
  timeYears: number;
}
export interface SviFitResponse {
  model: "raw_svi";
  coordinate: "log(K/S)";
  objective: "soft_l1_total_variance";
  series: Partial<Record<"call" | "put" | "otm", RawSviFit>>;
}
export interface SmileTenor {
  months: number[];
  expiry: string | null;
  days: number | null;
}

/** Add calendar months, clamping month-end rather than overflowing into March. */
export function smileTenorDate(
  months: number,
  today = new Date().toISOString().slice(0, 10)
): string {
  const start = new Date(`${today}T00:00:00Z`);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), last));
  return target.toISOString().slice(0, 10);
}

/** Nearest actual expiry within45 days; shared expiries are fetched/drawn once. */
export function selectSmileTenors(
  expirations: string[],
  months: number[],
  today?: string
): SmileTenor[] {
  const available = expirations.filter((e) => expiryDays(e, today) >= 7).sort();
  const result: SmileTenor[] = [];
  for (const month of [...new Set(months)].sort((a, b) => a - b)) {
    const target = smileTenorDate(month, today);
    const nearest = [...available].sort(
      (a, b) =>
        Math.abs(expiryDays(a, target)) - Math.abs(expiryDays(b, target)) || a.localeCompare(b)
    )[0];
    const expiry = nearest && Math.abs(expiryDays(nearest, target)) <= 45 ? nearest : null;
    const same = expiry ? result.find((item) => item.expiry === expiry) : undefined;
    if (same) same.months.push(month);
    else result.push({ months: [month], expiry, days: expiry ? expiryDays(expiry, today) : null });
  }
  return result;
}

export function smileSamples(points: IvSmilePoint[], side: SmileSide, spot: number) {
  const names: ("call" | "put" | "otm")[] = side === "both" ? ["call", "put"] : [side];
  return names.map((name) => ({
    name,
    points: points.flatMap((point): SviSample[] => {
      const value =
        name === "otm"
          ? spot > 0
            ? point.strike < spot
              ? point.putIV
              : point.callIV
            : null
          : name === "call"
            ? point.callIV
            : point.putIV;
      return value == null ? [] : [{ strike: point.strike, ivPercent: value }];
    }),
  }));
}

/** Evaluate server-calibrated total variance, only inside its observed strike span. */
export function sviIvAtStrike(strike: number, fit: RawSviFit): number | null {
  if (
    fit.status !== "ok" ||
    !fit.parameters ||
    fit.timeYears <= 0 ||
    fit.referencePrice <= 0 ||
    fit.minStrike == null ||
    fit.maxStrike == null ||
    strike < fit.minStrike ||
    strike > fit.maxStrike
  )
    return null;
  const { a, b, rho, m, sigma } = fit.parameters;
  const x = Math.log(strike / fit.referencePrice) - m;
  const w = a + b * (rho * x + Math.hypot(x, sigma));
  return Number.isFinite(w) && w > 0 ? 100 * Math.sqrt(w / fit.timeYears) : null;
}

/** Shared numeric K grid makes multi-expiry tooltip values refer to the SAME strike. */
export function smilePlotRows(
  series: { id: string; points: SviSample[]; fit?: RawSviFit }[],
  fitted: boolean,
  oiPoints: IvSmileOiPoint[] = []
) {
  const strikes = new Set(series.flatMap((s) => s.points.map((p) => p.strike)));
  for (const point of oiPoints) {
    if (point.callOI != null || point.putOI != null) strikes.add(point.strike);
  }
  const sorted = [...strikes].sort((a, b) => a - b);
  if (fitted && sorted.length > 1) {
    const lo = sorted[0];
    const hi = sorted[sorted.length - 1];
    for (let i = 0; i <= 180; i++) strikes.add(lo + ((hi - lo) * i) / 180);
  }
  const observed = series.map((s) => new Map(s.points.map((p) => [p.strike, p.ivPercent])));
  const oi = new Map(oiPoints.map((p) => [p.strike, p]));
  return [...strikes]
    .sort((a, b) => a - b)
    .map((strike) => {
      const row: Record<string, number | null> = { strike };
      row.callOI = oi.get(strike)?.callOI ?? null;
      row.putOI = oi.get(strike)?.putOI ?? null;
      series.forEach((s, i) => {
        row[`${s.id}_observed`] = observed[i].get(strike) ?? null;
        row[`${s.id}_fit`] = fitted && s.fit ? sviIvAtStrike(strike, s.fit) : null;
      });
      return row;
    });
}

export function expiryDays(expiry: string, today = new Date().toISOString().slice(0, 10)): number {
  return Math.round(
    (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000
  );
}

/** One maturity per smile; prefer >=7 DTE nearest 30, then nearest unexpired. */
export function chooseSmileExpiry(expirations: string[], today?: string): string | undefined {
  const available = expirations
    .map((expiry) => ({ expiry, days: expiryDays(expiry, today) }))
    .filter(({ days }) => Number.isFinite(days) && days >= 0)
    .sort((a, b) => a.days - b.days);
  const candidates = available.filter(({ days }) => days >= 7);
  return (candidates.length ? candidates : available).sort(
    (a, b) => Math.abs(a.days - 30) - Math.abs(b.days - 30) || a.days - b.days
  )[0]?.expiry;
}

/** Union of strikes preserves put-only quotes and explicit gaps in either side. */
export function buildIvSmile(
  chain: Pick<IvSmileChain, "calls" | "puts" | "spot">,
  rangePercent = 25,
  quotedOnly = true
) {
  const rows = new Map<number, IvSmilePoint>();
  let excluded = 0;
  for (const [side, options] of [
    ["callIV", chain.calls],
    ["putIV", chain.puts],
  ] as const) {
    for (const option of options) {
      const { strike, impliedVolatility: iv, bid, ask } = option;
      if (!Number.isFinite(strike) || strike <= 0) continue;
      if (
        rangePercent > 0 &&
        chain.spot > 0 &&
        Number.isFinite(chain.spot) &&
        Math.abs(strike / chain.spot - 1) > rangePercent / 100 + 1e-10
      )
        continue;
      const row = rows.get(strike) ?? { strike, callIV: null, putIV: null };
      rows.set(strike, row);
      const quoted =
        typeof bid === "number" &&
        Number.isFinite(bid) &&
        bid > 0 &&
        typeof ask === "number" &&
        Number.isFinite(ask) &&
        ask >= bid;
      // The backend rounds Yahoo's 1e-5 IV floor to zero. Never plot it as 0%.
      if (!Number.isFinite(iv) || iv <= 0.0001 || (quotedOnly && !quoted)) {
        excluded++;
        continue;
      }
      row[side] = iv * 100;
    }
  }
  const points = [...rows.values()].sort((a, b) => a.strike - b.strike);
  const callCount = points.filter((p) => p.callIV != null).length;
  const putCount = points.filter((p) => p.putIV != null).length;
  const strikeCount = points.filter((p) => p.callIV != null || p.putIV != null).length;
  return { points, callCount, putCount, strikeCount, excluded, sufficient: strikeCount >= 3 };
}
