/**
 * When may a REST poll slow down because the quote stream carries its symbols?
 * Pure — `hooks/useQuoteStream.ts` owns the live state and calls in here.
 */

/** A symbol counts as carried by the stream only if it ticked this recently. */
export const STREAM_TICK_FRESH_MS = 120_000;
/** REST cadence while the stream carries every open symbol of a query. */
export const STREAM_BACKOFF_MS = 300_000;
/**
 * REST cadence while none of a query's symbols is open. Shorter than the
 * stream backoff: "closed" comes from the last REST answer, so this bounds how
 * late an opening market is noticed for a symbol the stream does not carry.
 */
export const QUIET_BACKOFF_MS = 120_000;

/** How far a query's REST poll may back off: stream carries it, nothing open, or neither. */
export type Cadence = "streamed" | "quiet" | null;

export interface StreamCoverage {
  /** Backend's Yahoo socket(s) up — from `event: coverage`. */
  connected: boolean;
  /** Symbols refused a stream slot (process budget full). */
  denied: ReadonlySet<string>;
}

/** Yahoo `marketState` values in which a symbol trades (and so should tick). */
export function isOpenMarketState(state: string | null | undefined): boolean {
  return state === "REGULAR" || state === "PRE" || state === "POST";
}

/**
 * Symbols of `rows` that should be ticking: open market, or state unknown
 * (conservative — an unknown row keeps the poll at its base cadence).
 */
export function openSymbolsOf(
  rows: readonly { symbol?: string | null; marketState?: string | null }[]
): string[] {
  return rows
    .filter((r) => r.symbol && (r.marketState == null || isOpenMarketState(r.marketState)))
    .map((r) => r.symbol as string);
}

/** Canonical key for a symbol set: upper-cased, unique, sorted, comma-joined. */
export function symbolKey(symbols: readonly string[]): string {
  return [...new Set(symbols.filter(Boolean).map((s) => s.toUpperCase()))].sort().join(",");
}

/**
 * "quiet" when nothing in `key` is open (per the caller's REST data) — no
 * stream needed for that. "streamed" when the stream is open + connected and
 * every symbol holds a slot and ticked within `STREAM_TICK_FRESH_MS`.
 * Otherwise null: poll at the base cadence.
 */
export function streamCadence(
  key: string,
  coverage: StreamCoverage | null,
  streamOpen: boolean,
  lastTickAt: ReadonlyMap<string, number>,
  now: number
): Cadence {
  if (!key) return "quiet";
  if (!streamOpen || !coverage?.connected) return null;
  for (const s of key.split(",")) {
    if (coverage.denied.has(s)) return null;
    const t = lastTickAt.get(s);
    if (t === undefined || now - t > STREAM_TICK_FRESH_MS) return null;
  }
  return "streamed";
}

/** The poll interval for a query: backs off, never speeds up; `false` stays off. */
export function pollInterval(base: number | false, cadence: Cadence): number | false {
  if (base === false) return false;
  if (cadence === "streamed") return Math.max(base, STREAM_BACKOFF_MS);
  if (cadence === "quiet") return Math.max(base, QUIET_BACKOFF_MS);
  return base;
}
