"use client";

import { useAtom, useAtomValue } from "jotai";
import { BarChart2, LineChart, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useQuery } from "@tanstack/react-query";
import { chartTypeAtom, currentViewAtom, isDarkModeAtom } from "../atoms";
import { bloombergColors } from "../lib/theme-config";
import { ModularChart, IndicatorPicker, useChartIndicators, useChartTimeframe, ChartTimeframeBar, PERIOD_TO_YF } from "../chart";
import type { OhlcvBar, IndicatorRegistryEntry } from "../chart";

// ── Types ────────────────────────────────────────────────────────────────────

interface CryptoCoin {
  id: string;
  name: string;
  symbol: string;
  price: number;
  change: number | null;
  pctChange: number | null;
  marketCap: number | null;
  prevClose: number | null;
}

interface CryptoOverview {
  coins: CryptoCoin[];
}

interface HistoryPoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchCryptoOverview(): Promise<CryptoOverview> {
  const res = await fetch("/api/crypto?type=overview");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchCryptoHistory(coin: string, yfPeriod: string, interval: string): Promise<HistoryPoint[]> {
  const res = await fetch(`/api/crypto?type=history&coin=${encodeURIComponent(coin)}&period=${yfPeriod}&interval=${interval}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.history ?? [];
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1000) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

function fmtMcap(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  return v.toLocaleString();
}

function fmtVol(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

function fmtDate(d: string, timePeriod: string): string {
  const dt = new Date(d);
  if (timePeriod === "1d") return dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (timePeriod === "5d") return dt.toLocaleDateString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatChartDate(t: string | number): string {
  if (typeof t === "number") {
    return new Date(t * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }
  return t.slice(0, 7);
}

// ── Main Component ───────────────────────────────────────────────────────────

export function CryptoView({ onBack }: { onBack: () => void }) {
  const [isDarkMode] = useAtom(isDarkModeAtom);
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  const currentView = useAtomValue(currentViewAtom);
  const isActive = currentView === "crypto";

  const [selectedCoin, setSelectedCoin] = useState<string>("BTC");
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
    showFootprint,
    toggleFootprint,
    isCryptoSymbol,
    footprintLoading,
  } = useChartIndicators({ symbol: selectedCoin, barInterval, chartType });

  // ── Queries ──────────────────────────────────────────────────────────────

  const {
    data: overview,
    isLoading: overviewLoading,
    refetch: refetchOverview,
  } = useQuery({
    queryKey: ["crypto", "overview"],
    queryFn: fetchCryptoOverview,
    enabled: isActive,
    staleTime: 60_000,
    refetchInterval: isActive ? 120_000 : false,
  });

  const {
    data: history,
    isLoading: historyLoading,
  } = useQuery({
    queryKey: ["crypto", "history", selectedCoin, timePeriod, barInterval],
    queryFn: () => fetchCryptoHistory(selectedCoin, PERIOD_TO_YF[timePeriod], barInterval),
    enabled: isActive && !!selectedCoin,
    staleTime: 60_000,
  });

  // Auto-select BTC on load
  useEffect(() => {
    if (overview?.coins?.length && !overview.coins.find((c) => c.id === selectedCoin)) {
      setSelectedCoin(overview.coins[0].id);
    }
  }, [overview, selectedCoin]);

  const coins = overview?.coins ?? [];
  const selected = coins.find((c) => c.id === selectedCoin);
  const isUp = (selected?.pctChange ?? 0) >= 0;
  const priceColor = isUp ? "#00FF00" : "#FF0000";
  const chartColor = isUp ? "#00FF00" : "#FF0000";

  // ── Chart data stats ─────────────────────────────────────────────────────

  const chartData = history ?? [];
  const lastPoint = chartData[chartData.length - 1];
  const stats = chartData.length > 0
    ? {
        open: chartData[0].open,
        high: Math.max(...chartData.map((d) => d.high)),
        low: Math.min(...chartData.map((d) => d.low)),
        close: lastPoint.close,
        volume: chartData.reduce((s, d) => s + d.volume, 0),
      }
    : null;

  // ── OHLCV data for candlestick mode ─────────────────────────────────────
  const ohlcvData: OhlcvBar[] = useMemo(() => {
    if (!chartData.length) return [];
    return chartData
      .filter((q) => q.open != null && q.high != null && q.low != null)
      .map((q) => ({
        time: isIntraday
          ? Math.floor(new Date(q.date).getTime() / 1000)
          : q.date.slice(0, 10),
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume ?? undefined,
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
    <div className="h-full overflow-hidden flex flex-col" style={{ backgroundColor: "#000", color: colors.text }}>
      {/* ── Body: two columns ───────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">
        {/* ── Left Panel: Market Overview ──────────────────────────────────── */}
        <div
          className="flex flex-col border-r shrink-0"
          style={{ width: "35%", borderColor: colors.border, backgroundColor: "#050505" }}
        >
          {/* List header */}
          <div
            className="flex items-center justify-between px-3 py-1.5 border-b shrink-0"
            style={{ borderColor: colors.border }}
          >
            <span className="text-[10px] font-bold font-mono tracking-wider" style={{ color: colors.accent }}>
              CRYPTO MARKET
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
                {coins.length} coins
              </span>
              <button
                type="button"
                onClick={() => refetchOverview()}
                className="hover:opacity-70"
                style={{ color: colors.textSecondary }}
              >
                <RefreshCw size={10} />
              </button>
            </div>
          </div>

          {/* Table header */}
          <div
            className="grid px-3 py-1 border-b shrink-0"
            style={{
              gridTemplateColumns: "24px 56px 1fr 60px 72px",
              borderColor: colors.border,
            }}
          >
            <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>#</span>
            <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>COIN</span>
            <span className="text-[9px] font-mono text-right" style={{ color: colors.textSecondary }}>PRICE</span>
            <span className="text-[9px] font-mono text-right" style={{ color: colors.textSecondary }}>24H%</span>
            <span className="text-[9px] font-mono text-right" style={{ color: colors.textSecondary }}>MCAP</span>
          </div>

          {/* Scrollable list */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {overviewLoading && (
              <div className="flex items-center justify-center py-8">
                <span className="text-[10px] font-mono animate-pulse" style={{ color: colors.textSecondary }}>
                  Loading...
                </span>
              </div>
            )}
            {coins.map((coin, idx) => {
              const active = coin.id === selectedCoin;
              const up = (coin.pctChange ?? 0) >= 0;
              return (
                <button
                  key={coin.id}
                  type="button"
                  onClick={() => setSelectedCoin(coin.id)}
                  className="w-full grid px-3 py-1 text-left transition-colors"
                  style={{
                    gridTemplateColumns: "24px 56px 1fr 60px 72px",
                    backgroundColor: active ? (isDarkMode ? colors.accent + "18" : colors.accent + "22") : "transparent",
                    borderLeft: active ? `2px solid ${colors.accent}` : "2px solid transparent",
                  }}
                  onMouseEnter={(e) => {
                    if (!active) (e.currentTarget as HTMLElement).style.backgroundColor = "#111";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
                  }}
                >
                  <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
                    {idx + 1}
                  </span>
                  <span className="text-[10px] font-mono font-bold" style={{ color: active ? colors.accent : colors.text }}>
                    {coin.id}
                  </span>
                  <span className="text-[10px] font-mono text-right" style={{ color: colors.text }}>
                    ${fmtPrice(coin.price)}
                  </span>
                  <span
                    className="text-[10px] font-mono text-right font-bold"
                    style={{ color: up ? "#00FF00" : "#FF0000" }}
                  >
                    {up ? "+" : ""}{(coin.pctChange ?? 0).toFixed(2)}%
                  </span>
                  <span className="text-[9px] font-mono text-right" style={{ color: colors.textSecondary }}>
                    {fmtMcap(coin.marketCap)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Right Panel: Detail ──────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ backgroundColor: "#000" }}>
          {selected ? (
            <>
              {/* Coin header */}
              <div
                className="px-4 py-2 border-b shrink-0"
                style={{ borderColor: colors.border, backgroundColor: "#050505" }}
              >
                <div className="flex items-baseline gap-3">
                  <span className="text-[11px] font-mono font-bold tracking-wider" style={{ color: colors.accent }}>
                    {selected.name}
                  </span>
                  <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
                    {selected.symbol}
                  </span>
                </div>
                <div className="flex items-baseline gap-4 mt-1">
                  <span className="text-[18px] font-mono font-bold" style={{ color: priceColor }}>
                    ${fmtPrice(selected.price)}
                  </span>
                  <span
                    className="text-[11px] font-mono font-bold"
                    style={{ color: priceColor }}
                  >
                    {isUp ? "+" : ""}{(selected.pctChange ?? 0).toFixed(2)}%
                  </span>
                  <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
                    MCap {fmtMcap(selected.marketCap)}
                  </span>
                  <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
                    Prev {fmtPrice(selected.prevClose)}
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
                  <span className="text-[8px] font-mono ml-auto" style={{ color: colors.textSecondary }}>
                    {formatChartDate(ohlcvData[0].time)} – {formatChartDate(ohlcvData[ohlcvData.length - 1].time)}
                    <span className="ml-1 opacity-50">({ohlcvData.length} bars)</span>
                  </span>
                )}
                {/* Chart type toggle */}
                <div className="flex items-center gap-1">
                  <div className="flex border overflow-hidden" style={{ borderColor: colors.border }}>
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
                    onAdd={(entry) => addChartIndicator(entry)}
                    onRemove={removeChartIndicator}
                  />
                  {ohlcvData.some(d => (d.volume ?? 0) > 0) && (
                    <button
                      type="button"
                      onClick={toggleVolumeProfile}
                      title="Toggle Volume Profile"
                      className="px-1.5 py-0.5 border font-mono text-[9px] transition-colors"
                      style={{
                        borderColor: showVolumeProfile ? colors.accent : colors.border,
                        backgroundColor: showVolumeProfile ? `${colors.accent}22` : "transparent",
                        color: showVolumeProfile ? colors.accent : colors.textSecondary,
                      }}
                    >
                      VP
                    </button>
                  )}
                  {isCryptoSymbol && (
                    <button
                      type="button"
                      onClick={toggleFootprint}
                      title="Order Footprint (Binance)"
                      className="px-1.5 py-0.5 border font-mono text-[9px] transition-colors"
                      style={{
                        borderColor: showFootprint ? "#ff9800" : colors.border,
                        backgroundColor: showFootprint ? "#ff980022" : "transparent",
                        color: showFootprint ? "#ff9800" : colors.textSecondary,
                      }}
                    >
                      FP{footprintLoading ? "…" : ""}
                    </button>
                  )}
                </div>
              )}

              {/* Chart area */}
              <div className="flex-1 min-h-0 flex flex-col px-2 py-1">
                {historyLoading ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-2">
                    <span className="text-[10px] font-mono animate-pulse" style={{ color: colors.textSecondary }}>
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
                  <div className="flex-1 flex items-center justify-center">
                    <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
                      No data available
                    </span>
                  </div>
                ) : chartType === "candle" ? (
                  /* ── Candlestick (Modular Chart) ── */
                  <div className="flex-1 min-h-0">
                    <ModularChart
                      data={ohlcvData}
                      isDark={isDarkMode}
                      colors={colors}
                      height={280}
                      indicators={chartIndicators}
                      overlays={chartOverlays}
                      eventMarkers={eventMarkers}
                    />
                  </div>
                ) : (
                  <>
                    {/* Price chart — 70% */}
                    <div style={{ flex: "7 1 0", minHeight: 0 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                          <defs>
                            <linearGradient id="cryptoGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={chartColor} stopOpacity={0.3} />
                              <stop offset="100%" stopColor={chartColor} stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke={colors.border} strokeOpacity={0.3} />
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
                            tickFormatter={(v) => `$${fmtPrice(v)}`}
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
                            formatter={(value: unknown) => [`$${fmtPrice(Number(value))}`, "Price"]}
                          />
                          <Area
                            type="monotone"
                            dataKey="close"
                            stroke={chartColor}
                            strokeWidth={1.5}
                            fill="url(#cryptoGradient)"
                            dot={false}
                            isAnimationActive={false}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>

                    {/* Volume bars — 30% */}
                    <div style={{ flex: "3 1 0", minHeight: 0 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                          <XAxis
                            dataKey="date"
                            tickFormatter={(d) => fmtDate(d, timePeriod)}
                            tick={{ fontSize: 8, fill: colors.textSecondary, fontFamily: "monospace" }}
                            axisLine={{ stroke: colors.border }}
                            tickLine={false}
                            minTickGap={40}
                          />
                          <YAxis
                            tick={{ fontSize: 8, fill: colors.textSecondary, fontFamily: "monospace" }}
                            axisLine={{ stroke: colors.border }}
                            tickLine={false}
                            tickFormatter={(v) => fmtVol(v)}
                            width={72}
                            domain={[0, "auto"]}
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
                            formatter={(value: unknown) => [fmtVol(Number(value)), "Volume"]}
                          />
                          <Bar dataKey="volume" isAnimationActive={false}>
                            {chartData.map((entry, i) => (
                              <Cell
                                key={i}
                                fill={
                                  i > 0 && entry.close >= chartData[i - 1].close
                                    ? "#00FF0044"
                                    : "#FF000044"
                                }
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </>
                )}
              </div>

              {/* Bottom stats */}
              {stats && (
                <div
                  className="grid grid-cols-5 gap-px px-4 py-2 border-t shrink-0"
                  style={{ borderColor: colors.border, backgroundColor: "#050505" }}
                >
                  {[
                    { label: "OPEN", value: `$${fmtPrice(stats.open)}` },
                    { label: "HIGH", value: `$${fmtPrice(stats.high)}` },
                    { label: "LOW", value: `$${fmtPrice(stats.low)}` },
                    { label: "CLOSE", value: `$${fmtPrice(stats.close)}` },
                    { label: "VOLUME", value: fmtVol(stats.volume) },
                  ].map((s) => (
                    <div key={s.label} className="text-center">
                      <div className="text-[8px] font-mono tracking-wider" style={{ color: colors.textSecondary }}>
                        {s.label}
                      </div>
                      <div className="text-[10px] font-mono font-bold" style={{ color: colors.text }}>
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
                {overviewLoading ? "Loading..." : "Select a coin from the list"}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
