/**
 * TICK DATA board — the part the user arranges themselves.
 *
 * The board has seven built-in sections (rates, three index regions,
 * volatility, FX) whose rows come from the backend. On top of that the user
 * may, as freely as in the WATCHLIST:
 *   - add sections of their own and put any quoted symbol in them
 *   - rename, reorder and delete those sections; reorder and remove their rows
 *   - hide a built-in row or a whole built-in section (and bring it back)
 *
 * This file is the pure half: the saved shape and every edit as a function
 * from prefs to prefs. market-view.tsx renders it; quotes for custom rows come
 * from /api/tick-custom. Saved per browser in localStorage, like the board's
 * fold state and section order — not synced between machines.
 */

export const LS_TICK_BOARD = "bloomberg_tickdata_custom";

export const BUILTIN_TICK_SECTIONS = [
  "ratesUS",
  "ratesJP",
  "americas",
  "emea",
  "asiaPacific",
  "volatility",
  "fx",
] as const;

export type BuiltinTickSection = (typeof BUILTIN_TICK_SECTIONS)[number];
export type CustomTickSectionId = `c:${string}`;
export type TickSectionId = BuiltinTickSection | CustomTickSectionId;

export interface TickCustomRow {
  /** Quote symbol as the data source knows it (IXG, PTT.BK, BTC-USD, EURUSD=X). */
  symbol: string;
  /** Name shown on the board; the symbol when absent. */
  label?: string;
}

export interface TickCustomSection {
  id: CustomTickSectionId;
  label: string;
  rows: TickCustomRow[];
}

export interface TickBoardPrefs {
  sections: TickCustomSection[];
  /** Hidden built-in rows, as `${sectionId}|${rowId}`. */
  hiddenRows: string[];
  hiddenSections: BuiltinTickSection[];
}

export const MAX_CUSTOM_SECTIONS = 12;
export const MAX_ROWS_PER_SECTION = 40;
const SYMBOL_OK = /^[A-Z0-9.^=\-&]{1,20}$/;

/** What a board that was never edited shows: one list of the user's own. */
export const DEFAULT_TICK_BOARD: TickBoardPrefs = {
  sections: [{ id: "c:mylist", label: "MY LIST", rows: [{ symbol: "IXG" }] }],
  hiddenRows: [],
  hiddenSections: [],
};

export function isCustomSection(id: string): id is CustomTickSectionId {
  return id.startsWith("c:");
}

export function isBuiltinSection(id: string): id is BuiltinTickSection {
  return (BUILTIN_TICK_SECTIONS as readonly string[]).includes(id);
}

export function cleanSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  return SYMBOL_OK.test(s) ? s : null;
}

export function hiddenKey(section: string, rowId: string): string {
  return `${section}|${rowId}`;
}

/** Anything read back from storage, made safe to render. */
export function normalizeTickBoard(value: unknown): TickBoardPrefs {
  if (!value || typeof value !== "object") return DEFAULT_TICK_BOARD;
  const v = value as Partial<TickBoardPrefs>;
  const seen = new Set<string>();
  const sections: TickCustomSection[] = [];
  for (const s of Array.isArray(v.sections) ? v.sections : []) {
    if (!s || typeof s.id !== "string" || !isCustomSection(s.id) || seen.has(s.id)) continue;
    seen.add(s.id);
    const symbols = new Set<string>();
    const rows: TickCustomRow[] = [];
    for (const r of Array.isArray(s.rows) ? s.rows : []) {
      const symbol = typeof r?.symbol === "string" ? cleanSymbol(r.symbol) : null;
      if (!symbol || symbols.has(symbol)) continue;
      symbols.add(symbol);
      const label = typeof r.label === "string" ? r.label.trim().slice(0, 24) : "";
      rows.push(label && label !== symbol ? { symbol, label } : { symbol });
    }
    sections.push({
      id: s.id,
      label: (typeof s.label === "string" ? s.label.trim() : "").slice(0, 24) || "LIST",
      rows: rows.slice(0, MAX_ROWS_PER_SECTION),
    });
  }
  return {
    sections: sections.slice(0, MAX_CUSTOM_SECTIONS),
    hiddenRows: [
      ...new Set(
        (Array.isArray(v.hiddenRows) ? v.hiddenRows : []).filter((x) => typeof x === "string")
      ),
    ],
    hiddenSections: [
      ...new Set(
        (Array.isArray(v.hiddenSections) ? v.hiddenSections : []).filter(isBuiltinSection)
      ),
    ],
  };
}

export function loadTickBoard(): TickBoardPrefs {
  if (typeof window === "undefined") return DEFAULT_TICK_BOARD;
  try {
    const raw = localStorage.getItem(LS_TICK_BOARD);
    return raw ? normalizeTickBoard(JSON.parse(raw)) : DEFAULT_TICK_BOARD;
  } catch {
    return DEFAULT_TICK_BOARD;
  }
}

export function saveTickBoard(prefs: TickBoardPrefs): void {
  try {
    localStorage.setItem(LS_TICK_BOARD, JSON.stringify(prefs));
  } catch {
    /* private mode / quota — the board still works for this session */
  }
}

/** Every custom symbol once, in board order — the quote request. */
export function customSymbols(prefs: TickBoardPrefs): string[] {
  const out: string[] = [];
  for (const s of prefs.sections) {
    for (const r of s.rows) if (!out.includes(r.symbol)) out.push(r.symbol);
  }
  return out;
}

// ── Edits — each returns new prefs, or the same object when nothing changed ──

function mapSection(
  prefs: TickBoardPrefs,
  id: string,
  fn: (s: TickCustomSection) => TickCustomSection
): TickBoardPrefs {
  let changed = false;
  const sections = prefs.sections.map((s) => {
    if (s.id !== id) return s;
    const next = fn(s);
    if (next !== s) changed = true;
    return next;
  });
  return changed ? { ...prefs, sections } : prefs;
}

export function addSection(
  prefs: TickBoardPrefs,
  label: string,
  id: CustomTickSectionId = `c:${Date.now().toString(36)}`
): TickBoardPrefs {
  const name = label.trim().slice(0, 24);
  if (!name || prefs.sections.length >= MAX_CUSTOM_SECTIONS) return prefs;
  if (prefs.sections.some((s) => s.id === id)) return prefs;
  return { ...prefs, sections: [...prefs.sections, { id, label: name.toUpperCase(), rows: [] }] };
}

export function renameSection(prefs: TickBoardPrefs, id: string, label: string): TickBoardPrefs {
  const name = label.trim().slice(0, 24).toUpperCase();
  if (!name) return prefs;
  return mapSection(prefs, id, (s) => (s.label === name ? s : { ...s, label: name }));
}

export function removeSection(prefs: TickBoardPrefs, id: string): TickBoardPrefs {
  if (!prefs.sections.some((s) => s.id === id)) return prefs;
  return { ...prefs, sections: prefs.sections.filter((s) => s.id !== id) };
}

export function addRow(
  prefs: TickBoardPrefs,
  sectionId: string,
  rawSymbol: string,
  label?: string
): TickBoardPrefs {
  const symbol = cleanSymbol(rawSymbol);
  if (!symbol) return prefs;
  return mapSection(prefs, sectionId, (s) => {
    if (s.rows.length >= MAX_ROWS_PER_SECTION || s.rows.some((r) => r.symbol === symbol)) return s;
    const name = label?.trim().slice(0, 24);
    return {
      ...s,
      rows: [...s.rows, name && name !== symbol ? { symbol, label: name } : { symbol }],
    };
  });
}

export function removeRow(
  prefs: TickBoardPrefs,
  sectionId: string,
  symbol: string
): TickBoardPrefs {
  return mapSection(prefs, sectionId, (s) =>
    s.rows.some((r) => r.symbol === symbol)
      ? { ...s, rows: s.rows.filter((r) => r.symbol !== symbol) }
      : s
  );
}

/** Move a row one place up (-1) or down (+1) inside its section. */
export function moveRow(
  prefs: TickBoardPrefs,
  sectionId: string,
  symbol: string,
  delta: -1 | 1
): TickBoardPrefs {
  return mapSection(prefs, sectionId, (s) => {
    const from = s.rows.findIndex((r) => r.symbol === symbol);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= s.rows.length) return s;
    const rows = [...s.rows];
    [rows[from], rows[to]] = [rows[to], rows[from]];
    return { ...s, rows };
  });
}

export function toggleHiddenRow(
  prefs: TickBoardPrefs,
  section: BuiltinTickSection,
  rowId: string
): TickBoardPrefs {
  const key = hiddenKey(section, rowId);
  return {
    ...prefs,
    hiddenRows: prefs.hiddenRows.includes(key)
      ? prefs.hiddenRows.filter((k) => k !== key)
      : [...prefs.hiddenRows, key],
  };
}

export function toggleHiddenSection(
  prefs: TickBoardPrefs,
  section: BuiltinTickSection
): TickBoardPrefs {
  return {
    ...prefs,
    hiddenSections: prefs.hiddenSections.includes(section)
      ? prefs.hiddenSections.filter((s) => s !== section)
      : [...prefs.hiddenSections, section],
  };
}

/** Rows of a built-in section the user has not hidden. */
export function visibleRows<T extends { id: string }>(
  prefs: TickBoardPrefs,
  section: BuiltinTickSection,
  rows: T[]
): T[] {
  if (!prefs.hiddenRows.length) return rows;
  const prefix = `${section}|`;
  const hidden = new Set(
    prefs.hiddenRows.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
  );
  return hidden.size ? rows.filter((r) => !hidden.has(r.id)) : rows;
}

/**
 * Section order: saved positions that still exist, then anything new —
 * built-in sections a release added, custom sections just created.
 */
export function normalizeSectionOrder(value: unknown, prefs: TickBoardPrefs): TickSectionId[] {
  const known: TickSectionId[] = [...BUILTIN_TICK_SECTIONS, ...prefs.sections.map((s) => s.id)];
  const order: TickSectionId[] = [];
  for (const id of Array.isArray(value) ? value : []) {
    if (known.includes(id) && !order.includes(id)) order.push(id);
  }
  return [...order, ...known.filter((id) => !order.includes(id))];
}
