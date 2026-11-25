"use client";

import { PRICE_RANGE_UP } from "./indicators/price-range";

interface PriceRangeControlsProps {
  armed: boolean;
  /** First point placed, waiting for the second. */
  pending: boolean;
  /** A finished measurement is on the chart. */
  shown: boolean;
  onToggle: () => void;
  border: string;
  muted: string;
}

/** Ruler — the "measure" glyph. */
function RulerIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="block">
      <rect
        x="0.8"
        y="3"
        width="8.4"
        height="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <line x1="2.8" y1="3" x2="2.8" y2="5" stroke="currentColor" strokeWidth="0.9" />
      <line x1="5" y1="3" x2="5" y2="5.6" stroke="currentColor" strokeWidth="0.9" />
      <line x1="7.2" y1="3" x2="7.2" y2="5" stroke="currentColor" strokeWidth="0.9" />
    </svg>
  );
}

/** Price Range / measure: click a start and an end, read Δprice, Δ% and bars. */
export function PriceRangeControls({
  armed,
  pending,
  shown,
  onToggle,
  border,
  muted,
}: PriceRangeControlsProps) {
  const active = armed || shown;
  return (
    <button
      type="button"
      className="flex shrink-0 items-center gap-0.5 whitespace-nowrap border px-1 py-0 font-mono text-[8px] font-normal"
      style={{
        borderColor: armed ? PRICE_RANGE_UP : border,
        color: active ? PRICE_RANGE_UP : muted,
        background: armed ? `${PRICE_RANGE_UP}22` : "transparent",
      }}
      title={
        armed
          ? pending
            ? "Click where the move ends — click here to cancel"
            : "Click where the move starts on the price pane — click here to cancel"
          : shown
            ? "Clear the measurement (or click the chart / Esc)"
            : "Price Range: click two points to measure the change in price, % and bars. Not saved"
      }
      aria-label="Measure price range"
      aria-pressed={armed}
      onClick={onToggle}
    >
      <RulerIcon />
      {armed ? (pending ? "2/2" : "1/2") : "%"}
    </button>
  );
}
