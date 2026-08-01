"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
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

const REGIME_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  CRISIS: { bg: "#DD0000", text: "#ffffff", label: "#ffcccc" },
  "RISK-OFF": { bg: "#CC6600", text: "#000000", label: "#331a00" },
  TRENDING: { bg: "#CCAA00", text: "#000000", label: "#332b00" },
  DIVERGENT: { bg: "#00AA66", text: "#000000", label: "#002b1a" },
};

const FG_ZONE_COLORS: Record<string, { bg: string; text: string }> = {
  extreme_fear: { bg: "#CC2200", text: "#ffffff" },
  fear: { bg: "#CC6600", text: "#000000" },
  neutral: { bg: "#888800", text: "#000000" },
  greed: { bg: "#00AA44", text: "#000000" },
  extreme_greed: { bg: "#007733", text: "#ffffff" },
};

const VIX_LEVEL_COLORS: Record<string, { bg: string; text: string }> = {
  low: { bg: "#007733", text: "#ffffff" },
  normal: { bg: "#005522", text: "#ccffcc" },
  elevated: { bg: "#886600", text: "#000000" },
  high: { bg: "#CC6600", text: "#000000" },
  extreme: { bg: "#CC2200", text: "#ffffff" },
};

function ItemSegment({ item }: { item: TickerItem }) {
  // ── Regime pill — always highlighted ───────────────────────────────────────
  if (item.type === "regime" && item.regime_label) {
    const c = REGIME_COLORS[item.regime_label] ?? { bg: "#444", text: "#fff", label: "#fff" };
    return (
      <span
        className="inline-flex items-center gap-1 font-bold tracking-wider"
        style={{
          backgroundColor: c.bg,
          color: c.text,
          fontSize: 9.5,
          padding: "1px 7px",
        }}
      >
        <span style={{ color: c.label, fontSize: 8, opacity: 0.8 }}>REGIME</span>
        {item.regime_label}
      </span>
    );
  }

  // ── Fear & Greed pill — always highlighted ──────────────────────────────────
  if (item.type === "fear_greed" && item.fear_greed_zone) {
    const c = FG_ZONE_COLORS[item.fear_greed_zone] ?? { bg: "#444", text: "#fff" };
    const val = item.fear_greed_value != null ? Math.round(item.fear_greed_value) : "--";
    return (
      <span
        className="inline-flex items-center gap-1 font-bold tracking-wider"
        style={{
          backgroundColor: c.bg,
          color: c.text,
          fontSize: 9.5,
          padding: "1px 7px",
        }}
      >
        <span style={{ fontSize: 8, opacity: 0.75 }}>F&G</span>
        <span>{val}</span>
        <span style={{ fontSize: 7.5, opacity: 0.8 }}>{item.fear_greed_label ?? ""}</span>
      </span>
    );
  }

  // ── VIX pill — prominent when elevated/high/extreme ────────────────────────
  if (
    item.label === "VIX" &&
    item.vix_level &&
    item.vix_level !== "normal" &&
    item.vix_level !== "low"
  ) {
    const c = VIX_LEVEL_COLORS[item.vix_level] ?? { bg: "#444", text: "#fff" };
    const pctStr = item.pct != null ? `${item.pct >= 0 ? "+" : ""}${item.pct.toFixed(1)}%` : null;
    return (
      <span
        className="inline-flex items-center gap-1 font-bold tracking-wider"
        style={{
          backgroundColor: c.bg,
          color: c.text,
          fontSize: 9.5,
          padding: "1px 7px",
        }}
      >
        <span style={{ fontSize: 8, opacity: 0.8 }}>VIX</span>
        <span>{item.value != null ? item.value.toFixed(1) : "--"}</span>
        {pctStr && <span style={{ fontSize: 8, opacity: 0.85 }}>{pctStr}</span>}
      </span>
    );
  }

  // ── Normal market data ──────────────────────────────────────────────────────
  const { text, positive } = fmtChange(item.change, item.pct, item.type);
  const changeColor = positive === null ? "#777" : positive ? "#22DD66" : "#FF5555";

  return (
    <span className="inline-flex items-baseline gap-1">
      <span style={{ color: "#999999", fontSize: 9 }}>{item.label}</span>
      <span style={{ color: "#FFD700", letterSpacing: "0.02em" }}>
        {fmtValue(item.value, item.type)}
      </span>
      {text && <span style={{ color: changeColor, fontSize: 9 }}>{text}</span>}
    </span>
  );
}

/** Alert-rule event pill (backend/alerts) — cyan, so it reads as distinct
 *  from the stoploss/regime/DCC alerts that share this ticker. */
function RuleEventSegment({ event }: { event: AlertEvent }) {
  const values = Object.entries(event.snapshot)
    .filter(([key]) => !key.startsWith("const:"))
    .map(([, v]) => (typeof v === "number" ? v.toFixed(2) : "--"));

  return (
    <span
      className="inline-flex items-center gap-1.5 font-bold tracking-wide"
      style={{
        backgroundColor: "#003844",
        color: "#33DDFF",
        fontSize: 9.5,
        padding: "1px 7px",
      }}
    >
      <span style={{ fontSize: 10 }}>🔔</span>
      <span style={{ fontSize: 8, opacity: 0.75 }}>ALERT</span>
      <span>{event.symbol}</span>
      <span style={{ opacity: 0.85 }}>{ruleDisplayName(event.ruleName, event.symbol)}</span>
      {values.length > 0 && <span style={{ opacity: 0.7 }}>{values.join(" / ")}</span>}
    </span>
  );
}

function AlertSegment({ alert }: { alert: TickerAlert }) {
  // ── Stop loss — red pill ──────────────────────────────────────────────────
  if (alert.type === "stoploss" && alert.current_price != null && alert.stop_price != null) {
    const distPct = (((alert.stop_price - alert.current_price) / alert.stop_price) * 100).toFixed(
      2
    );
    return (
      <span
        className="inline-flex items-center gap-1.5 font-bold tracking-wide"
        style={{
          backgroundColor: "#CC0000",
          color: "#ffffff",
          fontSize: 9.5,
          padding: "1px 7px",
        }}
      >
        <span style={{ fontSize: 10 }}>⚑</span>
        <span style={{ fontSize: 8, opacity: 0.85 }}>STOP BREACH</span>
        <span>{alert.symbol}</span>
        <span style={{ opacity: 0.85 }}>CUR {alert.current_price.toFixed(2)}</span>
        <span style={{ opacity: 0.7 }}>SL {alert.stop_price.toFixed(2)}</span>
        <span>−{distPct}%</span>
      </span>
    );
  }

  // ── DCC correlation spike — purple/red pill ───────────────────────────────
  if (alert.type === "dcc") {
    const isCritical = alert.severity === "critical";
    return (
      <span
        className="inline-flex items-center gap-1.5 font-bold tracking-wide"
        style={{
          backgroundColor: isCritical ? "#660033" : "#441100",
          color: isCritical ? "#FF88CC" : "#FF9944",
          fontSize: 9.5,
          padding: "1px 7px",
        }}
      >
        <span style={{ fontSize: 8, opacity: 0.8 }}>CORR-SPIKE</span>
        <span>{alert.message}</span>
      </span>
    );
  }

  // ── Regime change event — amber pill ─────────────────────────────────────
  const m = alert.message.match(/REGIME:\s+(.+?)\s+[->]+\s+(.+)/);
  const label = m ? `${m[1]} -> ${m[2]}` : alert.message.replace(/^[🔴🟡⚠]\s*/u, "");

  return (
    <span
      className="inline-flex items-center gap-1.5 font-bold tracking-wide"
      style={{
        backgroundColor: "#CC6600",
        color: "#000000",
        fontSize: 9.5,
        padding: "1px 7px",
      }}
    >
      <span style={{ fontSize: 8, opacity: 0.7 }}>REGIME CHG</span>
      <span>{label}</span>
    </span>
  );
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

  if (!enabled) return null;

  const items = data?.items ?? [];
  const alerts = data?.alerts ?? [];
  const hasCritical = data?.has_critical ?? false;

  // ── Build content segments (alerts first, then market items) ───────────────
  const makeContent = () => {
    const parts: React.ReactNode[] = [];

    // Rule events lead: they're the ones the user explicitly asked to be told
    // about, unlike the standing stoploss/regime watches behind them.
    for (const event of tickerEvents) {
      parts.push(<RuleEventSegment key={`re${event.id}`} event={event} />);
      parts.push(<span key={`res${event.id}`}>{SEP}</span>);
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
  const durationSec = Math.max(30, items.length * 4 + alerts.length * 6 + tickerEvents.length * 6);

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
        <div
          className="inline-flex items-baseline whitespace-nowrap"
          style={{
            animationName: "ticker-scroll",
            animationDuration: `${durationSec}s`,
            animationTimingFunction: "linear",
            animationIterationCount: "infinite",
          }}
        >
          <span className="inline-flex items-baseline gap-0 pr-12">{content}</span>
          <span className="inline-flex items-baseline gap-0 pr-12">{content}</span>
        </div>
      </div>
    </div>
  );
}
