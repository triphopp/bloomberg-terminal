/**
 * One indicator ⇄ the series it owns on the chart.
 *
 * Lives outside ModularChart.tsx so the same code the chart runs on every tick
 * can be driven by a test and by the benchmark (`npm run bench:chart`) without
 * a canvas: a series here is anything with `setData` and `update`.
 *
 * Two kinds of indicator come through:
 *   - columnar (`indicator.columns`) — typed columns in, and only the points
 *     that have to be sent are built (series-data.ts `setSeriesColumns`);
 *   - everything else — `compute()` builds every point and they are compared
 *     with the last push (`setSeriesData`), exactly as before.
 */

import { type BarsDelta, barColumns } from "./columns.ts";
import { isCausal } from "./series-columns.ts";
import { type SeriesLike, setSeriesColumns, setSeriesData } from "./series-data.ts";
import type {
  ChartIndicator,
  IndicatorSeriesOutput,
  OhlcvBar,
  PointLabel,
  SeriesColumns,
} from "./types";

export type SeriesOutput = IndicatorSeriesOutput | SeriesColumns;

export function isColumns(output: SeriesOutput): output is SeriesColumns {
  return "values" in output;
}

/** What the indicator draws on these bars — columns when it has them, built points otherwise. */
export function indicatorOutputs(indicator: ChartIndicator, bars: OhlcvBar[]): SeriesOutput[] {
  return indicator.columns
    ? indicator.columns(barColumns(bars), indicator.config)
    : indicator.compute(bars, indicator.config);
}

/**
 * Whether the outputs draw anything at all. A pane for an indicator that draws
 * nothing is an empty band across the chart — Volume on an index (^MOVE, ^VIX)
 * whose every bar has no volume. A heatmap counts as drawn: its pane carries
 * the "why am I empty" message.
 */
export function outputsDrawAnything(outputs: SeriesOutput[]): boolean {
  for (const output of outputs) {
    if (isColumns(output)) {
      for (let i = output.from; i < output.values.length; i++) {
        if (Number.isFinite(output.values[i])) return true;
      }
    } else if (output.type === "heatmap") {
      if (output.heatmap) return true;
    } else {
      for (const point of output.data) {
        if ("value" in point && Number.isFinite(point.value)) return true;
      }
    }
  }
  return false;
}

/** First fill of a series just created for `output`. */
// biome-ignore lint/suspicious/noExplicitAny: lightweight-charts setData typing
export function fillSeries(series: SeriesLike<any>, output: SeriesOutput, bars: OhlcvBar[]): void {
  if (isColumns(output)) setSeriesColumns(series, output, barColumns(bars));
  else setSeriesData(series, output.data);
}

export interface LabelSink {
  setLabels(labels: PointLabel[]): void;
}

/**
 * Recompute one indicator against new bars and re-point the series it owns.
 *
 * Returns false when the indicator no longer produces the same series it was
 * built with — more bars can turn a "not enough data" indicator into a drawn
 * one, and a chart cannot grow a series without being rebuilt.
 *
 * `delta` is the step from the bars of the previous refill to `bars`
 * (columns.ts `barsDelta`), worked out once by the caller for all indicators.
 * Without it every columnar series is a full `setData`.
 */
export function refillSeries(
  indicator: ChartIndicator,
  // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts setData typing
  built: SeriesLike<any>[],
  bars: OhlcvBar[],
  kinds: ReadonlyArray<IndicatorSeriesOutput["type"]>,
  labelers?: (LabelSink | null)[],
  delta?: BarsDelta | null
): boolean {
  if (bars.length < indicator.minBars) return built.length === 0;
  const all = indicatorOutputs(indicator, bars);
  const outputs = all.every((o) => kinds.includes(o.type))
    ? all
    : all.filter((o) => kinds.includes(o.type));
  if (outputs.length !== built.length) return false;
  // A series that gained or lost labels needs a primitive attached / removed.
  if (labelers && outputs.some((o, i) => (!isColumns(o) && !!o.labels) !== !!labelers[i])) {
    return false;
  }
  const causal = indicator.columns ? isCausal(indicator) : false;
  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i];
    if (isColumns(output)) {
      setSeriesColumns(built[i], output, barColumns(bars), delta, causal);
    } else {
      setSeriesData(built[i], output.data);
      if (output.labels) labelers?.[i]?.setLabels(output.labels);
    }
  }
  return true;
}
