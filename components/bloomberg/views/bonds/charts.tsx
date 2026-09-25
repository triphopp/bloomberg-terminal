"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { BondHistoryRow, BondSupply, IssuanceWeek, SlowSeries } from "./types";
import { C, Panel, fmtDate } from "./ui";

const AXIS = { fontSize: 9, fontFamily: "monospace", fill: C.dim };
const TT = {
  backgroundColor: "#0a0a0a",
  border: "1px solid #2a2a2a",
  fontSize: 10,
  fontFamily: "monospace",
};

export const RANGES = { "3M": 63, "6M": 126, "1Y": 252, "2Y": 520 } as const;
export type RangeKey = keyof typeof RANGES;

// ── Multi-line history chart (yields / spreads) ───────────────────────────────

export interface LineDef {
  key: string;
  label: string;
  color: string;
  axis?: "left" | "right";
  /** crisis-level trigger (from /api/crisis) — dashed line, drawn only once the data range reaches it */
  threshold?: number;
}

export function HistoryChart({
  title,
  note,
  rows,
  lines,
  height = 220,
  rightUnit,
}: {
  title: string;
  note?: string;
  rows: BondHistoryRow[];
  lines: LineDef[];
  height?: number;
  rightUnit?: string;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const hasRight = lines.some((l) => l.axis === "right");
  const toggle = (k: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <Panel
      title={title}
      note={note}
      right={
        <div className="flex items-center gap-2">
          {lines.map((l) => (
            <button
              key={l.key}
              type="button"
              onClick={() => toggle(l.key)}
              style={{ color: hidden.has(l.key) ? "#444" : l.color, fontSize: 9 }}
            >
              {l.label}
              {l.axis === "right" ? " ▸" : ""}
            </button>
          ))}
        </div>
      }
    >
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows} margin={{ top: 6, right: hasRight ? 0 : 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#141414" />
          <XAxis dataKey="date" tick={AXIS} tickFormatter={fmtDate} minTickGap={40} />
          <YAxis yAxisId="left" tick={AXIS} width={36} domain={["auto", "auto"]} />
          {hasRight && (
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={AXIS}
              width={36}
              domain={["auto", "auto"]}
              tickFormatter={(v) => `${v}${rightUnit ?? ""}`}
            />
          )}
          <Tooltip
            contentStyle={TT}
            labelStyle={{ color: "#aaa" }}
            formatter={(v: number, name: string) => [
              typeof v === "number" ? `${v.toFixed(2)}%` : "—",
              lines.find((l) => l.key === name)?.label ?? name,
            ]}
          />
          {lines
            .filter((l) => l.threshold != null && !hidden.has(l.key))
            .map((l) => (
              <ReferenceLine
                key={`th-${l.key}`}
                yAxisId={l.axis ?? "left"}
                y={l.threshold}
                stroke={l.color}
                strokeOpacity={0.45}
                strokeDasharray="4 3"
                ifOverflow="hidden"
                label={{
                  value: `${l.label} ${l.threshold}%`,
                  position: "insideTopLeft",
                  fontSize: 8,
                  fill: l.color,
                }}
              />
            ))}
          {lines.map((l) => (
            <Line
              key={l.key}
              yAxisId={l.axis ?? "left"}
              type="monotone"
              dataKey={l.key}
              stroke={l.color}
              strokeWidth={1.3}
              dot={false}
              connectNulls
              hide={hidden.has(l.key)}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Panel>
  );
}

// ── Issuance per week vs 10Y / IG OAS ─────────────────────────────────────────

export function IssuanceChart({ weeks, height = 220 }: { weeks: IssuanceWeek[]; height?: number }) {
  const [overlay, setOverlay] = useState<"UST10Y" | "IG_OAS">("UST10Y");
  return (
    <Panel
      title="CORPORATE ISSUANCE / WEEK"
      note="deals ex-bank · SEC 424B2/424B5"
      right={
        <div className="flex items-center gap-2" style={{ fontSize: 9 }}>
          <span style={{ color: C.dim }}>LINE</span>
          {(["UST10Y", "IG_OAS"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setOverlay(k)}
              style={{ color: overlay === k ? C.amber : "#555" }}
            >
              {k === "UST10Y" ? "10Y" : "IG OAS"}
            </button>
          ))}
        </div>
      }
    >
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={weeks} margin={{ top: 6, right: 0, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#141414" />
          <XAxis dataKey="week" tick={AXIS} tickFormatter={fmtDate} minTickGap={40} />
          <YAxis yAxisId="n" tick={AXIS} width={30} allowDecimals={false} />
          <YAxis yAxisId="y" orientation="right" tick={AXIS} width={36} domain={["auto", "auto"]} />
          <Tooltip contentStyle={TT} labelStyle={{ color: "#aaa" }} />
          <Legend wrapperStyle={{ fontSize: 9, fontFamily: "monospace" }} iconSize={7} />
          <Bar
            yAxisId="n"
            dataKey="CORP"
            name="NONFIN"
            stackId="d"
            fill="#3B82F6"
            isAnimationActive={false}
          />
          <Bar
            yAxisId="n"
            dataKey="FIN"
            name="FIN ex-bank"
            stackId="d"
            fill="#1E4E8C"
            isAnimationActive={false}
          />
          <Bar
            yAxisId="n"
            dataKey="ABS"
            name="ABS"
            stackId="d"
            fill="#333"
            isAnimationActive={false}
          />
          <Line
            yAxisId="y"
            type="monotone"
            dataKey={overlay}
            name={overlay === "UST10Y" ? "10Y %" : "IG OAS %"}
            stroke={C.amber}
            strokeWidth={1.3}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </Panel>
  );
}

// ── Treasury gross supply per week ────────────────────────────────────────────

export function TreasurySupplyChart({
  weekly,
  height = 150,
}: { weekly: BondSupply["weekly"]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={weekly} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="#141414" />
        <XAxis dataKey="week" tick={AXIS} tickFormatter={fmtDate} minTickGap={40} />
        <YAxis tick={AXIS} width={36} />
        <Tooltip
          contentStyle={TT}
          labelStyle={{ color: "#aaa" }}
          formatter={(v: number, n: string) => [`$${v}bn`, n]}
        />
        <Legend wrapperStyle={{ fontSize: 9, fontFamily: "monospace" }} iconSize={7} />
        <Bar
          dataKey="coupons_bn"
          name="COUPONS"
          stackId="s"
          fill="#F59E0B"
          isAnimationActive={false}
        />
        <Bar dataKey="bills_bn" name="BILLS" stackId="s" fill="#3a3a3a" isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── Slow stock series (quarterly / monthly) ───────────────────────────────────

export function SlowCard({ s }: { s: SlowSeries }) {
  const last = s.points[s.points.length - 1];
  // $ series read as growth; SLOOS is already a net % and reads as a level
  const metric: "yoy_pct" | "value" = s.unit === "$bn" ? "yoy_pct" : "value";
  const data = useMemo(() => s.points.slice(-24), [s.points]);
  if (!last) return null;
  return (
    <div className="flex flex-col gap-0.5 p-2" style={{ border: `1px solid ${C.border}` }}>
      <div className="flex items-baseline justify-between gap-2">
        <span style={{ color: C.label, fontSize: 9, letterSpacing: "0.08em" }}>{s.label}</span>
        <span style={{ color: "#555", fontSize: 8 }}>{s.fred_id}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span style={{ color: C.amber, fontSize: 14 }}>
          {s.unit === "$bn" ? `$${(last.value / 1000).toFixed(2)}T` : `${last.value.toFixed(1)}%`}
        </span>
        {last.yoy_pct != null && (
          <span style={{ color: last.yoy_pct >= 0 ? C.up : C.down, fontSize: 10 }}>
            {last.yoy_pct >= 0 ? "+" : ""}
            {last.yoy_pct.toFixed(1)}% YoY
          </span>
        )}
        <span className="ml-auto" style={{ color: "#555", fontSize: 9 }}>
          {last.date.slice(0, 7)}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={54}>
        <ComposedChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <XAxis dataKey="date" hide />
          <YAxis hide domain={["auto", "auto"]} />
          <Tooltip
            contentStyle={TT}
            labelStyle={{ color: "#aaa" }}
            formatter={(v: number) => [
              metric === "yoy_pct" ? `${v?.toFixed(2)}% YoY` : `${v?.toFixed(1)}%`,
              "",
            ]}
          />
          <Bar dataKey={metric} fill="#3B82F6" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
