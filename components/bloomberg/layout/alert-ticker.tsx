"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useMemo } from "react";
import { tickerEnabledAtom } from "../atoms";
import { useAlertNotifications } from "../hooks/useAlertNotifications";
import { type AlertEvent, ruleDisplayName } from "../hooks/useAlertRules";

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
  type: "stoploss" | "regime" | "dcc";
  severity: "critical" | "warning";
  symbol: string | null;
  message: string;
  persistent: boolean;
  current_price?: number;
  stop_price?: number;
  expires_at?: string;
}

interface TickerResponse {
  items: TickerItem[];
  alerts: TickerAlert[];
  has_critical: boolean;
  timestamp: string;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtValue(v: number | null, type: string): string {
  if (v == null) return "--";
  if (type === "fx") return v.toFixed(4);
  if (v >= 10_000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v.toFixed(2);
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
  <span className="mx-2 select-none" style={{ color: "#2a2a2a" }}>
    |
  </span>
);

/**
 * One palette for the whole crawl. Every segment — quote, ALERT, REGIME, F&G —
 * uses these three roles and nothing else, so a signal is distinguished by what
 * it says, not by a colour of its own.
 */
const C = {
  tag: "#999999", // small left-hand label
  value: "#FFD700", // the reading itself
  detail: "#777777", // trailing context, no direction
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
 * Every non-quote segment (ALERT / REGIME / F&G / stop / corr-spike) renders
 * through here, with the same three slots and the same type scale as a quote:
 * 9px grey tag, gold value at the bar's base size, 9px trailing detail.
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
      <span style={{ color: C.tag, fontSize: 9 }}>{tag}</span>
      {value != null && <span style={{ color: C.value, letterSpacing: "0.02em" }}>{value}</span>}
      {children != null && (
        <span className="inline-flex items-baseline gap-1" style={{ color: C.detail, fontSize: 9 }}>
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
      <span style={{ color: C.tag, fontSize: 9 }}>{item.label}</span>
      <span style={{ color: C.value, letterSpacing: "0.02em" }}>
        {fmtValue(item.value, item.type)}
      </span>
      {text && <span style={{ color: changeColor, fontSize: 9 }}>{text}</span>}
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

/** Alert-rule pill (backend/alerts) — cyan, so it reads as distinct from the
 *  stoploss/regime/DCC alerts that share this ticker. One pill per symbol,
 *  listing every condition that symbol currently satisfies. */
function RuleEventSegment({ group }: { group: SymbolAlertGroup }) {
  return (
    <SignalPill tag="ALERT" value={group.symbol}>
      {group.conditions.length > 1 && <span>×{group.conditions.length}</span>}
      {group.conditions.map((c, i) => (
        <span key={c.ruleId} className="inline-flex items-center gap-1">
          {i > 0 && <span style={{ opacity: 0.4 }}>·</span>}
          <span>{c.label}</span>
          {c.values && <span>{c.values}</span>}
        </span>
      ))}
    </SignalPill>
  );
}

function AlertSegment({ alert }: { alert: TickerAlert }) {
  // ── Stop loss ─────────────────────────────────────────────────────────────
  if (alert.type === "stoploss" && alert.current_price != null && alert.stop_price != null) {
    const distPct = (((alert.stop_price - alert.current_price) / alert.stop_price) * 100).toFixed(
      2
    );
    return (
      <SignalPill tag="STOP BREACH" value={alert.symbol}>
        <span>CUR {alert.current_price.toFixed(2)}</span>
        <span>SL {alert.stop_price.toFixed(2)}</span>
        <span style={{ color: C.down }}>▼{distPct}%</span>
      </SignalPill>
    );
  }

  // ── DCC correlation spike ─────────────────────────────────────────────────
  if (alert.type === "dcc") {
    return <SignalPill tag="CORR-SPIKE" value={alert.message} />;
  }

  // ── Regime change event ───────────────────────────────────────────────────
  const m = alert.message.match(/REGIME:\s+(.+?)\s+[->]+\s+(.+)/);
  const plain = (w: string) => REGIME_DISPLAY[w.trim().toUpperCase()] ?? w.trim();
  const label = m
    ? `${plain(m[1])} → ${plain(m[2])}`
    : alert.message.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s*/u, "");

  return <SignalPill tag="REGIME CHG" value={label} />;
}

// ── Main component ────────────────────────────────────────────────────────────

export function AlertTicker() {
  const [enabled] = useAtom(tickerEnabledAtom);
  const { data } = useQuery<TickerResponse>({
    queryKey: ["ticker"],
    queryFn: () => fetch("/api/ticker").then((r) => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Also the app's single mount point for toast/sound delivery — the ticker
  // is always mounted, so the hook doesn't need a component of its own.
  const { tickerEvents } = useAlertNotifications();
  const ruleGroups = useMemo(() => groupRuleEvents(tickerEvents), [tickerEvents]);

  if (!enabled) return null;

  const items = data?.items ?? [];
  const alerts = data?.alerts ?? [];
  const hasCritical = data?.has_critical ?? false;

  // ── Build content segments (alerts first, then market items) ───────────────
  const makeContent = () => {
    const parts: React.ReactNode[] = [];

    // Rule events lead: they're the ones the user explicitly asked to be told
    // about, unlike the standing stoploss/regime watches behind them.
    for (const group of ruleGroups) {
      parts.push(<RuleEventSegment key={`re${group.symbol}`} group={group} />);
      parts.push(<span key={`res${group.symbol}`}>{SEP}</span>);
    }

    for (let i = 0; i < alerts.length; i++) {
      parts.push(<AlertSegment key={`a${i}`} alert={alerts[i]} />);
      parts.push(<span key={`as${i}`}>{SEP}</span>);
    }

    for (let i = 0; i < items.length; i++) {
      parts.push(<ItemSegment key={`m${i}`} item={items[i]} />);
      if (i < items.length - 1) parts.push(<span key={`ms${i}`}>{SEP}</span>);
    }

    return parts;
  };

  const content = makeContent();

  // ── Loading skeleton ───────────────────────────────────────────────────────
  if (content.length === 0) {
    return (
      <div
        className="shrink-0 flex items-center px-2 font-mono border-t"
        style={{ height: 22, backgroundColor: "#000", borderColor: "#1f1f1f" }}
      >
        <span style={{ color: "#333", fontSize: 9 }}>MARKET DATA LOADING...</span>
      </div>
    );
  }

  // Duration: ~4s per item, min 30s
  const durationSec = Math.max(30, items.length * 4 + alerts.length * 6 + ruleGroups.length * 6);

  return (
    <div
      className="shrink-0 overflow-hidden flex items-center font-mono border-t select-none"
      style={{
        height: 22,
        minHeight: 22,
        backgroundColor: hasCritical ? "#100000" : "#000000",
        borderColor: hasCritical ? "#330000" : "#1f1f1f",
      }}
    >
      {/* Label badge */}
      <span
        className="shrink-0 flex items-center justify-center h-full px-2 border-r font-bold tracking-widest"
        style={{
          backgroundColor: hasCritical ? "#CC0000" : "#FF6600",
          borderColor: hasCritical ? "#880000" : "#cc4400",
          color: "#000",
          fontSize: 8.5,
          minWidth: 38,
        }}
      >
        {hasCritical ? "ALERT" : "LIVE"}
      </span>

      {/* Scrolling content — content duplicated for seamless loop via translateX(-50%) */}
      <div className="flex-1 overflow-hidden h-full flex items-center pl-2">
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
