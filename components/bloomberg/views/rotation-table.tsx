"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import type { bloombergColors } from "../lib/theme-config";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RotationRow {
  name: string;
  symbol: string;
  kind: "theme" | "sector";
  d1: number | null;
  w1: number | null;
  m1: number | null;
  m3: number | null;
  m1_vs_bench: number | null;
  quadrant: "Leading" | "Improving" | "Weakening" | "Lagging" | null;
  mom_dir: "up" | "down" | null;
}

interface RotationData {
  rows: RotationRow[];
  bench: string;
  bench_m1: number | null;
  as_of: string | null;
  error?: string;
}

type KindFilter = "all" | "theme" | "sector";
type SortKey = "d1" | "w1" | "m1" | "m3" | "m1_vs_bench";

const QUAD_COLOR: Record<string, string> = {
  Leading: "#4ade80",
  Improving: "#60a5fa",
  Weakening: "#facc15",
  Lagging: "#f87171",
};

const SORT_COLS: { key: SortKey; label: string }[] = [
  { key: "d1", label: "1D%" },
  { key: "w1", label: "1W%" },
  { key: "m1", label: "1M%" },
  { key: "m3", label: "3M%" },
  { key: "m1_vs_bench", label: "1MvB" },
];

// Green/red cell shading scaled to ±15% (clamped) — matches heatmap read
function cellBg(v: number | null): string {
  if (v === null) return "transparent";
  const t = Math.min(1, Math.abs(v) / 15);
  return v >= 0 ? `rgba(34,197,94,${0.08 + t * 0.45})` : `rgba(239,68,68,${0.08 + t * 0.45})`;
}

function cellFg(v: number | null): string {
  if (v === null) return "#555";
  return v >= 0 ? "#4ade80" : "#f87171";
}

function fmt(v: number | null, compact = false): string {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(compact ? 1 : 2)}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface RotationTableProps {
  colors: typeof bloombergColors.dark;
  compact: boolean;
}

export function RotationTable({ colors, compact }: RotationTableProps) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("m1");

  const { data, isLoading, isError, refetch } = useQuery<RotationData>({
    queryKey: ["rotation-table"],
    queryFn: async () => {
      const res = await fetch("/api/rotation/table");
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-full gap-1">
        <Loader2 className="h-3 w-3 animate-spin" style={{ color: colors.textSecondary }} />
        <span className="text-[7px] font-mono" style={{ color: colors.textSecondary }}>
          loading rotation…
        </span>
      </div>
    );

  if (isError || !data || data.error)
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-[7px] font-mono" style={{ color: "#FF4444" }}>
          ERROR{" "}
          <button type="button" className="underline hover:opacity-70" onClick={() => refetch()}>
            RETRY
          </button>
        </span>
      </div>
    );

  const rows = data.rows
    .filter((r) => kind === "all" || r.kind === kind)
    .sort((a, b) => (b[sortKey] ?? -999) - (a[sortKey] ?? -999));

  const fs = compact ? "text-[6px]" : "text-[9px]";
  const cellPad = compact ? "px-0.5 py-px" : "px-1.5 py-0.5";
  const cols = SORT_COLS;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Filter + sort bar */}
      <div
        className="flex items-center gap-1 px-1 py-0.5 shrink-0"
        style={{ background: "#060606", borderBottom: `1px solid ${colors.border}` }}
      >
        <div className="flex overflow-hidden border" style={{ borderColor: colors.border }}>
          {(["all", "theme", "sector"] as KindFilter[]).map((k, i) => (
            <button
              type="button"
              key={k}
              className={`${compact ? "text-[6px]" : "text-[8px]"} font-bold px-1 py-0 leading-4`}
              style={{
                background: kind === k ? "#FF980020" : "transparent",
                color: kind === k ? "#FF9800" : colors.textSecondary,
                borderRight: i < 2 ? `1px solid ${colors.border}` : undefined,
              }}
              onClick={() => setKind(k)}
            >
              {k === "all" ? "ALL" : k === "theme" ? "THEME" : "SECTOR"}
            </button>
          ))}
        </div>
        <span
          className={`${compact ? "text-[5.5px]" : "text-[7px]"} font-mono ml-auto`}
          style={{ color: `${colors.textSecondary}88` }}
        >
          vs {data.bench} · {data.as_of ?? ""}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr
              className="sticky top-0"
              style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}
            >
              <th
                className={`${fs} ${cellPad} font-mono text-left font-bold`}
                style={{ color: colors.textSecondary }}
              >
                {compact ? "THEME/SEC" : "THEME / SECTOR"}
              </th>
              {cols.map((c) => (
                <th
                  key={c.key}
                  className={`${fs} ${cellPad} font-mono text-right font-bold cursor-pointer hover:opacity-70`}
                  style={{ color: sortKey === c.key ? "#FF9800" : colors.textSecondary }}
                  onClick={() => setSortKey(c.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setSortKey(c.key);
                  }}
                  title={`sort by ${c.label}`}
                >
                  {c.label}
                  {sortKey === c.key ? "▾" : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const qc = r.quadrant ? QUAD_COLOR[r.quadrant] : "#555";
              const arrow = r.mom_dir === "up" ? "↗" : r.mom_dir === "down" ? "↘" : "";
              return (
                <tr
                  key={r.symbol + r.name}
                  style={{ borderBottom: "1px solid #111" }}
                  title={`${r.name} (${r.symbol}) — ${r.quadrant ?? "?"} ${arrow} · RRG vs ${data.bench}`}
                >
                  <td
                    className={`${fs} ${cellPad} font-mono whitespace-nowrap`}
                    style={{ color: colors.text }}
                  >
                    {compact ? r.name.replace(/\s*\(X[A-Z]+\)$/, "").slice(0, 10) : r.name}
                    <span
                      className="ml-1 px-0.5 font-bold"
                      style={{ color: qc, background: `${qc}18`, border: `1px solid ${qc}33` }}
                    >
                      {compact ? (r.quadrant?.[0] ?? "?") : (r.quadrant ?? "?")}
                      {arrow}
                    </span>
                  </td>
                  {cols.map((c) => (
                    <td
                      key={c.key}
                      className={`${fs} ${cellPad} font-mono text-right`}
                      style={{ background: cellBg(r[c.key]), color: cellFg(r[c.key]) }}
                    >
                      {fmt(r[c.key], compact)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div
        className="shrink-0 flex items-center gap-1.5 px-1 py-0.5 flex-wrap"
        style={{ borderTop: `1px solid ${colors.border}`, background: "#060606" }}
      >
        {Object.entries(QUAD_COLOR).map(([q, c]) => (
          <span key={q} className={compact ? "text-[5.5px]" : "text-[7px]"} style={{ color: c }}>
            ● {compact ? q[0] : q}
          </span>
        ))}
        <span
          className={compact ? "text-[5.5px]" : "text-[7px]"}
          style={{ color: `${colors.textSecondary}66` }}
        >
          ↗↘ = RS-momentum turn · ETF proxies, equal-weight ไม่ใช่
        </span>
      </div>
    </div>
  );
}
