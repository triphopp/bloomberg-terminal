"use client";

/**
 * ModularChart — Composable chart container built on lightweight-charts.
 *
 * Architecture:
 * - Main candlestick/price pane
 * - Overlay indicators rendered as line/area series on the main pane
 * - Sub-pane indicators rendered in isolated panes below (MACD, RSI, etc.)
 * - Canvas overlay layer for Volume Profile
 * - All indicators are dynamically added/removed via the plugin system
 */

import {
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  type SeriesType,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { OverlayPrimitive } from "./overlay-primitive";
import type {
  CanvasOverlay,
  ChartColors,
  ChartEventMarker,
  ChartIndicator,
  IndicatorSeriesOutput,
  OhlcvBar,
} from "./types";

// ── Props ────────────────────────────────────────────────────────────────────

export interface ModularChartProps {
  /** OHLCV data (ascending time order, unique times) */
  data: OhlcvBar[];
  /** Theme */
  isDark: boolean;
  colors: ChartColors;
  /**
   * Fallback height used only when the parent gives the chart no definite height
   * (auto-height container). Inside a sized flex parent the chart fills it and
   * this acts as the minimum.
   */
  height?: number;
  /** Active indicator instances */
  indicators: ChartIndicator[];
  /** Active canvas overlays (e.g. Volume Profile) */
  overlays?: CanvasOverlay[];
  /** Event markers (dividends, earnings, splits) displayed on the chart */
  eventMarkers?: ChartEventMarker[];
  /**
   * Fired with the bar time when the user clicks inside the data area. Used by
   * the Regression Channel to pick its two endpoints. Held in a ref internally,
   * so passing a fresh closure each render does not rebuild the chart.
   */
  onBarClick?: (time: string | number) => void;
  /** Show a crosshair cursor — signals that a click will be captured. */
  crosshairCursor?: boolean;
}

// ── Pane sizing ──────────────────────────────────────────────────────────────
//
// Sub-panes used to be a flat 80px each and the chart simply grew taller with
// every indicator added — past the parent's height it was clipped, which is what
// made stacked indicators appear to bleed into the volume pane. Instead, fit the
// panes to the height actually available and only overflow (with a scrollbar)
// once even the minimums no longer fit.

const SUB_PANE_MAX = 80;
const SUB_PANE_MIN = 44; // below this a pane's price scale labels start to collide
const MAIN_PANE_MIN = 140;
/** Quantize measured height so a 1px reflow doesn't rebuild the whole chart. */
const HEIGHT_STEP = 8;

interface PaneLayout {
  /** Total height handed to lightweight-charts */
  chartHeight: number;
  /** Height of each sub-pane */
  subPaneHeight: number;
}

function computePaneLayout(available: number, paneCount: number): PaneLayout {
  if (paneCount === 0) {
    return { chartHeight: available, subPaneHeight: 0 };
  }
  const subPaneHeight = Math.max(
    SUB_PANE_MIN,
    Math.min(SUB_PANE_MAX, Math.floor((available - MAIN_PANE_MIN) / paneCount))
  );
  // Below this the panes would have to shrink past SUB_PANE_MIN, so scroll instead.
  const needed = MAIN_PANE_MIN + paneCount * subPaneHeight;
  return { chartHeight: Math.max(available, needed), subPaneHeight };
}

/**
 * Darkness of the surface the chart is actually painted on.
 *
 * Canvas overlays (Volume Profile) pick label/line colors from this, NOT from the
 * theme flag: every chart panel hardcodes a near-black background regardless of
 * theme, so in light mode `isDark === false` produced white label backgrounds on
 * a black chart. Walks up until it finds a background that isn't transparent.
 */
function isDarkSurface(el: HTMLElement | null, fallback: boolean): boolean {
  for (let node = el; node; node = node.parentElement) {
    const match = getComputedStyle(node).backgroundColor.match(
      /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/
    );
    if (!match) continue;
    const alpha = match[4] === undefined ? 1 : Number(match[4]);
    if (alpha < 0.2) continue; // effectively transparent — keep walking up
    const luminance =
      (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255;
    return luminance < 0.5;
  }
  return fallback;
}

// ── Component ────────────────────────────────────────────────────────────────

// ── Marker styling ──────────────────────────────────────────────────────────

const EVENT_MARKER_STYLES: Record<
  ChartEventMarker["type"],
  {
    shape: "circle" | "square" | "arrowUp" | "arrowDown";
    colorDark: string;
    colorLight: string;
  }
> = {
  dividend: { shape: "circle", colorDark: "#4fc3f7", colorLight: "#0288d1" },
  earnings: { shape: "square", colorDark: "#ffb74d", colorLight: "#e65100" },
  split: { shape: "arrowDown", colorDark: "#ce93d8", colorLight: "#7b1fa2" },
};

export function ModularChart({
  data,
  isDark,
  colors,
  height = 280,
  indicators,
  overlays = [],
  eventMarkers = [],
  onBarClick,
  crosshairCursor = false,
}: ModularChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  // Held in a ref so changing the handler never tears the chart down and
  // rebuilds it — the effect below depends on data/indicators, not on this.
  const barClickRef = useRef(onBarClick);
  barClickRef.current = onBarClick;

  // Height the parent actually grants us (0 until first measurement).
  const [availableHeight, setAvailableHeight] = useState(0);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const measure = () => {
      const h = wrapper.clientHeight;
      // Floor, never round: rounding up would hand the chart more height than the
      // parent has and clip the bottom pane by a few pixels.
      if (h > 0) setAvailableHeight(Math.floor(h / HEIGHT_STEP) * HEIGHT_STEP);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, []);

  const paneIndicators = indicators.filter((i) => i.type === "pane");
  const overlayIndicators = indicators.filter((i) => i.type === "overlay");
  const { chartHeight, subPaneHeight } = computePaneLayout(
    availableHeight > 0 ? availableHeight : height,
    paneIndicators.length
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: chart is fully rebuilt from these inputs; colors object identity is intentionally excluded
  useEffect(() => {
    const container = containerRef.current;
    if (!container || data.length === 0) return;

    const gridColor = isDark ? "#2a2a2a" : "#dcdcdc";

    // ── Create chart ──
    const chart = createChart(container, {
      width: container.clientWidth,
      height: chartHeight,
      layout: {
        background: { color: "transparent" },
        textColor: colors.textSecondary,
        fontFamily: "monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: gridColor },
        horzLines: { color: gridColor },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: colors.border, labelBackgroundColor: colors.surface, width: 1 },
        horzLine: { color: colors.border, labelBackgroundColor: colors.surface, width: 1 },
      },
      rightPriceScale: {
        borderColor: colors.border,
        textColor: colors.textSecondary,
        scaleMargins: {
          top: 0.05,
          bottom: 0.05,
        },
      },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
    });

    chartRef.current = chart;

    // ── Main candlestick series ──
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: colors.positive,
      downColor: colors.negative,
      borderUpColor: colors.positive,
      borderDownColor: colors.negative,
      wickUpColor: colors.positive,
      wickDownColor: colors.negative,
    });
    // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts setData typing
    candleSeries.setData(data as any[]);
    mainSeriesRef.current = candleSeries;

    // ── Render overlay indicators on main pane ──
    for (const indicator of overlayIndicators) {
      if (data.length < indicator.minBars) continue;
      const outputs = indicator.compute(data, indicator.config);

      for (const output of outputs) {
        if (output.type === "line") {
          const series = chart.addSeries(LineSeries, {
            color: output.color ?? "#ffc107",
            lineWidth: (output.lineWidth ?? 1) as 1 | 2 | 3 | 4,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts setData typing
          series.setData(output.data as any[]);
        }
      }
    }

    // ── Render pane indicators — each gets its own isolated pane ──
    for (const indicator of paneIndicators) {
      if (data.length < indicator.minBars) continue;
      const outputs = indicator.compute(data, indicator.config);

      const subPane = chart.addPane();
      subPane.setHeight(subPaneHeight);

      for (const output of outputs) {
        const isVolume = output.priceScaleId === "vol";

        if (output.type === "histogram") {
          const series = subPane.addSeries(HistogramSeries, {
            priceFormat: isVolume
              ? { type: "volume" }
              : { type: "price", precision: 4, minMove: 0.0001 },
            priceLineVisible: false,
            lastValueVisible: false,
          });
          // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts setData typing
          series.setData(output.data as any[]);
        } else if (output.type === "line") {
          const series = subPane.addSeries(LineSeries, {
            color: output.color ?? "#888",
            lineWidth: (output.lineWidth ?? 1) as 1 | 2 | 3 | 4,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts setData typing
          series.setData(output.data as any[]);
        }
      }
    }

    chart.timeScale().fitContent();

    // ── Event markers (dividends, earnings, splits) ──
    let markersPlugin: ReturnType<typeof createSeriesMarkers> | null = null;
    if (eventMarkers.length > 0) {
      const dataTimeSet = new Set(data.map((d) => (typeof d.time === "number" ? d.time : d.time)));
      const isIntradayData = data.length > 0 && typeof data[0].time === "number";

      const lwMarkers = eventMarkers
        .filter((em) => {
          if (isIntradayData) {
            const ts =
              typeof em.time === "number"
                ? em.time
                : Math.floor(new Date(`${em.time}T00:00:00`).getTime() / 1000);
            for (const dt of dataTimeSet) {
              if (typeof dt === "number" && Math.abs(dt - ts) < 86400) return true;
            }
            return false;
          }
          const dateStr = typeof em.time === "string" ? em.time.slice(0, 10) : "";
          return dataTimeSet.has(dateStr);
        })
        .map((em) => {
          const style = EVENT_MARKER_STYLES[em.type];
          // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts Time union
          let markerTime: any;
          if (isIntradayData) {
            if (typeof em.time === "number") {
              markerTime = em.time;
            } else {
              const dayTs = Math.floor(new Date(`${em.time}T00:00:00`).getTime() / 1000);
              let closest = data[0].time as number;
              let minDiff = Math.abs(closest - dayTs);
              for (const d of data) {
                const diff = Math.abs((d.time as number) - dayTs);
                if (diff < minDiff) {
                  minDiff = diff;
                  closest = d.time as number;
                }
              }
              markerTime = closest;
            }
          } else {
            markerTime = typeof em.time === "string" ? em.time.slice(0, 10) : em.time;
          }

          return {
            time: markerTime,
            position: "belowBar" as const,
            shape: style.shape,
            color: em.color ?? (isDark ? style.colorDark : style.colorLight),
            text: em.label,
            id: `${em.type}-${em.time}`,
          };
        })
        .sort((a, b) => {
          if (typeof a.time === "number" && typeof b.time === "number") return a.time - b.time;
          return String(a.time).localeCompare(String(b.time));
        });

      if (lwMarkers.length > 0) {
        markersPlugin = createSeriesMarkers(candleSeries, lwMarkers);
      }
    }

    // ── Canvas overlays (Volume Profile, Footprint) ──
    // Attached to the candle series as primitives: lightweight-charts renders
    // them on pane 0's own canvas, so they are clipped to that pane (a naked
    // POC priced off-screen can no longer paint over the indicator sub-panes)
    // and are redrawn on every internal invalidation — including price-scale
    // rescales, which emit no public event and previously had to be chased
    // with pointermove/wheel/dblclick listeners.
    let overlayUnsubscribe: (() => void) | null = null;

    if (overlays.length > 0) {
      // Measured once per chart build: overlay colors follow the painted surface,
      // not the theme flag (chart panels are hardcoded near-black in both themes).
      const surfaceDark = isDarkSurface(container, isDark);

      const primitives = overlays.map((o) => new OverlayPrimitive(o, data, surfaceDark));
      for (const p of primitives) {
        candleSeries.attachPrimitive(p);
      }

      overlayUnsubscribe = () => {
        for (const p of primitives) {
          candleSeries.detachPrimitive(p);
        }
      };
    }

    // ── Bar clicks (Regression Channel range selection) ──
    const clickHandler = (param: { time?: unknown }) => {
      if (param.time === undefined) return; // click landed outside the data
      barClickRef.current?.(param.time as string | number);
    };
    chart.subscribeClick(clickHandler);

    // ── Resize observer ──
    const ro = new ResizeObserver(() => {
      if (container) {
        chart.resize(container.clientWidth, chartHeight);
      }
    });
    ro.observe(container);

    return () => {
      markersPlugin?.detach();
      overlayUnsubscribe?.();
      chart.unsubscribeClick(clickHandler);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      mainSeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, isDark, chartHeight, subPaneHeight, indicators, overlays, eventMarkers]);

  // The wrapper is what gets measured, so it always renders — including in the
  // empty state, otherwise the ResizeObserver would never attach and the chart
  // would come back at its fallback height once data arrives.
  return (
    <div
      ref={wrapperRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: height,
        // auto (not conditional): when the panes fit, no scrollbar appears — and a
        // stale height measurement can never silently clip the bottom pane.
        overflowY: "auto",
        overflowX: "hidden",
      }}
    >
      {data.length === 0 ? (
        <div
          className="flex h-full items-center justify-center font-mono text-xs"
          style={{ color: colors.textSecondary }}
        >
          No OHLC data for this period
        </div>
      ) : (
        // Overlays (Volume Profile, Footprint) render as series primitives on
        // the chart's own canvas — no sibling <canvas> layers to position.
        <div
          ref={containerRef}
          style={{
            width: "100%",
            height: chartHeight,
            cursor: crosshairCursor ? "crosshair" : undefined,
          }}
        />
      )}
    </div>
  );
}
