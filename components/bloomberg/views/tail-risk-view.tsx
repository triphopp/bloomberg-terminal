"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { RefreshCw, Shield, ShieldAlert, ShieldOff, TrendingDown } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { isDarkModeAtom } from "../atoms";
import { bloombergColors } from "../lib/theme-config";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SignalStats {
  prec_is_l2_5d: number | null;
  rec_is_l2_5d: number | null;
  prec_oos_l2_5d: number | null;
  fires_pct_is: number | null;
  fires_pct_oos: number | null;
}

interface Signal {
  id: string;
  label: string;
  group: string;
  tier: number;
  active: boolean;
  verdict: string;
  description: string;
  stats: SignalStats;
}

interface VixTerm {
  vix9d: number | null;
  vix: number | null;
  vix3m: number | null;
  backwardation_front: boolean;
  backwardation_back: boolean;
}

interface HistoryItem {
  date: string;
  active_count: number;
  validated_count: number;
  composite: boolean;
}

interface TailRiskData {
  ts: string;
  data_date: string;
  signals: Signal[];
  composite_active: boolean;
  active_count: number;
  validated_active_count: number;
  validated_active_signals: string[];
  vix_term: VixTerm;
  fg_synthetic: number | null;
  rsi: number | null;
  crisis_score: number | null;
  sector_corr: number | null;
  history: HistoryItem[];
}

// ── Config ────────────────────────────────────────────────────────────────────

const VERDICT_COLOR: Record<string, string> = {
  STRONG: "#22DD66",
  USEFUL: "#88DD44",
  SENSITIVE: "#FFAA00",
  WEAK: "#FF6644",
  MIXED: "#AAAAAA",
  UNKNOWN: "#666666",
};

const TIER_LABEL: Record<number, string> = {
  1: "TIER 1",
  2: "TIER 2",
  3: "TIER 3",
  4: "REMOVED",
};

const GROUP_ORDER = [
  "VIX",
  "Sentiment",
  "Stress",
  "Technical",
  "Flow",
  "Regime",
  "Allocation",
  "Composite",
  "Rates",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(v: number | null): string {
  if (v == null) return "N/A";
  return `${(v * 100).toFixed(0)}%`;
}

function riskLevel(
  validatedCount: number,
  composite: boolean
): {
  label: string;
  color: string;
  bg: string;
} {
  if (composite && validatedCount >= 3)
    return { label: "HIGH RISK", color: "#FF2222", bg: "#1a0000" };
  if (validatedCount >= 2) return { label: "ELEVATED", color: "#FF8800", bg: "#1a0a00" };
  if (validatedCount >= 1) return { label: "CAUTION", color: "#FFCC00", bg: "#1a1500" };
  return { label: "NORMAL", color: "#22CC66", bg: "#001a08" };
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function VixTermBlock({ term }: { term: VixTerm }) {
  const backwardation = term.backwardation_front || term.backwardation_back;

  const cell = (label: string, val: number | null, highlight: boolean) => (
    <div className="flex flex-col items-center gap-0.5">
      <span style={{ color: "#666", fontSize: 8 }}>{label}</span>
      <span
        style={{
          color: highlight ? "#FF4444" : "#FFD700",
          fontSize: 13,
          fontWeight: "bold",
        }}
      >
        {val != null ? val.toFixed(1) : "--"}
      </span>
    </div>
  );

  return (
    <div
      className="flex flex-col gap-1 p-2 border"
      style={{
        borderColor: backwardation ? "#CC2200" : "#2a2a2a",
        backgroundColor: backwardation ? "#150000" : "#0a0a0a",
      }}
    >
      <div className="flex items-center gap-1">
        <span style={{ color: "#888", fontSize: 8, letterSpacing: "0.1em" }}>VIX TERM</span>
        {backwardation && (
          <span style={{ color: "#FF4444", fontSize: 7, fontWeight: "bold" }}>BACKWARDATION</span>
        )}
      </div>
      <div className="flex gap-4 justify-center">
        {cell("VIX9D", term.vix9d, !!term.backwardation_front)}
        {cell("VIX", term.vix, false)}
        {cell("VIX3M", term.vix3m, !!term.backwardation_back)}
      </div>
      <div className="flex gap-2 justify-center">
        <span style={{ fontSize: 7.5, color: term.backwardation_front ? "#FF4444" : "#333" }}>
          {term.backwardation_front ? "▲ FRONT INV" : "FRONT NORMAL"}
        </span>
        <span style={{ color: "#333", fontSize: 7.5 }}>|</span>
        <span style={{ fontSize: 7.5, color: term.backwardation_back ? "#FF4444" : "#333" }}>
          {term.backwardation_back ? "▲ BACK INV" : "BACK NORMAL"}
        </span>
      </div>
    </div>
  );
}

function SignalCard({ sig }: { sig: Signal }) {
  const verdictColor = VERDICT_COLOR[sig.verdict] ?? "#666";
  const tierHidden = sig.tier >= 4;

  return (
    <div
      className="p-2 border transition-colors"
      style={{
        borderColor: sig.active ? (sig.tier <= 2 ? "#CC4400" : "#884400") : "#1e1e1e",
        backgroundColor: sig.active ? (sig.tier <= 2 ? "#100500" : "#0a0500") : "#060606",
        opacity: tierHidden ? 0.4 : 1,
      }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-1 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              backgroundColor: sig.active ? "#FF4444" : "#222",
              flexShrink: 0,
            }}
          />
          <span
            className="font-bold truncate"
            style={{
              color: sig.active ? "#FFCC44" : "#666",
              fontSize: 9.5,
              letterSpacing: "0.05em",
            }}
          >
            {sig.label}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span style={{ color: verdictColor, fontSize: 7, fontWeight: "bold" }}>
            {sig.verdict}
          </span>
          <span style={{ color: "#333", fontSize: 7 }}>{TIER_LABEL[sig.tier]}</span>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex gap-2">
        <div className="flex flex-col items-center">
          <span style={{ color: "#555", fontSize: 7 }}>PREC IS</span>
          <span style={{ color: "#AAA", fontSize: 9 }}>{pct(sig.stats.prec_is_l2_5d)}</span>
        </div>
        <div className="flex flex-col items-center">
          <span style={{ color: "#555", fontSize: 7 }}>RECALL</span>
          <span style={{ color: "#AAA", fontSize: 9 }}>{pct(sig.stats.rec_is_l2_5d)}</span>
        </div>
        <div className="flex flex-col items-center">
          <span style={{ color: "#555", fontSize: 7 }}>FIRES IS</span>
          <span style={{ color: "#AAA", fontSize: 9 }}>{pct(sig.stats.fires_pct_is)}</span>
        </div>
        <div className="flex flex-col items-center ml-auto">
          <span style={{ color: "#555", fontSize: 7 }}>STATUS</span>
          <span style={{ color: sig.active ? "#FF4444" : "#334", fontSize: 9, fontWeight: "bold" }}>
            {sig.active ? "ACTIVE" : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

function HistoryChart({ history }: { history: HistoryItem[] }) {
  return (
    <ResponsiveContainer width="100%" height={80}>
      <BarChart data={history} barSize={6} margin={{ top: 2, right: 2, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="2 2" stroke="#1a1a1a" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(d: string) => d.slice(5)}
          tick={{ fill: "#444", fontSize: 7 }}
          interval={4}
          axisLine={false}
          tickLine={false}
        />
        <YAxis tick={{ fill: "#444", fontSize: 7 }} axisLine={false} tickLine={false} />
        <Tooltip
          contentStyle={{ backgroundColor: "#111", border: "1px solid #333", fontSize: 9 }}
          labelStyle={{ color: "#888" }}
          formatter={(v: number) => [v, "Active signals"]}
        />
        <Bar dataKey="validated_count" radius={[2, 2, 0, 0]}>
          {history.map((h) => (
            <Cell
              key={h.date}
              fill={h.composite ? "#FF4444" : h.validated_count >= 2 ? "#FF8800" : "#446644"}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function TailRiskView({ onBack }: { onBack?: () => void }) {
  const [isDarkMode] = useAtom(isDarkModeAtom);

  const { data, isLoading, error, refetch, isFetching } = useQuery<TailRiskData>({
    queryKey: ["tail-risk-signals"],
    queryFn: () => fetch("/api/tail-risk/signals").then((r) => r.json()),
    staleTime: 240_000,
    refetchInterval: 300_000,
  });

  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  if (isLoading) {
    return (
      <div
        className="flex-1 flex items-center justify-center font-mono"
        style={{ color: "#444", fontSize: 11 }}
      >
        COMPUTING SIGNALS...
      </div>
    );
  }

  if (error || !data || (data as unknown as { error?: string }).error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 font-mono">
        <span style={{ color: "#FF4444", fontSize: 11 }}>SIGNAL COMPUTATION FAILED</span>
        <button
          type="button"
          onClick={() => refetch()}
          style={{ color: "#666", fontSize: 9, border: "1px solid #333", padding: "2px 8px" }}
        >
          RETRY
        </button>
      </div>
    );
  }

  const level = riskLevel(data.validated_active_count, data.composite_active);
  const tier1 = data.signals.filter((s) => s.tier === 1);
  const tier2 = data.signals.filter((s) => s.tier === 2);
  const tier3 = data.signals.filter((s) => s.tier >= 3);

  const groups = (sigs: Signal[]) => {
    const map: Record<string, Signal[]> = {};
    for (const s of sigs) {
      map[s.group] = map[s.group] ?? [];
      map[s.group].push(s);
    }
    return Object.entries(map).sort(([a], [b]) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
  };

  return (
    <div className="flex flex-col h-full font-mono bg-black text-white overflow-hidden">
      {/* ── Top status bar ──────────────────────────────────────────────────── */}
      <div
        className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b"
        style={{ borderColor: "#1a1a1a", backgroundColor: level.bg }}
      >
        <span
          style={{ color: level.color, fontSize: 11, fontWeight: "bold", letterSpacing: "0.12em" }}
        >
          {level.label}
        </span>
        <span style={{ color: "#444", fontSize: 9 }}>|</span>
        <span style={{ color: "#888", fontSize: 9 }}>
          {data.validated_active_count} / {data.signals.filter((s) => s.tier <= 2).length} TIER-1/2
          SIGNALS ACTIVE
        </span>
        {data.composite_active && (
          <span style={{ color: "#FF4444", fontSize: 9, fontWeight: "bold" }}>
            ● COMPOSITE TRIGGERED
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span style={{ color: "#444", fontSize: 8 }}>DATA {data.data_date}</span>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1 px-2 py-0.5 border"
            style={{ borderColor: "#2a2a2a", color: "#666", fontSize: 8 }}
          >
            <RefreshCw size={8} className={isFetching ? "animate-spin" : ""} />
            {isFetching ? "..." : "REFRESH"}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex gap-3 p-3 min-h-full">
          {/* ── Left column: VIX term + gauges + history ──────────────────── */}
          <div className="w-44 shrink-0 flex flex-col gap-2">
            {/* VIX term structure */}
            {data.vix_term && <VixTermBlock term={data.vix_term} />}

            {/* Key metrics */}
            <div className="flex flex-col gap-1 p-2 border" style={{ borderColor: "#1e1e1e" }}>
              <span style={{ color: "#666", fontSize: 7.5, letterSpacing: "0.1em" }}>
                INDICATORS
              </span>
              {[
                {
                  label: "F&G SYNTHETIC",
                  val: data.fg_synthetic != null ? data.fg_synthetic.toFixed(1) : "N/A",
                  warn: data.fg_synthetic != null && data.fg_synthetic < 25,
                },
                {
                  label: "SPY RSI 14",
                  val: data.rsi != null ? data.rsi.toFixed(1) : "N/A",
                  warn: data.rsi != null && data.rsi < 35,
                },
                {
                  label: "CRISIS SCORE",
                  val: data.crisis_score != null ? data.crisis_score.toFixed(1) : "N/A",
                  warn: data.crisis_score != null && data.crisis_score > 45,
                },
                {
                  label: "SECT CORR",
                  val: data.sector_corr != null ? data.sector_corr.toFixed(3) : "N/A",
                  warn: data.sector_corr != null && data.sector_corr > 0.65,
                },
              ].map(({ label, val, warn }) => (
                <div key={label} className="flex justify-between items-center">
                  <span style={{ color: "#555", fontSize: 8 }}>{label}</span>
                  <span
                    style={{
                      color: warn ? "#FF8800" : "#888",
                      fontSize: 9,
                      fontWeight: warn ? "bold" : "normal",
                    }}
                  >
                    {val}
                  </span>
                </div>
              ))}
            </div>

            {/* 30-day history chart */}
            <div className="flex flex-col gap-1 p-2 border" style={{ borderColor: "#1e1e1e" }}>
              <span style={{ color: "#666", fontSize: 7.5, letterSpacing: "0.1em" }}>
                30D SIGNAL COUNT
              </span>
              <HistoryChart history={data.history} />
              <div className="flex gap-2 mt-0.5">
                <span className="flex items-center gap-0.5">
                  <span
                    style={{ width: 8, height: 8, background: "#FF4444", display: "inline-block" }}
                  />
                  <span style={{ color: "#555", fontSize: 7 }}>COMPOSITE</span>
                </span>
                <span className="flex items-center gap-0.5">
                  <span
                    style={{ width: 8, height: 8, background: "#FF8800", display: "inline-block" }}
                  />
                  <span style={{ color: "#555", fontSize: 7 }}>≥2 SIG</span>
                </span>
              </div>
            </div>

            {/* Backtest note */}
            <div className="p-2 border" style={{ borderColor: "#111" }}>
              <p style={{ color: "#333", fontSize: 7, lineHeight: 1.4 }}>
                Precision/Recall from IS backtest 2015-2022 at L2 (−3% crash) 5-day lookahead. OOS
                2023-24 had 0 L2 events — regime-dependent signals.
              </p>
            </div>
          </div>

          {/* ── Right: signal cards ──────────────────────────────────────────── */}
          <div className="flex-1 min-w-0 flex flex-col gap-3">
            {/* TIER 1 */}
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <span
                  style={{
                    color: "#FF8800",
                    fontSize: 8,
                    fontWeight: "bold",
                    letterSpacing: "0.15em",
                  }}
                >
                  TIER 1 — VALIDATED (BUILD NOW)
                </span>
                <span style={{ color: "#333", fontSize: 7 }}>
                  {tier1.filter((s) => s.active).length} / {tier1.length} ACTIVE
                </span>
              </div>
              <div
                className="grid gap-1.5"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}
              >
                {groups(tier1)
                  .flatMap(([, sigs]) => sigs)
                  .map((sig) => (
                    <SignalCard key={sig.id} sig={sig} />
                  ))}
              </div>
            </div>

            {/* TIER 2 */}
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <span
                  style={{
                    color: "#FFCC00",
                    fontSize: 8,
                    fontWeight: "bold",
                    letterSpacing: "0.15em",
                  }}
                >
                  TIER 2 — MONITOR
                </span>
                <span style={{ color: "#333", fontSize: 7 }}>
                  {tier2.filter((s) => s.active).length} / {tier2.length} ACTIVE
                </span>
              </div>
              <div
                className="grid gap-1.5"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}
              >
                {groups(tier2)
                  .flatMap(([, sigs]) => sigs)
                  .map((sig) => (
                    <SignalCard key={sig.id} sig={sig} />
                  ))}
              </div>
            </div>

            {/* TIER 3/4 — collapsed */}
            {tier3.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <span
                    style={{
                      color: "#444",
                      fontSize: 8,
                      fontWeight: "bold",
                      letterSpacing: "0.15em",
                    }}
                  >
                    TIER 3/4 — WEAK / REMOVED
                  </span>
                </div>
                <div
                  className="grid gap-1.5"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}
                >
                  {tier3.map((sig) => (
                    <SignalCard key={sig.id} sig={sig} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
