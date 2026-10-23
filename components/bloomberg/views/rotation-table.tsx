"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { QUAD_COLOR } from "../lib/rrg-quadrant";
import { SCROLLBAR_THIN_LIGHTER } from "../lib/style-constants";
import type { bloombergColors } from "../lib/theme-config";
import { RotationMapPanel } from "./rotation-map";
import { RotationMembers } from "./rotation-members";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RotationRow {
  name: string;
  id: string;
  symbol: string;
  kind: "theme" | "sector" | "industry";
  n_members: number | null;
  /** TH only: the SET industry group a sector belongs to, and how much of the
   *  group's market cap the ROT basket covers. */
  industry?: string;
  basket_n?: number;
  coverage_pct?: number | null;
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
  market?: string;
  definition?: {
    standard: string;
    source: string;
    membership_as_of: string | null;
    method: string;
  };
  error?: string;
}

type Market = "US" | "TH";
type KindFilter = "all" | "theme" | "sector" | "industry";
type SortKey = "d1" | "w1" | "m1" | "m3" | "m1_vs_bench";
type View = "TABLE" | "MAP";

const VIEW_KEY = "bloomberg_rotation_view";
const TAILS = [4, 8, 12] as const;

const KIND_TITLE: Record<Market, Partial<Record<KindFilter, string>>> = {
  US: {
    all: "Every group",
    theme: "Theme ETFs — a theme is what its fund holds",
    sector: "The 11 GICS sectors (Select Sector SPDRs)",
  },
  TH: {
    all: "Every group",
    industry: "The SET's 8 industry groups",
    sector: "The SET's sectors",
  },
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
  const [market, setMarket] = useState<Market>("US");
  const [kind, setKind] = useState<KindFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("m1");
  // The group whose members are on screen (the drill-down replaces the table).
  const [openGroup, setOpenGroup] = useState<{ id: string; name: string } | null>(null);
  const [view, setView] = useState<View>(() => {
    if (typeof window === "undefined") return "TABLE";
    try {
      if (localStorage.getItem(VIEW_KEY) === "MAP") return "MAP";
    } catch {
      /* ignore */
    }
    return "TABLE";
  });
  const [tail, setTail] = useState<number>(8);
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* ignore */
    }
  }, [view]);

  const { data, isLoading, isError, refetch } = useQuery<RotationData>({
    queryKey: ["rotation-table", market],
    queryFn: async () => {
      const res = await fetch(`/api/rotation/table?market=${market}`);
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    enabled: view === "TABLE",
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });

  const fs = compact ? "text-[6px]" : "text-[9px]";
  const cellPad = compact ? "px-0.5 py-px" : "px-1.5 py-0.5";
  const cols = SORT_COLS;
  const kinds: KindFilter[] =
    market === "TH" ? ["all", "industry", "sector"] : ["all", "theme", "sector"];

  const switchMarket = (m: Market) => {
    setMarket(m);
    setOpenGroup(null);
    setKind("all"); // US filters by theme/sector, TH by SET industry group/sector
  };

  const btnFs = compact ? "text-[6px]" : "text-[8px]";
  const viewBar = (
    <div className="flex items-center gap-1.5 shrink-0">
      {(["TABLE", "MAP"] as View[]).map((v) => (
        <button
          aria-pressed={view === v}
          type="button"
          key={v}
          className={`${btnFs} font-bold leading-4`}
          style={{ color: view === v ? "#FF9800" : colors.textSecondary }}
          onClick={() => setView(v)}
          title={v === "MAP" ? "Relative Rotation Graph — sectors only" : "Momentum table"}
        >
          {v}
        </button>
      ))}
    </div>
  );

  if (view === "MAP")
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div
          className="flex items-center gap-2 px-1 py-0.5 shrink-0"
          style={{ background: "#060606", borderBottom: `1px solid ${colors.border}` }}
        >
          {viewBar}
          <span style={{ color: "#333" }}>│</span>
          {(["US", "TH"] as Market[]).map((m) => (
            <button
              aria-pressed={market === m}
              type="button"
              key={m}
              className={`${btnFs} font-bold leading-4`}
              style={{ color: market === m ? "#57CC99" : colors.textSecondary }}
              onClick={() => switchMarket(m)}
            >
              {m === "US" ? "🇺🇸 US" : "🇹🇭 TH"}
            </button>
          ))}
          <span style={{ color: "#333" }}>│</span>
          <span className={btnFs} style={{ color: colors.textSecondary }}>
            TAIL
          </span>
          {TAILS.map((t) => (
            <button
              aria-pressed={tail === t}
              type="button"
              key={t}
              className={`${btnFs} font-bold leading-4`}
              style={{ color: tail === t ? "#FF9800" : colors.textSecondary }}
              onClick={() => setTail(t)}
              title={`${t} weeks of history per sector`}
            >
              {t}W
            </button>
          ))}
          <span
            className={`${compact ? "text-[5.5px]" : "text-[7px]"} font-mono ml-auto`}
            style={{ color: `${colors.textSecondary}88` }}
            title="RS = close ÷ benchmark (weekly). RS-Ratio = 100·RS ÷ SMA8(RS); RS-Mom = 100·RS-Ratio ÷ SMA4(RS-Ratio). JdK-style approximation. US = the 11 GICS sectors via their Select Sector SPDRs. TH = the SET's 8 industry groups, each a cap-weighted basket of its largest members (the SET's own indices are not on Yahoo); benchmark falls back to TDEX.BK (SET50 ETF) when Yahoo has no ^SET.BK history."
          >
            {market === "US" ? "GICS sectors (SPDR) vs SPY" : "SET industry groups vs SET"} · weekly
            · ⓘ
          </span>
        </div>
        <div className="flex-1 min-h-0">
          <RotationMapPanel market={market} tail={tail} colors={colors} compact={compact} />
        </div>
      </div>
    );

  if (openGroup)
    return (
      <RotationMembers
        market={market}
        groupId={openGroup.id}
        groupName={openGroup.name}
        colors={colors}
        compact={compact}
        onBack={() => setOpenGroup(null)}
      />
    );

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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Market + filter bar */}
      <div
        className="flex items-center gap-1 px-1 py-0.5 shrink-0"
        style={{ background: "#060606", borderBottom: `1px solid ${colors.border}` }}
      >
        {viewBar}
        <div className="flex overflow-hidden border" style={{ borderColor: colors.border }}>
          {(["US", "TH"] as Market[]).map((m, i) => (
            <button
              aria-pressed={market === m}
              type="button"
              key={m}
              className={`${compact ? "text-[6px]" : "text-[8px]"} font-bold px-1 py-0 leading-4`}
              style={{
                background: market === m ? "#57CC9920" : "transparent",
                color: market === m ? "#57CC99" : colors.textSecondary,
                borderRight: i === 0 ? `1px solid ${colors.border}` : undefined,
              }}
              onClick={() => switchMarket(m)}
            >
              {m === "US" ? "🇺🇸 US" : "🇹🇭 TH"}
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden border" style={{ borderColor: colors.border }}>
          {kinds.map((k, i) => (
            <button
              aria-pressed={kind === k}
              type="button"
              key={k}
              className={`${compact ? "text-[6px]" : "text-[8px]"} font-bold px-1 py-0 leading-4`}
              style={{
                background: kind === k ? "#FF980020" : "transparent",
                color: kind === k ? "#FF9800" : colors.textSecondary,
                borderRight: i < kinds.length - 1 ? `1px solid ${colors.border}` : undefined,
              }}
              onClick={() => setKind(k)}
              title={KIND_TITLE[market][k]}
            >
              {k === "all" ? "ALL" : k.toUpperCase()}
            </button>
          ))}
        </div>
        <span
          className={`${compact ? "text-[5.5px]" : "text-[7px]"} font-mono ml-auto`}
          style={{ color: `${colors.textSecondary}88` }}
          title={
            data.definition
              ? `${data.definition.standard} — ${data.definition.method}${
                  data.definition.membership_as_of
                    ? ` · membership as of ${data.definition.membership_as_of}`
                    : ""
                } · ${data.definition.source}`
              : undefined
          }
        >
          vs {data.bench} · {data.as_of ?? ""}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={SCROLLBAR_THIN_LIGHTER}>
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
                {market === "TH"
                  ? compact
                    ? "SET GROUP"
                    : "SET INDUSTRY / SECTOR"
                  : compact
                    ? "THEME/SEC"
                    : "THEME / SECTOR (GICS)"}
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
              const isIndustry = r.kind === "industry";
              const label =
                market === "TH"
                  ? compact
                    ? r.id
                    : r.name
                  : compact
                    ? r.name.replace(/\s*\(X[A-Z]+\)$/, "").slice(0, 10)
                    : r.name;
              const basket =
                r.coverage_pct != null
                  ? ` · index = ${r.basket_n} largest of ${r.n_members} (${r.coverage_pct}% of cap)`
                  : "";
              return (
                <tr
                  key={r.id}
                  className="cursor-pointer hover:opacity-80"
                  style={{
                    borderBottom: "1px solid #111",
                    background: isIndustry ? "#0c0c0c" : "transparent",
                  }}
                  title={`${r.name.includes(`(${r.symbol})`) ? r.name : `${r.name} (${r.symbol})`}${r.industry && !isIndustry ? ` · ${r.industry}` : ""} — ${r.quadrant ?? "?"} ${arrow}${basket} · click for members`}
                  onClick={() => setOpenGroup({ id: r.id, name: r.name })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setOpenGroup({ id: r.id, name: r.name });
                  }}
                >
                  <td
                    className={`${fs} ${cellPad} font-mono whitespace-nowrap ${isIndustry ? "font-bold" : ""}`}
                    style={{ color: colors.text }}
                  >
                    <span style={{ color: `${colors.textSecondary}88` }}>▸ </span>
                    {label}
                    {market === "TH" && !compact && (
                      <span className="ml-1" style={{ color: `${colors.textSecondary}88` }}>
                        {r.id}
                      </span>
                    )}
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
          {market === "US"
            ? "คลิกแถว = หุ้นทุกตัวในกลุ่ม · sector = GICS (SPDR) · theme = ETF"
            : "คลิกแถว = หุ้นทุกตัวตาม SET · กลุ่ม = cap-weighted หุ้นใหญ่ ≥80%"}
        </span>
      </div>
    </div>
  );
}
