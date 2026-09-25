"use client";

/**
 * BOND [B] — bond prices next to bond supply.
 *
 * A corporate yield is Treasury + spread. The page keeps the two legs apart
 * and puts each next to the supply that could move it: corporate deals (SEC
 * prospectus count) against the spread and the 10Y, Treasury auctions against
 * term premium, and the slow stock of corporate debt / bank loans underneath.
 * The event study is the direct test of "heavy issuance days push yields up".
 */

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useCreditData, useCreditRefresh } from "../../hooks/useCreditData";
import { useTabShortcuts } from "../../hooks/useTabShortcuts";

import {
  HistoryChart,
  IssuanceChart,
  RANGES,
  type RangeKey,
  SlowCard,
  TreasurySupplyChart,
} from "./charts";
import { ConditionsTab } from "./conditions";
import { BasisTradePanel } from "./positioning";
import { AuctionsTable, DealsPanel, EventStudyPanel, KpiStrip } from "./tables";
import type { BondIssuance, BondOverview, BondSupply } from "./types";
import { C, Panel } from "./ui";

type BondTab = "market" | "conditions";
const TABS: { id: BondTab; label: string }[] = [
  { id: "market", label: "MARKET" },
  { id: "conditions", label: "CONDITIONS" },
];
const TAB_KEY = "bloomberg_bond_tab";
const LEVEL_COLOR = ["#4ADE80", "#FFC107", "#FF9800", "#EF5350"];
const LEVEL_LABEL = ["NORMAL", "WATCH", "WARNING", "CRISIS"];

const getJson = <T,>(url: string) =>
  fetch(url).then(async (r) => {
    const body = await r.json();
    if (!r.ok) throw new Error(body?.error ?? body?.detail ?? `HTTP ${r.status}`);
    return body as T;
  });

export function BondView() {
  const [tab, setTab] = useState<BondTab>(() => {
    if (typeof window === "undefined") return "market";
    try {
      const s = localStorage.getItem(TAB_KEY);
      if (s === "market" || s === "conditions") return s;
    } catch {
      /* ignore */
    }
    return "market";
  });
  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* ignore */
    }
  }, [tab]);
  useTabShortcuts(TABS, setTab);

  const [range, setRange] = useState<RangeKey>("1Y");
  const [couponsOnly, setCouponsOnly] = useState(true);

  const overview = useQuery<BondOverview>({
    queryKey: ["bonds", "overview"],
    queryFn: () => getJson("/api/bonds/overview"),
    staleTime: 10 * 60_000,
    refetchInterval: 30 * 60_000,
  });
  const supply = useQuery<BondSupply>({
    queryKey: ["bonds", "supply"],
    queryFn: () => getJson("/api/bonds/supply"),
    staleTime: 60 * 60_000,
  });
  const issuance = useQuery<BondIssuance>({
    queryKey: ["bonds", "issuance"],
    queryFn: () => getJson("/api/bonds/issuance"),
    staleTime: 60_000,
    // Poll fast only while the EDGAR backfill is still filling the year
    refetchInterval: (q) => (q.state.data?.backfill.running ? 8_000 : 30 * 60_000),
  });

  const rows = useMemo(() => {
    const h = overview.data?.history ?? [];
    return h.slice(-RANGES[range]);
  }, [overview.data, range]);

  const weeks = useMemo(() => {
    const w = issuance.data?.weekly ?? [];
    const cutoff = rows[0]?.date;
    return cutoff ? w.filter((x) => x.week >= cutoff.slice(0, 10)) : w;
  }, [issuance.data, rows]);

  // Crisis level shows in the status bar on both tabs; polls only on CONDITIONS
  const credit = useCreditData(tab === "conditions");
  const refreshCredit = useCreditRefresh();

  const refreshAll = () => {
    overview.refetch();
    supply.refetch();
    issuance.refetch();
    if (tab === "conditions") refreshCredit();
  };
  const fetching =
    overview.isFetching || supply.isFetching || issuance.isFetching || credit.isFetching;
  const level = credit.data?.level;
  const errors = [
    ...(overview.data?.errors ?? []),
    ...(supply.data?.errors ?? []),
    ...(issuance.data?.backfill.last_error ? [`EDGAR ${issuance.data.backfill.last_error}`] : []),
  ];
  const bf = issuance.data?.backfill;

  return (
    <div className="flex flex-col h-full font-mono bg-black text-white overflow-hidden">
      {/* ── Status bar ─────────────────────────────────────────────────────── */}
      <div
        className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b flex-wrap"
        style={{ borderColor: "#1a1a1a" }}
      >
        <span style={{ color: C.amber, fontSize: 12, letterSpacing: "0.12em" }}>BOND MONITOR</span>
        <div className="flex items-center gap-2" style={{ fontSize: 10.5 }}>
          {TABS.map((t, i) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              title={`Alt+${i + 1}`}
              style={{ color: tab === t.id ? C.amber : "#555", letterSpacing: "0.08em" }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {level != null && (
          <button
            type="button"
            onClick={() => setTab("conditions")}
            title={`crisis level — ${credit.data?.triggered.length ?? 0} threshold breaches`}
            style={{ color: LEVEL_COLOR[level], fontSize: 10 }}
          >
            L{level} {LEVEL_LABEL[level]}
          </button>
        )}
        <div
          className="flex items-center gap-2"
          style={{ fontSize: 10, display: tab === "market" ? undefined : "none" }}
        >
          {(Object.keys(RANGES) as RangeKey[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              style={{ color: range === r ? C.amber : "#555" }}
            >
              {r}
            </button>
          ))}
        </div>
        {bf && bf.pending > 0 && (
          <span style={{ color: "#8a8a8a", fontSize: 10 }}>
            EDGAR {bf.running ? "backfilling" : "paused"} {bf.days_stored}/{bf.days_total} days
          </span>
        )}
        {errors.length > 0 && (
          <span style={{ color: "#B06000", fontSize: 10 }} title={errors.join("\n")}>
            {errors.length} source error{errors.length > 1 ? "s" : ""}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <span style={{ color: C.dim, fontSize: 10 }}>DATA {overview.data?.asOf ?? "—"}</span>
          <button
            type="button"
            onClick={refreshAll}
            disabled={fetching}
            className="flex items-center gap-1"
            style={{ color: "#777", fontSize: 10 }}
          >
            <RefreshCw size={9} className={fetching ? "animate-spin" : ""} />
            {fetching ? "..." : "REFRESH"}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "conditions" ? (
          <div className="p-2 pb-6">
            <ConditionsTab data={credit.data} isLoading={credit.isLoading} error={credit.error} />
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-2 pb-6">
            {overview.isLoading ? (
              <span style={{ color: "#666", fontSize: 11 }}>LOADING FRED…</span>
            ) : overview.error || overview.data?.ok === false ? (
              <span style={{ color: "#FF4444", fontSize: 11 }}>
                OVERVIEW FAILED — {overview.data?.detail ?? String(overview.error)}
              </span>
            ) : (
              <KpiStrip kpis={overview.data?.kpis ?? []} />
            )}

            {/* ── Price: Treasury leg, credit leg ───────────────────────────── */}
            <div className="grid gap-2 grid-cols-1 xl:grid-cols-2">
              <HistoryChart
                title="TREASURY LEG"
                note="yields % · term premium ▸ right axis"
                rows={rows}
                lines={[
                  { key: "UST2Y", label: "2Y", color: "#60A5FA" },
                  { key: "UST10Y", label: "10Y", color: C.amber },
                  { key: "UST30Y", label: "30Y", color: "#F472B6" },
                  { key: "REAL10", label: "10Y REAL", color: "#A3E635" },
                  { key: "TP10", label: "TERM PREM", color: "#C084FC", axis: "right" },
                ]}
              />
              <HistoryChart
                title="CREDIT LEG"
                note="spreads % · BBB yield ▸ right axis"
                rows={rows}
                lines={[
                  { key: "IG_OAS", label: "IG OAS", color: "#3B82F6", threshold: 2 },
                  { key: "HY_OAS", label: "HY OAS", color: "#EF4444", threshold: 5 },
                  { key: "BAA_AAA", label: "Baa−Aaa", color: "#A3A3A3" },
                  { key: "BBB_Y", label: "BBB YLD", color: C.amber, axis: "right" },
                ]}
              />
            </div>

            {/* ── Positioning: who holds the Treasury futures (CFTC, weekly) ─── */}
            <BasisTradePanel />

            {/* ── Supply: corporate ─────────────────────────────────────────── */}
            <div className="grid gap-2 grid-cols-1 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <div className="flex flex-col gap-2 min-w-0">
                {issuance.data ? (
                  <IssuanceChart weeks={weeks} />
                ) : (
                  <Panel title="CORPORATE ISSUANCE / WEEK">
                    <span style={{ color: "#666", fontSize: 10 }}>
                      {issuance.error ? `FAILED — ${String(issuance.error)}` : "LOADING EDGAR…"}
                    </span>
                  </Panel>
                )}
                {issuance.data && (
                  <EventStudyPanel
                    es={issuance.data.event_study}
                    backfill={issuance.data.backfill}
                  />
                )}
              </div>
              {issuance.data && (
                <DealsPanel deals={issuance.data.recent} method={issuance.data.method} />
              )}
            </div>

            {/* ── Supply: Treasury + slow stock ─────────────────────────────── */}
            <div className="grid gap-2 grid-cols-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <Panel
                title="TREASURY AUCTIONS"
                note="fiscaldata · high yield vs dealer takedown"
                right={
                  <button
                    type="button"
                    onClick={() => setCouponsOnly((v) => !v)}
                    style={{ color: couponsOnly ? C.amber : "#555", fontSize: 9 }}
                  >
                    {couponsOnly ? "COUPONS ONLY" : "ALL (incl. bills)"}
                  </button>
                }
              >
                {supply.data ? (
                  <>
                    <TreasurySupplyChart weekly={supply.data.weekly} />
                    <AuctionsTable
                      upcoming={supply.data.auctions.upcoming}
                      recent={supply.data.auctions.recent}
                      couponsOnly={couponsOnly}
                    />
                  </>
                ) : (
                  <span style={{ color: "#666", fontSize: 10 }}>
                    {supply.error ? `FAILED — ${String(supply.error)}` : "LOADING…"}
                  </span>
                )}
              </Panel>
              <Panel title="DEBT STOCK & CREDIT CONDITIONS" note="quarterly / monthly · FRED">
                <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                  {supply.data?.slow.map((s) => (
                    <SlowCard key={s.id} s={s} />
                  ))}
                </div>
                <span style={{ color: "#555", fontSize: 9 }}>
                  Z.1 ออกช้า ~5 เดือน — ใช้ยืนยันแนวโน้ม ไม่ใช่จับจังหวะ. SLOOS &gt; 0 = ธนาคารเข้มงวดขึ้น →
                  บริษัทหันไปออกหุ้นกู้แทน
                </span>
              </Panel>
            </div>

            <span style={{ color: "#444", fontSize: 9 }}>
              {overview.data?.source} · {supply.data?.source} · {issuance.data?.source}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default BondView;
