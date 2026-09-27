"use client";

/**
 * Always-on TAIL summary in the shared status row. Keep the current risk and
 * three highest-ranked named events stationary while market quotes move.
 *
 * A dimension whose data could not be verified reads NO DATA, never NORMAL —
 * the previous strip could print "ALL CLEAR" while its inputs were offline.
 */

import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { currentViewAtom } from "../atoms";
import { type EventSeverity, SEVERITY_COLOR } from "../views/tail/market-events";

type DimensionStatus = "ALERT" | "WATCH" | "NORMAL" | "UNKNOWN";
type RiskLevel = "HIGH" | "ELEVATED" | "CAUTION" | "NORMAL";

interface Dimension {
  id: string;
  label: string;
  status: DimensionStatus;
  on_count: number;
  total: number;
  unknown_count: number;
}

interface RibbonData {
  ok: boolean;
  risk_level: RiskLevel;
  dimensions: Dimension[];
  alert_dimensions: string[];
  watch_dimensions: string[];
  vix_term?: {
    vix: number | null;
    backwardation_front: boolean | null;
    backwardation_back: boolean | null;
  };
  vol_table?: { name: string; value: number | null; z63: number | null; ok: boolean }[];
  fear_greed?: number | null;
  dcc_v1_signal?: string;
  dcc_v3_signal?: string;
  data_health?: { degraded_count?: number };
  events?: {
    id: string;
    name: string;
    severity: EventSeverity;
    score?: number;
    summary: string;
    channel_label: string;
  }[];
  risk_basis?: { driver: "events" | "dimensions" | null; events_rule: string };
}

const EVENT_RANK: Record<EventSeverity, number> = { SEVERE: 3, ACTIVE: 2, WATCH: 1 };

function stripEventName(name: string): string {
  return name
    .replace(/^Cross-Asset /i, "")
    .split(" — ")[0]
    .toUpperCase();
}

const RISK_BADGE: Record<RiskLevel, { bg: string; border: string; fg: string }> = {
  HIGH: { bg: "#AA0000", border: "#550000", fg: "#FFDDDD" },
  ELEVATED: { bg: "#994400", border: "#552200", fg: "#FFEEDD" },
  CAUTION: { bg: "#665500", border: "#332a00", fg: "#FFF3CC" },
  NORMAL: { bg: "#141414", border: "#242424", fg: "#4a4a4a" },
};

export function TailRiskRibbon() {
  const [currentView, setCurrentView] = useAtom(currentViewAtom);

  const { data } = useQuery<RibbonData>({
    queryKey: ["tail-risk-signals"],
    queryFn: () => fetch("/api/tail-risk/signals").then((r) => r.json()),
    staleTime: 240_000,
    refetchInterval: 300_000,
  });

  const isActive = currentView === "tail";
  const level: RiskLevel = data?.risk_level ?? "NORMAL";
  const badge = RISK_BADGE[level] ?? RISK_BADGE.NORMAL;
  const dims = data?.dimensions ?? [];
  const degraded = data?.data_health?.degraded_count ?? 0;
  const failed = data != null && data.ok === false;
  const events = [...(data?.events ?? [])].sort(
    (a, b) => EVENT_RANK[b.severity] - EVENT_RANK[a.severity] || (b.score ?? 0) - (a.score ?? 0)
  );

  const vix = data?.vix_term?.vix;
  const inverted =
    data?.vix_term?.backwardation_front === true || data?.vix_term?.backwardation_back === true;
  const byName = new Map((data?.vol_table ?? []).map((r) => [r.name, r]));

  /** Detailed readings remain available on hover and in the TAIL view. */
  const extras = ["VVIX", "SKEW"]
    .map((n) => byName.get(n))
    .filter((r): r is NonNullable<typeof r> => !!r && r.ok && r.value != null);

  const topEvents = events.slice(0, 3);
  const detail = [
    ...dims.map((d) => `${d.label}: ${d.status} (${d.on_count}/${d.total})`),
    ...events.map((e) => `${e.name}: ${e.severity} — ${e.summary}`),
    ...extras.map((r) => `${r.name} ${r.value} (z63 ${r.z63 ?? "--"})`),
    vix != null ? `VIX ${vix.toFixed(1)}${inverted ? " inverted" : ""}` : "",
    degraded ? `${degraded} signals without data` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <button
      type="button"
      className="flex h-full min-w-0 shrink-0 items-center gap-1.5 overflow-hidden border-r px-2 text-left font-mono select-none"
      style={{
        width: "fit-content",
        maxWidth: "min(58vw, 820px)",
        backgroundColor: isActive ? "#170e02" : level === "NORMAL" ? "#050505" : `${badge.bg}22`,
        borderColor: isActive ? "#FF9800" : badge.border,
      }}
      title={detail}
      aria-label={`TAIL ${failed ? "data unavailable" : level}. Top events: ${topEvents.map((e) => e.name).join(", ") || "none"}. ${isActive ? "Leave" : "Open"} tail risk view`}
      onClick={() => setCurrentView(isActive ? "market" : "tail")}
    >
      <span className="shrink-0 font-bold tracking-wide" style={{ color: "#FF9800", fontSize: 9 }}>
        TAIL
      </span>
      <span
        className="shrink-0 rounded-sm px-1 py-0.5 font-bold"
        style={{ backgroundColor: badge.bg, color: badge.fg, fontSize: 9 }}
      >
        {failed ? "NO DATA" : dims.length === 0 ? "LOADING" : level}
      </span>
      {topEvents.map((e, index) => (
        <span
          key={e.id}
          className="min-w-0 truncate font-semibold"
          style={{ color: SEVERITY_COLOR[e.severity], fontSize: 8.5 }}
        >
          {index + 1} {stripEventName(e.name)}
        </span>
      ))}
      {events.length > 3 && (
        <span className="shrink-0 text-[8px] text-[#aaa]">+{events.length - 3}</span>
      )}
      {topEvents.length === 0 && dims.length > 0 && !failed && (
        <span className="min-w-0 truncate text-[8.5px] text-[#999]">NO NAMED EVENTS</span>
      )}
      {degraded > 0 && (
        <span className="ml-auto shrink-0 text-[8.5px] font-bold text-[#D6983C]">⚠ {degraded}</span>
      )}
    </button>
  );
}
