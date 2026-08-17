"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import {
  type PredictionEvent,
  type PredictionStrike,
  probColor,
  useStockPrediction,
} from "../../hooks/useStockPredictions";
import { fmtEndDate, fmtVol } from "./helpers";
import type { ThemeColors } from "./types";

function pct(p: number | null | undefined): string {
  return p == null ? "—" : `${Math.round(p * 100)}%`;
}

function price(n: number | null | undefined): string {
  if (n == null) return "—";
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2);
}

const TYPE_LABEL: Record<string, string> = {
  above: "CLOSE ABOVE",
  ladder: "TOUCH LADDER",
  updown: "UP / DOWN",
  earnings: "EARNINGS",
  other: "MARKET",
};

/** One rung: strike, probability bar, and where spot sits relative to it. */
function StrikeRow({
  strike,
  spot,
  colors,
}: {
  strike: PredictionStrike;
  spot: number | null;
  colors: ThemeColors;
}) {
  const above = spot != null && strike.strike > spot;
  const clr = probColor(strike.prob);
  return (
    <div className="flex items-center gap-1.5 px-2 py-[3px]">
      <span
        className="text-[9px] font-mono w-[52px] shrink-0 text-right"
        style={{ color: above ? "#4ade80" : "#f87171", opacity: 0.9 }}
      >
        {above ? "▲" : "▼"} {price(strike.strike)}
      </span>
      <div className="flex-1 h-1 rounded-sm min-w-0" style={{ backgroundColor: "#1a1a1a" }}>
        <div
          className="h-full rounded-sm"
          style={{ width: `${Math.min(100, strike.prob * 100)}%`, backgroundColor: clr }}
        />
      </div>
      <span
        className="text-[9px] font-mono font-bold w-7 text-right shrink-0"
        style={{ color: clr }}
      >
        {pct(strike.prob)}
      </span>
    </div>
  );
}

function EventBlock({
  event,
  spot,
  colors,
}: {
  event: PredictionEvent;
  spot: number | null;
  colors: ThemeColors;
}) {
  // Rungs already resolved (prob ≥ 0.98 / ≤ 0.02) price nothing — drop them so the
  // ladder shows only the live part of the distribution.
  const live = event.strikes.filter((s) => s.prob > 0.02 && s.prob < 0.98);
  const shown = (live.length ? live : event.strikes).slice(0, 10);

  return (
    <div className="border-b" style={{ borderColor: colors.border }}>
      <a
        href={event.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 px-2 py-1 hover:bg-[#111] group"
      >
        <span className="text-[8px] font-bold font-mono" style={{ color: colors.accent }}>
          {TYPE_LABEL[event.type] ?? "MARKET"}
        </span>
        <span className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
          {event.days_left != null ? `${event.days_left}d` : ""}
          {event.end_date ? ` · ${fmtEndDate(event.end_date)}` : ""}
        </span>
        <span
          className="text-[8px] font-mono ml-auto shrink-0"
          style={{ color: colors.textSecondary }}
        >
          {fmtVol(event.volume)}
        </span>
        <ExternalLink
          className="h-2 w-2 opacity-0 group-hover:opacity-40"
          style={{ color: colors.textSecondary }}
        />
      </a>

      {event.type === "updown" && event.prob_up != null ? (
        <div className="px-2 pb-1.5">
          <div className="flex items-center gap-2">
            <span
              className="text-[11px] font-bold font-mono"
              style={{ color: probColor(event.prob_up) }}
            >
              {pct(event.prob_up)}
            </span>
            <span className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
              closes UP today
            </span>
          </div>
        </div>
      ) : (
        <div className="pb-1">
          {shown.map((s) => (
            <StrikeRow key={s.slug || s.label} strike={s} spot={spot} colors={colors} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Market-implied view for one ticker: what Polymarket is charging right now for
 * this stock finishing above a level, or trading through it before expiry.
 */
export function PredictionLadder({
  symbol,
  company,
  colors,
}: {
  symbol: string;
  company?: string;
  colors: ThemeColors;
}) {
  const { data, isFetching } = useStockPrediction(symbol, company ?? "");
  const summary = data?.summary;
  const events = data?.events ?? [];

  if (!isFetching && events.length === 0) return null;

  return (
    <div className="border-b" style={{ borderColor: colors.border }}>
      <div
        className="sticky top-0 z-10 flex items-center gap-1 px-2 py-1 border-b"
        style={{ backgroundColor: colors.surface, borderColor: colors.border }}
      >
        <span
          className="text-[8px] font-bold font-mono tracking-widest"
          style={{ color: colors.accent }}
        >
          {symbol} IMPLIED
        </span>
        {data?.spot != null && (
          <span className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
            spot {price(data.spot)}
          </span>
        )}
        {isFetching && (
          <RefreshCw
            className="h-2.5 w-2.5 animate-spin ml-auto"
            style={{ color: colors.accent }}
          />
        )}
      </div>

      {/* Decision line: probability up, the levels either side, and the tilt */}
      {summary && (
        <div className="px-2 py-1.5 flex flex-col gap-1">
          <div className="flex items-baseline gap-1.5">
            <span
              className="text-[15px] font-bold font-mono leading-none"
              style={{ color: probColor(summary.prob_up) }}
            >
              {pct(summary.prob_up)}
            </span>
            <span className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
              {summary.prob_up_source === "updown"
                ? "closes up today"
                : summary.prob_up_source === "cdf"
                  ? "closes above spot"
                  : summary.nearest_up
                    ? `trades ${price(summary.nearest_up.strike)}`
                    : "implied up"}
            </span>
            {summary.horizon_days != null && (
              <span
                className="text-[8px] font-mono ml-auto"
                style={{ color: colors.textSecondary }}
              >
                {summary.horizon_days}d
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 text-[8px] font-mono">
            <span style={{ color: "#4ade80" }}>
              ▲ {price(summary.nearest_up?.strike ?? summary.implied_high)}{" "}
              {pct(summary.nearest_up?.prob)}
            </span>
            <span style={{ color: "#f87171" }}>
              ▼ {price(summary.nearest_down?.strike ?? summary.implied_low)}{" "}
              {pct(
                summary.nearest_down
                  ? summary.nearest_down.basis === "close"
                    ? 1 - summary.nearest_down.prob
                    : summary.nearest_down.prob
                  : null
              )}
            </span>
            {summary.skew != null && (
              <span
                className="ml-auto"
                style={{ color: summary.skew > 0 ? "#4ade80" : "#f87171" }}
                title="upside probability minus downside probability"
              >
                SKEW {summary.skew > 0 ? "+" : ""}
                {(summary.skew * 100).toFixed(0)}pp
              </span>
            )}
          </div>
        </div>
      )}

      {events.map((e) => (
        <EventBlock key={e.slug} event={e} spot={data?.spot ?? null} colors={colors} />
      ))}
    </div>
  );
}
