"use client";

import { Moon, Sun, Sunrise, Sunset } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface SessionConfig {
  label: string;
  short: string;
  /**
   * Session icon for dense rows where even the 3-letter code costs too much
   * width. The sunrise → sun → sunset → moon progression is the convention
   * broker and quote apps settled on: it reads as a position in the trading
   * day rather than as a status light, which is what a session actually is.
   */
  Icon: LucideIcon;
  color: string;
  bg: string;
}

// Yahoo's marketState distinguishes sessions that are TRADING from the dead
// stretches around them, and the two must not share a label:
//   PRE      pre-market is open        (04:00–09:30 ET)
//   PREPRE   overnight, nothing trades (20:00–04:00 ET)
//   POST     after-hours is open       (16:00–20:00 ET)
//   POSTPOST after-hours has ended     (from 20:00 ET)
// Labelling PREPRE "PRE-MARKET" told users the market was pre-trading at 07:00
// Bangkok — hours before it actually is — next to a price frozen at the last
// close. The closed states now say so.
const SESSION_CONFIG: Record<string, SessionConfig> = {
  PRE: { label: "PRE-MARKET", short: "PRE", Icon: Sunrise, color: "#f59e0b", bg: "#f59e0b22" },
  PREPRE: { label: "CLOSED", short: "CLOSED", Icon: Moon, color: "#6b7280", bg: "#6b728022" },
  REGULAR: { label: "MARKET OPEN", short: "OPEN", Icon: Sun, color: "#22c55e", bg: "#22c55e22" },
  POST: { label: "AFTER-HOURS", short: "AH", Icon: Sunset, color: "#818cf8", bg: "#818cf822" },
  POSTPOST: { label: "CLOSED", short: "CLOSED", Icon: Moon, color: "#6b7280", bg: "#6b728022" },
  CLOSED: { label: "CLOSED", short: "CLOSED", Icon: Moon, color: "#6b7280", bg: "#6b728022" },
};

/** Shape of the session fields on a quote, as returned by /api/stock?type=quote. */
export interface SessionQuote {
  marketState?: string | null;
  preMarketPrice?: number | null;
  preMarketChange?: number | null;
  preMarketChangePercent?: number | null;
  postMarketPrice?: number | null;
  postMarketChange?: number | null;
  postMarketChangePercent?: number | null;
  regularMarketPrice?: number | null;
  /** Exchange-local date the regular quote was last traded, "YYYY-MM-DD" */
  quoteDate?: string | null;
  /** False when that date is not the exchange's today — the move is a past session's */
  isCurrentSession?: boolean | null;
}

/** Short weekday tag for a "YYYY-MM-DD", e.g. "Fri" — used to date a stale move. */
export function sessionDayTag(quoteDate: string | null | undefined): string | null {
  if (!quoteDate) return null;
  const d = new Date(`${quoteDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

/**
 * How to render a regular-session change that may not be today's.
 *
 * Returns null while the quote IS current, so callers keep their normal styling
 * and pay nothing for the common case.
 */
export function staleMoveStyle(
  quote:
    | {
        quoteDate?: string | null;
        isCurrentSession?: boolean | null;
      }
    | null
    | undefined
): { opacity: number; tag: string | null; title: string } | null {
  if (!quote || quote.isCurrentSession !== false) return null;
  const tag = sessionDayTag(quote.quoteDate);
  return {
    // Dimmed rather than hidden: the last close is still the most recent fact
    // about the instrument, it just is not today's move.
    opacity: 0.45,
    tag,
    title: `Last traded ${quote.quoteDate ?? "before today"} — this is that session's move, not today's`,
  };
}

export function sessionConfig(state: string | null | undefined): SessionConfig | null {
  if (!state) return null;
  return SESSION_CONFIG[state] ?? SESSION_CONFIG.CLOSED;
}

/**
 * The price and move that are actually live right now.
 *
 * During pre/after-hours the regular-session numbers are yesterday's news —
 * frozen at the close — while the number still ticking is the extended-hours
 * one. Returns null when there is nothing extended to show (regular session,
 * or a venue like SET that has no pre/post concept), so callers fall back to
 * the regular fields.
 */
export function extendedSessionMove(quote: SessionQuote | null | undefined): {
  price: number;
  change: number | null;
  pct: number | null;
  Icon: LucideIcon;
  /** Short tag ("PRE"/"AH") — prefer this when a SessionGlyph is already nearby. */
  short: string;
  label: string;
} | null {
  const state = quote?.marketState;
  const cfg = sessionConfig(state);
  if (!quote || !cfg) return null;
  // Only the states that are actually TRADING. PREPRE/POSTPOST are the closed
  // stretches either side; their prices are the last print of a session that
  // has ended, so callers fall through to the regular fields (which carry an
  // isCurrentSession flag of their own).
  if (state === "PRE" && quote.preMarketPrice != null) {
    return {
      price: quote.preMarketPrice,
      change: quote.preMarketChange ?? null,
      pct: quote.preMarketChangePercent ?? null,
      Icon: cfg.Icon,
      short: cfg.short,
      label: cfg.label,
    };
  }
  if (state === "POST" && quote.postMarketPrice != null) {
    return {
      price: quote.postMarketPrice,
      change: quote.postMarketChange ?? null,
      pct: quote.postMarketChangePercent ?? null,
      Icon: cfg.Icon,
      short: cfg.short,
      label: cfg.label,
    };
  }
  return null;
}

/**
 * @param compact drop the letter-spacing and use the short label. Worth ~55px,
 *   which is the difference between a toolbar row that fits and one that
 *   overflows in a narrow panel. The full label stays in the tooltip.
 */
export function MarketSessionBadge({
  state,
  compact = false,
}: { state: string | null | undefined; compact?: boolean }) {
  if (!state) return null;
  const cfg = SESSION_CONFIG[state] ?? SESSION_CONFIG.CLOSED;
  return (
    <span
      title={cfg.label}
      className={`inline-flex shrink-0 whitespace-nowrap items-center gap-1 py-0.5 text-[9px] font-bold font-mono border ${
        compact ? "px-1" : "px-2 tracking-widest"
      }`}
      style={{ color: cfg.color, backgroundColor: cfg.bg, borderColor: `${cfg.color}44` }}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          backgroundColor: cfg.color,
          animation: state === "REGULAR" ? "pulse 2s infinite" : undefined,
        }}
      />
      {compact ? cfg.short : cfg.label}
    </span>
  );
}

/**
 * Session as a single icon, for table rows that cannot spare a badge.
 *
 * Hover gives the full label, so nothing is lost by compressing to a glyph.
 * Unlike a coloured dot it stays legible for colour-blind readers and in a
 * screenshot, since the shape carries the meaning on its own.
 */
export function SessionGlyph({
  state,
  className = "",
}: { state: string | null | undefined; className?: string }) {
  const cfg = sessionConfig(state);
  if (!cfg) return null;
  const { Icon } = cfg;
  return (
    <Icon
      className={`inline-block shrink-0 h-2.5 w-2.5 align-[-1px] ${className}`}
      style={{ color: cfg.color }}
      aria-label={cfg.label}
    >
      <title>{cfg.label}</title>
    </Icon>
  );
}

/**
 * @param hideLabel drop the leading PRE/AH tag. Set it when a MarketSessionBadge
 *   sits alongside, which already names the session — otherwise the row reads
 *   "PRE  PRE $52,610".
 */
export function ExtendedHoursPrice({
  quote,
  positiveColor = "#22c55e",
  negativeColor = "#ef4444",
  hideLabel = false,
}: {
  quote: SessionQuote | null | undefined;
  positiveColor?: string;
  negativeColor?: string;
  hideLabel?: boolean;
}) {
  const state = quote?.marketState;
  // min-w-0/overflow-hidden so a long value clips instead of forcing the parent
  // toolbar row wider; whitespace-nowrap so it never wraps to a second line.
  const cls =
    "flex items-center gap-2 text-[10px] font-mono whitespace-nowrap min-w-0 overflow-hidden";
  if (state === "PRE" && quote?.preMarketPrice) {
    const pct = quote.preMarketChangePercent ?? 0;
    const chg = quote.preMarketChange ?? 0;
    return (
      <div className={cls}>
        {!hideLabel && <span style={{ color: "#f59e0b" }}>PRE</span>}
        <span className="font-bold">${quote.preMarketPrice.toFixed(2)}</span>
        <span style={{ color: chg >= 0 ? positiveColor : negativeColor }}>
          {chg >= 0 ? "+" : ""}
          {chg.toFixed(2)} ({pct >= 0 ? "+" : ""}
          {pct.toFixed(2)}%)
        </span>
      </div>
    );
  }
  if (state === "POST" && quote?.postMarketPrice) {
    const pct = quote.postMarketChangePercent ?? 0;
    const chg = quote.postMarketChange ?? 0;
    return (
      <div className={cls}>
        {!hideLabel && <span style={{ color: "#818cf8" }}>AH</span>}
        <span className="font-bold">${quote.postMarketPrice.toFixed(2)}</span>
        <span style={{ color: chg >= 0 ? positiveColor : negativeColor }}>
          {chg >= 0 ? "+" : ""}
          {chg.toFixed(2)} ({pct >= 0 ? "+" : ""}
          {pct.toFixed(2)}%)
        </span>
      </div>
    );
  }
  return null;
}
