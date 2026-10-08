/**
 * Time and sales for STRUCTURE → DEPTH: the prints of the symbol on the chart,
 * newest first. Pure — the hook feeds it what the request and the stream bring.
 *
 * Two feeds overlap: the request hands over the last trades at once, the stream
 * then prints new ones — and after a reconnect prints some again. A print has
 * no id, so two with the same time, price, size and side are told apart only by
 * how many of them each feed holds (`mergeTape`).
 */

export interface Trade {
  /** When it traded, ms since the epoch. */
  t: number;
  price: number;
  size: number;
  /** B = the buyer lifted the offer · S = the seller hit the bid · N = neither. */
  side: "B" | "S" | "N";
  session?: string | null;
  /**
   * Given by `mergeTape` when the print enters the tape, and kept: the row's
   * identity on screen. Without it a row can only be keyed by its position,
   * and every new print then rebuilds every row below it (measured 2026-10-08:
   * ~1,700 DOM nodes created and destroyed a second on a busy stock).
   */
  id?: number;
}

export interface TapeTotals {
  buy: number;
  sell: number;
  neutral: number;
  /** buy − sell: who has been the aggressor over the prints held. */
  delta: number;
  /** Earliest print counted — the totals are since then, not since the open. */
  since: number | null;
  count: number;
}

export const TAPE_ROWS = 300;

const key = (x: Trade) => `${x.t}|${x.price}|${x.size}|${x.side}`;

let nextId = 1;

/**
 * `held` with `incoming` added, newest first, at most `max`. Prints already
 * held are not added twice; equal prints are kept as many times as the feed
 * that has most of them.
 */
export function mergeTape(held: Trade[], incoming: Trade[], max = TAPE_ROWS): Trade[] {
  if (!incoming.length) return held;
  const have = new Map<string, number>();
  for (const x of held) have.set(key(x), (have.get(key(x)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const fresh: Trade[] = [];
  for (const x of incoming) {
    const k = key(x);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > (have.get(k) ?? 0)) fresh.push({ ...x, id: nextId++ });
  }
  if (!fresh.length) return held;
  // Stable: equal times keep the order they arrived in, newest feed first.
  const out = [...fresh.reverse(), ...held].sort((a, b) => b.t - a.t);
  return out.length > max ? out.slice(0, max) : out;
}

export function tapeTotals(tape: Trade[]): TapeTotals {
  let buy = 0;
  let sell = 0;
  let neutral = 0;
  let since: number | null = null;
  for (const x of tape) {
    if (x.side === "B") buy += x.size;
    else if (x.side === "S") sell += x.size;
    else neutral += x.size;
    if (since == null || x.t < since) since = x.t;
  }
  return { buy, sell, neutral, delta: buy - sell, since, count: tape.length };
}
