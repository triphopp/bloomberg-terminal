"use client";

/**
 * REGIME → COT: the whole futures book in one line.
 *
 * PC1 of every contract's causal 3-year z of focus-group (leveraged funds /
 * managed money) net/OI, weekly from CFTC. The loadings are printed because
 * the factor means whatever it loads on — today mostly Treasury-futures
 * positioning, i.e. the basis trade — and a line with no key invites a story.
 * Display only: not an input to the regime HMM, and not backtested.
 */

import { useQuery } from "@tanstack/react-query";
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { cotExtreme, useCotSnapshot } from "../hooks/useCot";
import type { bloombergColors } from "../lib/theme-config";

interface FactorData {
  series: { date: string; value: number }[];
  loadings: Record<string, number>;
  explained: number | null;
  weeks: number;
  as_of: string | null;
  window: number;
  status?: { running: boolean };
}

export function CotFactorPanel({
  colors,
  compact = true,
}: {
  colors: typeof bloombergColors.dark;
  compact?: boolean;
}) {
  const { data, isLoading } = useQuery<FactorData>({
    queryKey: ["cot-factor"],
    queryFn: () => fetch("/api/cot/factor").then((r) => r.json()),
    staleTime: 60 * 60_000,
  });
  const { data: snap } = useCotSnapshot();

  if (isLoading || !data) {
    return (
      <div style={{ color: colors.textSecondary, fontSize: 10, padding: 8 }}>loading CFTC…</div>
    );
  }
  if (!data.series?.length) {
    return (
      <div style={{ color: "#8a6a3a", fontSize: 10, padding: 8 }}>
        {data.status?.running
          ? "กำลังดึงประวัติจาก CFTC…"
          : `ข้อมูลไม่พอคำนวณ factor (${data.weeks} weeks)`}
      </div>
    );
  }

  const last = data.series[data.series.length - 1];
  const loadings = Object.entries(data.loadings).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const top = loadings.slice(0, compact ? 6 : 17);
  const extremes = (snap?.contracts ?? [])
    .map((c) => ({ c, side: cotExtreme(c.groups[c.focus]) }))
    .filter((x) => x.side);

  return (
    <div className="flex flex-col h-full gap-1 p-1.5 font-mono overflow-y-auto">
      <div className="flex items-baseline gap-2">
        <span style={{ color: "#FF9800", fontSize: 10, letterSpacing: "0.1em" }}>
          POSITIONING PC1
        </span>
        <span className="tabular-nums" style={{ color: colors.text, fontSize: 12 }}>
          {last.value >= 0 ? "+" : ""}
          {last.value.toFixed(2)}
        </span>
        <span style={{ color: colors.textSecondary, fontSize: 9 }}>
          explains {Math.round((data.explained ?? 0) * 100)}% · as of Tue {data.as_of?.slice(5)} ·
          weekly
        </span>
      </div>

      <div style={{ height: compact ? 90 : 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data.series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="date"
              hide={compact}
              tick={{ fontSize: 9, fill: "#666" }}
              minTickGap={40}
            />
            <YAxis tick={{ fontSize: 9, fill: "#666" }} width={28} />
            <ReferenceLine y={0} stroke="#333" />
            <Tooltip
              contentStyle={{
                backgroundColor: "#0a0a0a",
                border: "1px solid #2a2a2a",
                fontSize: 10,
              }}
              formatter={(v: number) => [v.toFixed(2), "PC1"]}
            />
            <Line
              dataKey="value"
              stroke="#FF9800"
              dot={false}
              strokeWidth={1.3}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap gap-x-2" style={{ fontSize: 9 }}>
        <span style={{ color: colors.textSecondary }}>loads on:</span>
        {top.map(([k, w]) => (
          <span key={k} className="tabular-nums" style={{ color: w >= 0 ? "#4CAF50" : "#FF5252" }}>
            {k} {w >= 0 ? "+" : ""}
            {w.toFixed(2)}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-2" style={{ fontSize: 9 }}>
        <span style={{ color: colors.textSecondary }}>at extreme:</span>
        {extremes.length === 0 ? (
          <span style={{ color: "#555" }}>none</span>
        ) : (
          extremes.map(({ c, side }) => (
            <span key={c.code} style={{ color: side === "short" ? "#FF5252" : "#4CAF50" }}>
              {c.key} {side === "short" ? "▼" : "▲"}p{Math.round(c.groups[c.focus]?.pct ?? 0)}
            </span>
          ))
        )}
      </div>

      <span style={{ color: "#4a4a4a", fontSize: 8.5, lineHeight: 1.4 }}>
        PC1 ของ z (net/OI เทียบ 3 ปีย้อนหลัง, causal) ของ lev funds / managed money ทุกสัญญา. ความหมายขึ้นกับ
        loadings ด้านบน. แสดงผลเท่านั้น — ไม่ได้ป้อนเข้า HMM และยังไม่มี backtest.
      </span>
    </div>
  );
}
