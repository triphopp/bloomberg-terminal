// Filtering for the CASH / DIVIDENDS / REINVEST ledgers (PORT → CASH).
// Pure so it can be tested without React: each table describes how to read a
// row (date, amount, account, type, searchable text) and gets back the rows
// that pass, in the chosen order.

export type RangePreset = "ALL" | "1M" | "3M" | "YTD" | "1Y" | "YEAR" | "CUSTOM";
export type LedgerSort = "date_desc" | "date_asc" | "amt_desc" | "amt_asc";

export interface LedgerFilter {
  range: RangePreset;
  /** YYYY — used when range = YEAR. */
  year: string;
  /** YYYY-MM-DD, inclusive — used when range = CUSTOM. */
  from: string;
  to: string;
  /** Case-insensitive; every space-separated word must match some field. */
  q: string;
  /** "all" or an account id. Only offered when the tab is scoped to ALL. */
  account: string;
  /** Empty = every type. */
  types: string[];
  /** Minimum |amount|; null = no floor. */
  minAmount: number | null;
  sort: LedgerSort;
}

export const BLANK_FILTER: LedgerFilter = {
  range: "ALL",
  year: "",
  from: "",
  to: "",
  q: "",
  account: "all",
  types: [],
  minAmount: null,
  sort: "date_desc",
};

export interface RowAccess<T> {
  date: (r: T) => string;
  amount: (r: T) => number;
  account: (r: T) => string;
  type: (r: T) => string;
  text: (r: T) => (string | null | undefined)[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Inclusive [from, to] for the filter, or nulls for an open end. */
export function rangeBounds(
  f: LedgerFilter,
  today: string
): { from: string | null; to: string | null } {
  const t = new Date(`${today}T00:00:00Z`);
  const back = (months: number) => {
    const d = new Date(t);
    d.setUTCMonth(d.getUTCMonth() - months);
    return iso(d);
  };
  switch (f.range) {
    case "1M":
      return { from: back(1), to: null };
    case "3M":
      return { from: back(3), to: null };
    case "1Y":
      return { from: back(12), to: null };
    case "YTD":
      return { from: `${today.slice(0, 4)}-01-01`, to: null };
    case "YEAR":
      return f.year ? { from: `${f.year}-01-01`, to: `${f.year}-12-31` } : { from: null, to: null };
    case "CUSTOM":
      return { from: f.from || null, to: f.to || null };
    default:
      return { from: null, to: null };
  }
}

export function applyFilter<T>(rows: T[], f: LedgerFilter, get: RowAccess<T>, today: string): T[] {
  const { from, to } = rangeBounds(f, today);
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const types = new Set(f.types);
  const out = rows.filter((r) => {
    const d = (get.date(r) || "").slice(0, 10);
    // An undated row is kept only while no date bound is set — hiding it
    // silently under "YTD" would make it look deleted.
    if ((from || to) && !d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (f.account !== "all" && get.account(r) !== f.account) return false;
    if (types.size && !types.has(get.type(r))) return false;
    if (f.minAmount != null && Math.abs(get.amount(r)) < f.minAmount) return false;
    if (words.length) {
      const hay = get.text(r).filter(Boolean).join(" ").toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const byDate = (a: T, b: T) => (get.date(a) || "").localeCompare(get.date(b) || "");
  const byAmt = (a: T, b: T) => Math.abs(get.amount(a)) - Math.abs(get.amount(b));
  switch (f.sort) {
    case "date_asc":
      return out.sort(byDate);
    case "amt_desc":
      return out.sort((a, b) => byAmt(b, a) || byDate(b, a));
    case "amt_asc":
      return out.sort((a, b) => byAmt(a, b) || byDate(b, a));
    default:
      return out.sort((a, b) => byDate(b, a));
  }
}

/** True when anything would hide or reorder a row. */
export function isFiltered(f: LedgerFilter): boolean {
  return (
    f.range !== "ALL" ||
    f.q.trim() !== "" ||
    f.account !== "all" ||
    f.types.length > 0 ||
    f.minAmount != null
  );
}

/** Years present in the data, newest first — the YEAR menu. */
export function yearsOf<T>(rows: T[], date: (r: T) => string): string[] {
  const ys = new Set<string>();
  for (const r of rows) {
    const y = (date(r) || "").slice(0, 4);
    if (/^\d{4}$/.test(y)) ys.add(y);
  }
  return [...ys].sort().reverse();
}
