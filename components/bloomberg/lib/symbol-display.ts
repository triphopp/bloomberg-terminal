/**
 * symbol-display — the ONE place that decides how a symbol/name is shown.
 *
 * Backend (/api/stock/search) already emits display_symbol / display_name;
 * these helpers prefer those fields and fall back to computing the same
 * normalisation client-side, so every consumer (global search, MKT
 * SYMBOL <GO>, EQUITY search, watchlists…) renders identically even for
 * cached or legacy responses that lack the fields.
 *
 * Rules:
 *   BH.BK               → BH            (hide known exchange suffixes)
 *   BH_BUMRUNGRAD HOSP  → BUMRUNGRAD…   (strip duplicated ticker prefix)
 *
 * Never feed the display symbol back into an API call — quote/history/pin
 * paths must keep the real provider symbol (BH.BK).
 */

export interface SymbolLike {
  symbol: string;
  shortname?: string;
  longname?: string;
  display_symbol?: string;
  display_name?: string;
}

// Suffixes hidden from display. Extend here — nowhere else.
const HIDDEN_SUFFIXES = [".BK"];

export function displaySymbol(item: SymbolLike): string {
  if (item.display_symbol) return item.display_symbol;
  const sym = item.symbol ?? "";
  const upper = sym.toUpperCase();
  for (const suf of HIDDEN_SUFFIXES) {
    if (upper.endsWith(suf)) return sym.slice(0, -suf.length);
  }
  return sym;
}

export function displayName(item: SymbolLike): string {
  if (item.display_name) return item.display_name;
  const name = item.shortname || item.longname || "";
  const base = (item.symbol ?? "").split(".")[0].toUpperCase();
  if (base && name.toUpperCase().startsWith(`${base}_`)) {
    return name.slice(base.length + 1).trim();
  }
  return name;
}
