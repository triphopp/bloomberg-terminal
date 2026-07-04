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
import { useCallback, useEffect, useMemo, useRef } from "react";
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
  /** Chart height (main pane, excluding sub-panes) */
  height?: number;
  /** Active indicator instances */
  indicators: ChartIndicator[];
  /** Active canvas overlays (e.g. Volume Profile) */
  overlays?: CanvasOverlay[];
  /** Event markers (dividends, earnings, splits) displayed on the chart */
  eventMarkers?: ChartEventMarker[];
}

// ── Sub-pane height ──────────────────────────────────────────────────────────

const SUB_PANE_HEIGHT = 80; // px per sub-pane indicator

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
}: ModularChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null); // right-side strip
  const fullCanvasRef = useRef<HTMLCanvasElement>(null); // full-chart session VP
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);

  // Count pane indicators to compute total chart height
  const paneIndicators = indicators.filter((i) => i.type === "pane");
  const overlayIndicators = indicators.filter((i) => i.type === "overlay");
  const totalHeight = height + paneIndicators.length * SUB_PANE_HEIGHT;

  // biome-ignore lint/correctness/useExhaustiveDependencies: chart is fully rebuilt from these inputs; colors object identity is intentionally excluded
  useEffect(() => {
    const container = containerRef.current;
    if (!container || data.length === 0) return;

    const gridColor = isDark ? "#2a2a2a" : "#dcdcdc";

    // ── Create chart ──
    const chart = createChart(container, {
      width: container.clientWidth,
      height: totalHeight,
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
      subPane.setHeight(SUB_PANE_HEIGHT);

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
            color: isDark ? style.colorDark : style.colorLight,
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

    // ── Canvas overlays (Volume Profile, etc.) ──
    // Split overlays into right-strip and full-chart modes
    const rightOverlays = overlays.filter((o) => (o.mode ?? "right") === "right");
    const fullOverlays = overlays.filter((o) => o.mode === "full");
    let overlayUnsubscribe: (() => void) | null = null;

    if (rightOverlays.length > 0 || fullOverlays.length > 0) {
      let rafId = 0;

      const drawOverlaysNow = () => {
        rafId = 0;
        const dpr = window.devicePixelRatio || 1;

        // ── Right-side strip overlays (composite VP) ──
        if (rightOverlays.length > 0) {
          const canvas = overlayCanvasRef.current;
          if (canvas) {
            const logH = canvas.offsetHeight;
            const maxW = Math.max(...rightOverlays.map((o) => o.width));
            if (logH) {
              const needW = maxW * dpr;
              const needH = logH * dpr;
              if (canvas.width !== needW || canvas.height !== needH) {
                canvas.width = needW;
                canvas.height = needH;
              }
              const ctx = canvas.getContext("2d");
              if (ctx) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.save();
                ctx.scale(dpr, dpr);
                for (const overlay of rightOverlays) {
                  overlay.draw(ctx, chart, candleSeries, data, isDark);
                }
                ctx.restore();
              }
            }
          }
        }

        // ── Full-chart overlays (session VP) ──
        if (fullOverlays.length > 0) {
          const canvas = fullCanvasRef.current;
          const cont = containerRef.current;
          if (canvas && cont) {
            const logW = cont.clientWidth - 50;
            const logH = cont.clientHeight;
            if (logW > 0 && logH > 0) {
              const needW = logW * dpr;
              const needH = logH * dpr;
              if (canvas.width !== needW || canvas.height !== needH) {
                canvas.width = needW;
                canvas.height = needH;
              }
              canvas.style.width = `${logW}px`;
              canvas.style.height = `${logH}px`;

              const ctx = canvas.getContext("2d");
              if (ctx) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.save();
                ctx.scale(dpr, dpr);
                for (const overlay of fullOverlays) {
                  overlay.draw(ctx, chart, candleSeries, data, isDark);
                }
                ctx.restore();
              }
            }
          }
        }
      };

      // Throttle: coalesce rapid range-change events into one rAF
      const scheduleOverlayDraw = () => {
        if (!rafId) rafId = requestAnimationFrame(drawOverlaysNow);
      };

      scheduleOverlayDraw();
      chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleOverlayDraw);
      // Y-axis rescaling (dragging the price scale, wheel-zoom, double-click
      // reset) fires no lightweight-charts event, so priceToCoordinate output
      // changes without a redraw and VP bars drift off the candles. Redraw on
      // the raw pointer interactions instead — rAF-coalesced so it's cheap.
      container.addEventListener("pointermove", scheduleOverlayDraw);
      container.addEventListener("wheel", scheduleOverlayDraw, { passive: true });
      container.addEventListener("dblclick", scheduleOverlayDraw);

      overlayUnsubscribe = () => {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleOverlayDraw);
        container.removeEventListener("pointermove", scheduleOverlayDraw);
        container.removeEventListener("wheel", scheduleOverlayDraw);
        container.removeEventListener("dblclick", scheduleOverlayDraw);
        if (rafId) cancelAnimationFrame(rafId);
      };
    }

    // ── Resize observer ──
    const ro = new ResizeObserver(() => {
      if (container) {
        chart.resize(container.clientWidth, totalHeight);
      }
    });
    ro.observe(container);

    return () => {
      markersPlugin?.detach();
      overlayUnsubscribe?.();
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      mainSeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, isDark, totalHeight, indicators, overlays, eventMarkers]);

  // ── Empty state ──
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center font-mono text-xs"
        style={{ height, color: colors.textSecondary, borderColor: colors.border }}
      >
        No OHLC data for this period
      </div>
    );
  }

  const rightOverlaysRender = overlays.filter((o) => (o.mode ?? "right") === "right");
  const fullOverlaysRender = overlays.filter((o) => o.mode === "full");
  const overlayWidth =
    rightOverlaysRender.length > 0 ? Math.max(...rightOverlaysRender.map((o) => o.width)) : 0;

  return (
    <div style={{ position: "relative", width: "100%", height: totalHeight }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {/* Full-chart canvas overlay (session VP) */}
      {fullOverlaysRender.length > 0 && (
        <canvas
          ref={fullCanvasRef}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            pointerEvents: "none",
          }}
        />
      )}

      {/* Right-strip canvas overlay (composite VP) */}
      {rightOverlaysRender.length > 0 && (
        <canvas
          ref={overlayCanvasRef}
          style={{
            position: "absolute",
            right: 50,
            top: 0,
            width: overlayWidth,
            height: "100%",
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}
