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
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useAtom } from "jotai";
import {
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  type SeriesType,
  createChart,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { chartPaneHeightsAtom, chartRsiScaleAtom } from "../atoms";
import { createEventRailOverlay } from "./event-rail-overlay";
import { placeEvents } from "./event-reaction";
import { createHeatmapOverlay } from "./heatmap-overlay";
import { getIndicatorEntry } from "./indicators";
import { calcRSIState } from "./indicators/rsi";
import { priceForRsi } from "./indicators/rsiInverse";
import {
  RSI_SCALE_MODES,
  type RsiScaleBasis,
  type RsiScaleMode,
  inferPriceDecimals,
  rsiAxisFormatter,
  rsiLevelPreview,
} from "./indicators/rsiScale";
import { OverlayPrimitive } from "./overlay-primitive";
import { clampPaneHeight, computePaneLayout, paneKey, subPaneKeyAtOffset } from "./pane-layout";
import type {
  CanvasOverlay,
  ChartColors,
  ChartEventMarker,
  ChartIndicator,
  IndicatorSeriesOutput,
  OhlcvBar,
} from "./types";

// ── Props ────────────────────────────────────────────────────────────────────

/** Extra context handed to `onBarClick` alongside the bar time. */
export interface ChartClickContext {
  /** Click position in viewport coordinates — anchor for a popover. */
  point?: { x: number; y: number };
  /**
   * Event markers within `EVENT_HIT_BARS` of the clicked bar, nearest first.
   * Lets the caller open a detail card without doing its own hit-testing —
   * only the chart knows how bar times map to indices. More than one means the
   * user clicked a cluster and should be offered the list.
   */
  events?: ChartEventMarker[];
}

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
   * the Regression Channel to pick its two endpoints, and by the event detail
   * card via `ctx.event`. Held in a ref internally, so passing a fresh closure
   * each render does not rebuild the chart.
   */
  onBarClick?: (time: string | number, ctx?: ChartClickContext) => void;
  /** Show a crosshair cursor — signals that a click will be captured. */
  crosshairCursor?: boolean;
}

// ── Pane sizing ──────────────────────────────────────────────────────────────
// Layout arithmetic lives in ./pane-layout so it can be tested on its own.

/** Quantize measured height so a 1px reflow doesn't rebuild the whole chart. */
const HEIGHT_STEP = 8;

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

/**
 * How far from a marker a click still counts as hitting it, in bars.
 *
 * At 1Y daily inside the narrow MKT panel a bar is barely 2px wide, so demanding
 * an exact bar match would make the rail chips effectively unclickable.
 */
const EVENT_HIT_BARS = 2;

/**
 * Extra bottom margin on the price scale when the event rail is showing, as a
 * fraction of the pane. Keeps the candles from being drawn behind the chips —
 * the rail paints on top, so without this the lowest wicks disappear under it.
 */
const RAIL_SCALE_MARGIN = 0.1;

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
  // Pane heights the user dragged, persisted across rebuilds and view switches.
  const [paneHeights, setPaneHeights] = useAtom(chartPaneHeightsAtom);
  const [rsiScale, setRsiScale] = useAtom(chartRsiScaleAtom);
  // Sub-pane keys in creation order, so a pointer y can be resolved to the
  // indicator under it. Heights are read from the chart on demand rather than
  // cached here — a drag changes them without any rebuild.
  const subPaneKeysRef = useRef<string[]>([]);
  // Which sub-pane the pointer is over. Drives whether the right-click menu is
  // armed at all: resolved on move rather than on the contextmenu event so the
  // answer is already settled by the time Radix opens the menu.
  const [hoveredPaneKey, setHoveredPaneKey] = useState<string | null>(null);

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
  const rsiIndicator = paneIndicators.find((i) => paneKey(i.id) === "rsi");
  const rsiPeriod = (rsiIndicator?.config.period as number | undefined) ?? 14;

  /**
   * The bar every RSI level is projected from.
   *
   * Recomputed here rather than plumbed out of `compute()` so the axis and the
   * plotted line can never disagree — same function, same closes, same seed. A
   * second implementation would have to reproduce the warm-up exactly, and the
   * one place that got it subtly wrong took a whole point off the first bar.
   *
   * "closed" steps back one bar: the last bar may still be forming, and a state
   * that already contains the live price would make every projected level move
   * with the quote it is supposed to be a target for.
   */
  const rsiBasis: RsiScaleBasis | null = useMemo(() => {
    if (!rsiIndicator || data.length < rsiPeriod + 2) return null;
    const closes = data.map((d) => d.close);
    const states = calcRSIState(closes, rsiPeriod);
    const idx = states.length - (rsiScale.basis === "closed" ? 2 : 1);
    const state = idx >= 0 ? states[idx] : null;
    if (!state) return null;
    return {
      close: closes[idx],
      state,
      period: rsiPeriod,
      decimals: inferPriceDecimals(closes),
    };
  }, [data, rsiIndicator, rsiPeriod, rsiScale.basis]);
  const overlayIndicators = indicators.filter((i) => i.type === "overlay");
  const paneKeys = paneIndicators.map((i) => paneKey(i.id));
  // Height preferences are looked up from the registry rather than carried on the
  // instance: they are a property of the indicator's shape (how many rows it
  // stacks), not of the params the user picked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the id list, not the instances — params must not re-run this
  const preferredHeights = useMemo(() => {
    const out: Record<string, number> = {};
    for (const indicator of paneIndicators) {
      const entry = getIndicatorEntry(indicator.id);
      if (entry?.preferredPaneHeight) out[paneKey(indicator.id)] = entry.preferredPaneHeight;
    }
    return out;
  }, [paneIndicators.map((i) => i.id).join(",")]);

  const { chartHeight, heightFor } = computePaneLayout(
    availableHeight > 0 ? availableHeight : height,
    paneKeys,
    paneHeights,
    preferredHeights
  );
  // Serialised layout — the effect must rebuild when a restored height changes,
  // and `heightFor` is a fresh closure every render so it cannot be a dep itself.
  const paneHeightSig = paneKeys.map((k) => `${k}:${heightFor(k)}`).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: chart is fully rebuilt from these inputs; colors object identity is intentionally excluded
  useEffect(() => {
    const container = containerRef.current;
    if (!container || data.length === 0) return;

    const gridColor = isDark ? "#2a2a2a" : "#dcdcdc";

    // ── Event markers (dividends, earnings, splits) ──
    // Drawn by the event rail overlay further down, not as series markers. All
    // that is needed here is a bar index per marker so a click can be matched
    // back to it. Resolved before the chart exists because the price scale needs
    // to know up front whether to reserve room for the rail.
    const indexByTime = new Map<string, number>();
    data.forEach((d, i) => indexByTime.set(String(d.time), i));

    const placedEvents = placeEvents(eventMarkers, data);
    const hasRail = placedEvents.length > 0;

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
          bottom: hasRail ? RAIL_SCALE_MARGIN : 0.05,
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
    // Panes are recorded as they are created (a pane is skipped when the series
    // has too few bars, so pane index does not track indicator index) and read
    // back on teardown to capture whatever the user dragged them to.
    const builtPanes: { key: string; baseline: number | null; read: () => number }[] = [];
    for (const indicator of paneIndicators) {
      if (data.length < indicator.minBars) continue;
      const outputs = indicator.compute(data, indicator.config);

      const key = paneKey(indicator.id);
      const subPane = chart.addPane();
      subPane.setHeight(heightFor(key));
      builtPanes.push({ key, baseline: null, read: () => subPane.getHeight() });

      // "standard" pins RSI to 0–100 so the overbought/oversold lines sit where
      // the eye expects them; "autofit" is lightweight-charts' own autoscale,
      // which is what every pane got before this option existed.
      const pinRsiRange = key === "rsi" && rsiScale.mode !== "autofit";
      // The tick VALUES stay in RSI units — only their labels are rewritten.
      // Transforming the series instead would be circular: each bar's RSI
      // inverts to the close that produced it, so the "converted" line is just
      // the price chart again.
      const rsiFormatter = key === "rsi" ? rsiAxisFormatter(rsiScale.mode, rsiBasis) : null;
      const rsiPriceFormat = rsiFormatter
        ? ({ type: "custom", formatter: rsiFormatter, minMove: 0.01 } as const)
        : undefined;

      for (const output of outputs) {
        const isVolume = output.priceScaleId === "vol";

        if (output.type === "heatmap") {
          if (!output.heatmap) continue;
          // The cells are painted by a primitive, but a primitive has to hang off
          // a series and a pane needs a series to size itself — hence a fully
          // transparent anchor series holding one point per column. Its price
          // range is pinned so lightweight-charts cannot autoscale to a single
          // value and collapse the pane.
          const anchor = subPane.addSeries(LineSeries, {
            color: "transparent",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 1 } }),
          });
          // Anchor points. When the heatmap has no columns (its data has not
          // accumulated yet) the series is seeded from the chart's own bars
          // instead: a series with no data at all is not rendered, and the
          // primitive would go down with it — taking the "why am I empty"
          // message with it, which is exactly when that message is needed.
          const anchorPoints = output.heatmap.columns.length
            ? output.heatmap.columns.map((c) => ({ time: c.time, value: 0.5 }))
            : // One bar means first and last are the same time, and duplicate
              // times are rejected outright.
              [...new Set([data[0].time, data[data.length - 1].time])].map((time) => ({
                time,
                value: 0.5,
              }));
          // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts setData typing
          anchor.setData(anchorPoints as any[]);
          const primitive = new OverlayPrimitive(
            createHeatmapOverlay(output.heatmap),
            data,
            isDarkSurface(container, isDark)
          );
          anchor.attachPrimitive(primitive);
          continue;
        }

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
            ...(pinRsiRange
              ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) }
              : {}),
            ...(rsiPriceFormat ? { priceFormat: rsiPriceFormat } : {}),
          });
          // biome-ignore lint/suspicious/noExplicitAny: lightweight-charts setData typing
          series.setData(output.data as any[]);
        }
      }
    }

    subPaneKeysRef.current = builtPanes.map((p) => p.key);

    // ── RSI levels projected onto the price pane ──
    // Drawn as price lines on the current state, not as a series: the answer is
    // "what close on the next bar puts RSI at 70", which is a different number
    // every bar. Plotting it historically would be a path question with no
    // unique answer, and plotting it as a flat line would be a lie.
    if (rsiScale.projectToPricePane && rsiIndicator && rsiBasis) {
      const floor = Math.min(...data.map((d) => d.low));
      const ceiling = Math.max(...data.map((d) => d.high));
      const span = ceiling - floor || ceiling;

      for (const [levelKey, color] of [
        ["oversold", colors.positive],
        ["overbought", colors.negative],
      ] as const) {
        const level = rsiIndicator.config[levelKey] as number | undefined;
        if (typeof level !== "number") continue;

        const projection = priceForRsi(rsiBasis.close, rsiBasis.state, rsiBasis.period, level);
        if (!projection) continue;
        // Levels near 0 or 100 project absurdly far — RSI 95 can want a 60% day.
        // Drawing that squashes the price scale to a sliver, and the reading is
        // still there on the RSI axis.
        if (
          rsiScale.clipOffScale &&
          (projection.price < floor - span || projection.price > ceiling + span)
        ) {
          continue;
        }

        candleSeries.createPriceLine({
          price: projection.price,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `RSI ${level}`,
        });
      }
    }

    chart.timeScale().fitContent();

    // ── Canvas overlays (Volume Profile, Footprint, Event Rail) ──
    // Attached to the candle series as primitives: lightweight-charts renders
    // them on pane 0's own canvas, so they are clipped to that pane (a naked
    // POC priced off-screen can no longer paint over the indicator sub-panes)
    // and are redrawn on every internal invalidation — including price-scale
    // rescales, which emit no public event and previously had to be chased
    // with pointermove/wheel/dblclick listeners.
    let overlayUnsubscribe: (() => void) | null = null;

    // The event rail is an overlay like any other, so it inherits pane clipping
    // and the redraw-on-every-invalidation behaviour for free — including the
    // pan/zoom repositioning that a DOM-based rail would have to chase by hand.
    const allOverlays = hasRail ? [...overlays, createEventRailOverlay(placedEvents)] : overlays;

    if (allOverlays.length > 0) {
      // Measured once per chart build: overlay colors follow the painted surface,
      // not the theme flag (chart panels are hardcoded near-black in both themes).
      const surfaceDark = isDarkSurface(container, isDark);

      const primitives = allOverlays.map((o) => new OverlayPrimitive(o, data, surfaceDark));
      for (const p of primitives) {
        candleSeries.attachPrimitive(p);
      }

      overlayUnsubscribe = () => {
        for (const p of primitives) {
          candleSeries.detachPrimitive(p);
        }
      };
    }

    // ── Bar clicks (Regression Channel range selection, event detail card) ──
    // The chart reports the bar time; the events near it and the viewport
    // position are resolved here because only this scope knows the bar index
    // mapping and where the container sits on screen.
    const clickHandler = (param: { time?: unknown; point?: { x: number; y: number } }) => {
      if (param.time === undefined) return; // click landed outside the data
      const time = param.time as string | number;

      // Every marker in range, nearest first — not just the closest one. Chips
      // that collide on the rail are drawn as a single cluster, and opening only
      // one of the events hidden behind it would misreport what was clicked.
      let events: ChartEventMarker[] | undefined;
      const clickedIdx = indexByTime.get(String(time));
      if (clickedIdx !== undefined && hasRail) {
        const near = placedEvents
          .map((p) => ({ p, dist: Math.abs(p.barIdx - clickedIdx) }))
          .filter((h) => h.dist <= EVENT_HIT_BARS)
          .sort((a, b) => a.dist - b.dist);
        if (near.length > 0) events = near.map((h) => h.p.marker);
      }

      let point: { x: number; y: number } | undefined;
      if (param.point && container) {
        const rect = container.getBoundingClientRect();
        point = { x: rect.left + param.point.x, y: rect.top + param.point.y };
      }

      barClickRef.current?.(time, { point, events });
    };
    chart.subscribeClick(clickHandler);

    /**
     * Re-record what the panes currently measure.
     *
     * setHeight() is a request, not an assignment — lightweight-charts turns it
     * into a stretch factor and normalises across panes, so asking for 80 can
     * settle at 28. Diffing teardown height against the *requested* value would
     * flag every pane as user-resized on the first rebuild and pin panes nobody
     * touched, so the baseline is the settled height instead.
     *
     * Re-taken after any programmatic resize too: chart.resize() renormalises
     * every pane, and that must not be mistaken for a drag either.
     */
    const takeBaseline = () => {
      for (const p of builtPanes) {
        try {
          p.baseline = Math.round(p.read());
        } catch {
          /* pane gone — leave the previous baseline */
        }
      }
    };

    // ── Resize observer ──
    const ro = new ResizeObserver(() => {
      if (container) {
        chart.resize(container.clientWidth, chartHeight);
        takeBaseline();
      }
    });
    ro.observe(container);

    // First baseline, once the initial layout has settled.
    const baselineFrame = requestAnimationFrame(takeBaseline);

    return () => {
      cancelAnimationFrame(baselineFrame);
      // Read pane heights back BEFORE the chart is destroyed. A drag only lives
      // inside the chart instance, so this teardown is the single point where a
      // resize can be captured — miss it and the next rebuild silently reverts
      // to the computed default, which is exactly what used to happen on every
      // view switch. Panes with no baseline yet (torn down inside the same frame
      // they were built) are skipped: no drag can have happened.
      const dragged: Record<string, number> = {};
      for (const p of builtPanes) {
        if (p.baseline === null) continue;
        try {
          const now = Math.round(p.read());
          if (now > 0 && Math.abs(now - p.baseline) > 1) dragged[p.key] = clampPaneHeight(now);
        } catch {
          /* pane already gone — nothing to capture */
        }
      }
      if (Object.keys(dragged).length > 0) {
        setPaneHeights((prev) => ({ ...prev, ...dragged }));
      }

      overlayUnsubscribe?.();
      chart.unsubscribeClick(clickHandler);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      mainSeriesRef.current = null;
      subPaneKeysRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    data,
    isDark,
    chartHeight,
    paneHeightSig,
    indicators,
    overlays,
    eventMarkers,
    rsiScale,
    rsiBasis,
  ]);

  /**
   * Which sub-pane sits under a viewport y. Pane 0 is the price pane; the rest
   * follow in creation order, which is the order `subPaneKeysRef` was filled in.
   * The arithmetic lives in ./pane-layout so it can be tested without a canvas.
   */
  const subPaneKeyAt = (clientY: number): string | null => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return null;

    let heights: number[];
    try {
      heights = chart.panes().map((p) => p.getHeight());
    } catch {
      return null;
    }

    const offsetY = clientY - container.getBoundingClientRect().top;
    return subPaneKeyAtOffset(offsetY, heights, subPaneKeysRef.current);
  };

  const rsiMenuArmed = hoveredPaneKey === "rsi" && rsiIndicator != null;
  // The level the user is actually watching. Showing every level's target was
  // six lines saying the same thing; overbought is the one being approached.
  const rsiPreviewLevel = (rsiIndicator?.config.overbought as number | undefined) ?? 70;

  // The wrapper is what gets measured, so it always renders — including in the
  // empty state, otherwise the ResizeObserver would never attach and the chart
  // would come back at its fallback height once data arrives.
  return (
    <ContextMenu>
      {/*
        The trigger spans the whole chart but is only armed over the RSI pane —
        an overlay sized to that pane instead would have to swallow pointer
        events, taking the crosshair with it.
      */}
      <ContextMenuTrigger disabled={!rsiMenuArmed} asChild>
        <div
          ref={wrapperRef}
          onPointerMove={(e) => {
            const key = subPaneKeyAt(e.clientY);
            if (key !== hoveredPaneKey) setHoveredPaneKey(key);
          }}
          onPointerLeave={() => setHoveredPaneKey(null)}
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
      </ContextMenuTrigger>

      <ContextMenuContent className="w-64 font-mono text-xs">
        <ContextMenuLabel className="font-mono text-xs">
          {rsiIndicator?.name ?? "RSI"} scale
        </ContextMenuLabel>
        <ContextMenuSeparator />

        <ContextMenuRadioGroup
          value={rsiScale.mode}
          onValueChange={(mode) => setRsiScale((prev) => ({ ...prev, mode: mode as RsiScaleMode }))}
        >
          {RSI_SCALE_MODES.map(({ mode, label }) => (
            <ContextMenuRadioItem key={mode} value={mode}>
              {label}
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>

        <ContextMenuSeparator />
        <ContextMenuCheckboxItem
          checked={rsiScale.projectToPricePane}
          onCheckedChange={(on) =>
            setRsiScale((prev) => ({ ...prev, projectToPricePane: on === true }))
          }
        >
          Draw levels on price pane
        </ContextMenuCheckboxItem>
        <ContextMenuCheckboxItem
          checked={rsiScale.clipOffScale}
          onCheckedChange={(on) => setRsiScale((prev) => ({ ...prev, clipOffScale: on === true }))}
        >
          Clip off-scale levels
        </ContextMenuCheckboxItem>
        <ContextMenuCheckboxItem
          checked={rsiScale.basis === "live"}
          onCheckedChange={(on) =>
            setRsiScale((prev) => ({ ...prev, basis: on === true ? "live" : "closed" }))
          }
        >
          Project from forming bar
        </ContextMenuCheckboxItem>

        <ContextMenuSeparator />
        {/* Replaces the preview table an earlier design carried: one line, the
            level being approached, what it costs. */}
        <ContextMenuLabel className="font-mono text-[11px] font-normal opacity-70">
          {rsiLevelPreview(rsiPreviewLevel, rsiBasis)}
        </ContextMenuLabel>
      </ContextMenuContent>
    </ContextMenu>
  );
}
