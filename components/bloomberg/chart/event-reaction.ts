/**
 * Price reaction around a chart event.
 *
 * Everything here is derived from the OHLCV already loaded for the chart — no
 * extra request. That also means the answer is only as long as the visible
 * period: on a 1M window a five-bar drift after a report near the right edge is
 * simply `null` rather than wrong.
 */

import type { ChartEventMarker, EventPriceReaction, OhlcvBar } from "./types";

/** When the report landed relative to the session. */
export type EarningsSession = "BMO" | "AMC" | "UNKNOWN";

/**
 * Yahoo stamps earnings with a time of day. A report released after the close
 * cannot move that day's bar — the reaction shows up on the next one — so the
 * caller needs to know which bar to anchor on.
 */
export function earningsSession(reportedAt?: string): EarningsSession {
  if (!reportedAt) return "UNKNOWN";
  const match = reportedAt.match(/\s(\d{2}):(\d{2})/);
  if (!match) return "UNKNOWN";
  const hour = Number(match[1]);
  if (hour >= 16) return "AMC";
  if (hour > 0 && hour < 12) return "BMO";
  return "UNKNOWN";
}

/**
 * How far before the first loaded bar an event may sit and still be pulled onto
 * it, in days.
 *
 * Enough to cover a long weekend or a holiday that the window happens to open
 * on. Without a cap, forward resolution drags the *entire* history onto bar 0 —
 * a quarterly dividend payer with 20 years of records would stack ~120 events on
 * the first candle of a 3M chart.
 */
const MAX_BACKFILL_DAYS = 4;

/**
 * How far past the last bar an event may sit and still be shown as upcoming.
 *
 * Yahoo's earnings calendar carries estimates a year out for some names; a chip
 * for a report that far away tells the reader nothing about the chart in front
 * of them, so the rail stops at roughly two quarters.
 */
const MAX_FUTURE_DAYS = 200;

const dayDiff = (fromIso: string, toIso: string): number =>
  (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000;

/**
 * Index of the bar an event falls on, or -1 when it is outside the loaded range.
 *
 * Events land on non-trading days often enough (a dividend ex-date on a market
 * holiday, an AMC report on a Friday) that an exact key lookup drops real
 * events, so this resolves forward to the first bar at or after the event —
 * which is also the bar that actually prices the news. The resolution is capped
 * at `MAX_BACKFILL_DAYS` before the window opens so that pre-history events are
 * dropped instead of piling onto the first bar.
 */
export function findEventBarIndex(data: OhlcvBar[], marker: ChartEventMarker): number {
  if (data.length === 0) return -1;
  const isIntraday = typeof data[0].time === "number";

  if (isIntraday) {
    const target =
      typeof marker.time === "number"
        ? marker.time
        : Math.floor(new Date(`${marker.time}T00:00:00`).getTime() / 1000);
    let best = -1;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let i = 0; i < data.length; i++) {
      const diff = Math.abs((data[i].time as number) - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    // Beyond a day away the "nearest" bar is not the same event any more.
    return bestDiff <= 86_400 ? best : -1;
  }

  const target = typeof marker.time === "string" ? marker.time.slice(0, 10) : String(marker.time);
  const first = String(data[0].time);
  if (target < first && dayDiff(target, first) > MAX_BACKFILL_DAYS) return -1;

  for (let i = 0; i < data.length; i++) {
    if (String(data[i].time) >= target) return i;
  }
  return -1;
}

/** A marker resolved onto a real bar, so the time scale can place it. */
export interface PlacedEvent {
  marker: ChartEventMarker;
  /** Bar time the event is drawn at — always a time present in `data`. */
  time: string | number;
  /** Index of that bar in `data`. */
  barIdx: number;
  /**
   * The event has not happened yet, so `time`/`barIdx` are the last bar as an
   * anchor only — the rail draws it past the right edge, and there is no price
   * reaction to measure.
   */
  future?: boolean;
  /** Days from the last bar to the event. Only set when `future`. */
  daysAhead?: number;
}

/**
 * Snap markers onto bars that exist in the series, dropping the ones that fall
 * outside it.
 *
 * Lives next to `findEventBarIndex` rather than in the rail overlay so there is
 * exactly one placement rule: the chip on the rail and the price reaction in the
 * detail card have to agree on which bar an event belongs to, or the card
 * describes a different bar than the chip sits over.
 */
export function placeEvents(markers: ChartEventMarker[], data: OhlcvBar[]): PlacedEvent[] {
  if (data.length === 0) return [];
  const placed: PlacedEvent[] = [];
  const lastIdx = data.length - 1;

  for (const marker of markers) {
    const barIdx = findEventBarIndex(data, marker);
    if (barIdx >= 0) {
      placed.push({ marker, time: data[barIdx].time, barIdx });
      continue;
    }
    // No bar matched. That is either pre-history (dropped) or a date the market
    // has not reached yet — a declared ex-dividend, a scheduled report. Those
    // used to fall out here, which is why the rail only ever showed the *last*
    // dividend and never the next one.
    const ahead = daysPastLastBar(data, marker);
    if (ahead > 0 && ahead <= MAX_FUTURE_DAYS) {
      placed.push({
        marker,
        time: data[lastIdx].time,
        barIdx: lastIdx,
        future: true,
        daysAhead: ahead,
      });
    }
  }

  // Future chips are drawn in a queue past the right edge, so they have to come
  // out in date order regardless of the order the markers arrived in.
  placed.sort((a, b) => (a.daysAhead ?? 0) - (b.daysAhead ?? 0));
  return placed;
}

/**
 * Whole days between the last loaded bar and the event, or 0 when the event is
 * not after it.
 */
export function daysPastLastBar(data: OhlcvBar[], marker: ChartEventMarker): number {
  if (data.length === 0) return 0;
  const last = data[data.length - 1].time;

  if (typeof last === "number") {
    const target =
      typeof marker.time === "number"
        ? marker.time
        : Math.floor(new Date(`${String(marker.time).slice(0, 10)}T00:00:00`).getTime() / 1000);
    const diff = target - last;
    return diff > 0 ? Math.ceil(diff / 86_400) : 0;
  }

  const target = typeof marker.time === "string" ? marker.time.slice(0, 10) : String(marker.time);
  const lastStr = String(last).slice(0, 10);
  if (target <= lastStr) return 0;
  return Math.round(dayDiff(lastStr, target));
}

const pct = (value: number, base: number): number | null =>
  base > 0 ? (value / base - 1) * 100 : null;

/**
 * Reaction measured from the close *before* the market could react.
 *
 * For an after-close report that baseline is the report day's own close and the
 * move lands on the following bar, so the whole window shifts one bar right.
 */
export function computeEventReaction(
  data: OhlcvBar[],
  marker: ChartEventMarker
): EventPriceReaction {
  const empty: EventPriceReaction = {
    gapPct: null,
    sameDayPct: null,
    nextDayPct: null,
    fiveDayPct: null,
    closeOnEvent: null,
  };

  const eventIdx = findEventBarIndex(data, marker);
  if (eventIdx < 0) return empty;

  const closeOnEvent = data[eventIdx].close;

  // The bar that prices the news, and the last close before it was known.
  const session = marker.type === "earnings" ? earningsSession(marker.reportedAt) : "UNKNOWN";
  const reactIdx = session === "AMC" ? eventIdx + 1 : eventIdx;
  const baseIdx = reactIdx - 1;
  if (baseIdx < 0 || reactIdx >= data.length) return { ...empty, closeOnEvent };

  const base = data[baseIdx].close;
  const at = (offset: number): number | null => {
    const bar = data[reactIdx + offset];
    return bar ? pct(bar.close, base) : null;
  };

  return {
    gapPct: pct(data[reactIdx].open, base),
    sameDayPct: at(0),
    nextDayPct: at(1),
    fiveDayPct: at(5),
    closeOnEvent,
  };
}
