"use client";

/**
 * Macro context for TAIL — scheduled events, Fed, curve and regime.
 *
 * Context, not evidence: nothing here is counted in the risk level. Its job is
 * to change how a lit signal READS. VIX bid into an FOMC decision or a CPI
 * print is the market pricing a known event; the same move on a quiet week is
 * not. The EVENT tag on vol signals makes that distinction visible.
 */

import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EventKind = "FOMC" | "CPI" | "NFP" | "PCE" | "GDP";

export interface MacroEvent {
  date: string;
  kind: EventKind;
  label: string;
  sep: boolean;
  impact: "high" | "medium";
  source: string;
  days_until: number;
  bdays_until: number;
}

type Tone = "good" | "watch" | "bad" | "unknown";

interface RegimeCell {
  state: string | null;
  tone: Tone;
}

interface IndicatorPoint {
  value: number | null;
  prev: number | null;
  date: string | null;
}

export interface MacroContextData {
  ts: string;
  counted_in_composite: false;
  event_sensitive_signals: string[];
  calendar: {
    as_of: string;
    upcoming: MacroEvent[];
    past: MacroEvent[];
    event_window: { active: boolean; bdays: number; events: MacroEvent[] };
    next_fomc: { date: string; days_until: number; sep: boolean } | null;
    fomc_calendar_through: string;
    fomc_calendar_stale: boolean;
    fomc_calendar_expiring: boolean;
    releases_ok: boolean;
  } | null;
  indicators: Record<string, IndicatorPoint | null> | null;
  yield_curve: {
    "3m": number | null;
    "2y": number | null;
    "10y": number | null;
    spread_10y_2y: number | null;
    spread_10y_3m: number | null;
    inverted_10y_2y: boolean | null;
    inverted_10y_3m: boolean | null;
  } | null;
  fed: { rate: number | null; stance: "HIKING" | "CUTTING" | "HOLD" | null } | null;
  regime: Record<"growth" | "inflation" | "labor" | "policy", RegimeCell> | null;
  macro_ok: boolean;
}

export function useMacroContext() {
  return useQuery<MacroContextData>({
    queryKey: ["tail-macro-context"],
    queryFn: () => fetch("/api/tail-risk/macro-context").then((r) => r.json()),
    staleTime: 10 * 60_000,
    refetchInterval: 30 * 60_000,
  });
}

// ── Palette ───────────────────────────────────────────────────────────────────

export const KIND_COLOR: Record<EventKind, string> = {
  FOMC: "#FF8800",
  CPI: "#E05AE0",
  NFP: "#4FA3FF",
  PCE: "#9A7BFF",
  GDP: "#3DBE8B",
};

const TONE_COLOR: Record<Tone, string> = {
  good: "#4CAF50",
  watch: "#FFC107",
  bad: "#FF5252",
  unknown: "#444",
};

const when = (e: MacroEvent) =>
  e.days_until === 0
    ? "TODAY"
    : e.days_until === 1
      ? "TMRW"
      : e.days_until < 0
        ? `${-e.days_until}D AGO`
        : `${e.days_until}D`;

// ── Event strip (top of view) ─────────────────────────────────────────────────

export function EventStrip({ ctx }: { ctx: MacroContextData | undefined }) {
  const cal = ctx?.calendar;
  if (!cal) return null;
  const win = cal.event_window;
  const soon = cal.upcoming.filter((e) => e.days_until <= 21).slice(0, 8);

  return (
    <div
      className="shrink-0 flex items-center gap-2 px-3 py-1 border-b overflow-x-auto"
      style={{
        borderColor: "#1a1a1a",
        backgroundColor: win.active ? "#140c00" : "#050505",
      }}
    >
      <CalendarClock size={10} style={{ color: win.active ? "#FF8800" : "#555", flexShrink: 0 }} />
      {win.active ? (
        <span
          className="shrink-0 px-1 font-bold"
          style={{
            color: "#000",
            backgroundColor: "#FF8800",
            fontSize: 7.5,
            letterSpacing: "0.08em",
          }}
          title={`Within ±${win.bdays} business day of a scheduled release. Vol signals marked EVENT may be pricing the event rather than stress.`}
        >
          EVENT WINDOW · {win.events.map((e) => `${e.kind} ${when(e)}`).join(" · ")}
        </span>
      ) : (
        <span
          className="shrink-0"
          style={{ color: "#555", fontSize: 7.5, letterSpacing: "0.08em" }}
        >
          NO EVENT WINDOW
        </span>
      )}
      <span style={{ color: "#222", fontSize: 9 }}>|</span>
      {soon.length === 0 && (
        <span style={{ color: "#444", fontSize: 7.5 }}>nothing scheduled in 21 days</span>
      )}
      {soon.map((e) => (
        <span
          key={`${e.date}-${e.kind}`}
          className="shrink-0 flex items-center gap-1 px-1"
          style={{ border: `1px solid ${KIND_COLOR[e.kind]}33`, fontSize: 7.5 }}
          title={`${e.label} — ${e.date} (${e.source})`}
        >
          <span style={{ color: KIND_COLOR[e.kind], fontWeight: "bold" }}>
            {e.kind}
            {e.sep ? "+SEP" : ""}
          </span>
          <span style={{ color: "#666" }}>{e.date.slice(5)}</span>
          <span style={{ color: e.days_until <= 2 ? "#FFCC44" : "#888" }}>{when(e)}</span>
        </span>
      ))}
      {(!cal.releases_ok || cal.fomc_calendar_stale || cal.fomc_calendar_expiring) && (
        <span className="ml-auto shrink-0" style={{ color: "#B06000", fontSize: 7 }}>
          {!cal.releases_ok && "FRED releases unavailable — FOMC only. "}
          {cal.fomc_calendar_stale &&
            `FOMC calendar ended ${cal.fomc_calendar_through} — update event_calendar.py.`}
          {cal.fomc_calendar_expiring &&
            `FOMC calendar ends ${cal.fomc_calendar_through} — add next year.`}
        </span>
      )}
    </div>
  );
}

// ── Macro panel (left column) ─────────────────────────────────────────────────

const IND_ROWS: { key: string; label: string; fmt: (v: number) => string; unit: string }[] = [
  { key: "cpi", label: "CPI YoY", fmt: (v) => v.toFixed(2), unit: "%" },
  { key: "unemployment", label: "UNEMP", fmt: (v) => v.toFixed(1), unit: "%" },
  { key: "nfp", label: "NFP", fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}`, unit: "K" },
  { key: "gdp", label: "GDP YoY", fmt: (v) => v.toFixed(2), unit: "%" },
  { key: "retail_sales", label: "RETAIL MoM", fmt: (v) => v.toFixed(2), unit: "%" },
  { key: "consumer_sentiment", label: "SENTIMENT", fmt: (v) => v.toFixed(1), unit: "" },
];

function Row({
  label,
  value,
  color = "#888",
  title,
}: {
  label: string;
  value: React.ReactNode;
  color?: string;
  title?: string;
}) {
  return (
    <div className="flex justify-between items-center gap-2" title={title}>
      <span style={{ color: "#4a4a4a", fontSize: 7.5 }}>{label}</span>
      <span className="truncate" style={{ color, fontSize: 8 }}>
        {value}
      </span>
    </div>
  );
}

export function MacroPanel({ ctx }: { ctx: MacroContextData | undefined }) {
  const box = "flex flex-col gap-1 p-2 border";
  const head = { color: "#888", fontSize: 8, letterSpacing: "0.12em" } as const;

  if (!ctx) {
    return (
      <div className={box} style={{ borderColor: "#1e1e1e" }}>
        <span style={head}>MACRO CONTEXT</span>
        <span style={{ color: "#333", fontSize: 7.5 }}>loading…</span>
      </div>
    );
  }

  const fed = ctx.fed;
  const yc = ctx.yield_curve;
  const nf = ctx.calendar?.next_fomc;
  const bp = (x: number | null | undefined) =>
    x == null ? "NO DATA" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}bp`;

  return (
    <div className={box} style={{ borderColor: "#1e1e1e" }}>
      <div className="flex items-center justify-between">
        <span style={head}>MACRO CONTEXT</span>
        <span
          style={{ color: "#3a3a3a", fontSize: 6.5 }}
          title="Not counted in the risk level — no backtest behind it."
        >
          NOT IN COMPOSITE
        </span>
      </div>

      {!ctx.macro_ok && (
        <span style={{ color: "#B06000", fontSize: 7 }}>FRED macro series unavailable</span>
      )}

      {/* Fed */}
      <Row
        label="FED FUNDS"
        value={fed?.rate == null ? "NO DATA" : `${fed.rate.toFixed(2)}%`}
        color={fed?.rate == null ? "#333" : "#AAA"}
      />
      <Row
        label="STANCE"
        value={fed?.stance ?? "NO DATA"}
        color={
          fed?.stance === "HIKING" ? "#FF5252" : fed?.stance === "CUTTING" ? "#4CAF50" : "#888"
        }
        title="Direction of the effective fed funds rate over the last 3 prints"
      />
      <Row
        label="NEXT FOMC"
        value={
          nf
            ? `${nf.date.slice(5)}${nf.sep ? " +SEP" : ""} · ${nf.days_until === 0 ? "TODAY" : `${nf.days_until}D`}`
            : "CALENDAR ENDED"
        }
        color={nf && nf.days_until <= 2 ? "#FF8800" : "#888"}
      />

      {/* Curve */}
      <div className="h-px my-0.5" style={{ backgroundColor: "#151515" }} />
      <Row
        label="10Y−2Y"
        value={`${bp(yc?.spread_10y_2y)}${yc?.inverted_10y_2y ? " INV" : ""}`}
        color={yc?.inverted_10y_2y ? "#FF8800" : yc?.spread_10y_2y == null ? "#333" : "#888"}
        title="Inversion has preceded US recessions with a long, variable lag — slow backdrop, not a trigger"
      />
      <Row
        label="10Y−3M"
        value={`${bp(yc?.spread_10y_3m)}${yc?.inverted_10y_3m ? " INV" : ""}`}
        color={yc?.inverted_10y_3m ? "#FF8800" : yc?.spread_10y_3m == null ? "#333" : "#888"}
      />

      {/* Regime */}
      {ctx.regime && (
        <>
          <div className="h-px my-0.5" style={{ backgroundColor: "#151515" }} />
          <div className="grid grid-cols-2 gap-1">
            {(["growth", "inflation", "labor", "policy"] as const).map((k) => {
              const cell = ctx.regime?.[k];
              const c = TONE_COLOR[cell?.tone ?? "unknown"];
              return (
                <div key={k} className="px-1 py-0.5" style={{ border: `1px solid ${c}44` }}>
                  <div style={{ color: "#4a4a4a", fontSize: 6 }}>{k.toUpperCase()}</div>
                  <div className="truncate" style={{ color: c, fontSize: 7, fontWeight: "bold" }}>
                    {cell?.state ?? "NO DATA"}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Latest prints */}
      {ctx.indicators && (
        <>
          <div className="h-px my-0.5" style={{ backgroundColor: "#151515" }} />
          {IND_ROWS.map(({ key, label, fmt, unit }) => {
            const p = ctx.indicators?.[key];
            if (!p || p.value == null) {
              return <Row key={key} label={label} value="NO DATA" color="#333" />;
            }
            const d = p.prev == null ? 0 : p.value - p.prev;
            const arrow = Math.abs(d) < 1e-9 ? "·" : d > 0 ? "▲" : "▼";
            return (
              <Row
                key={key}
                label={label}
                value={`${fmt(p.value)}${unit} ${arrow}`}
                title={`${p.date ?? ""} · prev ${p.prev == null ? "—" : fmt(p.prev)}${unit}`}
              />
            );
          })}
        </>
      )}
    </div>
  );
}
