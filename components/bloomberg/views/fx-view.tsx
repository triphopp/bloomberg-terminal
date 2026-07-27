"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtom, useAtomValue } from "jotai";
import { BarChart2, LineChart, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { chartTypeAtom, currentViewAtom, isDarkModeAtom } from "../atoms";
import {
  ChartTimeframeBar,
  IndicatorPicker,
  ModularChart,
  PERIOD_TO_YF,
  useChartIndicators,
  useChartTimeframe,
} from "../chart";
import type { IndicatorRegistryEntry, OhlcvBar } from "../chart";
import { bloombergColors } from "../lib/theme-config";

// ── Types ────────────────────────────────────────────────────────────────────

interface FxPair {
  id: string;
  symbol: string;
  price: number;
  change: number | null;
  pctChange: number | null;
  prevClose: number | null;
}

interface FxOverview {
  pairs: FxPair[];
}

interface HistoryPoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchFxOverview(): Promise<FxOverview> {
  const res = await fetch("/api/fx?type=overview");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchFxHistory(
  symbol: string,
  period: string,
  interval: string
): Promise<HistoryPoint[]> {
  const res = await fetch(
    `/api/fx?type=history&pair=${encodeURIComponent(symbol)}&period=${period}&interval=${interval}`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.history ?? [];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtRate(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toFixed(4);
}

function fmtDate(d: string, timePeriod: string): string {
  const dt = new Date(d);
  if (timePeriod === "1d")
    return dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (timePeriod === "5d")
    return dt.toLocaleDateString("en-US", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatChartDate(t: string | number): string {
  if (typeof t === "number") {
    return new Date(t * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }
  return t.slice(0, 7);
}

// ── Component ────────────────────────────────────────────────────────────────

export function FxView({ onBack }: { onBack: () => void }) {
  const [isDarkMode] = useAtom(isDarkModeAtom);
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  const currentView = useAtomValue(currentViewAtom);
  const isActive = currentView === "fx";

  const [selectedPair, setSelectedPair] = useState<string>("EURUSD=X");
  const [chartType, setChartType] = useAtom(chartTypeAtom);

  const { timePeriod, barInterval, isIntraday, handlePeriodChange, handleIntervalChange } =
    useChartTimeframe({ defaultPeriod: "3m", defaultInterval: "1d" });

  // ── Modular chart indicator system ──
  const {
    indicators: chartIndicators,
    overlays: chartOverlays,
    eventMarkers,
    showVolumeProfile,
    addIndicator: addChartIndicator,
    removeIndicator: removeChartIndicator,
    toggleVolumeProfile,
  } = useChartIndicators({ symbol: selectedPair, barInterval, chartType });

  // ── Queries ──────────────────────────────────────────────────────────────

  const {
    data: overview,
    isLoading: overviewLoading,
    refetch: refetchOverview,
  } = useQuery({
    queryKey: ["fx", "overview"],
    queryFn: fetchFxOverview,
    enabled: isActive,
    staleTime: 60_000,
    refetchInterval: isActive ? 120_000 : false,
  });

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ["fx", "history", selectedPair, timePeriod, barInterval],
    queryFn: () => fetchFxHistory(selectedPair, PERIOD_TO_YF[timePeriod], barInterval),
    enabled: isActive && !!selectedPair,
    staleTime: 60_000,
  });

  // Auto-select first pair on load
  useEffect(() => {
    if (overview?.pairs?.length && !overview.pairs.find((p) => p.symbol === selectedPair)) {
      setSelectedPair(overview.pairs[0].symbol);
    }
  }, [overview, selectedPair]);

  const pairs = overview?.pairs ?? [];
  const selected = pairs.find((p) => p.symbol === selectedPair);
  const isUp = (selected?.pctChange ?? 0) >= 0;
  const rateColor = isUp ? "#00FF00" : "#FF0000";

  const chartData = history ?? [];
  const stats =
    chartData.length > 0
      ? {
          open: chartData[0].open,
          high: Math.max(...chartData.map((d) => d.high)),
          low: Math.min(...chartData.map((d) => d.low)),
          close: chartData[chartData.length - 1].close,
        }
      : null;

  // ── OHLCV data for candlestick mode ─────────────────────────────────────
  const ohlcvData: OhlcvBar[] = useMemo(() => {
    if (!chartData.length) return [];
    return chartData
      .filter((q) => q.open != null && q.high != null && q.low != null)
      .map((q) => ({
        time: isIntraday ? Math.floor(new Date(q.date).getTime() / 1000) : q.date.slice(0, 10),
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
      }))
      .sort((a, b) =>
        typeof a.time === "number"
          ? (a.time as number) - (b.time as number)
          : (a.time as string).localeCompare(b.time as string)
      )
      .filter((bar, i, arr) => i === 0 || bar.time !== arr[i - 1].time);
  }, [chartData, isIntraday]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className="h-full overflow-hidden flex flex-col"
      style={{ backgroundColor: "#000", color: colors.text }}
    >
      {/* ── Body: two columns ───────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">
        {/* ── Left Panel: Pair List ──────────────────────────────────────── */}
        <div
          className="flex flex-col border-r shrink-0"
          style={{ width: "32%", borderColor: colors.border, backgroundColor: "#050505" }}
        >
          {/* Table header */}
          <div
            className="grid px-3 py-1 border-b shrink-0"
            style={{
              gridTemplateColumns: "80px 1fr 72px 64px",
              borderColor: colors.border,
            }}
          >
            <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
              PAIR
            </span>
            <span
              className="text-[9px] font-mono text-right"
              style={{ color: colors.textSecondary }}
            >
              RATE
            </span>
            <span
              className="text-[9px] font-mono text-right"
              style={{ color: colors.textSecondary }}
            >
              CHG
            </span>
            <span
              className="text-[9px] font-mono text-right"
              style={{ color: colors.textSecondary }}
            >
              %CHG
            </span>
          </div>

          {/* Scrollable list */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {overviewLoading && (
              <div className="flex items-center justify-center py-8">
                <span
                  className="text-[10px] font-mono animate-pulse"
                  style={{ color: colors.textSecondary }}
                >
                  Loading...
                </span>
              </div>
            )}
            {pairs.map((pair) => {
              const active = pair.symbol === selectedPair;
              const up = (pair.pctChange ?? 0) >= 0;
              return (
                <button
                  key={pair.symbol}
                  type="button"
                  onClick={() => setSelectedPair(pair.symbol)}
                  className="w-full grid px-3 py-1.5 text-left transition-colors"
                  style={{
                    gridTemplateColumns: "80px 1fr 72px 64px",
                    backgroundColor: active
                      ? isDarkMode
                        ? `${colors.accent}18`
                        : `${colors.accent}22`
                      : "transparent",
                    borderLeft: active ? `2px solid ${colors.accent}` : "2px solid transparent",
                  }}
                  onMouseEnter={(e) => {
                    if (!active) (e.currentTarget as HTMLElement).style.backgroundColor = "#111";
                  }}
                  onMouseLeave={(e) => {
                    if (!active)
                      (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
                  }}
                >
                  <span
                    className="text-[10px] font-mono font-bold"
                    style={{ color: active ? colors.accent : colors.text }}
                  >
                    {pair.id}
                  </span>
                  <span className="text-[10px] font-mono text-right" style={{ color: colors.text }}>
                    {fmtRate(pair.price)}
                  </span>
                  <span
                    className="text-[10px] font-mono text-right"
                    style={{ color: up ? "#00FF00" : "#FF0000" }}
                  >
                    {up ? "+" : ""}
                    {(pair.change ?? 0).toFixed(4)}
                  </span>
                  <span
                    className="text-[10px] font-mono text-right font-bold"
                    style={{ color: up ? "#00FF00" : "#FF0000" }}
                  >
                    {up ? "+" : ""}
                    {(pair.pctChange ?? 0).toFixed(2)}%
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Right Panel: Detail + Chart ─────────────────────────────────── */}
        <div
          className="flex-1 flex flex-col min-h-0 overflow-hidden"
          style={{ backgroundColor: "#000" }}
        >
          {selected ? (
            <>
              {/* Pair header */}
              <div
                className="px-4 py-2 border-b shrink-0"
                style={{ borderColor: colors.border, backgroundColor: "#050505" }}
              >
                <div className="flex items-baseline gap-3">
                  <span
                    className="text-[13px] font-mono font-bold tracking-wider"
                    style={{ color: colors.accent }}
                  >
                    {selected.id}
                  </span>
                  <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
                    {selected.symbol}
                  </span>
                </div>
                <div className="flex items-baseline gap-4 mt-1">
                  <span className="text-[20px] font-mono font-bold" style={{ color: rateColor }}>
                    {fmtRate(selected.price)}
                  </span>
                  <span className="text-[11px] font-mono font-bold" style={{ color: rateColor }}>
                    {isUp ? "+" : ""}
                    {(selected.change ?? 0).toFixed(4)}
                  </span>
                  <span className="text-[11px] font-mono font-bold" style={{ color: rateColor }}>
                    ({isUp ? "+" : ""}
                    {(selected.pctChange ?? 0).toFixed(3)}%)
                  </span>
                  <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
                    Prev {fmtRate(selected.prevClose)}
                  </span>
                </div>
              </div>

              {/* Timeframe + Chart type toggle */}
              <div
                className="flex items-center justify-between gap-2 px-4 py-1.5 border-b shrink-0"
                style={{ borderColor: colors.border, backgroundColor: "#050505" }}
              >
                <ChartTimeframeBar
                  timePeriod={timePeriod}
                  barInterval={barInterval}
                  chartType={chartType}
                  colors={colors}
                  onPeriodChange={(p) => handlePeriodChange(p, chartType)}
                  onIntervalChange={handleIntervalChange}
                />
                {ohlcvData.length > 0 && (
                  <span
                    className="text-[8px] font-mono ml-auto"
                    style={{ color: colors.textSecondary }}
                  >
                    {formatChartDate(ohlcvData[0].time)} –{" "}
                    {formatChartDate(ohlcvData[ohlcvData.length - 1].time)}
                    <span className="ml-1 opacity-50">({ohlcvData.length} bars)</span>
                  </span>
                )}
                {/* Chart type toggle */}
                <div className="flex items-center gap-1">
                  <div
                    className="flex border overflow-hidden"
                    style={{ borderColor: colors.border }}
                  >
                    <button
                      type="button"
                      onClick={() => setChartType("area")}
                      className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-mono transition-colors"
                      style={{
                        backgroundColor: chartType === "area" ? colors.accent : "transparent",
                        color: chartType === "area" ? "#000" : colors.textSecondary,
                      }}
                    >
                      <LineChart className="h-2.5 w-2.5" /> AREA
                    </button>
                    <button
                      type="button"
                      onClick={() => setChartType("candle")}
                      className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-mono transition-colors border-l"
                      style={{
                        borderColor: colors.border,
                        backgroundColor: chartType === "candle" ? colors.accent : "transparent",
                        color: chartType === "candle" ? "#000" : colors.textSecondary,
                      }}
                    >
                      <BarChart2 className="h-2.5 w-2.5" /> CANDLE
                    </button>
                  </div>
                </div>
              </div>

              {/* Indicator picker (candle mode) */}
              {chartType === "candle" && (
                <div
                  className="flex items-center gap-2 px-4 py-1 border-b shrink-0"
                  style={{ borderColor: colors.border, backgroundColor: "#050505" }}
                >
                  <IndicatorPicker
                    colors={colors}
                    activeIndicators={chartIndicators}
                    onAdd={addChartIndicator}
                    onRemove={removeChartIndicator}
                  />
                </div>
              )}

              {/* Chart */}
              <div className="flex-1 min-h-0 px-2 py-1">
                {historyLoading ? (
                  <div className="h-full flex flex-col items-center justify-center gap-2">
                    <span
                      className="text-[10px] font-mono animate-pulse"
                      style={{ color: colors.textSecondary }}
                    >
                      {timePeriod === "max"
                        ? "Loading full history… this may take 10–30s"
                        : timePeriod === "5y"
                          ? "Loading 5-year history…"
                          : "Loading chart…"}
                    </span>
                    {timePeriod === "max" && (
                      <span className="text-[8px] font-mono" style={{ color: "#424242" }}>
                        Fetching all available data from Yahoo Finance
                      </span>
                    )}
                  </div>
                ) : chartData.length === 0 ? (
                  <div className="h-full flex items-center justify-center">
                    <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
                      No data available
                    </span>
                  </div>
                ) : chartType === "candle" ? (
                  <ModularChart
                    data={ohlcvData}
                    isDark={isDarkMode}
                    colors={colors}
                    height={260}
                    indicators={chartIndicators}
                    overlays={chartOverlays}
                    eventMarkers={eventMarkers}
                  />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                      <defs>
                        <linearGradient id="fxGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={rateColor} stopOpacity={0.25} />
                          <stop offset="100%" stopColor={rateColor} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke={colors.border}
                        strokeOpacity={0.3}
                      />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(d) => fmtDate(d, timePeriod)}
                        tick={{ fontSize: 9, fill: colors.textSecondary, fontFamily: "monospace" }}
                        axisLine={{ stroke: colors.border }}
                        tickLine={false}
                        minTickGap={40}
                      />
                      <YAxis
                        domain={["auto", "auto"]}
                        tick={{ fontSize: 9, fill: colors.textSecondary, fontFamily: "monospace" }}
                        axisLine={{ stroke: colors.border }}
                        tickLine={false}
                        tickFormatter={(v) => v.toFixed(4)}
                        width={72}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#111",
                          border: `1px solid ${colors.border}`,
                          borderRadius: 0,
                          fontFamily: "monospace",
                          fontSize: 10,
                        }}
                        labelStyle={{ color: colors.textSecondary, fontSize: 9 }}
                        labelFormatter={(d) => fmtDate(d as string, timePeriod)}
                        formatter={(value: unknown) => [Number(value).toFixed(4), "Rate"]}
                      />
                      <Area
                        type="monotone"
                        dataKey="close"
                        stroke={rateColor}
                        strokeWidth={1.5}
                        fill="url(#fxGradient)"
                        dot={false}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* Bottom stats */}
              {stats && (
                <div
                  className="grid grid-cols-4 gap-px px-4 py-2 border-t shrink-0"
                  style={{ borderColor: colors.border, backgroundColor: "#050505" }}
                >
                  {[
                    { label: "OPEN", value: fmtRate(stats.open) },
                    { label: "HIGH", value: fmtRate(stats.high) },
                    { label: "LOW", value: fmtRate(stats.low) },
                    { label: "CLOSE", value: fmtRate(stats.close) },
                  ].map((s) => (
                    <div key={s.label} className="text-center">
                      <div
                        className="text-[8px] font-mono tracking-wider"
                        style={{ color: colors.textSecondary }}
                      >
                        {s.label}
                      </div>
                      <div
                        className="text-[11px] font-mono font-bold"
                        style={{ color: colors.text }}
                      >
                        {s.value}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
                {overviewLoading ? "Loading..." : "Select a pair from the list"}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
