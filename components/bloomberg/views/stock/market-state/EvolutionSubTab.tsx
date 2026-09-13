"use client";

/**
 * C — State evolution.
 *
 * "สิ่งสำคัญคือไม่ดูเฉพาะค่าปัจจุบัน แต่ดู derivative" — so every score is drawn
 * with its rate of change beside it, and the reading under each chart is built
 * from the PAIR. A trend score of +0.7 falling and one rising are the same
 * number and opposite situations.
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { bloombergColors } from "../../../lib/theme-config";
import type { MarketStateResponse } from "./types";

type Colors = typeof bloombergColors.dark;

function Panel({
  title,
  rows,
  colors,
  domain,
  hint,
  reading,
}: {
  title: string;
  rows: { time: string; value: number | null; change: number | null }[];
  colors: Colors;
  domain: [number, number];
  hint: string;
  reading: string;
}) {
  return (
    <div className="border p-2" style={{ borderColor: colors.border }}>
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] tracking-widest" style={{ color: colors.textDimmed }}>
          {title}
        </span>
        <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }} title={hint}>
          {reading}
        </span>
      </div>
      <div style={{ height: 128 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={colors.borderFaint} vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fill: colors.textDimmed, fontSize: 8 }}
              minTickGap={70}
              stroke={colors.border}
            />
            <YAxis
              domain={domain}
              tick={{ fill: colors.textDimmed, fontSize: 8 }}
              width={38}
              stroke={colors.border}
            />
            <ReferenceLine y={0} stroke={colors.borderMid} />
            <Tooltip
              contentStyle={{
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                fontSize: 11,
                fontFamily: "monospace",
              }}
              labelStyle={{ color: colors.textSecondary }}
            />
            <Line
              type="monotone"
              dataKey="value"
              name="level"
              stroke={colors.accentSelected}
              strokeWidth={1.3}
              dot={false}
              isAnimationActive={false}
            />
            {/* The derivative, drawn on the same axis so a crossing of zero — the
                moment the level turns — is read off one picture, not two. */}
            <Line
              type="monotone"
              dataKey="change"
              name="d/dt (5 bars)"
              stroke={colors.accent}
              strokeWidth={1}
              strokeDasharray="3 2"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function EvolutionSubTab({ data, colors }: { data: MarketStateResponse; colors: Colors }) {
  const h = data.history;
  if (!h) return null;
  const s = data.scores ?? {};

  const build = (v: (number | null)[], c: (number | null)[]) =>
    h.times.map((t, i) => ({ time: t, value: v[i] ?? null, change: c[i] ?? null }));

  return (
    <div className="space-y-2">
      <div className="text-[9px] font-mono" style={{ color: colors.textDimmed }}>
        Solid = level · dashed = change over the last 5 bars. A level tells you where the market is;
        the dashed line tells you where it is going, which is what a transition looks like before it
        has a name.
      </div>
      <Panel
        title="TREND SCORE"
        rows={build(h.trend, h.trend_change)}
        colors={colors}
        domain={[-1, 1]}
        hint="20-bar return and 60-bar slope t-stat, standardised against this symbol's own year"
        reading={[s.trend?.word, s.trend?.direction].filter(Boolean).join(" · ") || "—"}
      />
      <Panel
        title="MOMENTUM SCORE"
        rows={build(h.momentum, h.momentum_change)}
        colors={colors}
        domain={[-1, 1]}
        hint="10-bar rate of change — a shorter horizon than TREND so the two can disagree"
        reading={[s.momentum?.sign, s.momentum?.word].filter(Boolean).join(" · ") || "—"}
      />
      <Panel
        title="VOLATILITY (σ)"
        rows={build(h.volatility, h.volatility_change)}
        colors={colors}
        domain={[-3, 3]}
        hint="Log realized volatility against its own 252-bar distribution"
        reading={[s.volatility?.level, s.volatility?.direction].filter(Boolean).join(" · ") || "—"}
      />
    </div>
  );
}
