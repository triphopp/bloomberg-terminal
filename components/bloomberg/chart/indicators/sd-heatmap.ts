/**
 * IV SD Heatmap — pane indicator.
 *
 * Five rows, −2σ at the bottom to +2σ at the top, showing where the
 * Black-Scholes lognormal distribution implied by the ATM options puts the
 * price. Sigma is the mid of the ATM call and put implied vols,
 * `σ_mid = (IV_call + IV_put)/2`, and the distribution is
 *
 *     ln(S_T/S_0) ~ N((r − q − σ²/2)T, σ²T)
 *
 * so row 0 is the lognormal MEDIAN — below the forward by `exp(σ²T/2)`.
 *
 * The rows are buckets in z (each sd level ±0.5σ, the outer two open-ended), not
 * points: a continuous distribution assigns zero probability to any single
 * price. Those bucket probabilities are constants — 6.7 / 24.2 / 38.3 / 24.2 /
 * 6.7 percent — so they are NOT what the colors show; they are the reference the
 * colors are measured against, printed in the row labels.
 *
 * Two modes for the cell values, both computed backend-side
 * (`/api/options/{symbol}/sd-bands`):
 *
 *   occupancy — how often price actually landed in each row over the trailing
 *               window, against the band projected `horizonDays` earlier. Warm =
 *               visited more than the normal distribution says, cool = less. The
 *               outlined cell is where the latest observation landed.
 *   cheapness — `P_rv − P_iv` on the same price edges. Red tails = IV is pricing
 *               more tail mass than realized vol delivers (positive variance
 *               premium); green tails = the opposite.
 *
 * Data is NOT computed from OHLCV — it is pre-fetched and injected into
 * `config.preloadedData` by the parent view via `updateIndicatorConfig()`, the
 * same arrangement fear-greed uses.
 */

import type {
  ChartIndicator,
  HeatmapColumn,
  HeatmapRail,
  HeatmapRowLabel,
  IndicatorFactory,
  IndicatorSeriesOutput,
  OhlcvBar,
} from "../types";

// ── Payload shape (mirrors backend/routers/options.py::get_sd_bands) ─────────

export interface SdBandRow {
  time: string;
  anchorTime?: string;
  spot: number;
  terminal?: number;
  sigmaIv: number;
  sigmaRv: number | null;
  dteAtSnapshot: number;
  T: number;
  prices: number[];
  edges: (number | null)[];
  cells: number[] | null;
  hitRow: number | null;
  hitZ: number | null;
  rvProbs?: number[];
  sampleSize?: number;
}

export interface SdBandsPayload {
  symbol: string;
  mode: "occupancy" | "cheapness";
  horizonDays: number;
  levels: number[];
  refProbs: number[];
  /** P(S_T >= the price at each sd level) — 97.7/84.1/50/15.9/2.3%. */
  exceedProbs?: number[];
  snapshotCount: number;
  /**
   * Snapshots on file BEFORE the front-week filter, present only when that
   * filter is why `snapshotCount` is 0. Distinguishes "nothing recorded" from
   * "everything recorded is unusable" — different problems, different fixes.
   */
  rawSnapshotCount?: number;
  series: SdBandRow[];
  /**
   * The still-open projection from the newest snapshot: today's band looking
   * `horizonDays` forward. `targetDate` is when that horizon lands, which is what
   * the rail's prices and odds are quoted for.
   */
  current: (Omit<SdBandRow, "cells" | "hitRow" | "hitZ"> & { targetDate?: string | null }) | null;
  note?: string;
}

/**
 * Cheapness is listed (and defaulted) first for a data reason, not a preference:
 * it scores today's IV against realized vol taken from the PRICE history, so it
 * produces a column from the very first snapshot. Occupancy needs outcomes, which
 * means `horizonDays` of waiting before it can draw anything at all.
 */
export const SD_HEATMAP_MODES = [
  { value: "cheapness", label: "Cheapness (IV vs RV)" },
  { value: "occupancy", label: "Occupancy (realized)" },
] as const;

export const SD_HEATMAP_DEFAULT_MODE = "cheapness";

// ── Color scales ──────────────────────────────────────────────────────────────

/**
 * Intensity ramp shared by both scales.
 *
 * `sqrt` rather than linear: most readings cluster near the middle of their
 * range, and a linear ramp leaves them all looking equally washed out while
 * spending its contrast on outliers nobody needs help spotting.
 *
 * The floor is genuinely transparent — a value at the reference should look like
 * nothing, not like a faint wash — and the ceiling stops well short of opaque so
 * the number printed inside the cell stays legible against it.
 */
const ALPHA_FLOOR = 0.06;
const ALPHA_CEIL = 0.72;

function intensity(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return ALPHA_FLOOR + (ALPHA_CEIL - ALPHA_FLOOR) * Math.sqrt(clamped);
}

/** Neutral wash for "this is right where it should be". */
const NEUTRAL = "rgba(120,120,130,0.05)";

//: Cool = under-visited / cheap, warm = over-visited / expensive. Chosen for
//: separation under both themes and for red-green colour blindness: the blue and
//: the amber differ in lightness as well as hue, so the pane still reads if the
//: red/green pair does not.
const COOL = "37, 99, 235"; // blue
const WARM = "234, 88, 12"; // amber-red
const CHEAP = "22, 163, 74"; // green
const RICH = "220, 38, 38"; // red

/**
 * Occupancy: ratio of observed frequency to the normal-distribution reference.
 *
 * A ratio, not a difference, because the reference itself spans 6.7% to 38.3% —
 * a 5-point overshoot is unremarkable in the centre row and a near-doubling in
 * the tails, and the eye should see the latter as the bigger deal.
 */
export function occupancyColor(freq: number, refProb: number): string | null {
  if (refProb <= 0) return null;
  const ratio = freq / refProb;
  if (Math.abs(ratio - 1) < 0.05) return NEUTRAL;
  // Saturates at 2.5× the expected rate, and at 0.4× on the way down.
  return ratio > 1
    ? `rgba(${WARM}, ${intensity((ratio - 1) / 1.5)})`
    : `rgba(${COOL}, ${intensity((1 - ratio) / 0.6)})`;
}

/**
 * Cheapness: `P_rv − P_iv`, a probability difference in [−1, 1].
 *
 * Red = IV assigns more mass here than realized vol does, i.e. this row is
 * expensive. Saturates at 8 percentage points, already a wide gap for one bucket.
 */
export function cheapnessColor(delta: number): string | null {
  if (Math.abs(delta) < 0.004) return NEUTRAL;
  const a = intensity(Math.abs(delta) / 0.08);
  return delta < 0 ? `rgba(${RICH}, ${a})` : `rgba(${CHEAP}, ${a})`;
}

function fmtPct(p: number): string {
  const pct = p * 100;
  return pct >= 10 ? `${pct.toFixed(0)}%` : `${pct.toFixed(1)}%`;
}

/**
 * The price RANGE a row covers, from its two bucket edges.
 *
 * A row is a bucket, not a point, so labelling it with the single price at its
 * centre was ambiguous: the +1σ cell read "554" while the row it names actually
 * spans 513–599, and nothing on screen said so. The outer rows are open-ended
 * and are shown as such rather than being given a fake bound.
 *
 * `edges` carries `null` at the two open ends (JSON has no infinity).
 */
export function fmtBand(lo: number | null, hi: number | null): string | null {
  if (lo == null && hi == null) return null;
  if (lo == null) return `<${fmtPrice(hi as number)}`;
  if (hi == null) return `>${fmtPrice(lo)}`;
  return `${fmtPrice(lo)}-${fmtPrice(hi)}`;
}

/** Tint for the sigma level itself: upside rows warm, downside cool. */
function levelColor(level: number, isUpside: boolean): string | undefined {
  if (level === 0) return undefined;
  return isUpside ? "rgba(240, 170, 120, 0.95)" : "rgba(150, 190, 245, 0.95)";
}

/**
 * One gutter entry: the sigma level, and beside it the odds of that outcome.
 *
 * The odds shown are `exceedProbs` — "price finishes at or above this line" —
 * not the bucket probability. That is the question the level itself poses: a
 * reader looking at the +1σ row wants the chance of GETTING there, and the
 * chance of finishing exactly within that band is a different, less actionable
 * number. Bucket probability stays available in the payload for anyone
 * comparing occupancy against its reference.
 */
function rowLabel(level: number, exceedProb: number | undefined): HeatmapRowLabel {
  const sign = level > 0 ? `+${level}` : `${level}`;
  return {
    level: `${sign}σ`,
    odds: exceedProb == null ? undefined : fmtPct(exceedProb),
    color: levelColor(level, level > 0),
  };
}

/** Normalise a bar time to YYYY-MM-DD for matching against daily payload rows. */
function barDate(time: string | number): string {
  return typeof time === "number"
    ? new Date(time * 1000).toISOString().slice(0, 10)
    : time.slice(0, 10);
}

// ── Empty states ──────────────────────────────────────────────────────────────

/**
 * Why the pane has nothing in it, in one line the user can act on.
 *
 * This indicator is empty by design on a symbol nobody has opened the options
 * chain for: Yahoo publishes only the CURRENT implied vol of a chain, so there is
 * no IV history to back-fill and the series has to be accumulated a day at a
 * time. That is worth saying out loud — otherwise the first impression of a
 * working feature is a blank box.
 */
export function emptyReason(payload: SdBandsPayload): string {
  const n = payload.snapshotCount ?? 0;
  if (n === 0) {
    // Rows exist but every one is inside the front week. Telling this user to
    // "open the OPTIONS tab" would be telling them to repeat what produced these
    // unusable rows in the first place — a chain viewed on an expiry week stores
    // a 0–4 DTE contract, whose ATM IV is pin risk rather than a 30-day view.
    const raw = payload.rawSnapshotCount ?? 0;
    if (raw > 0) {
      return `${raw} IV snapshot${raw === 1 ? "" : "s"} on file but all under 7 DTE (excluded) — recording a ~${payload.horizonDays ?? 30}-day expiry`;
    }
    return "No IV snapshots yet — recording one now (symbols without options never fill)";
  }
  // Cheapness scores today's IV against realized vol from the PRICE history, so
  // it works off a single snapshot. Occupancy has to wait for outcomes. Pointing
  // at the mode that already has what it needs beats "come back in a month".
  const need =
    payload.mode === "cheapness"
      ? "realized vol needs ~21 more sessions"
      : `outcomes need ~${payload.horizonDays ?? 30} more days — try CHEAPNESS mode meanwhile`;
  return `${n} IV snapshot${n === 1 ? "" : "s"} recorded — ${need}`;
}

/** A heatmap output that paints only `message`, keeping the row labels if known. */
function emptyOutput(
  mode: string,
  message: string,
  rows: HeatmapRowLabel[] = []
): IndicatorSeriesOutput {
  return {
    id: "sd-heatmap",
    label: mode === "cheapness" ? "SD Cheapness" : "SD Occupancy",
    type: "heatmap",
    data: [],
    heatmap: {
      rows,
      columns: [],
      colorScale: () => null,
      emptyMessage: message,
    },
  };
}

/**
 * Price with a sensible number of digits for its magnitude.
 *
 * A σ-band spans names priced from a few dollars to four figures, and a fixed
 * precision is wrong at one end or the other: 2 decimals on a 4-digit index is
 * noise that will not fit the cell, none on a $3 stock loses the band entirely.
 */
function fmtPrice(price: number): string {
  if (!Number.isFinite(price)) return "";
  if (price >= 1000) return price.toFixed(0);
  if (price >= 100) return price.toFixed(1);
  if (price >= 10) return price.toFixed(2);
  return price.toFixed(3);
}

/**
 * The right-edge strip: what price each sigma sits at, and the odds of getting
 * there, taken from the most recent projection available.
 *
 * `current` is preferred over the last plotted column because it is the OPEN
 * projection — the band from today's IV looking `horizonDays` forward, which is
 * the one a reader is actually deciding against. In occupancy mode the last
 * column is by construction `horizonDays` old.
 */
function buildRail(payload: SdBandsPayload): HeatmapRail | undefined {
  const source = payload.current ?? payload.series[payload.series.length - 1];
  const prices = source?.prices;
  if (!prices?.length) return undefined;

  const edges = source?.edges;
  const exceed = payload.exceedProbs ?? [];
  const asOf = payload.current?.targetDate ?? source?.time ?? "";

  // Bucket LOWER edges, not centre prices: an edge is unambiguous on its own
  // (the next row starts exactly where this one ends), and the rail is too
  // narrow for a full range. Falls back to centres if edges are missing.
  const rows =
    edges?.length === prices.length + 1
      ? prices.map((p, i) =>
          edges[i] == null
            ? `<${fmtPrice(edges[i + 1] as number)}`
            : `${fmtPrice(edges[i] as number)}+`
        )
      : prices.map(fmtPrice);

  return {
    rows,
    subRows: prices.map((_, i) => (exceed[i] == null ? null : `≥ ${fmtPct(exceed[i])}`)),
    title: asOf ? `→ ${asOf.slice(5)}` : undefined,
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

export const createSdHeatmap: IndicatorFactory = (overrides = {}) => {
  const indicator: ChartIndicator = {
    id: "sd-heatmap",
    name: "IV SD Heatmap",
    category: "volatility",
    type: "pane",
    description:
      "Black-Scholes σ-bands from ATM IV mid — five buckets (−2σ…+2σ) coloured by realized occupancy or IV-vs-RV cheapness",
    minBars: 1,
    params: [],
    config: {
      mode: SD_HEATMAP_DEFAULT_MODE,
      horizonDays: 30,
      rvWindow: 21,
      occWindow: 63,
      preloadedData: null,
      ...overrides,
    },

    compute(data: OhlcvBar[], config): IndicatorSeriesOutput[] {
      const payload = config.preloadedData as SdBandsPayload | null | undefined;
      const mode = (config.mode as string) ?? SD_HEATMAP_DEFAULT_MODE;

      // Empty states return an output rather than `[]`. Returning nothing leaves
      // the pane present but blank, which reads as a broken indicator — and this
      // one is EXPECTED to be empty at first, because the IV history it needs can
      // only be accumulated a day at a time.
      if (!payload || !payload.levels?.length) {
        return [
          emptyOutput(
            mode,
            payload === null || payload === undefined ? "Loading σ-bands…" : "No σ-band data"
          ),
        ];
      }

      const rows = payload.levels.map((level, i) => rowLabel(level, payload.exceedProbs?.[i]));
      const rowCount = rows.length;

      if (!payload.series?.length) {
        return [emptyOutput(mode, emptyReason(payload), rows)];
      }

      // Payload rows are daily; the chart may be on any interval. Matching by
      // date (rather than by index) is what keeps the columns under the right
      // candles when the IV history is sparser than the price history.
      const byDate = new Map<string, SdBandRow>();
      for (const row of payload.series) {
        if (row.cells?.length === rowCount) byDate.set(row.time.slice(0, 10), row);
      }

      const columns: HeatmapColumn[] = [];
      const seen = new Set<string>();
      for (const bar of data) {
        const key = barDate(bar.time);
        if (seen.has(key)) continue; // intraday: one column per day, on its first bar
        const row = byDate.get(key);
        if (!row?.cells) continue;
        seen.add(key);
        columns.push({
          time: bar.time,
          values: row.cells,
          markRow: row.hitRow,
          // COLOURED by the mode value, LABELLED with the price band the row
          // actually covers. A single centre price was ambiguous — it named a
          // point for a cell that means a range.
          cellLabels:
            row.edges?.length === rowCount + 1
              ? Array.from({ length: rowCount }, (_, i) => fmtBand(row.edges[i], row.edges[i + 1]))
              : undefined,
        });
      }

      if (columns.length === 0) {
        // Rows exist, so the payload is fine — the columns just fall outside the
        // period on screen. Naming the range the data covers is the actionable
        // part: the fix is to change the timeframe, not to wait for more data.
        const first = payload.series[0]?.time?.slice(0, 10) ?? "?";
        const last = payload.series[payload.series.length - 1]?.time?.slice(0, 10) ?? "?";
        return [
          emptyOutput(mode, `σ-bands cover ${first} … ${last} — outside this timeframe`, rows),
        ];
      }

      const isOccupancy = payload.mode !== "cheapness";
      const refProbs = payload.refProbs ?? [];

      return [
        {
          id: "sd-heatmap",
          label: isOccupancy ? "SD Occupancy" : "SD Cheapness",
          type: "heatmap",
          data: [],
          heatmap: {
            rows,
            columns,
            colorScale: (value, rowIndex) =>
              isOccupancy ? occupancyColor(value, refProbs[rowIndex] ?? 0) : cheapnessColor(value),
            formatValue: (value) =>
              isOccupancy ? `${(value * 100).toFixed(0)}%` : `${(value * 100).toFixed(1)}`,
            rail: buildRail(payload),
          },
        },
      ];
    },
  };

  return indicator;
};
