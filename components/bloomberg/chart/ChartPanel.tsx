"use client";

/**
 * ChartPanel — the MKT chart panel, packaged so it can be rendered anywhere.
 *
 * Same anatomy as the chart column in market-view, top to bottom:
 *   quote header · indicator bar · timeframe bar · chart (+ F&G / P/E sub-panes)
 *   · OHLC footer
 *
 * market-view still renders its own copy inline (it is entangled with the
 * symbol search, the layout splitters and the tick board); this is the version
 * the floating and detached chart windows use, so a popped-out chart looks and
 * behaves like the one it came from.
 */

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { usePrefetchStockHistory, useStockHistory, useStockQuote } from "../hooks/useStockData";
import { bloombergColors } from "../lib/theme-config";
import { EventDetailPopover } from "./EventDetailPopover";
import { FearGreedPane } from "./FearGreedPane";
import { IndicatorPicker } from "./IndicatorPicker";
import { ModularChart } from "./ModularChart";
import { PEPane } from "./PEPane";
import { TimeframeRow } from "./TimeframeRow";
import type { BarInterval, OhlcvBar, TimePeriod } from "./types";
import { useAutoExtendRange } from "./useAutoExtendRange";
import { useChartIndicators } from "./useChartIndicators";
import { applyInterval, applyPeriod } from "./useChartTimeframe";
import { useSdBands } from "./useSdBands";

const colors = bloombergColors.dark;

/** The subset of a history row the panel reads. */
interface HistoryRow {
  date: string;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
}

/** The subset of a quote the panel reads — field names vary by provider. */
interface QuoteRow {
  price?: number | null;
  regularMarketPrice?: number | null;
  changePercent?: number | null;
  regularMarketChangePercent?: number | null;
  change?: number | null;
  regularMarketChange?: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
  volume?: number | null;
  marketCap?: number | null;
}

export interface ChartPanelProps {
  symbol: string;
  label?: string;
  timePeriod: TimePeriod;
  barInterval: BarInterval;
  onTimeframeChange: (tf: { timePeriod: TimePeriod; barInterval: BarInterval }) => void;
  /**
   * Skip every data fetch and render nothing but a placeholder. Used by a
   * minimized window, which is a title bar with no body.
   */
  paused?: boolean;
  /** Extra controls rendered at the right end of the header row. */
  headerRight?: React.ReactNode;
  /** Drag handle wiring for a floating window title bar. */
  onHeaderPointerDown?: (e: React.PointerEvent) => void;
  /** Freeze the chart body at this pixel height (used during a resize drag). */
  frozenBodyHeight?: number | null;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (abs >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function fmtVol(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function ChartPanel({
  symbol,
  label,
  timePeriod,
  barInterval,
  onTimeframeChange,
  paused = false,
  headerRight,
  onHeaderPointerDown,
  frozenBodyHeight = null,
}: ChartPanelProps) {
  const activeSymbol = paused ? null : symbol;

  // The quote is cheap, cached and unpolled, and a paused (minimized) window
  // still shows the price in its title bar — so it is not gated on `paused`.
  const quoteQuery = useStockQuote(symbol);

  // Zoom out past the oldest bar and the window widens by itself — the fetch
  // below follows `effectivePeriod`, not the timeframe button the user pressed.
  // Fed back from the query below through an effect: the query cannot be read
  // before the hook that decides which window it fetches.
  const [dataState, setDataState] = useState({ barCount: 0, isLoading: false });
  const prefetchHistory = usePrefetchStockHistory();
  const { effectivePeriod, onLogicalRange, viewportKey, extended } = useAutoExtendRange({
    symbol: activeSymbol,
    period: timePeriod,
    interval: barInterval,
    barCount: dataState.barCount,
    isLoading: dataState.isLoading,
    enabled: !paused,
    onPrefetch: (p) => prefetchHistory(activeSymbol, p, barInterval),
  });
  const historyQuery = useStockHistory(activeSymbol, effectivePeriod, barInterval);

  const {
    indicators,
    overlays,
    eventMarkers,
    addIndicator,
    removeIndicator,
    windowUnit,
    toggleWindowUnit,
    showVolumeProfile,
    toggleVolumeProfile,
    regressionSel,
    regressionArmed,
    regressionPending,
    regressionOpts,
    toggleRegression,
    setRegressionMode,
    handleChartClick,
    showEvents,
    toggleEvents,
    supportsEvents,
    selectedEvent,
    clearSelectedEvent,
    showPE,
    togglePE,
    peData,
    peLoading,
    showFootprint,
    toggleFootprint,
    isCryptoSymbol,
    footprintLoading,
    updateIndicatorConfig,
  } = useChartIndicators({ symbol: activeSymbol, barInterval, chartType: "candle" });

  // Fear & Greed is a whole-market series, so it is fetched here rather than
  // computed from the symbol's bars, and injected the same way market-view does.
  const fearGreedActive = indicators.some((i) => i.id === "fear-greed");
  const fearGreedQuery = useQuery<{ history: Array<{ time: string; value: number }> }>({
    queryKey: ["fear-greed-history", "1y"],
    queryFn: () => fetch("/api/fear-greed/history?period=1y").then((r) => r.json()),
    enabled: fearGreedActive && !paused,
    staleTime: 60 * 60 * 1000,
  });
  useEffect(() => {
    if (fearGreedActive && fearGreedQuery.data?.history) {
      updateIndicatorConfig("fear-greed", { preloadedData: fearGreedQuery.data.history });
    }
  }, [fearGreedActive, fearGreedQuery.data, updateIndicatorConfig]);

  useSdBands({ indicators, symbol: activeSymbol, period: "1y", updateIndicatorConfig });

  const isIntraday = !["1d", "1wk"].includes(barInterval);

  const ohlcv: OhlcvBar[] = useMemo(() => {
    const rows: HistoryRow[] = historyQuery.data?.quotes ?? [];
    return rows.flatMap((q) => {
      const { open, high, low, close } = q;
      if (open == null || high == null || low == null || close == null) return [];
      return [
        {
          time: isIntraday ? Math.floor(new Date(q.date).getTime() / 1000) : q.date.slice(0, 10),
          open,
          high,
          low,
          close,
          volume: q.volume ?? undefined,
        },
      ];
    });
  }, [historyQuery.data, isIntraday]);

  // Memoised: ModularChart reads this array's identity as chart structure, so a
  // fresh `.filter()` each render would rebuild the whole chart every render.
  const chartIndicators = useMemo(
    () => indicators.filter((i) => i.id !== "fear-greed"),
    [indicators]
  );

  useEffect(() => {
    setDataState((prev) =>
      prev.barCount === ohlcv.length && prev.isLoading === historyQuery.isFetching
        ? prev
        : { barCount: ohlcv.length, isLoading: historyQuery.isFetching }
    );
  }, [ohlcv.length, historyQuery.isFetching]);

  const quote = quoteQuery.data as QuoteRow | undefined;
  const price = quote?.price ?? quote?.regularMarketPrice ?? null;
  const changePct = quote?.changePercent ?? quote?.regularMarketChangePercent ?? null;
  const change = quote?.change ?? quote?.regularMarketChange ?? null;
  const tone =
    changePct == null ? colors.textSecondary : changePct >= 0 ? colors.positive : colors.negative;

  const first = ohlcv[0];
  const last = ohlcv[ohlcv.length - 1];
  const periodTrend = first && last ? last.close >= first.close : true;
  const periodPct =
    first && last && first.close !== 0 ? ((last.close - first.close) / first.close) * 100 : null;
  const periodHigh = ohlcv.length ? Math.max(...ohlcv.map((d) => d.high)) : null;
  const periodLow = ohlcv.length ? Math.min(...ohlcv.map((d) => d.low)) : null;
  const hasVolume = ohlcv.some((d) => (d.volume ?? 0) > 0);
  const avgVolume = hasVolume
    ? ohlcv.reduce((sum, d) => sum + (d.volume ?? 0), 0) / ohlcv.length
    : null;

  const changeTf = onTimeframeChange;

  return (
    <div className="flex flex-col h-full" style={{ background: "#050505" }}>
      {/* ── Quote header ── */}
      <div
        className="flex items-center gap-1.5 px-1 py-0.5 shrink-0 select-none"
        style={{
          background: "#0d0d0d",
          borderBottom: `1px solid ${colors.border}`,
          cursor: onHeaderPointerDown ? "move" : undefined,
        }}
        onPointerDown={onHeaderPointerDown}
      >
        <span className="text-[11px] font-mono font-bold" style={{ color: colors.accent }}>
          {symbol}
        </span>
        {label && label !== symbol && (
          <span
            className="text-[9px] font-mono truncate max-w-[160px]"
            style={{ color: colors.textSecondary }}
          >
            {label}
          </span>
        )}
        <span className="text-[11px] font-mono" style={{ color: colors.text }}>
          {fmtPrice(price)}
        </span>
        {changePct != null && (
          <span className="text-[9px] font-mono" style={{ color: tone }}>
            {change != null ? `${change >= 0 ? "+" : ""}${fmtPrice(change)} ` : ""}
            {changePct >= 0 ? "+" : ""}
            {changePct.toFixed(2)}%
          </span>
        )}
        {!paused && (historyQuery.isFetching || quoteQuery.isFetching) && (
          <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: colors.accent }} />
        )}
        {/* The timeframe buttons still show what the user picked; this says how
            far the chart has actually loaded after zooming out past it. */}
        {extended && (
          <span
            className="text-[8px] font-mono px-0.5 border"
            title={`Zoomed out past ${timePeriod.toUpperCase()} — history auto-extended to ${effectivePeriod.toUpperCase()}`}
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            {effectivePeriod.toUpperCase()}·AUTO
          </span>
        )}
        <span className="flex-1" />
        {headerRight}
      </div>

      {paused ? null : (
        <>
          {/* ── Indicator bar ── */}
          <div
            className="flex items-center gap-1 px-1 py-0.5 shrink-0 flex-wrap"
            style={{ borderBottom: `1px solid ${colors.border}` }}
          >
            <IndicatorPicker
              colors={colors}
              activeIndicators={indicators}
              onAdd={addIndicator}
              onRemove={removeIndicator}
              windowUnit={windowUnit}
              onToggleWindowUnit={toggleWindowUnit}
            />
            <button
              type="button"
              className="text-[8px] px-1 py-0 font-bold border"
              disabled={!hasVolume}
              title={
                hasVolume
                  ? "Volume Profile"
                  : "Volume Profile — this symbol reports no volume (calculated indices like VIX, plus yields and FX, quote a level with nothing trading behind it)"
              }
              style={{
                borderColor: showVolumeProfile && hasVolume ? colors.accent : colors.border,
                color: !hasVolume
                  ? colors.border
                  : showVolumeProfile
                    ? colors.accent
                    : colors.textSecondary,
                background: showVolumeProfile && hasVolume ? `${colors.accent}15` : "transparent",
                cursor: hasVolume ? "pointer" : "not-allowed",
              }}
              onClick={toggleVolumeProfile}
            >
              VP
            </button>
            <button
              type="button"
              className="text-[8px] px-1 py-0 font-bold border"
              title={
                regressionSel
                  ? "Clear regression channel"
                  : regressionArmed
                    ? "Click two bars on the chart to set the range (click again to cancel)"
                    : "Regression Channel: click two bars to fit a trend + channel"
              }
              style={{
                borderColor: regressionArmed || regressionSel ? "#ffc107" : colors.border,
                color: regressionArmed || regressionSel ? "#ffc107" : colors.textSecondary,
                background: regressionArmed || regressionSel ? "#ffc10715" : "transparent",
              }}
              onClick={toggleRegression}
            >
              {regressionArmed ? (regressionPending ? "REG 2/2" : "REG 1/2") : "REG"}
            </button>
            {regressionSel && (
              <button
                type="button"
                className="text-[8px] px-1 py-0 font-bold border"
                style={{ borderColor: "#ffc107", color: "#ffc107", background: "#ffc10708" }}
                onClick={() =>
                  setRegressionMode(regressionOpts.mode === "stddev" ? "quantile" : "stddev")
                }
              >
                {regressionOpts.mode === "stddev"
                  ? `${regressionOpts.stdDevMult}σ`
                  : `q${regressionOpts.tauPct}`}
              </button>
            )}
            {supportsEvents && (
              <button
                type="button"
                className="text-[8px] px-1 py-0 font-bold border"
                title="Toggle Events (Dividends, Earnings, Splits)"
                style={{
                  borderColor: showEvents ? "#4fc3f7" : colors.border,
                  color: showEvents ? "#4fc3f7" : colors.textSecondary,
                  background: showEvents ? "#4fc3f715" : "transparent",
                }}
                onClick={toggleEvents}
              >
                EVT
              </button>
            )}
            {supportsEvents && (
              <button
                type="button"
                className="text-[8px] px-1 py-0 font-bold border"
                title="Toggle Trailing P/E history pane"
                style={{
                  borderColor: showPE ? "#ba68c8" : colors.border,
                  color: showPE ? "#ba68c8" : colors.textSecondary,
                  background: showPE ? "#ba68c815" : "transparent",
                }}
                onClick={togglePE}
              >
                P/E{showPE && peLoading ? "…" : ""}
              </button>
            )}
            {isCryptoSymbol && (
              <button
                type="button"
                className="text-[8px] px-1 py-0 font-bold border"
                style={{
                  borderColor: showFootprint ? "#ff9800" : colors.border,
                  color: showFootprint ? "#ff9800" : colors.textSecondary,
                  background: showFootprint ? "#ff980015" : "transparent",
                }}
                onClick={toggleFootprint}
              >
                FP{footprintLoading ? "…" : ""}
              </button>
            )}
          </div>

          {/* ── Timeframe — the MKT control: period buttons + TF dropdown ── */}
          <TimeframeRow
            colors={colors}
            timePeriod={timePeriod}
            barInterval={barInterval}
            onPeriodChange={(p) => changeTf(applyPeriod(p, barInterval))}
            onIntervalChange={(iv) => changeTf(applyInterval(iv, timePeriod))}
          />

          {/* ── Chart ── */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <div className="h-full flex flex-col" style={{ height: frozenBodyHeight ?? "100%" }}>
              <div className="flex-1 min-h-0 relative">
                {historyQuery.isLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="h-4 w-4 animate-spin" style={{ color: colors.accent }} />
                  </div>
                ) : ohlcv.length === 0 ? (
                  <div className="flex items-center justify-center h-full">
                    <span className="text-[10px]" style={{ color: colors.textSecondary }}>
                      No data for this period
                    </span>
                  </div>
                ) : (
                  <>
                    <ModularChart
                      data={ohlcv}
                      isDark
                      colors={colors}
                      height={160}
                      indicators={chartIndicators}
                      overlays={overlays}
                      eventMarkers={eventMarkers}
                      onBarClick={handleChartClick}
                      crosshairCursor={regressionArmed}
                      onLogicalRange={onLogicalRange}
                      viewportKey={viewportKey}
                    />
                    {selectedEvent && (
                      <EventDetailPopover
                        markers={selectedEvent.markers}
                        anchor={selectedEvent.anchor}
                        data={ohlcv}
                        colors={colors}
                        symbol={symbol}
                        onClose={clearSelectedEvent}
                      />
                    )}
                  </>
                )}
              </div>
              {fearGreedActive && fearGreedQuery.data?.history && (
                <div className="shrink-0">
                  <FearGreedPane data={fearGreedQuery.data.history} colors={colors} height={90} />
                </div>
              )}
              {showPE && peData?.history && peData.history.length > 0 && (
                <div className="shrink-0">
                  <PEPane data={peData.history} stats={peData.stats} colors={colors} height={90} />
                </div>
              )}
            </div>
          </div>

          {/* ── OHLC footer ── */}
          <div
            className="shrink-0 flex justify-between text-[9px] font-mono px-1 py-0.5"
            style={{ borderTop: "1px solid #1a1a1a", color: colors.textSecondary }}
          >
            <span>
              O:<span style={{ color: colors.text }}>{fmtPrice(first?.open)}</span>
            </span>
            <span>
              H:<span style={{ color: colors.text }}>{fmtPrice(periodHigh)}</span>
            </span>
            <span>
              L:<span style={{ color: colors.text }}>{fmtPrice(periodLow)}</span>
            </span>
            <span>
              C:<span style={{ color: colors.text }}>{fmtPrice(last?.close)}</span>
            </span>
            {avgVolume != null && (
              <span>
                AVG VOL:<span style={{ color: colors.text }}>{fmtVol(avgVolume)}</span>
              </span>
            )}
            {periodPct != null && (
              <span style={{ color: periodTrend ? colors.positive : colors.negative }}>
                {periodTrend ? "▲" : "▼"}
                {Math.abs(periodPct).toFixed(2)}%
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
