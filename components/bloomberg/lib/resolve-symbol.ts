/**
 * Typed ticker → the symbol Yahoo knows (`CPALL` → `CPALL.BK`).
 *
 * Every place that takes a symbol the user typed and did NOT pick from a
 * search list (MKT SYMBOL <GO>, global search Enter before results arrive,
 * terminal commands) goes through here. Only bare tickers ask the backend;
 * anything with a suffix/prefix (PTT.BK, ^GSPC, EURUSD=X, BRK-B) is taken as
 * meant. Answers are kept for the session. On any failure the input comes
 * back unchanged — resolving must never block opening a symbol.
 */

const BARE = /^[A-Z0-9]{1,8}$/;
const resolved = new Map<string, string>();

export async function resolveSymbol(raw: string, signal?: AbortSignal): Promise<string> {
  const sym = raw.trim().toUpperCase();
  if (!BARE.test(sym)) return sym;
  const hit = resolved.get(sym);
  if (hit) return hit;
  try {
    const res = await fetch(`/api/stock?type=resolve&symbol=${encodeURIComponent(sym)}`, {
      signal,
    });
    if (!res.ok) return sym;
    const data = (await res.json()) as { symbol?: string };
    const out = typeof data?.symbol === "string" && data.symbol ? data.symbol : sym;
    resolved.set(sym, out);
    return out;
  } catch {
    return sym;
  }
}
