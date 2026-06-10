"use client";

import { useMemo } from "react";
import {
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { fearGreedZoneColor, fearGreedZoneName } from "./indicators/fear-greed";

interface FgPoint {
  time: string;
  value: number;
}

interface Colors {
  border: string;
  textSecondary: string;
  surface: string;
  text: string;
}

export interface FearGreedPaneProps {
  data: FgPoint[];
  colors: Colors;
  height?: number;
}

const ZONE_BANDS = [
  { y1: 0,   y2: 25,  fill: "rgba(204,34,0,0.35)",    label: "Extreme Fear" },
  { y1: 25,  y2: 45,  fill: "rgba(204,102,0,0.28)",   label: "Fear" },
  { y1: 45,  y2: 55,  fill: "rgba(120,120,0,0.22)",   label: "Neutral" },
  { y1: 55,  y2: 75,  fill: "rgba(0,160,68,0.22)",    label: "Greed" },
  { y1: 75,  y2: 100, fill: "rgba(0,100,40,0.32)",    label: "Extreme Greed" },
];

export function FearGreedPane({ data, colors, height = 100 }: FearGreedPaneProps) {
  const chartData = useMemo(() => data.map(d => ({ time: d.time, value: d.value })), [data]);

  if (!data || data.length === 0) return null;

  const tickInterval = Math.max(1, Math.floor(chartData.length / 10));
  const lastVal = chartData[chartData.length - 1]?.value ?? 50;
  const zoneColor = fearGreedZoneColor(lastVal);
  const zoneName  = fearGreedZoneName(lastVal);

  return (
    <div className="mt-1 select-none">
      <div className="flex items-center gap-2 px-1 mb-0.5">
        <span style={{ color: colors.textSecondary, fontSize: 9, fontFamily: "monospace", letterSpacing: "0.05em" }}>
          FEAR &amp; GREED
        </span>
        <span style={{ color: zoneColor, fontSize: 9, fontFamily: "monospace", fontWeight: 700 }}>
          {lastVal.toFixed(1)}
        </span>
        <span style={{ color: zoneColor, fontSize: 8, fontFamily: "monospace" }}>
          {zoneName}
        </span>
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={chartData} margin={{ top: 2, right: 10, left: 0, bottom: 2 }}>
          {/* Zone background fills */}
          {ZONE_BANDS.map(z => (
            <ReferenceArea key={z.label} y1={z.y1} y2={z.y2} fill={z.fill} stroke="none" ifOverflow="visible" />
          ))}

          {/* Zone boundary dashes */}
          <ReferenceLine y={25} stroke="rgba(204,34,0,0.5)"   strokeDasharray="3 3" strokeWidth={1} />
          <ReferenceLine y={45} stroke="rgba(204,102,0,0.5)"  strokeDasharray="3 3" strokeWidth={1} />
          <ReferenceLine y={55} stroke="rgba(0,170,68,0.5)"   strokeDasharray="3 3" strokeWidth={1} />
          <ReferenceLine y={75} stroke="rgba(0,119,51,0.5)"   strokeDasharray="3 3" strokeWidth={1} />

          <CartesianGrid strokeDasharray="2 4" stroke={`${colors.border}55`} vertical={false} />
          <XAxis
            dataKey="time"
            tick={{ fontSize: 8, fill: colors.textSecondary, fontFamily: "monospace" }}
            tickLine={false}
            axisLine={{ stroke: colors.border }}
            interval={tickInterval}
            minTickGap={36}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 8, fill: colors.textSecondary, fontFamily: "monospace" }}
            tickLine={false}
            axisLine={{ stroke: colors.border }}
            ticks={[25, 45, 55, 75]}
            width={24}
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
            formatter={(v: number) => [
              <span style={{ color: fearGreedZoneColor(v) }}>{v.toFixed(1)} — {fearGreedZoneName(v)}</span>,
              "F&G",
            ]}
            labelStyle={{ color: colors.textSecondary, fontSize: 9 }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="rgba(255,255,255,0.85)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
