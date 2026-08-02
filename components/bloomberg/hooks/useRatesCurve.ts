"use client";

import { useQuery } from "@tanstack/react-query";

/** One tenor on a government bond curve — see backend/routers/rates.py `_row`. */
export interface RateRowData {
  id: string; // "US 10Y"
  country: "US" | "JP";
  tenor: string; // "10Y"
  value: number; // percent
  /** basis points vs the previous observation — null when only one obs exists */
  changeBp: number | null;
  /** basis points vs the first observation of the current year */
  ytdBp: number;
  sparkline1: number[];
  /** yfinance proxy the chart panel can draw, or null when none exists */
  chartSymbol: string | null;
  asOf: string;
}

export interface RatesCurve {
  us: RateRowData[];
  jp: RateRowData[];
  /** set when FRED_API_KEY is missing — US section renders this instead of rows */
  usError: string | null;
  jpSource: "mof" | "fred";
  /** true when MOF was unreachable and JP fell back to the monthly OECD 10Y */
  jpStale: boolean;
  asOf: string;
}

export function useRatesCurve() {
  return useQuery<RatesCurve>({
    queryKey: ["rates", "curve"],
    queryFn: async () => {
      const res = await fetch("/api/rates");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    // Bond curves publish once a day — polling harder just burns FRED quota
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}
