"use client";

/**
 * D — Regime posterior through time.
 *
 * A stacked area to 100%: the question this answers is not "how likely is BULL"
 * but "how is the model's belief MOVING" — a slow slide from one state to
 * another and an overnight jump are different market events, and only the shape
 * of the transition distinguishes them.
 *
 * The posterior is never smoothed. Hysteresis exists for the headline LABEL so
 * it stops flickering; applying it here would erase the uncertainty this tab
 * exists to show.
 */

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { bloombergColors } from "../../../lib/theme-config";
import { fmtProb } from "./SummarySubTab";
import type { MarketStateResponse } from "./types";

type Colors = typeof bloombergColors.dark;

export function ProbabilitySubTab({ data, colors }: { data: MarketStateResponse; colors: Colors }) {
  const h = data.history;
  const states = data.regime?.states ?? [];
  if (!h || states.length === 0) return null;

  const rows = h.times.map((t, i) => {
    const row: Record<string, string | number> = { time: t };
    states.forEach((s, k) => {
      row[s.key] = h.posterior[i]?.[k] ?? 0;
    });
    return row;
  });

  // How much the belief moved over the last 10 bars, per state — the number
  // behind "the regime is shifting" that the picture only implies.
  const drift = states.map((s, k) => {
    const last = h.posterior[h.posterior.length - 1]?.[k] ?? 0;
    const prev = h.posterior[Math.max(0, h.posterior.length - 11)]?.[k] ?? 0;
    return { ...s, now: last, prior: prev, delta: last - prev };
  });

  return (
    <div className="space-y-2">
      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={rows}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            stackOffset="expand"
          >
            <CartesianGrid stroke={colors.borderFaint} vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fill: colors.textDimmed, fontSize: 9 }}
              minTickGap={60}
              stroke={colors.border}
            />
            <YAxis
              tick={{ fill: colors.textDimmed, fontSize: 9 }}
              width={38}
              stroke={colors.border}
              tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            />
            <Tooltip
              contentStyle={{
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                fontSize: 11,
                fontFamily: "monospace",
              }}
              labelStyle={{ color: colors.textSecondary }}
              formatter={(v: number, name: string) => [
                fmtProb(v),
                states.find((s) => s.key === name)?.label ?? name,
              ]}
            />
            {states.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stackId="1"
                stroke={s.color}
                fill={s.color}
                fillOpacity={0.55}
                strokeWidth={0.5}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div>
        <div className="text-[9px] tracking-widest mb-1" style={{ color: colors.textDimmed }}>
          BELIEF SHIFT — last 10 bars
        </div>
        <table className="w-full text-[10px] font-mono border-collapse">
          <thead>
            <tr style={{ color: colors.textDimmed }}>
              <th className="text-left font-normal py-0.5">STATE</th>
              <th className="text-right font-normal">10 BARS AGO</th>
              <th className="text-right font-normal">NOW</th>
              <th className="text-right font-normal">Δ</th>
            </tr>
          </thead>
          <tbody>
            {drift.map((d) => (
              <tr key={d.key} style={{ borderTop: `1px solid ${colors.borderFaint}` }}>
                <td className="py-0.5" style={{ color: d.color }}>
                  {d.label}
                </td>
                <td className="text-right" style={{ color: colors.textSecondary }}>
                  {fmtProb(d.prior)}
                </td>
                <td className="text-right" style={{ color: colors.text }}>
                  {fmtProb(d.now)}
                </td>
                <td
                  className="text-right"
                  style={{
                    color:
                      Math.abs(d.delta) < 0.05
                        ? colors.textDimmed
                        : d.delta > 0
                          ? colors.positive
                          : colors.negative,
                  }}
                >
                  {d.delta >= 0 ? "+" : ""}
                  {(d.delta * 100).toFixed(0)}pp
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
