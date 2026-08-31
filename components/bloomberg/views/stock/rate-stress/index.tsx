"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { bloombergColors } from "../../../lib/theme-config";

import { DiagnosticsSubTab } from "./DiagnosticsSubTab";
import { DurationSubTab } from "./DurationSubTab";
import { ExposureSubTab } from "./ExposureSubTab";
import { HistorySubTab } from "./HistorySubTab";
import { ScenarioSubTab } from "./ScenarioSubTab";
import type { StressResponse } from "./types";

type Colors = typeof bloombergColors.dark;
type SubTab = "exposure" | "scenario" | "duration" | "history" | "diagnostics";

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "exposure", label: "EXPOSURE" },
  { id: "scenario", label: "SCENARIO" },
  { id: "duration", label: "DURATION" },
  { id: "history", label: "HISTORY" },
  { id: "diagnostics", label: "DIAGNOSTICS" },
];

function TabBtn({
  active,
  onClick,
  label,
  colors,
}: { active: boolean; onClick: () => void; label: string; colors: Colors }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2 py-1 text-xs font-mono border"
      style={{
        borderColor: active ? colors.accent : colors.border,
        backgroundColor: active ? colors.accent : "transparent",
        color: active ? "#000" : colors.text,
      }}
    >
      {label}
    </button>
  );
}

export function RateStressTab({ symbol, colors }: { symbol: string; colors: Colors }) {
  const [subTab, setSubTab] = useState<SubTab>("exposure");

  const { data, isLoading, error } = useQuery<StressResponse>({
    // A cold run fans out to EDGAR, FRED and five years of prices. Filings move
    // quarterly at most, so an hour of staleness costs nothing.
    queryKey: ["ir-stress", symbol],
    queryFn: () => fetch(`/api/ir-stress/${symbol}`).then((r) => r.json()),
    staleTime: 3_600_000,
    enabled: Boolean(symbol),
    // The five-year price download is bounded server-side, so a cold call comes
    // back with the price channel still pending rather than hanging. Poll until
    // it lands, then stop.
    refetchInterval: (query) =>
      query.state.data?.rate_beta?.status === "pending" ? 15_000 : false,
  });

  const panel = { backgroundColor: colors.surface, borderColor: colors.border };

  return (
    <div className="p-4 border" style={panel}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-xs font-bold tracking-widest" style={{ color: colors.accent }}>
          RATE STRESS
        </h3>
        <span className="text-[10px] font-mono" style={{ color: colors.textDimmed }}>
          {data?.valuation?.risk_free != null
            ? `10Y ${(data.valuation.risk_free * 100).toFixed(2)}% · `
            : ""}
          shocks are curve moves, not Fed moves · pre-hedge · US listings only
        </span>
      </div>

      <div className="flex gap-1 mb-4 flex-wrap">
        {SUB_TABS.map(({ id, label }) => (
          <TabBtn
            key={id}
            active={subTab === id}
            onClick={() => setSubTab(id)}
            label={label}
            colors={colors}
          />
        ))}
      </div>

      {isLoading && (
        <div className="text-xs font-mono py-8 text-center" style={{ color: colors.textDimmed }}>
          Loading filings, curve and five years of prices…
        </div>
      )}

      {error != null && (
        <div className="text-xs font-mono py-8 text-center" style={{ color: colors.negative }}>
          Rate-stress data unavailable for {symbol}
        </div>
      )}

      {/* A proxy timeout comes back as a 200 with an error body, which would
          otherwise leave the panel silently blank. */}
      {data?.error != null && (
        <div className="text-xs font-mono py-8 text-center" style={{ color: colors.negative }}>
          {data.error} — reload to try again; the first read of a company takes a while.
        </div>
      )}

      {data?.detail != null && (
        <div className="text-xs font-mono py-8 text-center" style={{ color: colors.textDimmed }}>
          {data.detail}
        </div>
      )}

      {data?.exposure != null && (
        <>
          {subTab === "exposure" && <ExposureSubTab data={data} colors={colors} />}
          {subTab === "scenario" && <ScenarioSubTab data={data} colors={colors} />}
          {subTab === "duration" && <DurationSubTab data={data} colors={colors} />}
          {subTab === "history" && <HistorySubTab symbol={symbol} colors={colors} />}
          {subTab === "diagnostics" && <DiagnosticsSubTab data={data} colors={colors} />}
        </>
      )}
    </div>
  );
}
