/**
 * CanvasOverlay → lightweight-charts series primitive adapter.
 *
 * The Volume Profile / Footprint overlays used to render onto two absolutely
 * positioned <canvas> elements stacked over the whole chart container, redrawn
 * by hand from a rAF loop wired to timeScale events plus raw pointermove /
 * wheel / dblclick listeners. That had two structural problems:
 *
 *   1. The canvases spanned the entire container, but the overlays draw in the
 *      MAIN series' price coordinates. priceToCoordinate() does not clamp, so
 *      anything priced outside the visible range (most visibly a naked POC)
 *      painted straight over the indicator sub-panes below.
 *   2. Y-axis rescaling emits no lightweight-charts event, so the redraw had to
 *      be guessed at from pointer input — which both over-fires and still
 *      misses cases.
 *
 * Attaching the overlay to the candle series as an ISeriesPrimitive hands both
 * problems to the library: primitives render on their own pane's canvas (so
 * pane 0 clipping is automatic and exact) and are redrawn on every internal
 * invalidation, including price-scale changes.
 *
 * The CanvasOverlay contract is unchanged apart from receiving its drawing area
 * explicitly (see OverlayRect) instead of reading it off `ctx.canvas`, which
 * under a primitive would describe the pane rather than the overlay's slot.
 */

import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasOverlay, OhlcvBar } from "./types";

class OverlayPaneRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _overlay: CanvasOverlay,
    private readonly _data: OhlcvBar[],
    private readonly _isDark: boolean,
    private readonly _chart: IChartApi | null,
    private readonly _series: ISeriesApi<SeriesType> | null
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._chart;
    const series = this._series;
    if (!chart || !series) return;

    target.useMediaCoordinateSpace((scope) => {
      const ctx = scope.context;
      const paneW = scope.mediaSize.width;
      const paneH = scope.mediaSize.height;
      if (paneW <= 0 || paneH <= 0) return;

      // "right" overlays draw from x=0 of a fixed-width strip. The pane canvas
      // already excludes the price scale, so shifting the origin left by the
      // strip width lands it flush against the scale, as before.
      const isRight = (this._overlay.mode ?? "right") === "right";
      const slotW = isRight ? Math.min(this._overlay.width, paneW) : paneW;

      ctx.save();
      if (isRight) ctx.translate(paneW - slotW, 0);
      this._overlay.draw(ctx, chart, series, this._data, this._isDark, {
        width: slotW,
        height: paneH,
      });
      ctx.restore();
    });
  }
}

class OverlayPaneView implements IPrimitivePaneView {
  constructor(private readonly _primitive: OverlayPrimitive) {}

  /** Above the series, matching the old canvas z-index that beat the candles. */
  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this._primitive.buildRenderer();
  }
}

export class OverlayPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private readonly _paneViews: IPrimitivePaneView[];

  constructor(
    private readonly _overlay: CanvasOverlay,
    private readonly _data: OhlcvBar[],
    private readonly _isDark: boolean
  ) {
    this._paneViews = [new OverlayPaneView(this)];
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
    return this._paneViews;
  }

  /** @internal — used by the pane view to build a renderer bound to live refs. */
  buildRenderer(): IPrimitivePaneRenderer {
    return new OverlayPaneRenderer(
      this._overlay,
      this._data,
      this._isDark,
      this._chart,
      this._series
    );
  }
}
