"use client";

const SESSION_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  PRE:      { label: "PRE-MARKET",  color: "#f59e0b", bg: "#f59e0b22" },
  PREPRE:   { label: "PRE-MARKET",  color: "#f59e0b", bg: "#f59e0b22" },
  REGULAR:  { label: "MARKET OPEN", color: "#22c55e", bg: "#22c55e22" },
  POST:     { label: "AFTER-HOURS", color: "#818cf8", bg: "#818cf822" },
  POSTPOST: { label: "AFTER-HOURS", color: "#818cf8", bg: "#818cf822" },
  CLOSED:   { label: "CLOSED",      color: "#6b7280", bg: "#6b728022" },
};

export function MarketSessionBadge({ state }: { state: string | null | undefined }) {
  if (!state) return null;
  const cfg = SESSION_CONFIG[state] ?? SESSION_CONFIG.CLOSED;
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold font-mono tracking-widest border"
      style={{ color: cfg.color, backgroundColor: cfg.bg, borderColor: cfg.color + "44" }}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          backgroundColor: cfg.color,
          animation: state === "REGULAR" ? "pulse 2s infinite" : undefined,
        }}
      />
      {cfg.label}
    </span>
  );
}

export function ExtendedHoursPrice({
  quote,
  positiveColor = "#22c55e",
  negativeColor = "#ef4444",
}: {
  quote: any;
  positiveColor?: string;
  negativeColor?: string;
}) {
  const state = quote?.marketState;
  if ((state === "PRE" || state === "PREPRE") && quote?.preMarketPrice) {
    const pct = quote.preMarketChangePercent ?? 0;
    const chg = quote.preMarketChange ?? 0;
    return (
      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5">
        <span style={{ color: "#f59e0b" }}>PRE</span>
        <span className="font-bold">${quote.preMarketPrice.toFixed(2)}</span>
        <span style={{ color: chg >= 0 ? positiveColor : negativeColor }}>
          {chg >= 0 ? "+" : ""}{chg.toFixed(2)} ({pct >= 0 ? "+" : ""}{pct.toFixed(2)}%)
        </span>
      </div>
    );
  }
  if ((state === "POST" || state === "POSTPOST") && quote?.postMarketPrice) {
    const pct = quote.postMarketChangePercent ?? 0;
    const chg = quote.postMarketChange ?? 0;
    return (
      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5">
        <span style={{ color: "#818cf8" }}>AH</span>
        <span className="font-bold">${quote.postMarketPrice.toFixed(2)}</span>
        <span style={{ color: chg >= 0 ? positiveColor : negativeColor }}>
          {chg >= 0 ? "+" : ""}{chg.toFixed(2)} ({pct >= 0 ? "+" : ""}{pct.toFixed(2)}%)
        </span>
      </div>
    );
  }
  return null;
}
