"use client";

import { useQuery } from "@tanstack/react-query";
import type { ChartEventMarker } from "../chart/types";

async function stockFetch(params: Record<string, string>) {
  const res = await fetch(`/api/stock?${new URLSearchParams(params)}`);
  if (!res.ok) return null;
  return res.json();
}

interface DividendEntry {
  date: string;
  dividend: number;
}
interface SplitEntry {
  date: string;
  ratio: number;
}
interface EarningsEntry {
  date: string;
  epsEstimate: number | null;
  reportedEPS: number | null;
  surprise: number | null;
}

export function useStockEvents(symbol: string | null, enabled = true) {
  const divQuery = useQuery({
    queryKey: ["stock", "dividends", symbol],
    queryFn: () => stockFetch({ symbol: symbol ?? "", type: "dividends" }),
    enabled: !!symbol && enabled,
    staleTime: 3_600_000,
  });

  const earningsQuery = useQuery({
    queryKey: ["stock", "earnings-calendar", symbol],
    queryFn: () => stockFetch({ symbol: symbol ?? "", type: "earnings-calendar" }),
    enabled: !!symbol && enabled,
    staleTime: 3_600_000,
  });

  const markers: ChartEventMarker[] = [];

  // Dividends
  const divs: DividendEntry[] = divQuery.data?.dividends ?? [];
  for (const d of divs) {
    markers.push({
      time: d.date,
      type: "dividend",
      label: "D",
      value: d.dividend,
      detail: `Dividend: $${d.dividend.toFixed(4)}`,
    });
  }

  // Splits
  const splits: SplitEntry[] = divQuery.data?.splits ?? [];
  for (const s of splits) {
    markers.push({
      time: s.date,
      type: "split",
      label: "S",
      value: s.ratio,
      detail: `Split ${s.ratio}:1`,
    });
  }

  // Earnings — label shows the surprise%, marker colored green (beat) / red (miss)
  const earnings: EarningsEntry[] = earningsQuery.data?.earningsDates ?? [];
  for (const e of earnings) {
    const dateOnly = e.date.slice(0, 10);
    const surprise = e.surprise;
    const surpriseText =
      surprise != null ? ` (${surprise > 0 ? "+" : ""}${surprise.toFixed(1)}%)` : "";
    const epsText =
      e.reportedEPS != null ? `EPS: $${e.reportedEPS.toFixed(2)}${surpriseText}` : "Earnings";
    // Only past earnings have a reported result; upcoming ones stay neutral "E".
    const label = surprise != null ? `${surprise > 0 ? "+" : ""}${surprise.toFixed(0)}%` : "E";
    const color = surprise != null ? (surprise >= 0 ? "#26a69a" : "#ef5350") : undefined;
    markers.push({
      time: dateOnly,
      type: "earnings",
      label,
      value: surprise ?? undefined,
      detail: epsText,
      color,
    });
  }

  return {
    markers,
    isLoading: divQuery.isLoading || earningsQuery.isLoading,
  };
}
