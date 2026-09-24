"use client";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type Colors, fmtK } from "../helpers";

// The book's own rotation map: entry cost of every lot still open at each
// week-end, stacked by bucket. A band that thickens is money moving in; one
// that thins is money coming out. Backend: /api/v2/portfolio/rotation.

export type RotationGroup = "theme" | "sector" | "account";
export type RotationMode = "COST" | "SHARE";

interface RotationSeries {
  key: string;
  values: number[];
  latest: number;
  peak: number;
  open_symbols: string[];
}

export interface PortfolioRotationResponse {
  weeks: string[];
  series: RotationSeries[];
  total: number[];
  markers: { date: string; kind: "cut"; label: string }[];
  excluded: number;
  /** First week of a long flat opening run that was cut from the chart. */
  flat_since?: string | null;
  base_currency: string;
  group: RotationGroup;
  taxonomy?: Record<string, string[]>;
  error?: string;
}

// Fixed colour per theme so a bucket keeps its colour across accounts and
// visits. Hues are spread around the wheel — no two neighbours in the stack
// share a family — and the legacy base is a muted slate so the live themes
// on top of it carry the eye.
const THEME_COLOR: Record<string, string> = {
  "TH LEGACY": "#64748b",
  PLATFORM: "#3b82f6",
  COMPUTE: "#a855f7",
  MEMORY: "#ec4899",
  POWER: "#f97316",
  DEFENSIVE: "#10b981",
  HEDGE: "#eab308",
  CRYPTO: "#06b6d4",
  OTHER: "#a1a1aa",
};
const PALETTE = [
  "#3b82f6",
  "#f97316",
  "#10b981",
  "#ec4899",
  "#eab308",
  "#a855f7",
  "#06b6d4",
  "#ef4444",
  "#84cc16",
  "#f472b6",
  "#14b8a6",
  "#fb7185",
  "#64748b",
  "#c084fc",
  "#fbbf24",
];

export function PortfolioRotationChart({
  accountId,
  currency,
  group,
  mode,
  colors,
  height = 280,
}: {
  accountId: string;
  currency: "THB" | "USD";
  group: RotationGroup;
  mode: RotationMode;
  colors: Colors;
  height?: number;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<string | null>(null);
  const sym = currency === "THB" ? "฿" : "$";

  const { data, isLoading, isError } = useQuery<PortfolioRotationResponse>({
    queryKey: ["portfolio-rotation", accountId, currency, group],
    queryFn: async () => {
      const qs = new URLSearchParams({ base_currency: currency, group });
      if (accountId !== "all") qs.set("account_id", accountId);
      const r = await fetch(`/api/v2/portfolio/rotation?${qs}`);
      if (!r.ok) throw new Error("fetch failed");
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const colorOf = useMemo(() => {
    const m: Record<string, string> = {};
    (data?.series ?? []).forEach((s, i) => {
      m[s.key] =
        group === "theme"
          ? (THEME_COLOR[s.key] ?? PALETTE[i % PALETTE.length])
          : PALETTE[i % PALETTE.length];
    });
    return m;
  }, [data, group]);

  const series = (data?.series ?? []).filter((s) => s.peak > 0);
  const shown = series.filter((s) => !hidden.has(s.key));

  const rows = useMemo(() => {
    if (!data) return [];
    return data.weeks.map((w, i) => {
      const row: Record<string, number | string> = { week: w };
      const tot = shown.reduce((a, s) => a + s.values[i], 0);
      for (const s of shown) {
        row[s.key] = mode === "SHARE" ? (tot > 0 ? (s.values[i] / tot) * 100 : 0) : s.values[i];
      }
      row.__total = data.total[i];
      return row;
    });
  }, [data, shown, mode]);

  if (isLoading)
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: colors.accent }} />
      </div>
    );
  if (isError || !data || data.error || !data.weeks.length)
    return (
      <div
        className="flex items-center justify-center text-[9px] font-mono"
        style={{ height, color: colors.textSecondary }}
      >
        {data?.error ?? "ยังไม่มีล็อตพอจะสร้าง rotation map"}
      </div>
    );

  const latestTotal = data.total.at(-1) ?? 0;
  const fmtWeek = (w: string) => `${w.slice(5, 7)}/${w.slice(2, 4)}`;
  const toggle = (k: string) =>
    setHidden((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n.size >= series.length ? prev : n;
    });

  return (
    <div className="flex flex-col lg:flex-row gap-2 min-w-0">
      <div className="flex-1 min-w-0">
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={rows} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f1f1f" vertical={false} />
            <XAxis
              dataKey="week"
              tick={{ fill: "#777", fontSize: 8 }}
              tickLine={false}
              tickFormatter={fmtWeek}
              minTickGap={24}
            />
            <YAxis
              tick={{ fill: "#777", fontSize: 8 }}
              tickLine={false}
              axisLine={false}
              domain={mode === "SHARE" ? [0, 100] : [0, "auto"]}
              ticks={mode === "SHARE" ? [0, 25, 50, 75, 100] : undefined}
              allowDataOverflow={mode === "SHARE"}
              tickFormatter={(v: number) => (mode === "SHARE" ? `${Math.round(v)}%` : fmtK(v))}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as Record<string, number>;
                const items = shown
                  .map((s) => ({ s, v: row[s.key] as number }))
                  .filter((x) => x.v > 0)
                  .sort((a, b) => b.v - a.v);
                return (
                  <div
                    className="font-mono"
                    style={{
                      background: "#0d0d0d",
                      border: "1px solid #333",
                      padding: 6,
                      fontSize: 10,
                      color: "#e5e5e5",
                    }}
                  >
                    <div className="mb-1">
                      week to {label} · open cost {sym}
                      {fmtK(row.__total)}
                    </div>
                    {items.map(({ s, v }) => (
                      <div key={s.key} className="flex justify-between gap-3">
                        <span style={{ color: colorOf[s.key] }}>■ {s.key}</span>
                        <span>{mode === "SHARE" ? `${v.toFixed(1)}%` : `${sym}${fmtK(v)}`}</span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            {data.markers.map((m, i) => (
              <ReferenceLine
                key={`${m.date}-${m.label}`}
                x={m.date}
                stroke="#f87171"
                strokeDasharray="3 3"
                label={{
                  value: m.label,
                  position: "insideTopLeft",
                  fill: "#f87171",
                  fontSize: 9,
                  dy: -14 + (i % 3) * 11,
                }}
              />
            ))}
            {shown.map((s) => (
              <Area
                key={s.key}
                dataKey={s.key}
                stackId="rot"
                type="linear"
                stroke={colorOf[s.key]}
                strokeWidth={hover === s.key ? 2 : 0.8}
                fill={colorOf[s.key]}
                fillOpacity={hover == null ? 0.72 : hover === s.key ? 0.95 : 0.18}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Legend = today's book, largest first; click to hide a band */}
      <div className="lg:w-56 shrink-0 font-mono text-[9px]">
        <div
          className="flex justify-between pb-1 mb-1 border-b"
          style={{ borderColor: "#222", color: colors.textSecondary }}
        >
          <span>NOW · {data.weeks.at(-1)}</span>
          <span>
            {sym}
            {fmtK(latestTotal)}
          </span>
        </div>
        {[...series]
          .sort((a, b) => b.latest - a.latest || b.peak - a.peak)
          .map((s) => {
            const off = hidden.has(s.key);
            const share = latestTotal > 0 ? (s.latest / latestTotal) * 100 : 0;
            return (
              <button
                type="button"
                key={s.key}
                onClick={() => toggle(s.key)}
                onMouseEnter={() => !off && setHover(s.key)}
                onMouseLeave={() => setHover(null)}
                className="flex items-center gap-1.5 w-full py-[2px] text-left"
                style={{ color: off ? "#444" : s.latest > 0 ? colors.text : "#777" }}
                title={`${s.open_symbols.length ? `Open: ${s.open_symbols.join(", ")}` : "No open lots"} · peak ${sym}${fmtK(s.peak)} · click to hide/show`}
              >
                <span
                  data-frame
                  className="inline-block w-2.5 h-2.5 shrink-0"
                  style={{ background: off ? "#333" : colorOf[s.key] }}
                />
                <span className="flex-1 truncate">{s.key}</span>
                <span className="tabular-nums">
                  {s.latest > 0 ? `${sym}${fmtK(s.latest)}` : "—"}
                </span>
                <span className="w-10 text-right tabular-nums" style={{ color: "#777" }}>
                  {s.latest > 0 ? `${share.toFixed(0)}%` : ""}
                </span>
              </button>
            );
          })}
        {data.flat_since && (
          <div className="mt-1 text-[8px]" style={{ color: "#666" }}>
            flat {data.flat_since} → {data.weeks[0]} hidden (placeholder entry dates)
          </div>
        )}
        {data.excluded > 0 && (
          <div className="mt-1 text-[8px]" style={{ color: "#666" }}>
            {data.excluded} lots excluded (closed without exit date / no cost)
          </div>
        )}
      </div>
    </div>
  );
}
