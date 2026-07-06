"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface PePoint {
  time: string;
  pe: number | null;
  eps?: number;
  close?: number;
}

export interface PeStats {
  current: number;
  min: number;
  max: number;
  median: number;
  p10: number;
  p90: number;
  currentPct: number;
}

interface Colors {
  border: string;
  textSecondary: string;
  surface: string;
  text: string;
}

export interface PEPaneProps {
  data: PePoint[];
  stats: PeStats | null;
  colors: Colors;
  height?: number;
}

/** Valuation zone from percentile rank of the current P/E within its own history. */
function valuationLabel(pct: number): { name: string; color: string } {
  if (pct < 20) return { name: "CHEAP", color: "#00AA44" };
  if (pct < 40) return { name: "BELOW AVG", color: "#66AA22" };
  if (pct < 60) return { name: "FAIR", color: "#999900" };
  if (pct < 80) return { name: "ABOVE AVG", color: "#CC6600" };
  return { name: "EXPENSIVE", color: "#CC2200" };
}

export function PEPane({ data, stats, colors, height = 110 }: PEPaneProps) {
  // Drop undefined-P/E gaps for the line; recharts skips nulls but we also want a
  // clean domain. Keep time order.
  const chartData = useMemo(() => data.map((d) => ({ time: d.time, pe: d.pe })), [data]);

  // Clip the Y domain so early hyper-growth P/E spikes (e.g. 700x) don't flatten
  // the useful range. Cap at max(p90 × 1.4, current × 1.4), floored at the real max.
  const yMax = useMemo(() => {
    if (!stats) return "auto" as const;
    const cap = Math.max(stats.p90 * 1.4, stats.current * 1.5, stats.median * 1.2);
    return Math.min(stats.max, Math.ceil(cap / 10) * 10);
  }, [stats]);

  if (!data || data.length === 0) return null;

  const tickInterval = Math.max(1, Math.floor(chartData.length / 10));
  const val = valuationLabel(stats?.currentPct ?? 50);

  return (
    <div className="mt-1 select-none">
      <div className="flex items-center gap-2 px-1 mb-0.5">
        <span
          style={{
            color: colors.textSecondary,
            fontSize: 9,
            fontFamily: "monospace",
            letterSpacing: "0.05em",
          }}
        >
          P/E (TTM, adj)
        </span>
        {stats && (
          <>
            <span
              style={{ color: val.color, fontSize: 9, fontFamily: "monospace", fontWeight: 700 }}
            >
              {stats.current.toFixed(1)}x
            </span>
            <span style={{ color: val.color, fontSize: 8, fontFamily: "monospace" }}>
              {val.name} · {stats.currentPct.toFixed(0)}th pct
            </span>
            <span style={{ color: colors.textSecondary, fontSize: 8, fontFamily: "monospace" }}>
              med {stats.median.toFixed(0)}x · range {stats.min.toFixed(0)}–{stats.max.toFixed(0)}x
            </span>
          </>
        )}
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={chartData} margin={{ top: 2, right: 10, left: 0, bottom: 2 }}>
          {/* Valuation bands: cheap (≤p10) green, fair (p10–p90) neutral, rich (≥p90) red */}
          {stats && (
            <>
              <ReferenceArea
                y1={0}
                y2={stats.p10}
                fill="rgba(0,160,68,0.18)"
                stroke="none"
                ifOverflow="visible"
              />
              <ReferenceArea
                y1={stats.p10}
                y2={stats.p90}
                fill="rgba(120,120,0,0.10)"
                stroke="none"
                ifOverflow="visible"
              />
              <ReferenceArea
                y1={stats.p90}
                y2={typeof yMax === "number" ? yMax : stats.max}
                fill="rgba(204,34,0,0.16)"
                stroke="none"
                ifOverflow="visible"
              />
              <ReferenceLine
                y={stats.median}
                stroke={`${colors.textSecondary}99`}
                strokeDasharray="4 3"
                strokeWidth={1}
              />
            </>
          )}

          <CartesianGrid strokeDasharray="2 4" stroke={`${colors.border}55`} vertical={false} />
          <XAxis
            dataKey="time"
            tick={{ fontSize: 8, fill: colors.textSecondary, fontFamily: "monospace" }}
            tickLine={false}
            axisLine={{ stroke: colors.border }}
            interval={tickInterval}
            minTickGap={36}
            tickFormatter={(v: string) => v.slice(0, 4)}
          />
          <YAxis
            domain={[0, yMax]}
            tick={{ fontSize: 8, fill: colors.textSecondary, fontFamily: "monospace" }}
            tickLine={false}
            axisLine={{ stroke: colors.border }}
            width={30}
            tickFormatter={(v: number) => `${v}x`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: colors.surface,
              borderColor: colors.border,
              color: colors.text,
              fontSize: 10,
              fontFamily: "monospace",
              borderRadius: 0,
              padding: "4px 8px",
            }}
            formatter={(v) => [typeof v === "number" ? `${v.toFixed(1)}x` : "n/a", "P/E"]}
            labelStyle={{ color: colors.textSecondary, fontSize: 9 }}
          />
          <Line
            type="monotone"
            dataKey="pe"
            stroke="rgba(255,255,255,0.85)"
            strokeWidth={1.5}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
