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
interface UpcomingDividendEntry {
  date: string;
  payDate: string | null;
  dividend: number | null;
  estimated: boolean;
}
interface EarningsEntry {
  date: string;
  epsEstimate: number | null;
  reportedEPS: number | null;
  surprise: number | null;
  eventType?: string;
  /** yahoo_calendar = next report from Ticker.calendar; set_rule = SET deadline */
  source?: string;
  estimated?: boolean;
  windowEnd?: string | null;
  deadline?: boolean;
  period?: string;
}
interface MacroEvent {
  date: string;
  kind: string;
  label: string;
  sep: boolean;
  impact: string;
  source: string;
}

/**
 * Macro releases worth a chip on a single stock's chart. FOMC moves every
 * market; CPI and NFP are US prints, so a SET listing gets the rate decision
 * only. PCE and GDP stay off — at a monthly cadence they would crowd the rail
 * without often moving a single name.
 */
const MACRO_KINDS_US = new Set(["FOMC", "CPI", "NFP"]);
const MACRO_KINDS_OTHER = new Set(["FOMC"]);
/** How far ahead an upcoming macro release earns a chip. */
const MACRO_AHEAD_DAYS = 45;

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const EMPTY: ChartEventMarker[] = [];

/** Local calendar day, so "upcoming" matches the user's clock, not UTC. */
function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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

  // One calendar for every symbol — cached far longer than the per-symbol
  // queries because the dates only change when FRED publishes a new schedule.
  const macroQuery = useQuery({
    queryKey: ["macro", "calendar"],
    queryFn: async () => {
      const res = await fetch("/api/macro/calendar?back_days=1095&ahead_days=120");
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!symbol && enabled,
    staleTime: 6 * 3_600_000,
  });

  const divData = divQuery.data;
  const earningsData = earningsQuery.data;
  const macroData = macroQuery.data;

  // Memoized on the query payloads. Built fresh on every render this array would
  // change identity each time and needlessly redraw the event rail on every
  // parent render. The chart instance now survives marker updates.
  const markers: ChartEventMarker[] = useMemo(() => {
    if (!divData && !earningsData && !macroData) return EMPTY;
    const out: ChartEventMarker[] = [];
    const today = todayIso();

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

    // Upcoming dividends — declared but not yet gone ex, so they are absent from
    // the paid history above. The amount is last quarter's unless the issuer
    // announced a change, hence `estimated`.
    const upcomingDivs: UpcomingDividendEntry[] = divData?.upcomingDividends ?? [];
    for (const u of upcomingDivs) {
      const amount = u.dividend ?? undefined;
      out.push({
        time: u.date.slice(0, 10),
        type: "dividend",
        label: "D",
        value: amount,
        dividend: amount,
        payDate: u.payDate,
        upcoming: true,
        estimated: u.estimated,
        detail:
          amount != null
            ? `Ex-div ${amount.toFixed(4)}${u.estimated ? " (est)" : ""}`
            : "Ex-dividend",
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
        // A scheduled report: dated today or later with nothing reported yet —
        // a report due today has no reaction bar until the session prints one.
        upcoming: e.date.slice(0, 10) >= today && e.reportedEPS == null,
        estimated: e.estimated,
        windowEnd: e.windowEnd,
        deadline: e.deadline,
        period: e.period,
        source: e.source,
        ...(e.deadline ? { detail: `SET filing deadline · ${e.period ?? ""}`.trim() } : {}),
      });
    }

    // Macro releases. Past ones all go on the rail (their reaction is the
    // point); upcoming ones only the NEXT of each kind within MACRO_AHEAD_DAYS.
    // Upcoming chips queue right of the last bar in date order until the pane
    // runs out, so a month of scheduled prints would push this stock's own
    // earnings off the edge.
    const macroKinds = symbol?.toUpperCase().endsWith(".BK") ? MACRO_KINDS_OTHER : MACRO_KINDS_US;
    const macroEvents: MacroEvent[] = macroData?.events ?? [];
    const horizon = addDaysIso(today, MACRO_AHEAD_DAYS);
    const nextShown = new Set<string>();
    for (const m of macroEvents) {
      if (!macroKinds.has(m.kind)) continue;
      const day = m.date.slice(0, 10);
      const upcoming = day >= today;
      if (upcoming) {
        if (day > horizon || nextShown.has(m.kind)) continue;
        nextShown.add(m.kind);
      }
      out.push({
        time: day,
        type: "macro",
        label: m.kind,
        // The backend label already says "+ SEP" for projection meetings.
        detail: m.label,
        macroKind: m.kind,
        macroLabel: m.label,
        sep: m.sep,
        source: m.source,
        upcoming,
      });
    }

    return out.length > 0 ? out : EMPTY;
  }, [divData, earningsData, macroData, symbol]);

  return {
    markers,
    isLoading: divQuery.isLoading || earningsQuery.isLoading || macroQuery.isLoading,
  };
}
