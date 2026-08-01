"use client";

import { useAtom } from "jotai";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { isDarkModeAtom } from "../atoms";
import { useCreditData, useCreditRefresh } from "../hooks/useCreditData";
import type { CreditData, CreditSignal, CrisisLevel } from "../hooks/useCreditData";
import { useTabShortcuts } from "../hooks/useTabShortcuts";
import { bloombergColors } from "../lib/theme-config";

// ── Tab type ──────────────────────────────────────────────────────────────────

type CreditTab = "overview" | "spreads" | "stress" | "consumer";

// ── Signal keys by tab ────────────────────────────────────────────────────────

const SPREAD_KEYS = ["hy_spread", "ig_spread", "em_hy_spread", "ted_spread"] as const;
const STRESS_KEYS = ["vix", "stl_fsi", "nfci"] as const;
const CONSUMER_KEYS = [
  "breakeven_5y",
  "breakeven_10y",
  "mortgage_30y",
  "cc_delinquency",
  "mtg_delinquency",
] as const;

// Signals that have a threshold (shown in overview alert grid)
const SIGNAL_KEYS = [
  "hy_spread",
  "ig_spread",
  "em_hy_spread",
  "ted_spread",
  "vix",
  "stl_fsi",
  "nfci",
  "yield_10y2y",
  "yield_10y3m",
] as const;
type SignalKey = (typeof SIGNAL_KEYS)[number];

// ── Level config ──────────────────────────────────────────────────────────────

const LEVEL_CFG = {
  0: {
    label: "NORMAL",
    color: "#4caf50",
    bg_dark: "#051a05",
    bg_light: "#f0fff0",
    Icon: ShieldCheck,
  },
  1: {
    label: "WATCH",
    color: "#ffc107",
    bg_dark: "#1a1500",
    bg_light: "#fffde0",
    Icon: ShieldAlert,
  },
  2: {
    label: "WARNING",
    color: "#ff9800",
    bg_dark: "#1a0c00",
    bg_light: "#fff3e0",
    Icon: AlertTriangle,
  },
  3: {
    label: "CRISIS ALERT",
    color: "#ef5350",
    bg_dark: "#1a0505",
    bg_light: "#fff0f0",
    Icon: XCircle,
  },
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string) {
  if (!d) return "";
  const parts = d.split("-");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const mon = months[(Number.parseInt(parts[1]) - 1) % 12];
  // Show day only when it's meaningful (not the 1st, which is the monthly default)
  if (parts[2] && parts[2] !== "01") return `${mon} ${Number.parseInt(parts[2])}`;
  return `${mon} '${parts[0].slice(2)}`;
}

function fmtVal(v: number | null | undefined, unit: string) {
  if (v == null) return "—";
  const n = Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1);
  return unit === "bps" ? `${n} bps` : unit === "%" ? `${n}%` : n;
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function TabBtn({
  active,
  onClick,
  label,
  accent,
  text,
  border,
  shortcutN,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  accent: string;
  text: string;
  border: string;
  shortcutN?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 px-3 py-1 text-xs font-mono font-bold border tracking-wider transition-colors"
      style={{
        borderColor: active ? accent : border,
        backgroundColor: active ? accent : "transparent",
        color: active ? "#000" : text,
      }}
      title={shortcutN ? `Alt+${shortcutN}` : undefined}
    >
      {shortcutN != null && (
        <span
          className="text-[8px] opacity-40 hidden sm:inline"
          style={{ color: active ? "#000" : accent }}
        >
          ⌥{shortcutN}
        </span>
      )}
      {label}
    </button>
  );
}

function SectionHeader({
  title,
  sub,
  colors,
}: { title: string; sub?: string; colors: typeof bloombergColors.dark }) {
  return (
    <div className="flex items-baseline gap-3 mb-2">
      <span className="text-[10px] font-bold tracking-widest" style={{ color: colors.accent }}>
        {title}
      </span>
      {sub && (
        <span className="text-[10px]" style={{ color: colors.textSecondary }}>
          {sub}
        </span>
      )}
    </div>
  );
}

// ── Crisis level banner ───────────────────────────────────────────────────────

function CrisisBanner({
  data,
  isDark,
  colors,
}: { data: CreditData; isDark: boolean; colors: typeof bloombergColors.dark }) {
  const cfg = LEVEL_CFG[data.level];
  const bg = isDark ? cfg.bg_dark : cfg.bg_light;
  const Icon = cfg.Icon;

  if (data.level < 2) return null;

  return (
    <div
      className="flex items-start gap-2 p-2 border mb-2"
      style={{
        borderColor: cfg.color,
        backgroundColor: bg,
        animation: data.level === 3 ? "pulse 2s cubic-bezier(0.4,0,0.6,1) infinite" : undefined,
      }}
    >
      <Icon className="h-5 w-5 shrink-0 mt-0.5" style={{ color: cfg.color }} />
      <div>
        <div className="text-xs font-bold font-mono mb-1" style={{ color: cfg.color }}>
          ⚠ FINANCIAL STRESS LEVEL {data.level} — {cfg.label}
        </div>
        <div className="text-[10px] font-mono" style={{ color: colors.text }}>
          {data.triggered.length} signal{data.triggered.length !== 1 ? "s" : ""} above threshold:{" "}
          {data.triggered
            .map((k) => {
              const s = data.signals[k as keyof CreditData["signals"]];
              return s ? s.label : k;
            })
            .join(" · ")}
        </div>
      </div>
    </div>
  );
}

// ── Level gauge ───────────────────────────────────────────────────────────────

function LevelGauge({
  level,
  triggered,
  total,
  isDark,
  colors,
}: {
  level: CrisisLevel;
  triggered: number;
  total: number;
  isDark: boolean;
  colors: typeof bloombergColors.dark;
}) {
  const cfg = LEVEL_CFG[level];
  const Icon = cfg.Icon;

  return (
    <div
      className="border p-2 flex flex-col gap-2"
      style={{ borderColor: cfg.color, backgroundColor: isDark ? cfg.bg_dark : cfg.bg_light }}
    >
      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5" style={{ color: cfg.color }} />
        <span
          className="text-[10px] tracking-widest font-bold"
          style={{ color: colors.textSecondary }}
        >
          CRISIS LEVEL
        </span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold font-mono" style={{ color: cfg.color }}>
          {level}
        </span>
        <span className="text-sm font-bold font-mono" style={{ color: cfg.color }}>
          {cfg.label}
        </span>
      </div>

      <div className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
        {triggered} / {total} signals triggered
      </div>

      {/* Progress bars for each level */}
      <div className="flex gap-1 mt-1">
        {([0, 1, 2, 3] as CrisisLevel[]).map((l) => (
          <div
            key={l}
            className="flex-1 h-2"
            style={{
              backgroundColor: l <= level ? LEVEL_CFG[l].color : isDark ? "#2a2a2a" : "#e5e5e5",
              opacity: l <= level ? 1 : 0.4,
            }}
          />
        ))}
      </div>
      <div
        className="flex justify-between text-[8px] font-mono"
        style={{ color: colors.textSecondary }}
      >
        <span>NORMAL</span>
        <span>WATCH</span>
        <span>WARNING</span>
        <span>CRISIS</span>
      </div>
    </div>
  );
}

// ── Signal card (in overview grid) ───────────────────────────────────────────

function SignalCard({
  sig,
  isDark,
  colors,
}: {
  sig: CreditSignal;
  isDark: boolean;
  colors: typeof bloombergColors.dark;
}) {
  if (!sig)
    return (
      <div
        className="border p-2 opacity-40 font-mono text-center text-xs"
        style={{
          borderColor: colors.border,
          backgroundColor: colors.surface,
          color: colors.textSecondary,
        }}
      >
        No data
      </div>
    );

  const pct =
    sig.threshold != null ? Math.min(100, Math.abs(sig.value / sig.threshold) * 100) : null;

  const barColor = sig.triggered ? "#ef5350" : "#4caf50";
  const borderC = sig.triggered ? "#ef5350" : colors.border;

  return (
    <div
      className="border p-2 flex flex-col gap-1 font-mono"
      style={{ borderColor: borderC, backgroundColor: colors.surface }}
    >
      <div className="flex items-center justify-between">
        <span
          className="text-[9px] tracking-wide font-bold"
          style={{ color: colors.textSecondary }}
        >
          {sig.label.toUpperCase()}
        </span>
        {sig.triggered ? (
          <XCircle className="h-3.5 w-3.5 shrink-0" style={{ color: "#f87171" }} />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: "#4ade80" }} />
        )}
      </div>

      <div className="flex items-baseline gap-1">
        <span
          className="text-[11px] font-bold"
          style={{ color: sig.triggered ? "#ef5350" : colors.text }}
        >
          {fmtVal(sig.value, sig.unit)}
        </span>
      </div>

      {sig.threshold != null && (
        <>
          <div className="text-[9px]" style={{ color: colors.textSecondary }}>
            threshold: {fmtVal(sig.threshold, sig.unit)}
          </div>
          <div className="w-full h-1.5" style={{ backgroundColor: isDark ? "#2a2a2a" : "#e5e5e5" }}>
            <div
              className="h-full transition-all"
              style={{ width: `${pct ?? 0}%`, backgroundColor: barColor }}
            />
          </div>
        </>
      )}

      <div className="text-[9px]" style={{ color: colors.textSecondary }}>
        prev: {fmtVal(sig.prev, sig.unit)} · {fmtDate(sig.date)}
      </div>
    </div>
  );
}

// ── Time series chart ─────────────────────────────────────────────────────────

function SeriesChart({
  sig,
  isDark,
  colors,
  height = 200,
}: {
  sig: CreditSignal;
  isDark: boolean;
  colors: typeof bloombergColors.dark;
  height?: number;
}) {
  if (!sig || sig.series.length < 2) {
    return (
      <div
        className="flex items-center justify-center border"
        style={{ height, borderColor: colors.border, color: colors.textSecondary }}
      >
        <span className="text-xs font-mono">No data</span>
      </div>
    );
  }

  const chartData = [...sig.series].reverse().slice(-48);
  const lineColor = sig.triggered ? "#ef5350" : colors.accent;
  const gridColor = isDark ? "#2a2a2a" : "#e5e5e5";
  const ttStyle = {
    backgroundColor: isDark ? "#1a1a1a" : "#fff",
    border: `1px solid ${colors.border}`,
    fontSize: 11,
    fontFamily: "monospace",
  };

  return (
    <div
      className="border p-2"
      style={{ borderColor: colors.border, backgroundColor: colors.surface }}
    >
      <div className="flex items-center justify-between mb-1">
        <span
          className="text-[10px] font-bold tracking-wide font-mono"
          style={{ color: colors.accent }}
        >
          {sig.label.toUpperCase()}
        </span>
        <div className="flex items-center gap-2">
          <span
            className="text-[11px] font-bold font-mono"
            style={{ color: sig.triggered ? "#ef5350" : colors.text }}
          >
            {fmtVal(sig.value, sig.unit)}
          </span>
          {sig.triggered ? (
            <XCircle className="h-3.5 w-3.5" style={{ color: "#f87171" }} />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" style={{ color: "#4ade80" }} />
          )}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 15 }}>
          <defs>
            <linearGradient id={`cg-${sig.label.replace(/\s/g, "")}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={lineColor} stopOpacity={0.25} />
              <stop offset="95%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={gridColor} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 8, fontFamily: "monospace", fill: colors.textSecondary }}
            angle={-45}
            textAnchor="end"
            interval={Math.floor(chartData.length / 6)}
            tickFormatter={fmtDate}
          />
          <YAxis
            tick={{ fontSize: 9, fontFamily: "monospace", fill: colors.textSecondary }}
            domain={["auto", "auto"]}
            tickFormatter={(v) => (sig.unit === "bps" ? `${v}` : `${v}${sig.unit}`)}
            width={40}
          />
          <Tooltip
            formatter={(v: number) => [fmtVal(v, sig.unit), sig.label]}
            contentStyle={ttStyle}
            labelStyle={{ color: colors.text }}
          />
          {sig.threshold != null && (
            <ReferenceLine
              y={sig.threshold}
              stroke="#888"
              strokeDasharray="4 2"
              label={{
                value: `Threshold ${sig.threshold}${sig.unit === "bps" ? " bps" : sig.unit}`,
                position: "insideTopRight",
                fontSize: 8,
                fill: "#888",
              }}
            />
          )}
          {/* Zero line for FSI / NFCI / yield spreads */}
          {sig.threshold === 0 && <ReferenceLine y={0} stroke="#888" strokeDasharray="2 2" />}
          <Area
            type="monotone"
            dataKey="value"
            stroke={lineColor}
            strokeWidth={1.5}
            fill={`url(#cg-${sig.label.replace(/\s/g, "")})`}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── OVERVIEW tab ──────────────────────────────────────────────────────────────

function OverviewTab({
  data,
  isDark,
  colors,
}: { data: CreditData; isDark: boolean; colors: typeof bloombergColors.dark }) {
  const totalSignals = SIGNAL_KEYS.length;
  const triggered = data.triggered.length;

  return (
    <div className="space-y-3">
      <CrisisBanner data={data} isDark={isDark} colors={colors} />

      {/* Level gauge + quick stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="sm:col-span-1">
          <LevelGauge
            level={data.level}
            triggered={triggered}
            total={totalSignals}
            isDark={isDark}
            colors={colors}
          />
        </div>

        <div className="sm:col-span-2 grid grid-cols-2 gap-2">
          {/* Triggered signals list */}
          <div
            className="border p-2"
            style={{ borderColor: colors.border, backgroundColor: colors.surface }}
          >
            <div
              className="text-[9px] tracking-widest font-bold mb-1"
              style={{ color: colors.textSecondary }}
            >
              TRIGGERED SIGNALS
            </div>
            {triggered === 0 ? (
              <div
                className="flex items-center gap-1.5 text-[10px] font-mono"
                style={{ color: "#4ade80" }}
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> All clear
              </div>
            ) : (
              <div className="space-y-1">
                {data.triggered.map((k) => {
                  const s = data.signals[k as keyof CreditData["signals"]];
                  if (!s) return null;
                  return (
                    <div key={k} className="flex items-center gap-1.5 text-[10px] font-mono">
                      <XCircle className="h-3 w-3 shrink-0" style={{ color: "#f87171" }} />
                      <span style={{ color: colors.text }}>{s.label}</span>
                      <span className="ml-auto font-bold" style={{ color: "#f87171" }}>
                        {fmtVal(s.value, s.unit)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Key spread summary */}
          <div
            className="border p-2 space-y-1.5"
            style={{ borderColor: colors.border, backgroundColor: colors.surface }}
          >
            <div
              className="text-[9px] tracking-widest font-bold mb-2"
              style={{ color: colors.textSecondary }}
            >
              KEY SPREADS
            </div>
            {SPREAD_KEYS.map((k) => {
              const s = data.signals[k];
              if (!s) return null;
              return (
                <div key={k} className="flex items-center justify-between text-[10px] font-mono">
                  <span style={{ color: colors.textSecondary }}>{s.label}</span>
                  <span
                    className="font-bold"
                    style={{ color: s.triggered ? "#ef5350" : colors.text }}
                  >
                    {fmtVal(s.value, s.unit)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Signal cards grid */}
      <div>
        <SectionHeader title="STRESS SIGNALS" sub="signals with alert thresholds" colors={colors} />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
          {SIGNAL_KEYS.map((k) => (
            <SignalCard key={k} sig={data.signals[k]} isDark={isDark} colors={colors} />
          ))}
        </div>
      </div>

      {/* Data note */}
      <div
        className="flex items-center gap-2 p-2 border text-[10px] font-mono w-fit"
        style={{
          borderColor: colors.border,
          backgroundColor: colors.surface,
          color: colors.textSecondary,
        }}
      >
        <span>
          Source: <span style={{ color: colors.accent }}>FRED</span> (Federal Reserve Economic Data)
          · Level = signals above threshold
        </span>
      </div>
    </div>
  );
}

// ── SPREADS tab ───────────────────────────────────────────────────────────────

function SpreadsTab({
  data,
  isDark,
  colors,
}: { data: CreditData; isDark: boolean; colors: typeof bloombergColors.dark }) {
  return (
    <div className="space-y-2">
      <SectionHeader
        title="BOND SPREADS"
        sub="Option-Adjusted Spread (bps) — higher = more credit stress"
        colors={colors}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {SPREAD_KEYS.map((k) => (
          <SeriesChart key={k} sig={data.signals[k]} isDark={isDark} colors={colors} height={200} />
        ))}
      </div>

      {/* Spread comparison table */}
      <div>
        <SectionHeader title="SPREAD LEVELS" sub="current vs threshold" colors={colors} />
        <div className="border overflow-hidden" style={{ borderColor: colors.border }}>
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr style={{ backgroundColor: colors.surface, color: colors.textSecondary }}>
                <th className="text-left px-3 py-2">Indicator</th>
                <th className="text-right px-3 py-2">Current</th>
                <th className="text-right px-3 py-2">Prev</th>
                <th className="text-right px-3 py-2">Threshold</th>
                <th className="text-right px-3 py-2">% of Threshold</th>
                <th className="text-center px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {SPREAD_KEYS.map((k, i) => {
                const s = data.signals[k];
                if (!s) return null;
                const pctOfThreshold = s.threshold
                  ? Math.round((s.value / s.threshold) * 100)
                  : null;
                return (
                  <tr
                    key={k}
                    style={{
                      backgroundColor: i % 2 === 0 ? "transparent" : isDark ? "#0d0d0d" : "#f9f9f9",
                      borderTop: `1px solid ${colors.border}`,
                    }}
                  >
                    <td className="px-3 py-2" style={{ color: colors.text }}>
                      {s.label}
                    </td>
                    <td
                      className="px-3 py-2 text-right font-bold"
                      style={{ color: s.triggered ? "#ef5350" : colors.text }}
                    >
                      {fmtVal(s.value, s.unit)}
                    </td>
                    <td className="px-3 py-2 text-right" style={{ color: colors.textSecondary }}>
                      {fmtVal(s.prev, s.unit)}
                    </td>
                    <td className="px-3 py-2 text-right" style={{ color: colors.textSecondary }}>
                      {s.threshold != null ? fmtVal(s.threshold, s.unit) : "—"}
                    </td>
                    <td
                      className="px-3 py-2 text-right"
                      style={{
                        color:
                          pctOfThreshold != null && pctOfThreshold >= 80
                            ? "#ef5350"
                            : colors.textSecondary,
                      }}
                    >
                      {pctOfThreshold != null ? `${pctOfThreshold}%` : "—"}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {s.triggered ? (
                        <span className="font-bold" style={{ color: "#f87171" }}>
                          ⚠ TRIGGERED
                        </span>
                      ) : (
                        <span style={{ color: "#4ade80" }}>✓ OK</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── STRESS tab ────────────────────────────────────────────────────────────────

function StressTab({
  data,
  isDark,
  colors,
}: { data: CreditData; isDark: boolean; colors: typeof bloombergColors.dark }) {
  return (
    <div className="space-y-2">
      <SectionHeader
        title="FINANCIAL STRESS INDICATORS"
        sub="VIX · FSI · NFCI · Yield curve inversions"
        colors={colors}
      />

      {/* Yield curve spread status */}
      <div className="grid grid-cols-2 gap-2">
        {(["yield_10y2y", "yield_10y3m"] as const).map((k) => {
          const s = data.signals[k];
          if (!s) return null;
          const inverted = s.triggered;
          return (
            <div
              key={k}
              className="flex items-center gap-2 p-2 border font-mono"
              style={{
                borderColor: inverted ? "#ef5350" : "#4caf50",
                backgroundColor: inverted
                  ? isDark
                    ? "#1a0505"
                    : "#fff5f5"
                  : isDark
                    ? "#051a05"
                    : "#f5fff5",
              }}
            >
              {inverted ? (
                <TrendingDown className="h-5 w-5 shrink-0" style={{ color: "#f87171" }} />
              ) : (
                <TrendingUp className="h-5 w-5 shrink-0" style={{ color: "#4ade80" }} />
              )}
              <div>
                <div
                  className="text-xs font-bold"
                  style={{ color: inverted ? "#ef5350" : "#4caf50" }}
                >
                  {s.label}: {fmtVal(s.value, s.unit)} {inverted ? "⚠ INVERTED" : "✓ NORMAL"}
                </div>
                <div className="text-[9px]" style={{ color: colors.textSecondary }}>
                  Inversion = recession signal (6–18mo lead)
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Hint: yield curve detail in MACRO */}
      <div
        className="flex items-center gap-2 p-2 border text-[10px] font-mono"
        style={{
          borderColor: `${colors.accent}44`,
          backgroundColor: colors.surface,
          color: colors.textSecondary,
        }}
      >
        <span style={{ color: colors.accent }}>MACRO [6] → YIELD</span>
        <span>for full yield curve history, recession probability, and term premium</span>
      </div>

      {/* Stress index charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {STRESS_KEYS.map((k) => (
          <SeriesChart key={k} sig={data.signals[k]} isDark={isDark} colors={colors} height={180} />
        ))}
      </div>
    </div>
  );
}

// ── CONSUMER tab ──────────────────────────────────────────────────────────────

function ConsumerTab({
  data,
  isDark,
  colors,
}: { data: CreditData; isDark: boolean; colors: typeof bloombergColors.dark }) {
  return (
    <div className="space-y-2">
      <SectionHeader
        title="CONSUMER & HOUSING STRESS"
        sub="Breakeven inflation · Mortgage rate · Delinquency rates"
        colors={colors}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {CONSUMER_KEYS.map((k) => (
          <SeriesChart key={k} sig={data.signals[k]} isDark={isDark} colors={colors} height={190} />
        ))}
      </div>
    </div>
  );
}

// ── Main CreditView ───────────────────────────────────────────────────────────

export function CreditView({ onBack }: { onBack: () => void }) {
  const [isDark] = useAtom(isDarkModeAtom);
  const colors = isDark ? bloombergColors.dark : bloombergColors.light;

  const [activeTab, setActiveTab] = useState<CreditTab>("overview");
  const { data, isLoading, error } = useCreditData();
  const refresh = useCreditRefresh();

  const tabs: { id: CreditTab; label: string }[] = [
    { id: "overview", label: "OVERVIEW" },
    { id: "spreads", label: "SPREADS" },
    { id: "stress", label: "STRESS" },
    { id: "consumer", label: "CONSUMER" },
  ];

  useTabShortcuts(tabs, setActiveTab);

  const level = data?.level ?? 0;
  const levelCfg = LEVEL_CFG[level];

  return (
    <div
      className="h-full overflow-y-auto"
      style={{ backgroundColor: colors.background, color: colors.text }}
    >
      {/* Tab bar + level badge + refresh (no separate header row) */}
      <div
        className="flex items-center gap-1 px-2 py-1.5 border-b"
        style={{ borderColor: colors.border }}
      >
        <div className="flex gap-1 flex-1">
          {tabs.map((t, i) => (
            <TabBtn
              key={t.id}
              active={activeTab === t.id}
              onClick={() => setActiveTab(t.id)}
              label={t.label}
              accent={colors.accent}
              text={colors.text}
              border={colors.border}
              shortcutN={i + 1}
            />
          ))}
        </div>
        {data && (
          <div
            className="flex items-center gap-1 px-2 py-0.5 border text-[9px] font-mono font-bold shrink-0"
            style={{ borderColor: levelCfg.color, color: levelCfg.color }}
          >
            <span>L{level}</span>
            <span>·</span>
            <span>{levelCfg.label}</span>
          </div>
        )}
        <button
          type="button"
          onClick={refresh}
          className="flex items-center gap-1 text-[10px] font-mono hover:opacity-70 shrink-0"
          style={{ color: colors.accent }}
          title="Force-refresh credit series cache"
        >
          <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Content */}
      <div className="p-2">
        {isLoading && !data && (
          <div
            className="flex items-center justify-center py-20"
            style={{ color: colors.textSecondary }}
          >
            <RefreshCw className="h-5 w-5 animate-spin mr-3" style={{ color: colors.accent }} />
            <span className="text-[10px] font-mono">
              Fetching stress indicators from FRED… (first load ~10s)
            </span>
          </div>
        )}

        {error && !data && (
          <div
            className="flex items-center gap-2 p-2 border text-[10px] font-mono"
            style={{ borderColor: "#ef5350", color: "#ef5350" }}
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Backend error: {String(error)} — make sure the Python backend is running.</span>
          </div>
        )}

        {data && (
          <>
            {activeTab === "overview" && (
              <OverviewTab data={data} isDark={isDark} colors={colors} />
            )}
            {activeTab === "spreads" && <SpreadsTab data={data} isDark={isDark} colors={colors} />}
            {activeTab === "stress" && <StressTab data={data} isDark={isDark} colors={colors} />}
            {activeTab === "consumer" && (
              <ConsumerTab data={data} isDark={isDark} colors={colors} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
