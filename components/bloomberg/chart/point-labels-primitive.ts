/**
 * Text labels pinned to (bar time, price) points of a line series — e.g. the
 * price at each ZigZag pivot. An indicator asks for them through
 * `IndicatorSeriesOutput.labels`; ModularChart attaches one of these to that
 * line series.
 *
 * Not `createSeriesMarkers`: library marker text is laid out against the bar,
 * not the point, and the repo moved off markers already (event-rail-overlay.ts).
 * A primitive renders on the series' own pane, so it is clipped to the price
 * pane and redrawn on every scroll, zoom and price-scale change for free.
 *
 * Labels outside the visible range are skipped, and a label that would overlap
 * the previous one on the same side (above / below) is dropped, so a dense
 * zoomed-out chart thins out instead of turning into a smear.
 */

import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { PointLabel } from "./types";

const FONT = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
const PAD_X = 3;
const BOX_H = 14;
/** Gap between the point and the near edge of its label. */
const OFFSET = 6;

class PointLabelsRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _labels: readonly PointLabel[],
    private readonly _chart: IChartApi | null,
    private readonly _series: ISeriesApi<SeriesType> | null,
    private readonly _isDark: boolean
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._chart;
    const series = this._series;
    if (!chart || !series || this._labels.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = chart.timeScale();
      ctx.save();
      ctx.font = FONT;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      // Right edge of the last label drawn on each side, for overlap culling.
      const lastRight = { above: Number.NEGATIVE_INFINITY, below: Number.NEGATIVE_INFINITY };
      for (const l of this._labels) {
        const x = ts.timeToCoordinate(l.time as Time);
        const y = series.priceToCoordinate(l.price);
        if (x == null || y == null) continue;
        const w = ctx.measureText(l.text).width + PAD_X * 2;
        if (x < 0 || x > mediaSize.width) continue;
        // Kept inside the pane: the newest corner sits against the price scale,
        // and a centred box would lose its tail under it.
        const left = Math.max(0, Math.min(x - w / 2, mediaSize.width - w));
        if (left < lastRight[l.position] + 2) continue;
        lastRight[l.position] = left + w;

        const cy = l.position === "above" ? y - OFFSET - BOX_H / 2 : y + OFFSET + BOX_H / 2;
        ctx.globalAlpha = l.faded ? 0.6 : 1;
        ctx.fillStyle = this._isDark ? "rgba(0,0,0,0.72)" : "rgba(255,255,255,0.85)";
        ctx.fillRect(left, cy - BOX_H / 2, w, BOX_H);
        ctx.strokeStyle = l.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(left + 0.5, cy - BOX_H / 2 + 0.5, w - 1, BOX_H - 1);
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, left + w / 2, cy + 0.5);
      }
      ctx.restore();
    });
  }
}

class PointLabelsView implements IPrimitivePaneView {
  constructor(private readonly _p: PointLabelsPrimitive) {}
  zOrder() {
    return "top" as const;
  }
  renderer(): IPrimitivePaneRenderer {
    return this._p.buildRenderer();
  }
}

export class PointLabelsPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private readonly _views: IPrimitivePaneView[] = [new PointLabelsView(this)];

  constructor(
    private _labels: readonly PointLabel[],
    private readonly _isDark: boolean
  ) {}

  /** Swap the labels in place (live tick / more history) and repaint. */
  setLabels(labels: readonly PointLabel[]): void {
    this._labels = labels;
    this._series?.applyOptions({});
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart as IChartApi;
    this._series = param.series as ISeriesApi<SeriesType>;
  }

  detached(): void {
    this._chart = null;
    this._series = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._views;
  }

  /** @internal */
  buildRenderer(): IPrimitivePaneRenderer {
    return new PointLabelsRenderer(this._labels, this._chart, this._series, this._isDark);
  }
}
