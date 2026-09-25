"use client";

/**
 * BOND → CONDITIONS — what used to be the CRDT view, minus what BOND/TAIL
 * already show (merged 2026-09-25).
 *
 * Kept: the crisis level (count of threshold breaches from `/api/crisis`),
 * financial-stress indices, breakevens, and household credit. Dropped: TED
 * spread — FRED stopped it in 2022-01 with LIBOR, so its "latest" value was a
 * three-year-old number shown as live. HY/IG OAS and the curve live in the
 * MARKET tab; VIX lives in TAIL.
 */

import {
  Area,
  AreaChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { CreditData, CreditSignal } from "../../hooks/useCreditData";
import { DealerBalanceSheetPanel } from "./positioning";
import { C, Panel, bpColor, fmtDate } from "./ui";

const LEVEL = [
  { label: "NORMAL", color: "#4ADE80" },
  { label: "WATCH", color: "#FFC107" },
  { label: "WARNING", color: "#FF9800" },
  { label: "CRISIS ALERT", color: "#EF5350" },
] as const;

/** Threshold signals that make up the crisis level (TED excluded — dead series). */
const LEVEL_KEYS = [
  "hy_spread",
  "ig_spread",
  "stl_fsi",
  "nfci",
  "vix",
  "yield_10y2y",
  "yield_10y3m",
] as const;

const CHART_GROUPS: { title: string; note: string; keys: (keyof CreditData["signals"])[] }[] = [
  {
    title: "FINANCIAL STRESS",
    note: "weekly · > 0 = tighter than average",
    keys: ["stl_fsi", "nfci"],
  },
  {
    title: "INFLATION EXPECTATIONS",
    note: "nominal − TIPS",
    keys: ["breakeven_5y", "breakeven_10y"],
  },
  {
    title: "HOUSEHOLD CREDIT",
    note: "mortgage rate weekly · delinquency quarterly",
    keys: ["mortgage_30y", "cc_delinquency", "mtg_delinquency"],
  },
];

const TT = {
  backgroundColor: "#0a0a0a",
  border: "1px solid #2a2a2a",
  fontSize: 10,
  fontFamily: "monospace",
};

function fmt(v: number | null | undefined, unit: string): string {
  if (v == null) return "—";
  const n = Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1);
  return unit === "%" ? `${n}%` : n;
}

/** `series` comes newest-first; `date` on the signal is month-stamped, so read the series. */
function lastDate(sig: NonNullable<CreditSignal>): string {
  return sig.series[0]?.date ?? sig.date;
}

function SignalChart({ id, sig }: { id: string; sig: CreditSignal }) {
  if (!sig) {
    return (
      <div className="p-2" style={{ border: `1px solid ${C.border}`, color: C.dim, fontSize: 10 }}>
        {id} — no data
      </div>
    );
  }
  const data = [...sig.series].reverse();
  const chg = sig.prev != null ? sig.value - sig.prev : null;
  const color = sig.triggered ? C.up : "#3B82F6";
  const gid = `cond-${id}`;
  return (
    <div className="flex flex-col gap-0.5 p-2 min-w-0" style={{ border: `1px solid ${C.border}` }}>
      <div className="flex items-baseline gap-2">
        <span style={{ color: C.label, fontSize: 9, letterSpacing: "0.08em" }}>{sig.label}</span>
        <span className="ml-auto" style={{ color: "#555", fontSize: 9 }}>
          {lastDate(sig)}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span style={{ color: C.amber, fontSize: 14 }}>{fmt(sig.value, sig.unit)}</span>
        {chg != null && (
          <span style={{ color: bpColor(chg), fontSize: 10 }}>
            {chg > 0 ? "+" : ""}
            {fmt(chg, sig.unit)}
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={80}>
        <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.25} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" hide />
          <YAxis hide domain={["auto", "auto"]} />
          <Tooltip
            contentStyle={TT}
            labelStyle={{ color: "#aaa" }}
            labelFormatter={(d: string) => d}
            formatter={(v: number) => [fmt(v, sig.unit), sig.label]}
          />
          {sig.threshold != null && (
            <ReferenceLine y={sig.threshold} stroke="#666" strokeDasharray="3 2" />
          )}
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.3}
            fill={`url(#${gid})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex justify-between" style={{ color: "#444", fontSize: 8 }}>
        <span>{data[0] ? fmtDate(data[0].date) : ""}</span>
        <span>{data.length ? fmtDate(data[data.length - 1].date) : ""}</span>
      </div>
    </div>
  );
}

function LevelPanel({ data }: { data: CreditData }) {
  const lvl = LEVEL[data.level] ?? LEVEL[0];
  return (
    <Panel
      title="CRISIS LEVEL"
      note="threshold breaches: 1 = WATCH · 3 = WARNING · 5 = CRISIS"
      right={
        <span style={{ color: lvl.color, fontSize: 12, letterSpacing: "0.12em" }}>
          L{data.level} {lvl.label}
        </span>
      }
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: "1fr 64px 64px 44px",
          fontSize: 9,
          color: C.dim,
          columnGap: 8,
        }}
      >
        <span>SIGNAL</span>
        <span className="text-right">VALUE</span>
        <span className="text-right">TRIGGER</span>
        <span className="text-right">STATE</span>
      </div>
      {LEVEL_KEYS.map((k) => {
        const s = data.signals[k];
        if (!s) return null;
        return (
          <div
            key={k}
            className="grid"
            style={{ gridTemplateColumns: "1fr 64px 64px 44px", fontSize: 10.5, columnGap: 8 }}
          >
            <span style={{ color: "#aaa" }}>{s.label}</span>
            <span className="text-right" style={{ color: C.amber }}>
              {fmt(s.value, s.unit)}
            </span>
            <span className="text-right" style={{ color: "#666" }}>
              {k.startsWith("yield_") ? "<" : ">"} {fmt(s.threshold, s.unit)}
            </span>
            <span className="text-right" style={{ color: s.triggered ? C.up : "#4a4a4a" }}>
              {s.triggered ? "ON" : "off"}
            </span>
          </div>
        );
      })}
    </Panel>
  );
}

export function ConditionsTab({
  data,
  isLoading,
  error,
}: {
  data: CreditData | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  if (isLoading) return <span style={{ color: "#666", fontSize: 11 }}>LOADING /api/crisis…</span>;
  if (error || !data) {
    return (
      <span style={{ color: "#FF4444", fontSize: 11 }}>
        CONDITIONS FAILED — {error ? String(error) : "no data"}
      </span>
    );
  }
  return (
    <div className="grid gap-2 grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)]">
      <div className="flex flex-col gap-2 min-w-0">
        <LevelPanel data={data} />
        <DealerBalanceSheetPanel />
      </div>
      <div className="flex flex-col gap-2 min-w-0">
        {CHART_GROUPS.map((g) => (
          <Panel key={g.title} title={g.title} note={g.note}>
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
            >
              {g.keys.map((k) => (
                <SignalChart key={k} id={k} sig={data.signals[k]} />
              ))}
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}
