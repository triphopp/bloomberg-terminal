/**
 * symbol-display — the ONE place that decides how a symbol/name is shown.
 *
 * Backend (/api/stock/search, /api/stock/quote) already emits the display
 * fields (`backend/symbol_names.py`); these helpers prefer those fields and
 * fall back to computing the same normalisation client-side, so every consumer
 * (global search, MKT SYMBOL <GO>, EQUITY search, watchlists…) renders
 * identically even for cached or legacy responses that lack the fields.
 *
 * Rules (same cases pinned in lib/__tests__/symbol-display.test.ts and
 * backend/tests/test_symbol_names.py):
 *   ^MOVE               → MOVE          (index caret)
 *   BH.BK / ^SET.BK     → BH / SET      (hide known exchange suffixes)
 *   BH_BUMRUNGRAD HOSP  → BUMRUNGRAD…   (strip duplicated ticker prefix)
 *   ^MOVE "Northern Trust iBoxx…" → "ICE BofA MOVE Index" (Yahoo mislabel)
 *
 * Never feed the display symbol back into an API call — quote/history/pin
 * paths must keep the real provider symbol (BH.BK, ^MOVE).
 */

export interface SymbolLike {
  symbol: string;
  shortname?: string;
  longname?: string;
  display_symbol?: string;
  display_name?: string;
}

// Suffixes hidden from display. Extend here and in backend/symbol_names.py.
const HIDDEN_SUFFIXES = [".BK"];

// Provider symbol → its real name, where Yahoo's is wrong. Mirror of NAME_FIXES.
const NAME_FIXES: Record<string, string> = {
  "^MOVE": "ICE BofA MOVE Index",
};

export function displaySymbol(item: SymbolLike): string {
  if (item.display_symbol) return item.display_symbol;
  let sym = item.symbol ?? "";
  if (sym.startsWith("^")) sym = sym.slice(1);
  const upper = sym.toUpperCase();
  for (const suf of HIDDEN_SUFFIXES) {
    if (upper.endsWith(suf)) return sym.slice(0, -suf.length);
  }
  return sym;
}

export function displayName(item: SymbolLike): string {
  if (item.display_name) return item.display_name;
  const symbol = item.symbol ?? "";
  const name = (NAME_FIXES[symbol.toUpperCase()] ?? (item.shortname || item.longname || "")).trim();
  const base = symbol.replace(/^\^/, "").split(".")[0].toUpperCase();
  if (base && name.toUpperCase().startsWith(`${base}_`)) {
    return name.slice(base.length + 1).trim();
  }
  return name;
}
