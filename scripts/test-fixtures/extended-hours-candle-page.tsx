"use client";

/** Copy to app/chart-line-check/page.tsx temporarily for visual QA. */
import { ModularChart } from "@/components/bloomberg/chart/ModularChart";
import type { ChartIndicator, OhlcvBar } from "@/components/bloomberg/chart/types";
import { extendedHoursPriceLine } from "@/components/bloomberg/core/market-session";
import { bloombergColors } from "@/components/bloomberg/lib/theme-config";
import { useState } from "react";

const colors = bloombergColors.dark;
const indicators: ChartIndicator[] = [];
const bars: OhlcvBar[] = Array.from({ length: 30 }, (_, index) => {
  const close = 100 + Math.sin(index / 3) * 2 + index / 10;
  return {
    time: new Date(Date.UTC(2026, 7, index + 10)).toISOString().slice(0, 10),
    open: close - 0.7,
    high: close + 1.2,
    low: close - 1.4,
    close,
  };
});

export default function ChartLineCheck() {
  const [mode, setMode] = useState<"PRE" | "POST" | "CLOSED">("PRE");
  const [prePrice, setPrePrice] = useState(125);
  const quote =
    mode === "PRE"
      ? { marketState: "PRE", preMarketPrice: prePrice }
      : mode === "POST"
        ? { marketState: "POST", postMarketPrice: 80 }
        : { marketState: "CLOSED", postMarketPrice: 80 };
  const line = extendedHoursPriceLine(quote);

  return (
    <main style={{ background: "#000", color: "#fff", minHeight: "100vh", padding: 24 }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <button type="button" onClick={() => setMode("PRE")}>
          PRE
        </button>
        <button type="button" onClick={() => setMode("POST")}>
          POST
        </button>
        <button type="button" onClick={() => setMode("CLOSED")}>
          CLOSED
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("PRE");
            setPrePrice((value) => value + 7);
          }}
        >
          PRE UPDATE
        </button>
        <span data-testid="session-line">{line ? `${line.title} ${line.price}` : "NO LINE"}</span>
      </div>
      <div style={{ width: 850, height: 450 }}>
        <ModularChart
          data={bars}
          isDark
          colors={colors}
          height={450}
          indicators={indicators}
          referencePriceLine={line}
          viewportKey="test-bars"
        />
      </div>
    </main>
  );
}
