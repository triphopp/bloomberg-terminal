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
import { fmtPriceStd } from "../../lib/number-format";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EventKind =
  | "FOMC"
  | "CPI"
  | "NFP"
  | "PCE"
  | "GDP"
  | "PPI"
  | "RETAIL"
  | "JOLTS"
  | "ISM"
  | "MINUTES"
  | "OPEX"
  | "VIXEXP"
  | "CLAIMS"
  | "EIA";

export interface MacroEvent {
  date: string;
  kind: EventKind;
  label: string;
  sep: boolean;
  impact: "high" | "medium" | "low";
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
  /** Day of the latest scheduled release for this print (ET), if it has one. */
  released?: string | null;
  /** Released within the last 3 days and already shown. */
  new?: boolean;
  /** Released, but the number shown is still the previous one. */
  pending?: boolean;
}

/** One axis of MACRO READ — a number, what it means, and the rule that said so. */
export interface MacroAxis {
  id: "inflation" | "energy" | "growth" | "rates_vol";
  label: string;
  state: string | null;
  tone: Tone;
  value: number | null;
  unit: string;
  detail: string;
  rule: string;
  proxy?: boolean;
  gap_vs_target?: number | null;
  trend_3m?: number | null;
  source?: string | null;
  z63?: number | null;
  pctile_1y?: number | null;
  cross_check?: Record<string, number | null>;
  components?: {
    parts?: Record<string, number>;
    as_of?: Record<string, string | null>;
    note?: string;
  } | null;
}

export interface MacroRead {
  counted_in_composite: false;
  validated: false;
  axes: MacroAxis[];
  summary: string | null;
  note: string;
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
  macro_read: MacroRead | null;
  ism_proxy_components?: MacroAxis["components"];
  oil?: OilBalance | null;
  macro_ok: boolean;
}

/** One line of the EIA weekly balance. Stocks in million barrels. */
export interface OilRow {
  key: string;
  label: string;
  unit: string;
  value: number;
  date: string;
  chg_w: number | null;
  yoy_pct: number | null;
  vs_5y_pct: number | null;
  low_5y: number | null;
  high_5y: number | null;
}

export interface OilPrice {
  key: string;
  label: string;
  unit: string;
  value: number;
  date: string;
  yoy_pct: number | null;
  chg_13w_pct: number | null;
}

export interface OilBalance {
  week_ending: string | null;
  rows: OilRow[];
  prices: OilPrice[];
  cushion_vs_5y_pct: number | null;
  released?: string;
  new?: boolean;
  pending?: boolean;
  next_release: string;
  stale_age_s: number | null;
  demo_key: boolean;
  source: string;
  counted_in_composite: false;
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
  PPI: "#C77BD0",
  RETAIL: "#5FB8A0",
  JOLTS: "#6F9BD8",
  ISM: "#8FB04A",
  MINUTES: "#C98A3C",
  OPEX: "#D8C24A",
  VIXEXP: "#E0705A",
  CLAIMS: "#5C7FA8",
  EIA: "#A0764A",
};

/** How far ahead each impact level earns a chip — a weekly report three weeks
 * out would push the next FOMC off the strip. */
const STRIP_AHEAD_DAYS: Record<MacroEvent["impact"], number> = { high: 21, medium: 10, low: 3 };
const STRIP_MAX = 12;

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
  const soon = cal.upcoming
    .filter((e) => e.days_until <= (STRIP_AHEAD_DAYS[e.impact] ?? 21))
    .slice(0, STRIP_MAX);

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
            fontSize: 9.5,
            letterSpacing: "0.08em",
          }}
          title={`Within ±${win.bdays} business day of a scheduled release. Vol signals marked EVENT may be pricing the event rather than stress.`}
        >
          EVENT WINDOW · {win.events.map((e) => `${e.kind} ${when(e)}`).join(" · ")}
        </span>
      ) : (
        <span
          className="shrink-0"
          style={{ color: "#555", fontSize: 9.5, letterSpacing: "0.08em" }}
        >
          NO EVENT WINDOW
        </span>
      )}
      <NewPrints ctx={ctx} />
      <span style={{ color: "#4a4a4a", fontSize: 11 }}>|</span>
      {soon.length === 0 && (
        <span style={{ color: "#666", fontSize: 9.5 }}>nothing scheduled in 21 days</span>
      )}
      {soon.map((e) => (
        <span
          key={`${e.date}-${e.kind}`}
          className="shrink-0 flex items-center gap-1 px-1"
          style={{ border: `1px solid ${KIND_COLOR[e.kind]}33`, fontSize: 9.5 }}
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
        <span className="ml-auto shrink-0" style={{ color: "#B06000", fontSize: 9 }}>
          {!cal.releases_ok && "FRED releases unavailable — FOMC and rule dates only. "}
          {cal.fomc_calendar_stale &&
            `FOMC calendar ended ${cal.fomc_calendar_through} — update event_calendar.py.`}
          {cal.fomc_calendar_expiring &&
            `FOMC calendar ends ${cal.fomc_calendar_through} — add next year.`}
        </span>
      )}
    </div>
  );
}

// ── Just-released numbers ─────────────────────────────────────────────────────

const NEW_COLOR = "#35D07F";

const NewBadge = ({ label = "NEW" }: { label?: string }) => (
  <span
    className="shrink-0 px-1 font-bold"
    style={{ color: "#000", backgroundColor: NEW_COLOR, fontSize: 8.5, letterSpacing: "0.08em" }}
  >
    {label}
  </span>
);

/** Prints released in the last few days, value against the previous one — on
 *  the strip at the top so a number that just changed cannot be missed. */
function NewPrints({ ctx }: { ctx: MacroContextData | undefined }) {
  const ind = ctx?.indicators;
  const fresh = IND_ROWS.flatMap((r) => {
    const p = ind?.[r.key];
    return p?.new && p.value != null ? [{ r, p, value: p.value }] : [];
  });
  // Newest release first, so today's number leads the strip.
  fresh.sort((a, b) => (b.p.released ?? "").localeCompare(a.p.released ?? ""));
  const waiting = IND_ROWS.filter((r) => ind?.[r.key]?.pending);
  const oil = ctx?.oil;
  if (fresh.length === 0 && waiting.length === 0 && !oil?.new) return null;
  return (
    <>
      <span style={{ color: "#4a4a4a", fontSize: 11 }}>|</span>
      {fresh.map(({ r, p, value }, i) => (
        <span
          key={r.key}
          className="shrink-0 flex items-center gap-1"
          style={{ fontSize: 9.5 }}
          title={`${r.label} · period ${p.date?.slice(0, 7) ?? ""} · released ${p.released ?? ""}`}
        >
          {/* One badge per release day, on its first print. */}
          {fresh.findIndex((f) => f.p.released === p.released) === i && (
            <NewBadge label={`NEW ${p.released?.slice(5) ?? ""}`} />
          )}
          <span style={{ color: "#888" }}>{r.label} </span>
          <span style={{ color: "#fff", fontWeight: "bold" }}>
            {r.fmt(value)}
            {r.unit}
          </span>
          {p.prev != null && (
            <span style={{ color: "#666" }}>
              {" "}
              ← {r.fmt(p.prev)}
              {r.unit}
            </span>
          )}
        </span>
      ))}
      {oil?.new && (
        <span className="shrink-0 flex items-center gap-1" style={{ fontSize: 9.5 }}>
          <NewBadge label={`EIA ${oil.released?.slice(5) ?? ""}`} />
          {oil.rows
            .filter((x) => x.key === "crude" || x.key === "gasoline" || x.key === "distillate")
            .map((x) => (
              <span key={x.key} title={`${x.label} · week ending ${x.date} · change on the week`}>
                <span style={{ color: "#888" }}>{x.label.split(" ")[0]} </span>
                <span style={{ color: "#fff", fontWeight: "bold" }}>
                  {signed(x.chg_w, 1, "mb")}
                </span>
              </span>
            ))}
        </span>
      )}
      {waiting.length > 0 && (
        <span
          className="shrink-0"
          style={{ color: "#FFCC44", fontSize: 9.5 }}
          title="The release time has passed but FRED has not published the number yet — retried every 15 minutes."
        >
          RELEASED, WAITING FOR DATA: {waiting.map((r) => r.label).join(" · ")}
        </span>
      )}
    </>
  );
}

// ── Macro panel (left column) ─────────────────────────────────────────────────

const IND_ROWS: {
  key: string;
  label: string;
  fmt: (v: number) => string;
  unit: string;
  title?: string;
}[] = [
  { key: "cpi", label: "CPI YoY", fmt: (v) => v.toFixed(2), unit: "%" },
  {
    key: "cpi_core",
    label: "CPI CORE",
    fmt: (v) => v.toFixed(2),
    unit: "%",
    title: "CPI ex food & energy — the part monetary policy can actually reach",
  },
  { key: "pce", label: "PCE YoY", fmt: (v) => v.toFixed(2), unit: "%" },
  {
    key: "pce_core",
    label: "PCE CORE",
    fmt: (v) => v.toFixed(2),
    unit: "%",
    title: "The Fed's 2% target is written on THIS series, not on CPI",
  },
  {
    key: "ism_proxy",
    label: "ISM PROXY",
    fmt: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`,
    unit: "sd",
    title:
      "Philly + Empire + Dallas Fed manufacturing surveys, each scaled by its own 10y sd. " +
      "0 = neutral. A proxy for the ISM, not the ISM — FRED dropped the ISM series in 2022",
  },
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
      <span style={{ color: "#6a6a6a", fontSize: 9.5 }}>{label}</span>
      <span className="truncate" style={{ color, fontSize: 10 }}>
        {value}
      </span>
    </div>
  );
}

/** MACRO READ — three axes of the backdrop, each with its rule attached.
 *
 *  Not a forecast and not part of the risk level: it reads today's prints and
 *  says what state they describe, which is the piece TAIL was missing. A lit
 *  vol signal means one thing with growth expanding and inflation falling, and
 *  another with growth contracting while the Fed is still tight — and the point
 *  of keeping the three axes side by side, instead of blending them into one
 *  score, is that the difference stays visible.
 */
export function MacroReadPanel({ ctx }: { ctx: MacroContextData | undefined }) {
  const read = ctx?.macro_read;
  const box = "flex flex-col gap-1 p-2 border";
  if (!read) {
    return (
      <div className={box} style={{ borderColor: "#1e1e1e" }}>
        <span style={{ color: "#888", fontSize: 10, letterSpacing: "0.12em" }}>MACRO READ</span>
        <span style={{ color: "#555", fontSize: 9.5 }}>loading…</span>
      </div>
    );
  }

  return (
    <div className={box} style={{ borderColor: "#1e1e1e" }}>
      <div className="flex items-center justify-between">
        <span style={{ color: "#888", fontSize: 10, letterSpacing: "0.12em" }}>MACRO READ</span>
        <span
          style={{ color: "#5a5a5a", fontSize: 9 }}
          title="No backtest behind these rules, and a macro print is not a market forecast. Not counted in the risk level."
        >
          NOT IN COMPOSITE · UNVALIDATED
        </span>
      </div>

      {read.axes.map((a) => {
        const c = TONE_COLOR[a.tone ?? "unknown"];
        const trend = a.trend_3m == null ? null : a.trend_3m > 0 ? "▲" : a.trend_3m < 0 ? "▼" : "·";
        return (
          <div key={a.id} className="px-1 py-0.5" style={{ border: `1px solid ${c}33` }}>
            <div className="flex items-baseline justify-between gap-2">
              <span style={{ color: "#6a6a6a", fontSize: 9 }}>
                {a.label}
                {a.proxy && (
                  <span style={{ color: "#B06000" }} title="composed series, not the ISM itself">
                    {" "}
                    PROXY
                  </span>
                )}
              </span>
              <span style={{ color: c, fontSize: 10, fontWeight: "bold" }}>
                {a.state ?? "NO DATA"}
                {trend && <span style={{ color: "#666", fontWeight: "normal" }}> {trend}</span>}
              </span>
            </div>
            <div className="truncate" style={{ color: "#666", fontSize: 9 }} title={a.rule}>
              {a.detail}
            </div>
          </div>
        );
      })}

      {/* The cross-check: four inflation prints that disagree, side by side, so
          "inflation is 3.7%" is never read off the wrong one. */}
      {(() => {
        const x = read.axes.find((a) => a.id === "inflation")?.cross_check;
        if (!x) return null;
        const cell = (k: string, lbl: string, hint: string) => (
          <span key={k} title={hint} style={{ color: "#555", fontSize: 9 }}>
            {lbl}{" "}
            <span style={{ color: x[k] == null ? "#333" : "#888" }}>
              {x[k] == null ? "—" : `${x[k]?.toFixed(2)}%`}
            </span>
          </span>
        );
        return (
          <div className="flex flex-wrap gap-x-2">
            {cell("cpi", "CPI", "Headline CPI YoY — what the news quotes")}
            {cell("cpi_core", "CORE CPI", "CPI ex food & energy")}
            {cell("pce", "PCE", "Headline PCE YoY")}
            {cell("pce_core", "CORE PCE", "The Fed's target measure")}
          </div>
        );
      })()}

      <span style={{ color: "#555", fontSize: 8.5, lineHeight: 1.4 }}>
        {read.note} — hover แต่ละแถวเพื่อดูกฎที่ใช้ตัดสิน
      </span>
    </div>
  );
}

const signed = (v: number | null | undefined, dp: number, suffix = "") =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}${suffix}`;

/** OIL · EIA WEEKLY — the US petroleum balance behind the ENERGY → CPI axis.
 *
 *  Stocks are read against the same week of the previous five years, not
 *  against last week: inventories are seasonal, and a draw in driving season
 *  says nothing by itself. For stocks, below the seasonal norm is the risky
 *  side (red); for prices, up is. Context only — never in the risk level.
 */
export function OilPanel({ ctx }: { ctx: MacroContextData | undefined }) {
  const box = "flex flex-col gap-1 p-2 border";
  const head = { color: "#888", fontSize: 10, letterSpacing: "0.12em" } as const;
  const oil = ctx?.oil;
  if (!oil) {
    return (
      <div className={box} style={{ borderColor: "#1e1e1e" }}>
        <span style={head}>OIL · EIA WEEKLY</span>
        <span style={{ color: "#555", fontSize: 9.5 }}>
          {ctx ? "NO DATA — EIA ไม่ตอบ" : "loading…"}
        </span>
      </div>
    );
  }
  const energy = ctx?.macro_read?.axes.find((a) => a.id === "energy");
  const isStock = (r: OilRow) => r.unit === "mb";
  // Tight is the bad side for a stock; for a flow there is no bad side.
  const devColor = (r: OilRow) =>
    r.vs_5y_pct == null || !isStock(r)
      ? "#888"
      : r.vs_5y_pct <= -5
        ? "#FF5252"
        : r.vs_5y_pct >= 5
          ? "#4CAF50"
          : "#888";
  const level = (r: OilRow) =>
    r.unit === "mb"
      ? r.value.toFixed(1)
      : r.unit === "%"
        ? r.value.toFixed(1)
        : Math.round(r.value).toLocaleString("en-US");
  const chg = (r: OilRow) => signed(r.chg_w, r.unit === "kb/d" ? 0 : 1);
  const cell = { fontSize: 9.5, textAlign: "right" } as const;
  const grid = {
    display: "grid",
    gridTemplateColumns: "1fr 58px 48px 50px 50px",
    columnGap: 6,
  } as const;

  return (
    <div className={box} style={{ borderColor: "#1e1e1e" }}>
      <div className="flex items-center justify-between">
        <span style={head}>OIL · EIA WEEKLY</span>
        <span style={{ color: "#5a5a5a", fontSize: 9 }} title={oil.source}>
          {oil.new && <NewBadge label={`NEW ${oil.released?.slice(5) ?? ""}`} />} WEEK{" "}
          {oil.week_ending?.slice(5) ?? "—"} · NEXT {oil.next_release.slice(5)} · NOT IN COMPOSITE
        </span>
      </div>

      {energy && (
        <div
          className="px-1 py-0.5"
          style={{ border: `1px solid ${TONE_COLOR[energy.tone ?? "unknown"]}33` }}
          title={energy.rule}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span style={{ color: "#6a6a6a", fontSize: 9 }}>{energy.label}</span>
            <span
              style={{
                color: TONE_COLOR[energy.tone ?? "unknown"],
                fontSize: 10,
                fontWeight: "bold",
              }}
            >
              {energy.state ?? "NO DATA"}
            </span>
          </div>
          <div style={{ color: "#666", fontSize: 9 }}>{energy.detail}</div>
        </div>
      )}

      <div style={{ ...grid, color: "#555", fontSize: 8.5 }}>
        <span />
        <span style={{ textAlign: "right" }}>LEVEL</span>
        <span style={{ textAlign: "right" }}>Δ WK</span>
        <span style={{ textAlign: "right" }}>YOY</span>
        <span style={{ textAlign: "right" }} title="vs the same week of the previous five years">
          VS 5Y
        </span>
      </div>
      {oil.rows.map((r) => (
        <div
          key={r.key}
          style={grid}
          title={
            r.low_5y == null
              ? `${r.label} · ${r.date}`
              : `${r.label} · ${r.date} · 5y same-week range ${r.low_5y.toFixed(1)}–${r.high_5y?.toFixed(1)} ${r.unit}`
          }
        >
          <span style={{ color: "#6a6a6a", fontSize: 9.5 }}>
            {r.label} <span style={{ color: "#444" }}>{r.unit}</span>
          </span>
          <span style={{ ...cell, color: "#bbb" }}>{level(r)}</span>
          <span style={{ ...cell, color: "#888" }}>{chg(r)}</span>
          <span style={{ ...cell, color: "#888" }}>{signed(r.yoy_pct, 1, "%")}</span>
          <span style={{ ...cell, color: devColor(r) }}>{signed(r.vs_5y_pct, 1, "%")}</span>
        </div>
      ))}

      <div style={{ ...grid, color: "#555", fontSize: 8.5, marginTop: 2 }}>
        <span>PRICES</span>
        <span style={{ textAlign: "right" }}>LAST</span>
        <span />
        <span style={{ textAlign: "right" }}>YOY</span>
        <span style={{ textAlign: "right" }}>13W</span>
      </div>
      {oil.prices.map((p) => {
        const up = (v: number | null) =>
          v == null ? "#888" : v >= 10 ? "#FF5252" : v <= -10 ? "#4CAF50" : "#888";
        return (
          <div key={p.key} style={grid} title={`${p.label} · ${p.date}`}>
            <span style={{ color: "#6a6a6a", fontSize: 9.5 }}>
              {p.label} <span style={{ color: "#444" }}>{p.unit}</span>
            </span>
            <span style={{ ...cell, color: "#bbb" }}>{fmtPriceStd(p.value)}</span>
            <span />
            <span style={{ ...cell, color: up(p.yoy_pct) }}>{signed(p.yoy_pct, 1, "%")}</span>
            <span style={{ ...cell, color: up(p.chg_13w_pct) }}>
              {signed(p.chg_13w_pct, 1, "%")}
            </span>
          </div>
        );
      })}

      {(oil.stale_age_s != null || oil.demo_key) && (
        <span style={{ color: "#B06000", fontSize: 8.5, lineHeight: 1.4 }}>
          {oil.stale_age_s != null &&
            `EIA ไม่ตอบ — ใช้ข้อมูลที่ดึงไว้ ${Math.round(oil.stale_age_s / 3600)} ชม.ก่อน. `}
          {oil.demo_key && "ใช้ DEMO_KEY (10 ครั้ง/ชม.) — ตั้ง EIA_API_KEY ใน backend/.env"}
        </span>
      )}
    </div>
  );
}

export function MacroPanel({ ctx }: { ctx: MacroContextData | undefined }) {
  const box = "flex flex-col gap-1 p-2 border";
  const head = { color: "#888", fontSize: 10, letterSpacing: "0.12em" } as const;

  if (!ctx) {
    return (
      <div className={box} style={{ borderColor: "#1e1e1e" }}>
        <span style={head}>MACRO CONTEXT</span>
        <span style={{ color: "#555", fontSize: 9.5 }}>loading…</span>
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
          style={{ color: "#5a5a5a", fontSize: 9 }}
          title="Not counted in the risk level — no backtest behind it."
        >
          NOT IN COMPOSITE
        </span>
      </div>

      {!ctx.macro_ok && (
        <span style={{ color: "#B06000", fontSize: 9 }}>FRED macro series unavailable</span>
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
                  <div style={{ color: "#6a6a6a", fontSize: 8.5 }}>{k.toUpperCase()}</div>
                  <div className="truncate" style={{ color: c, fontSize: 9, fontWeight: "bold" }}>
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
          {IND_ROWS.map(({ key, label, fmt, unit, title }) => {
            const p = ctx.indicators?.[key];
            if (!p || p.value == null) {
              return <Row key={key} label={label} value="NO DATA" color="#333" title={title} />;
            }
            const d = p.prev == null ? 0 : p.value - p.prev;
            const arrow = Math.abs(d) < 1e-9 ? "·" : d > 0 ? "▲" : "▼";
            const tip = `${title ? `${title}\n` : ""}${p.date ?? ""} · prev ${
              p.prev == null ? "—" : fmt(p.prev)
            }${unit}${p.released ? ` · released ${p.released}` : ""}`;
            if (p.new) {
              // Just released: previous value → new value, spelled out.
              return (
                <div
                  key={key}
                  className="flex justify-between items-center gap-2 px-1"
                  style={{ backgroundColor: "#0c1f14", border: `1px solid ${NEW_COLOR}55` }}
                  title={tip}
                >
                  <span
                    className="flex items-center gap-1"
                    style={{ color: "#bbb", fontSize: 9.5 }}
                  >
                    {label} <NewBadge label={`NEW ${p.released?.slice(5) ?? ""}`} />
                  </span>
                  <span style={{ fontSize: 10 }}>
                    {p.prev != null && (
                      <span style={{ color: "#666" }}>
                        {fmt(p.prev)}
                        {unit} →{" "}
                      </span>
                    )}
                    <span style={{ color: "#fff", fontWeight: "bold" }}>
                      {fmt(p.value)}
                      {unit} {arrow}
                    </span>
                  </span>
                </div>
              );
            }
            return (
              <Row
                key={key}
                label={p.pending ? `${label} · รอข้อมูล ${p.released?.slice(5) ?? ""}` : label}
                value={`${fmt(p.value)}${unit} ${arrow}`}
                color={p.pending ? "#FFCC44" : undefined}
                title={tip}
              />
            );
          })}
        </>
      )}
    </div>
  );
}
