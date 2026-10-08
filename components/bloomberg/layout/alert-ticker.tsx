"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  calendarDateOf,
  calendarHeadline,
  isCalendarEvent,
  whenText,
} from "../alerts/calendar-alert";
import {
  type AlertTarget,
  alertLinkLabel,
  alertTargetOf,
  useOpenAlertTarget,
} from "../alerts/useOpenAlertTarget";
import { isWebullEnded, isWebullEvent, webullHeadline, webullWhen } from "../alerts/webull-alert";
import { tickerEnabledAtom } from "../atoms";
import { useAlertNotifications } from "../hooks/useAlertNotifications";
import { type AlertEvent, ruleDisplayName } from "../hooks/useAlertRules";
import { fmtPriceStd } from "../lib/number-format";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TickerItem {
  label: string;
  value: number | null;
  change: number | null;
  pct: number | null;
  type: "index" | "fx" | "commodity" | "indicator" | "regime" | "fear_greed";
  regime_label?: string;
  regime_score?: number | null;
  fear_greed_value?: number | null;
  fear_greed_zone?: string | null;
  fear_greed_label?: string | null;
  vix_level?: "low" | "normal" | "elevated" | "high" | "extreme";
}

interface TickerAlert {
  type: "regime";
  severity: "critical" | "warning";
  symbol: string | null;
  message: string;
  persistent: boolean;
  expires_at?: string;
}

interface TickerResponse {
  items: TickerItem[];
  alerts: TickerAlert[];
  has_critical: boolean;
  timestamp: string;
  /** Served from cache while a refresh runs behind it — the numbers are real
   *  but a minute or two old. */
  stale?: boolean;
  /** Not one market row came back: an upstream failure, not a quiet market. */
  degraded?: boolean;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtValue(v: number | null, type: string): string {
  if (v == null) return "--";
  if (type === "fx") return v.toFixed(4);
  return fmtPriceStd(v);
}

function fmtChange(
  change: number | null,
  pct: number | null,
  type: string
): {
  text: string;
  positive: boolean | null;
} {
  if (change == null) return { text: "", positive: null };
  const positive = change >= 0;
  const arrow = positive ? "▲" : "▼";
  const sign = positive ? "+" : "";

  let absStr: string;
  if (type === "fx") {
    absStr = Math.abs(change).toFixed(4);
  } else if (Math.abs(change) >= 100) {
    absStr = Math.abs(change).toFixed(0);
  } else {
    absStr = Math.abs(change).toFixed(2);
  }

  const pctStr = pct != null ? `  ${sign}${pct.toFixed(2)}%` : "";
  return { text: `${arrow}${sign}${absStr}${pctStr}`, positive };
}

// ── Sub-components ────────────────────────────────────────────────────────────

const SEP = (
  <span className="mx-2 select-none" style={{ color: "#555" }}>
    ·
  </span>
);

/**
 * Shared roles for quote and contextual readings in the moving market feed.
 */
const C = {
  tag: "#aaa", // small left-hand label
  value: "#FFD700", // the reading itself
  detail: "#aaa", // trailing context, no direction
  up: "#22DD66",
  down: "#FF5555",
};

/**
 * Backend regime labels are quant shorthand ("DIVERGENT" = low average
 * cross-sector correlation). On a one-line crawl nobody decodes that, so the
 * ticker shows the plain-language reading from `regime_v2.LABEL_INFO` instead.
 * The backend label is unchanged — this is display only.
 */
const REGIME_DISPLAY: Record<string, string> = {
  CRISIS: "SEVERE STRESS",
  "RISK-OFF": "UNDER STRESS",
  TRENDING: "ONE-WAY TREND",
  DIVERGENT: "CALM",
  MIXED: "MIXED",
  CORRELATED: "MOVING AS ONE",
};

/**
 * Contextual market readings use the same label/value structure as a quote.
 */
function SignalPill({
  tag,
  value,
  children,
}: {
  tag: string;
  value?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span style={{ color: C.tag, fontSize: 8.5 }}>{tag}</span>
      {value != null && <span style={{ color: C.value, letterSpacing: "0.02em" }}>{value}</span>}
      {children != null && (
        <span
          className="inline-flex items-baseline gap-1"
          style={{ color: C.detail, fontSize: 8.5 }}
        >
          {children}
        </span>
      )}
    </span>
  );
}

function ItemSegment({ item }: { item: TickerItem }) {
  // ── Regime ────────────────────────────────────────────────────────────────
  if (item.type === "regime" && item.regime_label) {
    const word = REGIME_DISPLAY[item.regime_label] ?? item.regime_label;
    return (
      <SignalPill tag="REGIME" value={word}>
        {item.regime_score != null && <span>CORR {item.regime_score.toFixed(2)}</span>}
      </SignalPill>
    );
  }

  // ── Fear & Greed ──────────────────────────────────────────────────────────
  if (item.type === "fear_greed" && item.fear_greed_zone) {
    const val = item.fear_greed_value != null ? String(Math.round(item.fear_greed_value)) : "--";
    return (
      <SignalPill tag="F&G" value={val}>
        <span>{item.fear_greed_label ?? ""}</span>
      </SignalPill>
    );
  }

  // ── Quotes — VIX included; its level is already legible from the number ────
  const { text, positive } = fmtChange(item.change, item.pct, item.type);
  const changeColor = positive === null ? C.detail : positive ? C.up : C.down;

  return (
    <span className="inline-flex items-baseline gap-1">
      <span style={{ color: C.tag, fontSize: 8.5 }}>{item.label}</span>
      <span
        className="font-semibold"
        style={{ color: C.value, fontSize: 10.5, letterSpacing: "0.01em" }}
      >
        {fmtValue(item.value, item.type)}
      </span>
      {text && <span style={{ color: changeColor, fontSize: 8.5 }}>{text}</span>}
    </span>
  );
}

// ── Rule-event grouping ───────────────────────────────────────────────────────

/** One rule currently in breach for a symbol, carrying its latest reading. */
interface RuleCondition {
  ruleId: string;
  label: string;
  values: string;
  /** How many times this rule has fired while unacked — `level` triggers
   *  re-fire every bar, so the count is the only thing that was changing. */
  count: number;
  latestId: number;
  /** Where this condition is acted on: PORT → RISK (TRADE GUARD / MARGIN), or
   *  the thesis a CALENDAR reminder belongs to. null = a plain rule alert. */
  target: AlertTarget | null;
  /** A CALENDAR reminder — a date coming up, not a condition in breach. */
  reminder: boolean;
}

interface SymbolAlertGroup {
  symbol: string;
  conditions: RuleCondition[];
  latestId: number;
}

function snapshotValues(event: AlertEvent): string {
  return Object.entries(event.snapshot)
    .filter(([key]) => !key.startsWith("const:"))
    .map(([, v]) => (typeof v === "number" ? v.toFixed(2) : "--"))
    .join(" / ");
}

/**
 * Collapse the raw event feed into one entry per symbol.
 *
 * The feed is append-only: a `level` rule re-fires on every bar it stays true,
 * so a single standing condition arrives as N events with identical text and a
 * drifting number. Rendering them one-per-pill made the ticker grow without
 * bound. Keep only the newest event per (symbol, rule) — that's the current
 * reading — and group those under the symbol.
 */
function groupRuleEvents(events: AlertEvent[]): SymbolAlertGroup[] {
  const bySymbol = new Map<string, Map<string, RuleCondition>>();

  for (const event of events) {
    let rules = bySymbol.get(event.symbol);
    if (!rules) {
      rules = new Map();
      bySymbol.set(event.symbol, rules);
    }
    // Events for a deleted rule have no name; fall back to the id so two
    // different deleted rules don't merge into one line.
    // Key on the *displayed* rule name, not the rule id: a symbol watched by
    // two rules that render the same headline (e.g. the same condition cloned
    // per timeframe) otherwise renders the identical text twice in one pill.
    // A CALENDAR reminder is one event, never a re-fire: two dates of one
    // symbol are two lines, so it keys on itself.
    const calendar = isCalendarEvent(event);
    const webull = isWebullEvent(event);
    // A WEBULL notice about a date still ahead is a reminder too; one that has
    // ended is a thing not working, and ranks with the breaches.
    const reminder = calendar || (webull && !isWebullEnded(event));
    // WEBULL: one line per kind — today's "token ends" replaces yesterday's.
    const key = calendar
      ? `cal#${event.id}`
      : webull
        ? event.ruleId
        : ruleDisplayName(event.ruleName, event.symbol) || `#${event.id}`;
    const prev = rules.get(key);
    if (prev && prev.latestId >= event.id) {
      prev.count += 1;
      continue;
    }
    rules.set(key, {
      ruleId: key,
      label: calendar
        ? calendarHeadline(event)
        : webull
          ? webullHeadline(event)
          : ruleDisplayName(event.ruleName, event.symbol),
      // Worded from the date as it is read: "tomorrow" becomes "today" overnight.
      values: calendar
        ? whenText(calendarDateOf(event))
        : webull
          ? webullWhen(event)
          : snapshotValues(event),
      count: (prev?.count ?? 0) + 1,
      latestId: event.id,
      target: alertTargetOf(event),
      reminder,
    });
  }

  // A condition in breach outranks a reminder, in a group and among groups:
  // the chip names the first one, and a stop that broke must not sit behind
  // tomorrow's earnings.
  const urgency = (c: RuleCondition) => (c.reminder ? 0 : 1);
  return [...bySymbol.entries()]
    .map(([symbol, rules]) => {
      const conditions = [...rules.values()].sort(
        (a, b) => urgency(b) - urgency(a) || b.latestId - a.latestId
      );
      return {
        symbol,
        conditions,
        latestId: conditions.reduce((m, c) => Math.max(m, c.latestId), 0),
      };
    })
    .sort((a, b) => urgency(b.conditions[0]) - urgency(a.conditions[0]) || b.latestId - a.latestId);
}

/** What one condition says on one line: the reading, or when the date is. */
const conditionText = (c: RuleCondition) => `${c.label}${c.values ? ` · ${c.values}` : ""}`;

function AlertLine({ symbol, c }: { symbol: string; c: RuleCondition }) {
  return (
    <>
      <span className="font-bold" style={{ color: c.reminder ? "#4ade80" : "#FFB13B" }}>
        {symbol}
      </span>{" "}
      <span style={{ color: "#ddd" }}>{conditionText(c)}</span>
      {c.target && <span style={{ color: "#33DDFF" }}> — {alertLinkLabel(c.target)} →</span>}
    </>
  );
}

/**
 * Every active alert, each with the way to the page that handles it. The chip
 * can name only one; this is where the rest are reached. Fixed, not absolute:
 * the ticker clips its overflow and sits at the bottom of the window.
 */
function AlertList({
  groups,
  alerts,
  anchor,
  onOpen,
  onClose,
}: {
  groups: SymbolAlertGroup[];
  alerts: TickerAlert[];
  anchor: { left: number; bottom: number };
  onOpen: (t: AlertTarget) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 w-[380px] max-w-[92vw] border font-mono"
      style={{
        left: anchor.left,
        bottom: anchor.bottom,
        maxHeight: "50vh",
        overflowY: "auto",
        background: "#0d0d0d",
        borderColor: "#3a2922",
        fontSize: 10,
      }}
    >
      {groups.flatMap((g) =>
        g.conditions.map((c) => {
          const target = c.target;
          return target ? (
            <button
              type="button"
              key={`${g.symbol}|${c.ruleId}`}
              className="block w-full text-left px-2 py-1 hover:opacity-80"
              onClick={() => {
                onClose();
                onOpen(target);
              }}
            >
              <AlertLine symbol={g.symbol} c={c} />
            </button>
          ) : (
            <div key={`${g.symbol}|${c.ruleId}`} className="px-2 py-1">
              <AlertLine symbol={g.symbol} c={c} />
            </div>
          );
        })
      )}
      {alerts.map((a) => (
        <div
          key={a.message}
          className="px-2 py-1"
          style={{ color: a.severity === "critical" ? "#FF6565" : "#FFB13B" }}
        >
          {a.message}
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function AlertTicker() {
  const [enabled] = useAtom(tickerEnabledAtom);
  const { data, isLoading, isError } = useQuery<TickerResponse>({
    queryKey: ["ticker"],
    // Poll at 90s. The backend serves its cached payload at once and refreshes
    // behind it when older than 45s (10 min over the weekend), so each poll
    // costs at most one warm rebuild and never waits on it. `stale` only comes
    // back once refreshes have been failing — see backend/routers/ticker.py.
    // Hidden tabs don't poll (React Query's refetchIntervalInBackground=false).
    queryFn: () => fetch("/api/ticker").then((r) => r.json()),
    refetchInterval: 90_000,
    staleTime: 45_000,
  });

  // Last payload that actually carried market rows. A refetch that fails, or
  // one the backend answers in a degraded state, must not blank a bar that is
  // already showing real numbers — the crawl is ambient, and an old print reads
  // better than an empty strip.
  const lastGood = useRef<TickerResponse | null>(null);
  // `data` is whatever the proxy returned, NOT necessarily a TickerResponse: on
  // an upstream failure `app/api/ticker/route.ts` answers `{ error, detail }`
  // with no `items` at all, and React Query hands that body over as data rather
  // than as an error. Reaching into `.items.length` there throws during render,
  // and the ticker sits above every view with no error boundary over it — one
  // 502 took down the whole terminal.
  const rows = Array.isArray(data?.items) ? data.items : null;
  useEffect(() => {
    if (data && rows && rows.length > 0) lastGood.current = data;
  }, [data, rows]);

  // Also the app's single mount point for toast/sound delivery — the ticker
  // is always mounted, so the hook doesn't need a component of its own.
  const { tickerEvents } = useAlertNotifications();
  const ruleGroups = useMemo(() => groupRuleEvents(tickerEvents), [tickerEvents]);
  const openTarget = useOpenAlertTarget();
  // The list of every alert, opened from "+N" — anchored where that was clicked.
  const [listAt, setListAt] = useState<{ left: number; bottom: number } | null>(null);

  if (!enabled) return null;

  const shown = rows && rows.length > 0 ? data : lastGood.current;
  const items = shown?.items ?? [];
  const alerts = shown?.alerts ?? [];
  const hasCritical = shown?.has_critical ?? false;
  // Dimmed, not blank: the data on screen is real but no longer current.
  const isStale = Boolean(shown && (shown.stale || shown.degraded || isError || shown !== data));

  // Alerts stay stationary; only quotes scroll. A critical alert must never
  // require waiting for the crawl to cycle back into view.
  const makeContent = () => {
    const parts: React.ReactNode[] = [];

    for (let i = 0; i < items.length; i++) {
      parts.push(<ItemSegment key={`m${i}`} item={items[i]} />);
      if (i < items.length - 1) parts.push(<span key={`ms${i}`}>{SEP}</span>);
    }

    return parts;
  };

  const content = makeContent();

  // ── Empty bar ──────────────────────────────────────────────────────────────
  // Only reachable now when nothing has EVER arrived this session: once a
  // payload with rows lands it is held in lastGood and kept on screen. The
  // three cases read differently and used to be one undifferentiated
  // "MARKET DATA LOADING..." that also covered outright failure.
  if (content.length === 0 && ruleGroups.length === 0 && alerts.length === 0) {
    const [msg, color] = isLoading
      ? ["MARKET DATA LOADING...", "#333"]
      : isError || data?.degraded || !rows
        ? ["MARKET DATA UNAVAILABLE — RETRYING", "#884400"]
        : ["NO MARKET DATA", "#333"];
    return (
      <div
        className="min-w-0 flex-1 flex items-center px-2 font-mono"
        style={{ backgroundColor: "#000" }}
      >
        <span style={{ color, fontSize: 8.5 }}>{msg}</span>
      </div>
    );
  }

  // Duration: ~4s per market item, min 30s. Alerts never enter this crawl.
  const durationSec = Math.max(30, items.length * 4);
  const firstRule = ruleGroups[0];
  const firstAlert = alerts[0];
  // The chip names one alert, and is the way to the page that handles it: PORT
  // → RISK for a TRADE GUARD / MARGIN one, the thesis a CALENDAR date belongs
  // to. Rebalance wins when several guard conditions are waiting on that symbol
  // only if it is the one named. "+N" opens the rest.
  const chipCondition = firstRule?.conditions[0] ?? null;
  const chipTarget = chipCondition?.target ?? null;
  const alertCount = ruleGroups.reduce((n, g) => n + g.conditions.length, 0) + alerts.length;
  const alertTitle = [
    ...ruleGroups.map((g) => `${g.symbol}: ${g.conditions.map(conditionText).join(" · ")}`),
    ...alerts.map((a) => a.message),
  ].join("\n");

  return (
    <div
      className="min-w-0 flex-1 overflow-hidden flex items-center font-mono select-none"
      style={{
        backgroundColor: hasCritical ? "#100000" : "#000000",
      }}
    >
      {/* Label badge */}
      <span
        className="shrink-0 flex items-center justify-center h-full px-2 border-r font-bold tracking-wide"
        style={{
          backgroundColor: hasCritical ? "#CC0000" : isStale ? "#665200" : "#FF6600",
          borderColor: hasCritical ? "#880000" : isStale ? "#443300" : "#cc4400",
          color: "#000",
          fontSize: 8.5,
          minWidth: 38,
        }}
      >
        {hasCritical ? "ALERT" : isStale ? "STALE" : "LIVE"}
      </span>

      {alertCount > 0 &&
        (() => {
          const chipClass =
            "flex min-w-0 shrink items-center gap-1.5 overflow-hidden px-2 font-bold h-full";
          const chipStyle = {
            color: hasCritical ? "#FF6565" : chipCondition?.reminder ? "#4ade80" : "#FFB13B",
            fontSize: 9,
          };
          const chipText = firstRule
            ? `${firstRule.symbol} ${
                chipCondition
                  ? chipCondition.reminder
                    ? conditionText(chipCondition)
                    : chipCondition.label
                  : "ALERT"
              }`
            : firstAlert?.message;
          const body = (
            <>
              <span className="shrink-0">●</span>
              <span className="truncate">{chipText}</span>
              {chipTarget && <span className="shrink-0">→</span>}
            </>
          );
          return (
            <span
              // data-frame: the rule that divides the alert from the crawl is the content
              data-frame
              className="flex min-w-0 max-w-[46%] shrink-0 items-center border-r h-full"
              style={{ borderColor: "#3a2922" }}
            >
              {chipTarget ? (
                <button
                  type="button"
                  data-frame
                  className={`${chipClass} select-none hover:opacity-80`}
                  style={chipStyle}
                  title={`${alertTitle}

${alertLinkLabel(chipTarget)} →`}
                  aria-label={`${alertCount} active alerts: ${alertTitle} — ${alertLinkLabel(chipTarget)}`}
                  onClick={() => openTarget(chipTarget)}
                >
                  {body}
                </button>
              ) : (
                <span
                  className={chipClass}
                  style={chipStyle}
                  title={alertTitle}
                  aria-label={`${alertCount} active alerts: ${alertTitle}`}
                >
                  {body}
                </span>
              )}
              {alertCount > 1 && (
                <button
                  type="button"
                  data-frame
                  aria-pressed={listAt != null}
                  className="shrink-0 select-none px-1.5 font-bold h-full hover:opacity-80"
                  style={{ color: "#33DDFF", fontSize: 9 }}
                  title={`ดูทั้ง ${alertCount} รายการ`}
                  aria-label={`All ${alertCount} active alerts`}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setListAt((at) =>
                      at
                        ? null
                        : {
                            left: Math.max(4, r.left - 120),
                            bottom: window.innerHeight - r.top + 2,
                          }
                    );
                  }}
                >
                  +{alertCount - 1}
                </button>
              )}
              {listAt && (
                <AlertList
                  groups={ruleGroups}
                  alerts={alerts}
                  anchor={listAt}
                  onOpen={openTarget}
                  onClose={() => setListAt(null)}
                />
              )}
            </span>
          );
        })()}

      {/* Scrolling content — content duplicated for seamless loop via translateX(-50%) */}
      <div
        className="min-w-0 flex-1 overflow-hidden h-full flex items-center pl-2"
        style={{ opacity: isStale ? 0.55 : 1 }}
      >
        {/* Two identical halves; the keyframe translates exactly -50%, so the
            second half lands where the first started — no visible seam.
            `shrink-0 w-max` is load-bearing: as a flex child this div would
            otherwise shrink to the viewport width, making -50% half a *screen*
            instead of half the *content* and cutting the crawl off mid-way.
            `minWidth: 200%` covers the opposite case — content narrower than
            the bar, where each half still fills it so the loop never trails a
            blank gap. */}
        <div
          className="inline-flex items-baseline whitespace-nowrap shrink-0 w-max"
          style={{
            minWidth: "200%",
            animationName: "ticker-scroll",
            animationDuration: `${durationSec}s`,
            animationTimingFunction: "linear",
            animationIterationCount: "infinite",
          }}
        >
          <span className="inline-flex items-baseline gap-0 pr-12 flex-1 shrink-0">{content}</span>
          <span className="inline-flex items-baseline gap-0 pr-12 flex-1 shrink-0">{content}</span>
        </div>
      </div>
    </div>
  );
}
