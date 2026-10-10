// Paging for PORT → TOOLS → RESEARCH: a page is as many rows as the panel is
// tall, so a page never scrolls. Pure — tested in __tests__/research-paging.test.ts.

/** Height of one row in px. Rows are fixed-height so the count below is exact. */
export const ROW_H = 46;

/** Rows that fit in `height` px without scrolling — never fewer than one. */
export function pageSizeFor(height: number, rowH = ROW_H): number {
  if (!(height > 0) || !(rowH > 0)) return 1;
  return Math.max(1, Math.floor(height / rowH));
}

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, size)));
}

/** The page holding row `first`, kept inside the list. The panel remembers the
 *  first row it shows, not a page number: when the window is resized the page
 *  size changes and the row being read must stay on screen. */
export function pageOf(first: number, total: number, size: number): number {
  const s = Math.max(1, size);
  const last = pageCount(total, s) - 1;
  return Math.min(last, Math.max(0, Math.floor(first / s)));
}

export function pageSlice<T>(rows: T[], page: number, size: number): T[] {
  const s = Math.max(1, size);
  return rows.slice(page * s, page * s + s);
}

/** `graphs.updated_at` is UTC in two spellings — "2026-10-09 01:46:55.193"
 *  (sync) and "2026-10-06T18:03:21.975083" (router) — neither with a zone. */
export function parseUtc(stamp: string | null | undefined): Date | null {
  if (!stamp) return null;
  let s = stamp.trim().replace(" ", "T");
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += "Z";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** Local "YYYY-MM-DD HH:mm", or "—". */
export function fmtStamp(stamp: string | null | undefined): string {
  const d = parseUtc(stamp);
  if (!d) return "—";
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

type Searchable = {
  title: string;
  description?: string | null;
  symbol?: string | null;
  tags?: string | null;
  updated_at: string;
};

/** Every word of `query` must appear in the title, symbol, tags or description. */
export function matchesResearch(row: Searchable, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay =
    `${row.title} ${row.symbol ?? ""} ${row.tags ?? ""} ${row.description ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Newest first by the moment the page was last written. The two spellings of
 *  the stamp do not sort as text ("…09 01" < "…09T01"), so compare as dates. */
export function newestFirst<T extends Searchable>(rows: T[]): T[] {
  const at = (r: T) => parseUtc(r.updated_at)?.getTime() ?? 0;
  return [...rows].sort((a, b) => at(b) - at(a));
}
