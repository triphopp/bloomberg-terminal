"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { riskLinkLabel, riskTargetOf } from "../alerts/guard-alert";
import { useOpenRisk } from "../alerts/useOpenRisk";
import { type RiskSubTabRequest, tickerEnabledAtom } from "../atoms";
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
  /** PORT → RISK page this condition is acted on (TRADE GUARD / MARGIN only). */
  risk: RiskSubTabRequest | null;
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
    const key = ruleDisplayName(event.ruleName, event.symbol) || `#${event.id}`;
    const prev = rules.get(key);
    if (prev && prev.latestId >= event.id) {
      prev.count += 1;
      continue;
    }
    rules.set(key, {
      ruleId: key,
      label: ruleDisplayName(event.ruleName, event.symbol),
      values: snapshotValues(event),
      count: (prev?.count ?? 0) + 1,
      latestId: event.id,
      risk: riskTargetOf(event),
    });
  }

  return [...bySymbol.entries()]
    .map(([symbol, rules]) => {
      const conditions = [...rules.values()].sort((a, b) => b.latestId - a.latestId);
      return {
        symbol,
        conditions,
        latestId: conditions.reduce((m, c) => Math.max(m, c.latestId), 0),
      };
    })
    .sort((a, b) => b.latestId - a.latestId);
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
  const openRisk = useOpenRisk();

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
  // The chip names one alert; when that alert is a TRADE GUARD / MARGIN one it
  // is also the way to the page that handles it. Rebalance wins when several
  // guard conditions are waiting on that symbol only if it is the one named.
  const chipRisk = firstRule?.conditions[0]?.risk ?? null;
  const alertCount = ruleGroups.length + alerts.length;
  const alertTitle = [
    ...ruleGroups.map(
      (g) => `${g.symbol}: ${g.conditions.map((c) => `${c.label} ${c.values}`).join(" · ")}`
    ),
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
            "flex min-w-0 max-w-[42%] shrink-0 items-center gap-1.5 overflow-hidden border-r px-2 font-bold h-full";
          const chipStyle = {
            borderColor: "#3a2922",
            color: hasCritical ? "#FF6565" : "#FFB13B",
            fontSize: 9,
          };
          const body = (
            <>
              <span className="shrink-0">●</span>
              <span className="truncate">
                {firstRule
                  ? `${firstRule.symbol} ${firstRule.conditions[0]?.label ?? "ALERT"}`
                  : firstAlert?.message}
              </span>
              {alertCount > 1 && <span className="shrink-0">+{alertCount - 1}</span>}
              {chipRisk && <span className="shrink-0">→</span>}
            </>
          );
          return chipRisk ? (
            <button
              type="button"
              data-frame
              className={`${chipClass} select-none hover:opacity-80`}
              style={chipStyle}
              title={`${alertTitle}

${riskLinkLabel(chipRisk)} →`}
              aria-label={`${alertCount} active alerts: ${alertTitle} — ${riskLinkLabel(chipRisk)}`}
              onClick={() => openRisk(chipRisk)}
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
