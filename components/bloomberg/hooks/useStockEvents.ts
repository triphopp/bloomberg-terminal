"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
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
  eventType?: string;
}

const EMPTY: ChartEventMarker[] = [];

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

  const divData = divQuery.data;
  const earningsData = earningsQuery.data;

  // Memoized on the query payloads. Built fresh on every render this array would
  // change identity each time, and <ModularChart> keys its rebuild effect on the
  // marker array — an unmemoized list tore the whole chart down and recreated it
  // on every parent render for as long as EVT was switched on.
  const markers: ChartEventMarker[] = useMemo(() => {
    if (!divData && !earningsData) return EMPTY;
    const out: ChartEventMarker[] = [];

    // Dividends
    const divs: DividendEntry[] = divData?.dividends ?? [];
    for (const d of divs) {
      out.push({
        time: d.date.slice(0, 10),
        type: "dividend",
        label: "D",
        value: d.dividend,
        dividend: d.dividend,
        detail: `Dividend ${d.dividend.toFixed(4)}`,
      });
    }

    // Splits
    const splits: SplitEntry[] = divData?.splits ?? [];
    for (const s of splits) {
      out.push({
        time: s.date.slice(0, 10),
        type: "split",
        label: "S",
        value: s.ratio,
        splitRatio: s.ratio,
        detail: `Split ${s.ratio}:1`,
      });
    }

    // Earnings — colored green (beat) / red (miss); an upcoming report has no
    // reported EPS yet and stays neutral.
    const earnings: EarningsEntry[] = earningsData?.earningsDates ?? [];
    for (const e of earnings) {
      const surprise = e.surprise;
      const surpriseText =
        surprise != null ? ` (${surprise > 0 ? "+" : ""}${surprise.toFixed(1)}%)` : "";
      const detail =
        e.reportedEPS != null ? `EPS ${e.reportedEPS.toFixed(2)}${surpriseText}` : "Earnings";
      out.push({
        time: e.date.slice(0, 10),
        type: "earnings",
        label: surprise != null ? `${surprise > 0 ? "+" : ""}${surprise.toFixed(0)}%` : "E",
        value: surprise ?? undefined,
        detail,
        color: surprise != null ? (surprise >= 0 ? "#26a69a" : "#ef5350") : undefined,
        epsEstimate: e.epsEstimate,
        reportedEPS: e.reportedEPS,
        surprise,
        eventType: e.eventType,
        reportedAt: e.date,
      });
    }

    return out.length > 0 ? out : EMPTY;
  }, [divData, earningsData]);

  return {
    markers,
    isLoading: divQuery.isLoading || earningsQuery.isLoading,
  };
}
