"use client";

/**
 * EventDetailPopover — the detail card behind a chart event marker.
 *
 * Rail chips carry only a short label; the numbers live here, along with the
 * fields the API already returned but nothing ever displayed (EPS estimate vs
 * reported) and the price reaction derived from the loaded OHLCV.
 *
 * Takes the whole list of markers near the click, because chips that collide on
 * the rail are drawn as one cluster — showing only the nearest would quietly
 * hide the rest. With more than one, the card opens on the list.
 */

import { Banknote, ChevronLeft, Clock, Split, TrendingDown, TrendingUp, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EventIconName } from "./event-icons.ts";
import { eventChipStyle } from "./event-rail-overlay";
import { computeEventReaction, earningsSession } from "./event-reaction";
import type { ChartColors, ChartEventMarker, OhlcvBar } from "./types";

export interface EventDetailPopoverProps {
  /** Markers near the click, nearest first. Never empty. */
  markers: ChartEventMarker[];
  /** Click position in viewport coordinates. */
  anchor: { x: number; y: number };
  /** Bars currently on the chart — the reaction is measured against these. */
  data: OhlcvBar[];
  colors: ChartColors;
  symbol: string | null;
  onClose: () => void;
}

const CARD_WIDTH = 232;
/** Keep the card clear of the click so it never lands under the cursor. */
const OFFSET = 12;
const VIEWPORT_MARGIN = 8;

/**
 * The DOM twin of the rail's canvas icons.
 *
 * The rail cannot use React components — it paints on the chart's own canvas —
 * so the two sets are drawn from different code. Keeping them keyed off the same
 * `EventIconName` is what stops them drifting into two different vocabularies
 * for the same event.
 */
const ICON: Record<EventIconName, typeof Banknote> = {
  cash: Banknote,
  arrowUp: TrendingUp,
  arrowDown: TrendingDown,
  clock: Clock,
  split: Split,
};

const TYPE_TITLE: Record<ChartEventMarker["type"], string> = {
  dividend: "DIVIDEND",
  earnings: "EARNINGS",
  split: "SPLIT",
};

function fmtPct(v: number | null, colors: ChartColors) {
  if (v == null) return { text: "—", color: colors.textSecondary };
  return {
    text: `${v > 0 ? "+" : ""}${v.toFixed(2)}%`,
    color: v > 0 ? colors.positive : v < 0 ? colors.negative : colors.textSecondary,
  };
}

function Row({
  label,
  value,
  valueColor,
  colors,
}: {
  label: string;
  value: string;
  valueColor?: string;
  colors: ChartColors;
}) {
  return (
    <div className="flex justify-between gap-3 leading-[14px]">
      <span style={{ color: colors.textSecondary }}>{label}</span>
      <span style={{ color: valueColor ?? colors.text }}>{value}</span>
    </div>
  );
}

export function EventDetailPopover({
  markers,
  anchor,
  data,
  colors,
  symbol,
  onClose,
}: EventDetailPopoverProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Which of a clustered set is being shown in detail. `null` means the list is
  // showing; a single-marker click skips the list entirely.
  const [picked, setPicked] = useState<number | null>(markers.length === 1 ? 0 : null);
  // Placed after mount so the real height can be measured — a card opened near
  // the bottom of the chart would otherwise hang off the viewport.
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: anchor.x + OFFSET,
    top: anchor.y + OFFSET,
  });

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left = anchor.x + OFFSET;
    let top = anchor.y + OFFSET;
    if (left + width > window.innerWidth - VIEWPORT_MARGIN) left = anchor.x - width - OFFSET;
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) top = anchor.y - height - OFFSET;
    setPos({
      left: Math.max(VIEWPORT_MARGIN, left),
      top: Math.max(VIEWPORT_MARGIN, top),
    });
  }, [anchor.x, anchor.y]);

  // Escape and any click outside dismiss the card. The outside listener is
  // registered on the next frame: the click that opened this card is still
  // propagating, and catching it would close the card in the same tick.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    const frame = requestAnimationFrame(() => window.addEventListener("mousedown", onDown));
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  // Re-measure whenever the card swaps between the list and a detail view — the
  // two are different heights, and a card near the bottom edge would otherwise
  // grow off-screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `picked` changes the measured height, which is what this repositions for
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const { height } = el.getBoundingClientRect();
    setPos((p) => ({
      ...p,
      top: Math.max(
        VIEWPORT_MARGIN,
        Math.min(p.top, window.innerHeight - height - VIEWPORT_MARGIN)
      ),
    }));
  }, [picked]);

  const fmtDate = (m: ChartEventMarker) =>
    typeof m.time === "string" ? m.time.slice(0, 10) : String(m.time);

  // ── Cluster list ──
  if (picked === null) {
    return (
      <div
        ref={cardRef}
        className="fixed z-50 font-mono text-[9px] shadow-lg"
        style={{
          left: pos.left,
          top: pos.top,
          width: CARD_WIDTH,
          background: colors.surface,
          border: `1px solid ${colors.border}`,
        }}
      >
        <div
          className="flex items-center justify-between px-1.5 py-1"
          style={{ borderBottom: `1px solid ${colors.border}` }}
        >
          <span className="font-bold tracking-wide" style={{ color: colors.text }}>
            {markers.length} EVENTS
            {symbol ? <span style={{ color: colors.textSecondary }}> · {symbol}</span> : null}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close event detail"
            style={{ color: colors.textSecondary }}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
        <div className="py-0.5">
          {markers.map((m, i) => {
            const chip = eventChipStyle(m);
            const Icon = ICON[chip.icon];
            return (
              <button
                key={`${m.type}-${String(m.time)}`}
                type="button"
                className="flex w-full items-center gap-2 px-1.5 py-0.5 text-left hover:bg-white/5"
                onClick={() => setPicked(i)}
              >
                <span
                  className="flex w-6 shrink-0 items-center gap-0.5 font-bold"
                  style={{ color: chip.color }}
                  title={chip.label}
                >
                  <Icon className="h-2.5 w-2.5" aria-label={chip.label} />
                </span>
                <span className="shrink-0" style={{ color: colors.text }}>
                  {fmtDate(m)}
                </span>
                <span className="truncate" style={{ color: colors.textSecondary }}>
                  {m.detail ?? TYPE_TITLE[m.type]}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const marker = markers[picked];
  const reaction = computeEventReaction(data, marker);
  const dateStr = fmtDate(marker);
  const session = marker.type === "earnings" ? earningsSession(marker.reportedAt) : "UNKNOWN";

  const beat = marker.surprise != null && marker.surprise >= 0;
  // Mirrors the marker palette in ModularChart: an upcoming report is neutral
  // orange, not the split purple a plain type check would fall through to.
  const accent =
    marker.type === "dividend"
      ? "#4fc3f7"
      : marker.type === "split"
        ? "#ce93d8"
        : marker.surprise == null
          ? "#ffb74d"
          : beat
            ? colors.positive
            : colors.negative;

  // An after-close report moves the following bar, so say which bar the numbers
  // below are actually measuring rather than silently shifting the window.
  const reactionLabel =
    session === "AMC"
      ? "REACTION (AMC → next bar)"
      : session === "BMO"
        ? "REACTION (BMO)"
        : "REACTION";

  const divYield =
    marker.type === "dividend" && marker.dividend != null && reaction.closeOnEvent
      ? (marker.dividend / reaction.closeOnEvent) * 100
      : null;

  return (
    <div
      ref={cardRef}
      className="fixed z-50 font-mono text-[9px] shadow-lg"
      style={{
        left: pos.left,
        top: pos.top,
        width: CARD_WIDTH,
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderLeft: `2px solid ${accent}`,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-1.5 py-1"
        style={{ borderBottom: `1px solid ${colors.border}` }}
      >
        <span className="flex items-center gap-1 font-bold tracking-wide" style={{ color: accent }}>
          {markers.length > 1 && (
            <button
              type="button"
              onClick={() => setPicked(null)}
              aria-label="Back to event list"
              style={{ color: colors.textSecondary }}
            >
              <ChevronLeft className="h-2.5 w-2.5" />
            </button>
          )}
          {TYPE_TITLE[marker.type]}
          {marker.upcoming ? <span style={{ color: colors.textSecondary }}>· UPCOMING</span> : null}
          {symbol ? <span style={{ color: colors.textSecondary }}> · {symbol}</span> : null}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close event detail"
          style={{ color: colors.textSecondary }}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </div>

      <div className="px-1.5 py-1 space-y-0.5">
        <Row
          label={marker.upcoming && marker.type === "dividend" ? "EX-DATE" : "DATE"}
          value={dateStr}
          colors={colors}
        />
        {marker.upcoming && marker.payDate ? (
          <Row label="PAY DATE" value={marker.payDate} colors={colors} />
        ) : null}

        {marker.type === "earnings" && (
          <>
            <Row
              label="EST"
              value={marker.epsEstimate != null ? marker.epsEstimate.toFixed(2) : "—"}
              colors={colors}
            />
            <Row
              label="ACTUAL"
              value={marker.reportedEPS != null ? marker.reportedEPS.toFixed(2) : "not reported"}
              colors={colors}
            />
            {marker.surprise != null && (
              <Row
                label="SURPRISE"
                value={`${marker.surprise > 0 ? "+" : ""}${marker.surprise.toFixed(2)}%  ${beat ? "BEAT" : "MISS"}`}
                valueColor={beat ? colors.positive : colors.negative}
                colors={colors}
              />
            )}
          </>
        )}

        {marker.type === "dividend" && (
          <>
            <Row
              label="AMOUNT"
              value={
                marker.dividend != null
                  ? `${marker.dividend.toFixed(4)}${marker.estimated ? " est" : ""}`
                  : "—"
              }
              colors={colors}
            />
            <Row
              label="YIELD"
              value={divYield != null ? `${divYield.toFixed(2)}%` : "—"}
              colors={colors}
            />
          </>
        )}

        {marker.type === "split" && (
          <Row
            label="RATIO"
            value={marker.splitRatio != null ? `${marker.splitRatio}:1` : "—"}
            colors={colors}
          />
        )}
      </div>

      <div className="px-1.5 py-1 space-y-0.5" style={{ borderTop: `1px solid ${colors.border}` }}>
        {marker.upcoming ? (
          // No bar exists for a date the market has not reached, so every
          // reaction figure would be an em dash. Say why instead of showing four
          // blanks that read like missing data.
          <div style={{ color: colors.textSecondary }}>
            Scheduled — no price reaction yet
            {marker.estimated ? "; amount carried from the last payment" : ""}
          </div>
        ) : (
          <>
            <div className="tracking-wide" style={{ color: colors.textSecondary }}>
              {reactionLabel}
            </div>
            {(
              [
                ["gap", reaction.gapPct],
                ["close", reaction.sameDayPct],
                ["D+1", reaction.nextDayPct],
                ["D+5", reaction.fiveDayPct],
              ] as const
            ).map(([label, value]) => {
              const f = fmtPct(value, colors);
              return (
                <Row
                  key={label}
                  label={label}
                  value={f.text}
                  valueColor={f.color}
                  colors={colors}
                />
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
