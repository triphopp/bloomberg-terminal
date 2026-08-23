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
   * `horizonDays` forward — the band the GUTTER prices are quoted for.
   *
   * `targetDate` is when that horizon lands. Nothing renders it: the horizon is
   * already named in the caption's sigma segment, and a second pointer to the
   * same fact was noise.
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

/**
 * Which sigma the caption quotes.
 *
 * The horizon figure is what the GRID is drawn at, so it stays the default —
 * the rows only mean anything against it. The daily figure is the one a trader
 * carries around ("this thing moves about 1.3% a day"), and is the honest way to
 * compare two symbols whose snapshots sit at different DTEs.
 */
export const SD_SIGMA_BASES = [
  { value: "horizon", label: "Horizon (matches the grid)" },
  { value: "daily", label: "Daily (per session)" },
  { value: "both", label: "Both" },
] as const;

export const SD_SIGMA_BASIS_DEFAULT = "horizon";

/**
 * Sessions per year, for turning annualised vol into a per-DAY move.
 *
 * 252, not the 365 the pricing uses: `T` is calendar time because an option
 * decays over weekends, but a "daily move" is a move over a SESSION — quoting it
 * per calendar day would understate it by ~17% and describe a day that does not
 * trade.
 */
const SESSIONS_PER_YEAR = 252;

// ── Color scales ──────────────────────────────────────────────────────────────

/**
 * Colour ramp shared by both scales.
 *
 * Two channels move together with magnitude, not one: the hue walks a pale →
 * vivid → deep ramp AND the alpha climbs. Alpha alone (the earlier design) was
 * the problem the pane was hard to read for — every reading rendered as the same
 * hue at a slightly different wash, so a column that was mildly rich and one that
 * was extremely rich looked near-identical and no trend came off the grid.
 *
 * Alpha still does the salience work because it is the only channel that behaves
 * the same in both themes: near-transparent = "nothing here" against a light and
 * a dark pane alike, where a fixed pale colour would mean "loud" on one and
 * "invisible" on the other. The ramp end-points therefore stay mid-lightness —
 * deep enough to read as intense, never so dark they sink into a dark pane.
 *
 * `t` is gamma-compressed (sqrt): most readings cluster low in their range, and a
 * linear ramp spends all its contrast on outliers nobody needs help spotting.
 */
const ALPHA_FLOOR = 0.1;
const ALPHA_CEIL = 0.95;
const GAMMA = 0.5; // sqrt

type Rgb = readonly [number, number, number];

/** Pale → vivid → deep, one ramp per direction of each scale. */
const RAMP_COOL: readonly Rgb[] = [
  [147, 197, 253],
  [59, 130, 246],
  [29, 78, 216],
];
const RAMP_WARM: readonly Rgb[] = [
  [253, 186, 116],
  [249, 115, 22],
  [194, 65, 12],
];
const RAMP_CHEAP: readonly Rgb[] = [
  [134, 239, 172],
  [34, 197, 94],
  [21, 128, 61],
];
const RAMP_RICH: readonly Rgb[] = [
  [252, 165, 165],
  [239, 68, 68],
  [185, 28, 28],
];

/** Position on a multi-stop ramp, `t` in [0,1], returned as an `rgba()` string. */
export function rampColor(stops: readonly Rgb[], t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const eased = clamped ** GAMMA;
  const span = stops.length - 1;
  const pos = eased * span;
  const i = Math.min(span - 1, Math.floor(pos));
  const f = pos - i;
  const [r0, g0, b0] = stops[i];
  const [r1, g1, b1] = stops[i + 1];
  const mix = (a: number, b: number) => Math.round(a + (b - a) * f);
  const alpha = ALPHA_FLOOR + (ALPHA_CEIL - ALPHA_FLOOR) * eased;
  return `rgba(${mix(r0, r1)}, ${mix(g0, g1)}, ${mix(b0, b1)}, ${alpha.toFixed(3)})`;
}

/** Neutral wash for "this is right where it should be". */
const NEUTRAL = "rgba(130, 135, 145, 0.14)";

/**
 * Occupancy: ratio of observed frequency to the normal-distribution reference.
 *
 * A ratio, not a difference, because the reference itself spans 6.7% to 38.3% —
 * a 5-point overshoot is unremarkable in the centre row and a near-doubling in
 * the tails, and the eye should see the latter as the bigger deal.
 *
 * Cool = under-visited, warm = over-visited. The pair is chosen for separation
 * under red-green colour blindness too: blue and amber differ in lightness as
 * well as hue, so the pane still reads if the red/green pair does not.
 */
export function occupancyColor(freq: number, refProb: number): string | null {
  if (refProb <= 0) return null;
  const ratio = freq / refProb;
  if (Math.abs(ratio - 1) < 0.05) return NEUTRAL;
  // Saturates at ~2.2x the expected rate, and at ~0.45x on the way down.
  return ratio > 1
    ? rampColor(RAMP_WARM, (ratio - 1) / 1.2)
    : rampColor(RAMP_COOL, (1 - ratio) / 0.55);
}

/**
 * Cheapness: `P_rv - P_iv`, a probability difference in [-1, 1].
 *
 * Red = IV assigns more mass here than realized vol does, i.e. this row is
 * expensive. Saturates at 6 percentage points — already a wide gap for a single
 * bucket, and low enough that ordinary days land somewhere with visible colour
 * rather than all bunching at the transparent end.
 */
export function cheapnessColor(delta: number): string | null {
  if (Math.abs(delta) < 0.004) return NEUTRAL;
  return delta < 0
    ? rampColor(RAMP_RICH, Math.abs(delta) / 0.06)
    : rampColor(RAMP_CHEAP, delta / 0.06);
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

/**
 * A bucket named by its LOWER edge alone — the compact form of `fmtBand`.
 *
 * Unambiguous without the upper bound because the row above starts exactly where
 * this one ends, and it fits roughly half the width, which is what lets a cell on
 * a dense chart still carry that day's price.
 */
export function fmtEdge(lo: number | null, hi: number | null): string | null {
  if (lo == null && hi == null) return null;
  if (lo == null) return `<${fmtPrice(hi as number)}`;
  return `${fmtPrice(lo)}+`;
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
function rowLabel(
  level: number,
  exceedProb: number | undefined,
  value: string | undefined
): HeatmapRowLabel {
  const sign = level > 0 ? `+${level}` : `${level}`;
  return {
    level: `${sign}σ`,
    odds: exceedProb == null ? undefined : fmtPct(exceedProb),
    value,
    color: levelColor(level, level > 0),
  };
}

/**
 * Per-row current value for the gutter: the price each bucket STARTS at.
 *
 * A lower edge needs no second number to be unambiguous — the next row up begins
 * exactly where this one ends — so it fits the gutter where a full range would
 * not. Taken from `current` (the still-open projection) rather than the last
 * plotted column, because that is the band a reader is deciding against; in
 * occupancy mode the newest column is `horizonDays` old by construction.
 */
function rowValues(payload: SdBandsPayload, rowCount: number): (string | undefined)[] {
  const source = payload.current ?? payload.series[payload.series.length - 1];
  const edges = source?.edges;
  if (edges?.length === rowCount + 1) {
    return Array.from({ length: rowCount }, (_, i) =>
      edges[i] == null ? `<${fmtPrice(edges[i + 1] as number)}` : `${fmtPrice(edges[i] as number)}+`
    );
  }
  const prices = source?.prices;
  if (prices?.length === rowCount) return prices.map(fmtPrice);
  return Array.from({ length: rowCount }, () => undefined);
}

/** Vol quoted the way a chain quotes it: annualised, one decimal. */
function fmtVol(sigma: number): string {
  return `${(sigma * 100).toFixed(1)}%`;
}

/**
 * The header line: how big a sigma actually IS for this symbol.
 *
 * The grid can say where price sat relative to ±1σ but never how much a sigma is
 * worth, and that number is what makes the pane assessable — ±1.2% and ±9% are
 * the same picture here and completely different trades. Quoted twice, because
 * both readings are used: annualised vol (comparable across symbols and against
 * the chain) and the move over THIS horizon in percent and in currency.
 *
 * The currency figure is the linear `S·σ√t`, not the lognormal band edge, so it
 * reads symmetrically; the exact, asymmetric edges are in the gutter and in the
 * cells. Segments are ordered most important first — a narrow pane drops the
 * tail.
 *
 * `basis` picks the span the sigma is quoted over — see `SD_SIGMA_BASES`.
 */
export function buildCaption(
  payload: SdBandsPayload,
  basis: string = SD_SIGMA_BASIS_DEFAULT
): string[] | undefined {
  const source = payload.current ?? payload.series[payload.series.length - 1];
  if (!source || !Number.isFinite(source.sigmaIv) || !(source.T > 0)) return undefined;

  const segments: string[] = [];

  /** One sigma over `label`'s span, in percent and — when spot is known — in currency. */
  const sigmaSegment = (label: string, sigma: number) => {
    const move = Number.isFinite(source.spot) ? ` ≈ ±${fmtPrice(source.spot * sigma)}` : "";
    return `1σ/${label} ±${(sigma * 100).toFixed(sigma < 0.02 ? 2 : 1)}%${move}`;
  };

  const days = Math.max(1, Math.round(source.T * 365));
  const horizon = () => sigmaSegment(`${days}d`, source.sigmaIv * Math.sqrt(source.T));
  const daily = () => sigmaSegment("1d", source.sigmaIv / Math.sqrt(SESSIONS_PER_YEAR));

  // Order matters — a narrow pane keeps the head and drops the tail, so whichever
  // basis was asked for leads.
  if (basis === "daily") segments.push(daily());
  else if (basis === "both") segments.push(horizon(), daily());
  else segments.push(horizon());

  segments.push(`IV ${fmtVol(source.sigmaIv)}`);

  const rv = source.sigmaRv;
  if (rv != null && Number.isFinite(rv) && rv > 0) {
    segments.push(`RV ${fmtVol(rv)}`);
    segments.push(`IV/RV ${(source.sigmaIv / rv).toFixed(2)}`);
  }

  return segments;
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
  rows: HeatmapRowLabel[] = [],
  caption?: string[]
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
      caption,
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
      sigmaBasis: SD_SIGMA_BASIS_DEFAULT,
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

      const rowCount = payload.levels.length;
      const values = rowValues(payload, rowCount);
      const rows = payload.levels.map((level, i) =>
        rowLabel(level, payload.exceedProbs?.[i], values[i])
      );

      // The caption survives an empty grid on purpose: `current` is today's
      // projection, so how big a sigma is for this symbol is known from the very
      // first snapshot — long before there are outcomes to colour a cell with.
      const caption = buildCaption(
        payload,
        (config.sigmaBasis as string) ?? SD_SIGMA_BASIS_DEFAULT
      );

      if (!payload.series?.length) {
        return [emptyOutput(mode, emptyReason(payload), rows, caption)];
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
          // Same price, one number instead of two, for the cells a dense chart
          // leaves too narrow for the full range. Without it a year of daily
          // columns printed nothing at all, which is where the drift of the
          // bands over time is the whole point.
          cellLabelsCompact:
            row.edges?.length === rowCount + 1
              ? Array.from({ length: rowCount }, (_, i) => fmtEdge(row.edges[i], row.edges[i + 1]))
              : row.prices?.length === rowCount
                ? row.prices.map(fmtPrice)
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
          emptyOutput(
            mode,
            `σ-bands cover ${first} … ${last} — outside this timeframe`,
            rows,
            caption
          ),
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
            caption,
          },
        },
      ];
    },
  };

  return indicator;
};
