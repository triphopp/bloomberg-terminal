"use client";

/**
 * MarketStateTab — the REGIME panel, shared by NEWS and stock-view exactly the
 * way RATE STRESS is, so the two entry points can never drift apart.
 *
 * Tab order is the reading order the brief lays out, and it is not arbitrary:
 * SUMMARY says what the market is doing, REGIME and PROBABILITY let you check
 * that claim against the price, EVOLUTION shows where it is heading, and only
 * then does STRATEGY say what any of it might be good for. Interpretation
 * first, decision last — with the decision layer behind its own tab so it can
 * be rejected on its own.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { bloombergColors } from "../../../lib/theme-config";
import { DiagnosticsSubTab } from "./DiagnosticsSubTab";
import { EvolutionSubTab } from "./EvolutionSubTab";
import { ProbabilitySubTab } from "./ProbabilitySubTab";
import { RegimeChartSubTab } from "./RegimeChartSubTab";
import { StrategySubTab } from "./StrategySubTab";
import { SummarySubTab } from "./SummarySubTab";
import type { MarketStateResponse } from "./types";

type Colors = typeof bloombergColors.dark;
type SubTab = "summary" | "regime" | "evolution" | "probability" | "strategy" | "diagnostics";

const SUB_TABS: { id: SubTab; label: string; hint: string }[] = [
  { id: "summary", label: "SUMMARY", hint: "The Market State Vector and the sentence it makes" },
  { id: "regime", label: "REGIME", hint: "Price with the regime shaded behind it" },
  {
    id: "evolution",
    label: "EVOLUTION",
    hint: "Trend / momentum / volatility and their rates of change",
  },
  { id: "probability", label: "PROBABILITY", hint: "Posterior over states through time" },
  {
    id: "strategy",
    label: "STRATEGY",
    hint: "Which styles have suited this state — the decision layer",
  },
  { id: "diagnostics", label: "DIAGNOSTICS", hint: "Feature redundancy check and the model card" },
];

function TabBtn({
  active,
  onClick,
  label,
  hint,
  colors,
}: { active: boolean; onClick: () => void; label: string; hint: string; colors: Colors }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
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

export function MarketStateTab({ symbol, colors }: { symbol: string; colors: Colors }) {
  const [subTab, setSubTab] = useState<SubTab>("summary");

  const { data, isLoading, error } = useQuery<MarketStateResponse>({
    // A fit over ten years of daily bars takes about a second and the inputs
    // change once a day; an hour of staleness costs nothing and saves the fit.
    queryKey: ["market-state", symbol],
    queryFn: () => fetch(`/api/market-state/${encodeURIComponent(symbol)}`).then((r) => r.json()),
    staleTime: 3_600_000,
    enabled: Boolean(symbol),
    retry: false,
  });

  const panel = { backgroundColor: colors.surface, borderColor: colors.border };

  return (
    <div className="p-4 border" style={panel}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-xs font-bold tracking-widest" style={{ color: colors.accent }}>
          MARKET STATE · {symbol}
        </h3>
        <span className="text-[10px] font-mono" style={{ color: colors.textDimmed }}>
          {data?.status === "ok"
            ? `${data.bars} bars · as of ${data.as_of} · Gaussian HMM, ${data.diagnostics?.model.n_states} states`
            : "latent-state model over OHLCV"}
        </span>
      </div>

      <div className="flex gap-1 mb-4 flex-wrap">
        {SUB_TABS.map(({ id, label, hint }) => (
          <TabBtn
            key={id}
            active={subTab === id}
            onClick={() => setSubTab(id)}
            label={label}
            hint={hint}
            colors={colors}
          />
        ))}
      </div>

      {isLoading && (
        <div className="text-xs font-mono py-8 text-center" style={{ color: colors.textDimmed }}>
          Fitting the state model — features, redundancy check, then the HMM…
        </div>
      )}

      {error != null && (
        <div className="text-xs font-mono py-8 text-center" style={{ color: colors.negative }}>
          Market State unavailable for {symbol}
        </div>
      )}

      {/* The backend answers "not enough history" with a 200 and a reason, which
          would otherwise render as a blank panel. */}
      {data && data.status !== "ok" && (
        <div className="text-xs font-mono py-8 text-center" style={{ color: colors.textSecondary }}>
          {data.detail ?? `No state model for ${symbol}.`}
        </div>
      )}

      {data?.status === "ok" && (
        <>
          {subTab === "summary" && <SummarySubTab data={data} colors={colors} />}
          {subTab === "regime" && <RegimeChartSubTab data={data} colors={colors} />}
          {subTab === "evolution" && <EvolutionSubTab data={data} colors={colors} />}
          {subTab === "probability" && <ProbabilitySubTab data={data} colors={colors} />}
          {subTab === "strategy" && <StrategySubTab data={data} symbol={symbol} colors={colors} />}
          {subTab === "diagnostics" && <DiagnosticsSubTab data={data} colors={colors} />}
        </>
      )}
    </div>
  );
}
