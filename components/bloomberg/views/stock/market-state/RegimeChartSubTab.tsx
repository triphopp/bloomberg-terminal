"use client";

/**
 * B — Price with regime shading.
 *
 * The chart that makes the model checkable: if the shaded bands do not line up
 * with what the price obviously did, the model is wrong and the reader can see
 * it without reading a single statistic.
 *
 * Bands are built by RUN, not per bar. One `<ReferenceArea>` per bar would be
 * ~500 SVG rects on a two-year window, which is both slow and visually noisy at
 * the boundaries; collapsing consecutive same-state bars into one band also
 * makes the regime's DURATION visible, which is half of what the picture is for.
 */

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { bloombergColors } from "../../../lib/theme-config";
import { toRuns } from "./regime-runs";
import type { MarketStateResponse } from "./types";

type Colors = typeof bloombergColors.dark;

export function RegimeChartSubTab({ data, colors }: { data: MarketStateResponse; colors: Colors }) {
  const history = data.history;
  const states = data.regime?.states ?? [];

  const rows = useMemo(
    () =>
      (history?.times ?? []).map((t, i) => ({
        time: t,
        close: history?.close[i] ?? null,
        state: history?.state[i] ?? 0,
        idx: i,
      })),
    [history]
  );
  const runs = useMemo(() => toRuns(history?.state ?? []), [history]);

  if (!history || rows.length === 0) return null;

  const closes = rows.map((r) => r.close).filter((v): v is number => v != null);
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const pad = (hi - lo) * 0.06;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        {states.map((s) => (
          <span
            key={s.key}
            className="flex items-center gap-1 text-[10px] font-mono"
            title={s.blurb}
          >
            <span className="inline-block w-3 h-3" style={{ background: s.color, opacity: 0.5 }} />
            <span style={{ color: colors.textSecondary }}>{s.label}</span>
          </span>
        ))}
        <span className="text-[9px] font-mono ml-auto" style={{ color: colors.textDimmed }}>
          {rows.length} bars · shading is the causal label, not hindsight
        </span>
      </div>

      <div style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="msPrice" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.text} stopOpacity={0.25} />
                <stop offset="100%" stopColor={colors.text} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={colors.borderFaint} vertical={false} />
            {runs.map((run) => (
              <ReferenceArea
                key={`${run.from}-${run.state}`}
                x1={rows[run.from]?.time}
                x2={rows[run.to]?.time}
                fill={states[run.state]?.color ?? colors.border}
                fillOpacity={0.16}
                stroke="none"
                ifOverflow="extendDomain"
              />
            ))}
            <XAxis
              dataKey="time"
              tick={{ fill: colors.textDimmed, fontSize: 9 }}
              minTickGap={60}
              stroke={colors.border}
            />
            <YAxis
              domain={[lo - pad, hi + pad]}
              tick={{ fill: colors.textDimmed, fontSize: 9 }}
              width={52}
              stroke={colors.border}
              tickFormatter={(v: number) => v.toFixed(v >= 1000 ? 0 : 2)}
            />
            <Tooltip
              contentStyle={{
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                fontSize: 11,
                fontFamily: "monospace",
              }}
              labelStyle={{ color: colors.textSecondary }}
              formatter={(v: number, _n, item: { payload?: { state?: number } }) => [
                v?.toFixed?.(2),
                states[item?.payload?.state ?? 0]?.label ?? "",
              ]}
            />
            <Area
              type="monotone"
              dataKey="close"
              stroke={colors.text}
              strokeWidth={1.2}
              fill="url(#msPrice)"
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Run table: the durations the shading shows, as numbers. */}
      <div>
        <div className="text-[9px] tracking-widest mb-1" style={{ color: colors.textDimmed }}>
          MOST RECENT REGIME RUNS
        </div>
        <div className="flex flex-wrap gap-1">
          {runs
            .slice(-8)
            .reverse()
            .map((run) => (
              <span
                key={`${run.from}-${run.state}-tag`}
                className="text-[9px] font-mono px-1 py-0.5 border"
                style={{
                  borderColor: states[run.state]?.color ?? colors.border,
                  color: states[run.state]?.color ?? colors.text,
                }}
              >
                {states[run.state]?.label ?? "?"} · {run.to - run.from + 1}b ·{" "}
                {rows[run.from]?.time?.slice(2)}
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}
