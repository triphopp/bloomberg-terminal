// Search, filter, group and sort for the thesis navigator — pure, tested in
// views/portfolio/__tests__/thesis-nav-filter.test.ts.
import type { Thesis } from "./types";

export type NavGroup = "kind" | "sector" | "category" | "none";
export type NavSort = "updated" | "symbol" | "work";

export interface NavState {
  q: string;
  /** "" = every kind. */
  kind: string;
  sector: string;
  status: string;
  onlyPending: boolean;
  onlyUnread: boolean;
  group: NavGroup;
  sort: NavSort;
}

export const NAV_DEFAULT: NavState = {
  q: "",
  kind: "",
  sector: "",
  status: "",
  onlyPending: false,
  onlyUnread: false,
  group: "kind",
  sort: "updated",
};

/** What a row is waiting on — owed work first, then things not looked at yet. */
export interface NavCounts {
  pending: number;
  watch: number;
  alert: number;
  unread: number;
}

export const NO_COUNTS: NavCounts = { pending: 0, watch: 0, alert: 0, unread: 0 };

export const DEFAULT_KINDS = ["equity", "credit", "fund", "macro", "theme", "process", "other"];

/** Kinds that are a tradable instrument: price targets and a position make sense. */
export const INSTRUMENT_KINDS = new Set(["equity", "credit", "fund"]);

/** `kind`, else what the backend derived, else what `category` said before the
 *  column existed (it used to carry equity / credit / PROCESS). */
export function kindOf(t: Pick<Thesis, "kind" | "kind_eff" | "category">): string {
  const k = (t.kind || t.kind_eff || "").trim().toLowerCase();
  if (k) return k;
  const c = (t.category || "").trim().toLowerCase();
  return DEFAULT_KINDS.includes(c) ? c : "equity";
}

export function sectorOf(t: Pick<Thesis, "sector" | "sector_eff">): string {
  return (t.sector || t.sector_eff || "").trim();
}

export function tagsOf(t: Pick<Thesis, "tags">): string[] {
  return (t.tags || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Every word of the query has to appear somewhere — "inp optical" finds the
 *  thesis tagged with both, in either order. */
export function matchesQuery(t: Thesis, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  // The body is in the list payload, so the search reaches the text too.
  const hay = [t.symbol, t.title, t.tags, kindOf(t), sectorOf(t), t.strategy, t.category, t.body]
    .map((x) => (x ?? "").toLowerCase())
    .join(" \u0001 ");
  return words.every((w) => hay.includes(w.replace(/^#/, "")));
}

export function filterTheses(
  theses: Thesis[],
  s: NavState,
  counts: Record<string, NavCounts> = {}
): Thesis[] {
  const out = theses.filter((t) => {
    const c = counts[t.id] ?? NO_COUNTS;
    if (s.kind && kindOf(t) !== s.kind) return false;
    if (s.sector && sectorOf(t) !== s.sector) return false;
    if (s.status && t.status !== s.status) return false;
    if (s.onlyPending && c.pending + c.alert === 0) return false;
    if (s.onlyUnread && c.unread === 0) return false;
    return matchesQuery(t, s.q);
  });
  const work = (t: Thesis) => {
    const c = counts[t.id] ?? NO_COUNTS;
    return c.pending * 1000 + c.alert * 1000 + c.watch * 10 + c.unread;
  };
  const bySymbol = (a: Thesis, b: Thesis) => a.symbol.localeCompare(b.symbol);
  if (s.sort === "symbol") return out.sort(bySymbol);
  if (s.sort === "work") return out.sort((a, b) => work(b) - work(a) || bySymbol(a, b));
  return out.sort(
    (a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || bySymbol(a, b)
  );
}

/** Groups in a fixed order (the default kinds first, then the user's own,
 *  alphabetically; an empty label last) so the list does not reshuffle when a
 *  filter changes. */
export function groupTheses(list: Thesis[], group: NavGroup): [string, Thesis[]][] {
  if (group === "none") return [["", list]];
  const label = (t: Thesis) =>
    group === "kind" ? kindOf(t) : group === "sector" ? sectorOf(t) : (t.category || "").trim();
  const map = new Map<string, Thesis[]>();
  for (const t of list) {
    const k = label(t);
    map.set(k, [...(map.get(k) ?? []), t]);
  }
  const rank = (k: string) => {
    if (!k) return 9999;
    const i = group === "kind" ? DEFAULT_KINDS.indexOf(k) : -1;
    return i >= 0 ? i : 100;
  };
  return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

/** value → how many theses carry it, for the filter chips and the sector menu. */
export function facet(theses: Thesis[], of: (t: Thesis) => string): [string, number][] {
  const map = new Map<string, number>();
  for (const t of theses) {
    const k = of(t);
    if (k) map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
