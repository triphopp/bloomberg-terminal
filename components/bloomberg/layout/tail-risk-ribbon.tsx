"use client";

/**
 * Always-on TAIL strip. Shows the six risk dimensions rather than individual
 * signal names: at 18px tall there is no room for a signal list, and "which
 * kind of risk is lit" is the question a glance can actually answer.
 *
 * A dimension whose data could not be verified reads NO DATA, never NORMAL —
 * the previous strip could print "ALL CLEAR" while its inputs were offline.
 */

import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { currentViewAtom } from "../atoms";

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
}

/** Short tags — the full dimension labels don't fit an 18px strip. */
const SHORT: Record<string, string> = {
  equity_vol: "EQ-VOL",
  tail_pricing: "TAIL",
  cross_asset_vol: "X-ASSET",
  credit_stress: "CREDIT",
  flow_positioning: "FLOW",
  correlation: "CORR",
};

const STATUS_COLOR: Record<DimensionStatus, { fg: string; bg: string; border: string }> = {
  ALERT: { fg: "#FF3333", bg: "#260000", border: "#5a0000" },
  WATCH: { fg: "#FFAA00", bg: "#1a1200", border: "#4a3200" },
  NORMAL: { fg: "#3a6b48", bg: "#050a06", border: "#16241a" },
  UNKNOWN: { fg: "#8a6a3a", bg: "#0f0900", border: "#2a1a00" },
};

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

  const vix = data?.vix_term?.vix;
  const inverted =
    data?.vix_term?.backwardation_front === true || data?.vix_term?.backwardation_back === true;
  const byName = new Map((data?.vol_table ?? []).map((r) => [r.name, r]));

  /** VVIX and SKEW ride along in the strip: they move on different information
   *  than VIX and are the cheapest early read on tail demand. */
  const extras = ["VVIX", "SKEW"]
    .map((n) => byName.get(n))
    .filter((r): r is NonNullable<typeof r> => !!r && r.ok && r.value != null);

  return (
    // A real <button>: the strip toggles a view, so it should be reachable and
    // activatable by keyboard without reimplementing what the element already does.
    <button
      type="button"
      className="shrink-0 w-full flex items-center gap-0 border-t cursor-pointer select-none font-mono text-left"
      style={{
        height: 18,
        backgroundColor: isActive ? "#0a0500" : level === "NORMAL" ? "#000000" : `${badge.bg}22`,
        borderColor: isActive ? "#FF6600" : level === "NORMAL" ? "#111111" : badge.border,
      }}
      aria-label={isActive ? "Leave tail risk view" : "Open tail risk view"}
      onClick={() => setCurrentView(isActive ? "market" : "tail")}
    >
      <span
        className="shrink-0 flex items-center justify-center h-full px-2 border-r font-bold tracking-widest"
        style={{
          backgroundColor: badge.bg,
          borderColor: badge.border,
          color: badge.fg,
          fontSize: 7.5,
          minWidth: 38,
        }}
      >
        TAIL
      </span>

      <div className="flex items-center gap-1 px-2 h-full overflow-hidden">
        {failed ? (
          <span style={{ color: "#FF4444", fontSize: 7.5 }}>TAIL DATA UNAVAILABLE</span>
        ) : dims.length === 0 ? (
          <span style={{ color: "#333", fontSize: 7.5 }}>LOADING RISK DIMENSIONS...</span>
        ) : (
          <>
            <span style={{ color: badge.fg, fontSize: 7.5, fontWeight: "bold" }}>{level}</span>
            {dims.map((d) => {
              const c = STATUS_COLOR[d.status];
              const muted = d.status === "NORMAL";
              return (
                <span
                  key={d.id}
                  className="px-1"
                  style={{
                    color: c.fg,
                    backgroundColor: c.bg,
                    border: `1px solid ${c.border}`,
                    fontSize: 6.5,
                    letterSpacing: "0.05em",
                    opacity: muted ? 0.55 : 1,
                    fontWeight: muted ? "normal" : "bold",
                  }}
                  title={`${d.label}: ${d.status} — ${d.on_count}/${d.total} signals on${
                    d.unknown_count ? `, ${d.unknown_count} without data` : ""
                  }`}
                >
                  {SHORT[d.id] ?? d.label}
                  {d.status === "UNKNOWN" ? "?" : d.on_count > 0 ? ` ${d.on_count}` : ""}
                </span>
              );
            })}
          </>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2 px-2 shrink-0">
        {extras.map((r) => (
          <span
            key={r.name}
            style={{
              color: r.z63 != null && r.z63 > 1.5 ? "#FF8800" : "#444",
              fontSize: 7,
            }}
            title={`${r.name} z63 ${r.z63 ?? "--"}`}
          >
            {r.name} {r.value?.toFixed(r.name === "SKEW" ? 0 : 1)}
          </span>
        ))}
        {vix != null && (
          <span style={{ color: inverted ? "#FF4444" : "#555", fontSize: 7.5 }}>
            VIX {vix.toFixed(1)}
            {inverted ? " INV" : ""}
          </span>
        )}
        {degraded > 0 && (
          <span style={{ color: "#B06000", fontSize: 7 }} title="Signals with unverifiable data">
            ⚠ {degraded} NO DATA
          </span>
        )}
        <span style={{ color: "#222", fontSize: 7 }}>{isActive ? "v" : "^"} TAIL</span>
      </div>
    </button>
  );
}
