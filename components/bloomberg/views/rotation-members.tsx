"use client";

import { useQuery } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { currentViewAtom, stockSearchSymbolAtom } from "../atoms";
import { openChartWindowAtom } from "../atoms/chart-windows";
import { fmtPriceStd, numberFormat } from "../lib/number-format";
import { QUAD_COLOR, type Quadrant } from "../lib/rrg-quadrant";
import type { bloombergColors } from "../lib/theme-config";

// ── Types (/api/rotation/constituents) ────────────────────────────────────────

export interface MemberRow {
  symbol: string;
  yf_symbol: string;
  name: string;
  sector: string | null;
  weight: number | null;
  market_cap: number | null;
  in_basket: boolean | null;
  priced: boolean;
  price: number | null;
  d1: number | null;
  w1: number | null;
  m1: number | null;
  m3: number | null;
  m1_vs_bench: number | null;
  quadrant: Quadrant | null;
  mom_dir: "up" | "down" | null;
}

interface MemberSource {
  label: string;
  url: string;
  as_of: string | null;
  coverage: "all" | "top10";
  weight_basis: string;
  n_total: number;
  n_priced: number;
  note?: string;
}

export interface MembersData {
  id: string;
  market: "US" | "TH";
  bench?: string;
  as_of?: string | null;
  currency?: "USD" | "THB";
  group?: {
    id: string;
    name: string;
    kind: "sector" | "theme" | "industry";
    industry?: string;
    definition: string;
    source?: MemberSource;
    basket?: { n: number; coverage_pct: number | null };
  };
  rows: MemberRow[];
  error?: string;
}

type SortKey = "weight" | "d1" | "w1" | "m1" | "m3" | "m1_vs_bench";

const RET_COLS: { key: Exclude<SortKey, "weight">; label: string }[] = [
  { key: "d1", label: "1D%" },
  { key: "w1", label: "1W%" },
  { key: "m1", label: "1M%" },
  { key: "m3", label: "3M%" },
  { key: "m1_vs_bench", label: "1MvB" },
];

const PCT2 = numberFormat(2, 2);
const MCAP = numberFormat(0, 0);

function retFg(v: number | null): string {
  if (v === null) return "#555";
  return v >= 0 ? "#4ade80" : "#f87171";
}

function retBg(v: number | null): string {
  if (v === null) return "transparent";
  const t = Math.min(1, Math.abs(v) / 15);
  return v >= 0 ? `rgba(34,197,94,${0.06 + t * 0.4})` : `rgba(239,68,68,${0.06 + t * 0.4})`;
}

function fmtRet(v: number | null, compact: boolean): string {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(compact ? 1 : 2)}`;
}

/** Every member of one ROT group, by the group's published definition. */
export function RotationMembers({
  market,
  groupId,
  groupName,
  colors,
  compact,
  onBack,
}: {
  market: "US" | "TH";
  groupId: string;
  groupName: string;
  colors: typeof bloombergColors.dark;
  compact: boolean;
  onBack: () => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("weight");
  const setView = useSetAtom(currentViewAtom);
  const setStockSymbol = useSetAtom(stockSearchSymbolAtom);
  const openChartWindow = useSetAtom(openChartWindowAtom);

  const { data, isLoading, isError, refetch } = useQuery<MembersData>({
    queryKey: ["rotation-constituents", market, groupId],
    queryFn: async () => {
      const res = await fetch(
        `/api/rotation/constituents?market=${market}&id=${encodeURIComponent(groupId)}`
      );
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });

  const rows = useMemo(() => {
    const list = data?.rows ?? [];
    return [...list].sort(
      (a, b) => (b[sortKey] ?? Number.NEGATIVE_INFINITY) - (a[sortKey] ?? Number.NEGATIVE_INFINITY)
    );
  }, [data, sortKey]);

  const open = (r: MemberRow, shift: boolean) => {
    if (shift) {
      openChartWindow({ symbol: r.yf_symbol });
      return;
    }
    setStockSymbol(r.yf_symbol);
    setView("stock");
  };

  const fs = compact ? "text-[6px]" : "text-[9px]";
  const small = compact ? "text-[5.5px]" : "text-[7px]";
  const cellPad = compact ? "px-0.5 py-px" : "px-1.5 py-0.5";
  const isTh = market === "TH";
  const isIndustry = data?.group?.kind === "industry";
  const src = data?.group?.source;
  // Compact keeps what ranks a member against its group; the expanded panel shows all of it.
  const retCols = compact
    ? RET_COLS.filter((c) => c.key === "m1" || c.key === "m1_vs_bench")
    : RET_COLS;

  const sortBtn = (key: SortKey, label: string, align: "left" | "right" = "right") => (
    <button
      type="button"
      aria-pressed={sortKey === key}
      className={`font-bold hover:opacity-70 w-full ${align === "right" ? "text-right" : "text-left"}`}
      style={{ color: sortKey === key ? "#FF9800" : colors.textSecondary }}
      onClick={() => setSortKey(key)}
      title={`sort by ${label}`}
    >
      {label}
      {sortKey === key ? "▾" : ""}
    </button>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Group bar: back · name · what the group is and where its members come from */}
      <div
        className="shrink-0 px-1 py-0.5"
        style={{ background: "#060606", borderBottom: `1px solid ${colors.border}` }}
      >
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={`${compact ? "text-[6px]" : "text-[8px]"} font-bold leading-4 hover:opacity-70`}
            style={{ color: "#FF9800" }}
            onClick={onBack}
            title="Back to the rotation table"
          >
            ◂ BACK
          </button>
          <span className={`${fs} font-mono font-bold truncate`} style={{ color: colors.text }}>
            {data?.group?.name ?? groupName}
          </span>
          <span className={`${small} font-mono shrink-0`} style={{ color: colors.textSecondary }}>
            {groupId}
            {data?.group?.kind ? ` · ${data.group.kind.toUpperCase()}` : ""}
          </span>
          {src && (
            <a
              href={src.url}
              target="_blank"
              rel="noreferrer"
              className={`${small} font-mono ml-auto shrink-0 underline hover:opacity-70`}
              style={{ color: `${colors.textSecondary}aa` }}
              title={`${src.label}${src.as_of ? ` · as of ${src.as_of}` : ""}${src.note ? ` — ${src.note}` : ""}`}
            >
              {src.coverage === "all" ? `${src.n_total} MEMBERS` : `TOP ${src.n_total}`}
              {src.as_of ? ` · ${src.as_of}` : ""} · SRC
            </a>
          )}
        </div>
        {data?.group && !compact && (
          <div
            className={`${small} font-mono leading-tight`}
            style={{ color: `${colors.textSecondary}cc` }}
          >
            {data.group.definition}
            {src ? ` · source: ${src.label}` : ""}
            {src?.note ? ` — ${src.note}` : ""}
            {data.group.basket?.coverage_pct != null
              ? ` · ROT index = ${data.group.basket.n} largest (${data.group.basket.coverage_pct}% of group cap, cap-weighted) •`
              : ""}
            {src && src.n_priced < src.n_total ? ` · returns for the ${src.n_priced} largest` : ""}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center flex-1 gap-1">
          <Loader2 className="h-3 w-3 animate-spin" style={{ color: colors.textSecondary }} />
          <span className={`${small} font-mono`} style={{ color: colors.textSecondary }}>
            loading members…
          </span>
        </div>
      ) : isError || !data || data.error || !data.rows.length ? (
        <div className="flex items-center justify-center flex-1">
          <span className={`${small} font-mono`} style={{ color: "#FF4444" }}>
            {data?.error ? data.error.toUpperCase() : "NO MEMBER DATA"}{" "}
            <button type="button" className="underline hover:opacity-70" onClick={() => refetch()}>
              RETRY
            </button>
          </span>
        </div>
      ) : (
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
                  SYMBOL
                </th>
                {!compact && (
                  <th
                    className={`${fs} ${cellPad} font-mono text-left font-bold`}
                    style={{ color: colors.textSecondary }}
                  >
                    NAME
                  </th>
                )}
                {!compact && isIndustry && (
                  <th
                    className={`${fs} ${cellPad} font-mono text-left font-bold`}
                    style={{ color: colors.textSecondary }}
                  >
                    SECTOR
                  </th>
                )}
                <th className={`${fs} ${cellPad} font-mono`}>{sortBtn("weight", "WT%")}</th>
                {!compact && isTh && (
                  <th
                    className={`${fs} ${cellPad} font-mono text-right font-bold`}
                    style={{ color: colors.textSecondary }}
                    title="Market cap from the SET composition, million baht"
                  >
                    CAP ฿M
                  </th>
                )}
                {!compact && (
                  <th
                    className={`${fs} ${cellPad} font-mono text-right font-bold`}
                    style={{ color: colors.textSecondary }}
                  >
                    LAST
                  </th>
                )}
                {retCols.map((c) => (
                  <th key={c.key} className={`${fs} ${cellPad} font-mono`}>
                    {sortBtn(c.key, c.label)}
                  </th>
                ))}
                <th
                  className={`${fs} ${cellPad} font-mono text-left font-bold`}
                  style={{ color: colors.textSecondary }}
                >
                  Q
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const qc = r.quadrant ? QUAD_COLOR[r.quadrant] : "#555";
                const arrow = r.mom_dir === "up" ? "↗" : r.mom_dir === "down" ? "↘" : "";
                return (
                  <tr
                    key={r.yf_symbol}
                    className="cursor-pointer hover:opacity-80"
                    style={{ borderBottom: "1px solid #111", opacity: r.priced ? 1 : 0.55 }}
                    title={`${r.symbol} — ${r.name}${r.sector ? ` · ${r.sector}` : ""} · click = stock page · shift+click = chart window`}
                    onClick={(e) => open(r, e.shiftKey)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") open(r, e.shiftKey);
                    }}
                  >
                    <td
                      className={`${fs} ${cellPad} font-mono whitespace-nowrap font-bold`}
                      style={{ color: colors.text }}
                    >
                      {r.symbol}
                      {r.in_basket ? (
                        <span style={{ color: "#FF9800" }} title="In the group's ROT index basket">
                          {" "}
                          •
                        </span>
                      ) : null}
                    </td>
                    {!compact && (
                      <td
                        className={`${fs} ${cellPad} font-mono truncate max-w-[180px]`}
                        style={{ color: colors.textSecondary }}
                      >
                        {r.name}
                      </td>
                    )}
                    {!compact && isIndustry && (
                      <td
                        className={`${fs} ${cellPad} font-mono`}
                        style={{ color: colors.textSecondary }}
                      >
                        {r.sector ?? ""}
                      </td>
                    )}
                    <td
                      className={`${fs} ${cellPad} font-mono text-right`}
                      style={{ color: colors.text }}
                    >
                      {r.weight == null ? "—" : PCT2.format(r.weight)}
                    </td>
                    {!compact && isTh && (
                      <td
                        className={`${fs} ${cellPad} font-mono text-right`}
                        style={{ color: colors.textSecondary }}
                      >
                        {r.market_cap == null ? "—" : MCAP.format(r.market_cap / 1e6)}
                      </td>
                    )}
                    {!compact && (
                      <td
                        className={`${fs} ${cellPad} font-mono text-right`}
                        style={{ color: colors.text }}
                      >
                        {fmtPriceStd(r.price)}
                      </td>
                    )}
                    {retCols.map((c) => (
                      <td
                        key={c.key}
                        className={`${fs} ${cellPad} font-mono text-right`}
                        style={{ background: retBg(r[c.key]), color: retFg(r[c.key]) }}
                      >
                        {fmtRet(r[c.key], compact)}
                      </td>
                    ))}
                    <td
                      className={`${fs} ${cellPad} font-mono font-bold whitespace-nowrap`}
                      style={{ color: qc }}
                    >
                      {compact ? (r.quadrant?.[0] ?? "") : (r.quadrant ?? "")}
                      {arrow}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div
        className={`shrink-0 ${small} font-mono px-1 py-0.5`}
        style={{
          borderTop: `1px solid ${colors.border}`,
          background: "#060606",
          color: `${colors.textSecondary}88`,
        }}
      >
        คลิก = หน้าหุ้น · shift+คลิก = กราฟ · WT% = {src?.weight_basis ?? "weight"}
        {isTh ? " · • = อยู่ในตะกร้าดัชนีกลุ่ม" : ""}
        {data?.bench ? ` · vs ${data.bench}` : ""}
      </div>
    </div>
  );
}
