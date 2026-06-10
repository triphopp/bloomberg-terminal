"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { currentViewAtom } from "../atoms";

interface TailSummary {
  composite_active:        boolean;
  validated_active_count:  number;
  validated_active_signals: string[];
  vix_term?: {
    vix:                  number | null;
    backwardation_front:  boolean;
    backwardation_back:   boolean;
  };
  fg_synthetic?: number | null;
  dcc_v1_signal?: string;  // NORMAL | CAUTION | SPIKE | EXTREME
  dcc_v3_signal?: string;
}

const SIGNAL_SHORT: Record<string, string> = {
  "g1_vix_backwardation": "VIX BKWD",
  "g1_vix_spike":         "VIX SPIKE",
  "g1_vix_momentum":      "VIX MOM",
  "g5_fg_extreme_fear":   "F&G FEAR",
  "g6_sector_convergent": "SECT CORR",
  "g7_rsi_oversold":      "RSI<35",
  "g8_layer_a_bearish":   "LAYER-A",
  "g10_volume_surge":     "VOL SURGE",
  "g12_composite":        "COMPOSITE",
  "g13_dcc_v1":           "DCC-V1",
  "g14_dcc_hmm":          "DCC-HMM",
};

const DCC_LEVEL_COLOR: Record<string, string> = {
  EXTREME: "#FF3333",
  SPIKE:   "#FF8800",
  CAUTION: "#CCAA00",
  NORMAL:  "#336633",
};

function ribbonColor(count: number, composite: boolean): { bg: string; border: string; text: string } {
  if (composite && count >= 3) return { bg: "#1a0000", border: "#440000", text: "#FF3333" };
  if (count >= 2)              return { bg: "#0f0800", border: "#332000", text: "#FF8800" };
  if (count >= 1)              return { bg: "#0a0a00", border: "#2a2a00", text: "#CCAA00" };
  return                              { bg: "#000000", border: "#111111", text: "#336633" };
}

export function TailRiskRibbon() {
  const [currentView, setCurrentView] = useAtom(currentViewAtom);

  const { data } = useQuery<TailSummary>({
    queryKey:        ["tail-risk-signals"],
    queryFn:         () => fetch("/api/tail-risk/signals").then(r => r.json()),
    staleTime:       240_000,
    refetchInterval: 300_000,
  });

  const count     = data?.validated_active_count ?? 0;
  const composite = data?.composite_active       ?? false;
  const active    = data?.validated_active_signals ?? [];
  const vix       = data?.vix_term?.vix;
  const bkwd      = data?.vix_term?.backwardation_front || data?.vix_term?.backwardation_back;
  const fg        = data?.fg_synthetic;
  const dccV1     = data?.dcc_v1_signal ?? "NORMAL";
  const dccV3     = data?.dcc_v3_signal ?? "NORMAL";

  const colors = ribbonColor(count, composite);
  const isActive = currentView === "tail";

  return (
    <div
      className="shrink-0 flex items-center gap-0 border-t cursor-pointer select-none font-mono"
      style={{
        height:          18,
        backgroundColor: isActive ? "#0a0500" : colors.bg,
        borderColor:     isActive ? "#FF6600" : colors.border,
      }}
      onClick={() => setCurrentView(isActive ? "market" : "tail")}
    >
      {/* Label */}
      <span
        className="shrink-0 flex items-center justify-center h-full px-2 border-r font-bold tracking-widest"
        style={{
          backgroundColor: composite ? "#880000" : count >= 1 ? "#664400" : "#1a1a1a",
          borderColor:     composite ? "#440000" : "#2a2a2a",
          color:           composite ? "#FF6666" : count >= 1 ? "#FFAA44" : "#444444",
          fontSize:        7.5,
          minWidth:        38,
        }}
      >
        TAIL
      </span>

      {/* Signal pills */}
      <div className="flex items-center gap-1 px-2 h-full overflow-hidden">
        {count === 0 && dccV1 === "NORMAL" && dccV3 === "NORMAL" ? (
          <span style={{ color: "#336633", fontSize: 7.5 }}>ALL CLEAR — 0 SIGNALS ACTIVE</span>
        ) : (
          <>
            {count > 0 && (
              <span style={{ color: colors.text, fontSize: 7.5, fontWeight: "bold" }}>
                {count} ACTIVE:
              </span>
            )}
            {active.map(sid => {
              // DCC pills show their level (SPIKE/EXTREME) inline for clarity
              let label = SIGNAL_SHORT[sid] ?? sid.replace(/g\d+_/, "").toUpperCase();
              let pillColor = composite ? "#FF8888" : "#FF9933";
              let pillBg    = composite ? "#330000" : "#1a0f00";
              let pillBorder = composite ? "#550000" : "#3a2000";

              if (sid === "g13_dcc_v1" && dccV1 !== "NORMAL") {
                label = `DCC:${dccV1 === "EXTREME" ? "EXT" : dccV1}`;
                pillColor  = DCC_LEVEL_COLOR[dccV1] ?? pillColor;
                pillBg     = dccV1 === "EXTREME" ? "#200000" : "#1a0800";
                pillBorder = dccV1 === "EXTREME" ? "#550000" : "#3a1800";
              } else if (sid === "g14_dcc_hmm" && dccV3 !== "NORMAL") {
                label = `HMM:${dccV3 === "EXTREME" ? "EXT" : dccV3}`;
                pillColor  = DCC_LEVEL_COLOR[dccV3] ?? pillColor;
                pillBg     = dccV3 === "EXTREME" ? "#200010" : "#0e0a1a";
                pillBorder = dccV3 === "EXTREME" ? "#550033" : "#281844";
              }

              return (
                <span
                  key={sid}
                  className="px-1 py-0"
                  style={{
                    backgroundColor: pillBg,
                    color:           pillColor,
                    fontSize:        7,
                    border:          `1px solid ${pillBorder}`,
                    letterSpacing:   "0.05em",
                  }}
                >
                  {label}
                </span>
              );
            })}
            {composite && (
              <span style={{ color: "#FF4444", fontSize: 7, fontWeight: "bold" }}>
                ● COMPOSITE
              </span>
            )}
          </>
        )}
      </div>

      {/* Right: DCC status + VIX + F&G */}
      <div className="ml-auto flex items-center gap-2 px-2 shrink-0">
        {/* DCC compact status — always shown, color-coded by level */}
        <span
          style={{
            color:       DCC_LEVEL_COLOR[dccV1] ?? "#444",
            fontSize:    7,
            fontWeight:  dccV1 !== "NORMAL" ? "bold" : "normal",
            opacity:     dccV1 === "NORMAL" ? 0.4 : 1,
          }}
        >
          DCC:{dccV1 === "NORMAL" ? "OK" : dccV1 === "EXTREME" ? "EXT" : dccV1}
        </span>
        <span
          style={{
            color:       DCC_LEVEL_COLOR[dccV3] ?? "#444",
            fontSize:    7,
            fontWeight:  dccV3 !== "NORMAL" ? "bold" : "normal",
            opacity:     dccV3 === "NORMAL" ? 0.4 : 1,
          }}
        >
          HMM:{dccV3 === "NORMAL" ? "OK" : dccV3 === "EXTREME" ? "EXT" : dccV3}
        </span>
        {vix != null && (
          <span style={{ color: bkwd ? "#FF4444" : "#444", fontSize: 7.5 }}>
            VIX {vix.toFixed(1)}{bkwd ? " BKWD" : ""}
          </span>
        )}
        {fg != null && (
          <span style={{ color: fg < 25 ? "#FF6600" : "#444", fontSize: 7.5 }}>
            F&G {fg.toFixed(0)}
          </span>
        )}
        <span style={{ color: "#222", fontSize: 7 }}>
          {isActive ? "v" : "^"} TAIL
        </span>
      </div>
    </div>
  );
}
