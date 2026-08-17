"use client";

/**
 * US equities session clock for the TICK DATA board.
 *
 * Presentation only — the session maths lives in `lib/us-market-session.ts` so
 * holidays and half-days can be tested against fixed instants instead of being
 * unreachable until the day they occur.
 *
 * The "NO LUNCH BREAK" line is deliberate: NYSE and NASDAQ trade continuously
 * 09:30–16:00 ET, and the absence of a midday pause is exactly the thing a
 * reader coming from SET (12:30–14:30 ICT) or TSE (11:30–12:30 JST) needs told.
 */

import { useEffect, useMemo, useState } from "react";
import {
  LAST_CALENDAR_YEAR,
  PRE_OPEN,
  type Phase,
  REGULAR_CLOSE,
  REGULAR_OPEN,
  computeSession,
  fmtClock,
  fmtCountdown,
} from "../lib/us-market-session";

/** Same four colours `market-session.tsx` uses for Yahoo's marketState, so the
 *  clock and the per-quote session badges never disagree visually about what
 *  "pre-market" or "after-hours" looks like. */
const PHASE_COLOR: Record<Phase, string> = {
  OPEN: "#22c55e",
  PRE: "#f59e0b",
  AFTER: "#818cf8",
  CLOSED: "#6b7280",
};

const PHASE_LABEL: Record<Phase, string> = {
  OPEN: "OPEN",
  PRE: "PRE-MKT",
  AFTER: "AFTER-HRS",
  CLOSED: "CLOSED",
};

interface Props {
  colors: { border: string; textSecondary: string };
}

export function UsMarketClock({ colors }: Props) {
  // Mount-gated: the server render has no user timezone, so starting at null
  // and filling in on the client keeps hydration from mismatching.
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const s = useMemo(() => (now ? computeSession(now) : null), [now]);

  const local = useMemo(() => {
    if (!now) return null;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "LOCAL";
    return {
      time: new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(now),
      zone: zone.split("/").pop()?.replace(/_/g, " ") ?? zone,
    };
  }, [now]);

  if (!s || !local) {
    return (
      <div
        className="shrink-0 px-1 py-1 font-mono text-[8px]"
        style={{ borderBottom: `1px solid ${colors.border}`, color: colors.textSecondary }}
      >
        US SESSION —:—:—
      </div>
    );
  }

  const phaseColor = PHASE_COLOR[s.phase];

  // The bar spans the whole extended session, so regular hours read as the
  // slice of the trading day they actually are.
  const spanStart = PRE_OPEN;
  const spanEnd = s.afterCloseMinute;
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const pct = (m: number) => clamp(((m - spanStart) / (spanEnd - spanStart)) * 100);

  const regularLeft = pct(REGULAR_OPEN);
  const regularRight = pct(s.closeMinute);
  const nowPct = s.minutes < spanStart || s.minutes > spanEnd ? null : pct(s.minutes);

  return (
    <div
      className="shrink-0 flex flex-col gap-0.5 px-1 py-1 font-mono"
      style={{ borderBottom: `1px solid ${colors.border}`, background: "#050505" }}
      title={`${s.etWeekday} ${s.etDateKey} — regular session ${fmtClock(REGULAR_OPEN)}–${fmtClock(
        s.closeMinute
      )} ET, no midday break`}
    >
      {/* Clocks + phase */}
      <div className="flex items-center gap-1">
        <span className="text-[8px] font-bold tracking-wider" style={{ color: "#888" }}>
          US SESSION
        </span>
        <span
          className="px-1 text-[7px] font-bold"
          style={{
            color: phaseColor,
            border: `1px solid ${phaseColor}44`,
            background: "#00000066",
          }}
        >
          {PHASE_LABEL[s.phase]}
        </span>
        <span className="text-[10px] font-bold tabular-nums" style={{ color: "#FFD700" }}>
          {s.etTime}
        </span>
        <span className="text-[7px]" style={{ color: "#666" }}>
          {s.etZone}
        </span>
        <span className="ml-auto text-[8px] tabular-nums" style={{ color: colors.textSecondary }}>
          {local.time}
        </span>
        <span className="text-[7px]" style={{ color: "#444" }}>
          {local.zone}
        </span>
      </div>

      {/* Timeline */}
      <div className="relative h-[7px] w-full" style={{ background: "#141414" }}>
        <div
          className="absolute top-0 bottom-0"
          style={{
            left: `${regularLeft}%`,
            width: `${Math.max(0, regularRight - regularLeft)}%`,
            background: s.phase === "OPEN" ? "#0d3d1e" : "#1c1c1c",
            borderLeft: "1px solid #2a2a2a",
            borderRight: "1px solid #2a2a2a",
          }}
        />
        {nowPct != null && (
          <div
            className="absolute top-0 bottom-0"
            style={{ left: `${nowPct}%`, width: 1.5, background: phaseColor }}
          />
        )}
      </div>

      {/* Boundaries */}
      <div className="flex items-center justify-between text-[6.5px]" style={{ color: "#555" }}>
        <span>PRE {fmtClock(PRE_OPEN)}</span>
        <span style={{ color: s.phase === "OPEN" ? "#22c55e" : "#777" }}>
          REGULAR {fmtClock(REGULAR_OPEN)}–{fmtClock(s.closeMinute)}
        </span>
        <span>AH →{fmtClock(s.afterCloseMinute)}</span>
      </div>

      {/* The answer about lunch, plus what happens next */}
      <div className="flex items-center gap-1 text-[6.5px]">
        {/* Quotes the standard close even on a half-day: this line is about the
            shape of a normal US session, and the REGULAR row above already
            carries today's actual end time. */}
        <span style={{ color: "#3f6b4a" }}>
          NO LUNCH BREAK — continuous {fmtClock(REGULAR_OPEN)}–{fmtClock(REGULAR_CLOSE)} ET
        </span>
        <span className="ml-auto" style={{ color: "#777" }}>
          {s.isHoliday
            ? "NYSE HOLIDAY"
            : s.isWeekend
              ? "WEEKEND"
              : s.nextChangeIn != null
                ? `${s.nextChangeLabel} in ${fmtCountdown(s.nextChangeIn)}`
                : "session over"}
        </span>
      </div>

      {(s.isHalfDay || s.calendarStale) && (
        <div className="text-[6.5px]" style={{ color: "#B06000" }}>
          {s.isHalfDay && "HALF DAY — early close 13:00 ET. "}
          {s.calendarStale && `Holiday calendar ends ${LAST_CALENDAR_YEAR} — update NYSE_HOLIDAYS.`}
        </div>
      )}
    </div>
  );
}
