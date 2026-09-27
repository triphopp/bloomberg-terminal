"use client";

import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const PALETTE = [
  "#ff9800",
  "#36c5f0",
  "#ec5ba7",
  "#7bd66c",
  "#b488ff",
  "#f5d547",
  "#20c9ad",
  "#ff6b60",
  "#94b9e9",
  "#e5a45c",
];

type History = { quotes?: Array<{ date: string; close: number | null }> };

/** Comparison uses each asset's first close on a shared date as 0%. */
export function CompareChart({
  symbols,
  period,
  interval,
}: { symbols: string[]; period: string; interval: string }) {
  const queries = useQueries({
    queries: symbols.map((symbol) => ({
      queryKey: ["stock", "history", symbol, period, interval],
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<History> => {
        const params = new URLSearchParams({ type: "history", symbol, period, interval });
        const response = await fetch(`/api/stock?${params}`, { signal });
        if (!response.ok) throw new Error(`${symbol}: history unavailable (${response.status})`);
        return response.json();
      },
      staleTime: 60_000,
    })),
  });

  const { rows, missing } = useMemo(() => {
    const maps = queries.map(
      (query) =>
        new Map(
          (query.data?.quotes ?? [])
            .filter((bar) => bar.close != null && Number.isFinite(bar.close) && bar.close > 0)
            .map((bar) => [bar.date, bar.close as number])
        )
    );
    const unavailable = symbols.filter(
      (_, index) => queries[index].isError || (queries[index].isSuccess && maps[index].size === 0)
    );
    const available = maps.filter((map) => map.size > 0);
    if (!available.length) return { rows: [], missing: unavailable };
    const dates = [...available[0].keys()]
      .filter((date) => available.every((map) => map.has(date)))
      .sort();
    const first = dates[0];
    if (!first) return { rows: [], missing: unavailable };
    const bases = maps.map((map) => map.get(first));
    return {
      rows: dates.map((date) =>
        Object.fromEntries([
          ["date", date],
          ...symbols.map((symbol, index) => [
            symbol,
            bases[index] ? ((maps[index].get(date) ?? 0) / bases[index] - 1) * 100 : null,
          ]),
        ])
      ),
      missing: unavailable,
    };
  }, [queries, symbols]);

  if (queries.some((query) => query.isPending))
    return (
      <div className="h-full flex items-center justify-center text-[10px] text-zinc-500">
        LOADING COMPARISON…
      </div>
    );
  if (!rows.length)
    return (
      <div className="h-full flex items-center justify-center text-[10px] text-zinc-500">
        NO COMMON HISTORY FOR THESE SYMBOLS
      </div>
    );

  return (
    <div className="h-full min-h-0 flex flex-col" style={{ background: "#050505" }}>
      <div className="shrink-0 flex flex-wrap gap-x-3 gap-y-0.5 px-2 py-1 font-mono text-[9px]">
        {symbols.map((symbol, index) => (
          <span key={symbol} style={{ color: missing.includes(symbol) ? "#777" : PALETTE[index] }}>
            ● {symbol}
            {missing.includes(symbol) ? " NO DATA" : ""}
          </span>
        ))}
        <span className="text-zinc-500">RETURN % · FIRST COMMON CLOSE = 0%</span>
      </div>
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 20, left: 4, bottom: 2 }}>
            <CartesianGrid stroke="#222" strokeDasharray="2 3" />
            <XAxis dataKey="date" tick={{ fill: "#777", fontSize: 9 }} minTickGap={45} />
            <YAxis
              tick={{ fill: "#999", fontSize: 9 }}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              width={48}
            />
            <Tooltip
              contentStyle={{ background: "#111", border: "1px solid #444", fontSize: 10 }}
              formatter={(v) => `${Number(v).toFixed(2)}%`}
            />
            {symbols.map((symbol, index) => (
              <Line
                key={symbol}
                dataKey={symbol}
                type="linear"
                dot={false}
                stroke={PALETTE[index]}
                strokeWidth={1.5}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
