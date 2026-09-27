"use client";

import { TREND_LINE_COLOR } from "./indicators/trend-line";

interface TrendLineControlsProps {
  count: number;
  armed: boolean;
  pending: boolean;
  onToggle: () => void;
  onUndo: () => void;
  onClear: () => void;
  border: string;
  muted: string;
}

/** Diagonal segment with a dot at each end — the "draw a line" glyph. */
function LineIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="block">
      <line x1="1.5" y1="8.5" x2="8.5" y2="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="1.5" cy="8.5" r="1.2" fill="currentColor" />
      <circle cx="8.5" cy="1.5" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function TrendLineControls({
  count,
  armed,
  pending,
  onToggle,
  onUndo,
  onClear,
  border,
  muted,
}: TrendLineControlsProps) {
  const active = armed || count > 0;
  return (
    <div className="flex shrink-0 items-center gap-0.5 whitespace-nowrap font-mono text-[8px]">
      <button
        type="button"
        className="flex shrink-0 items-center gap-0.5 border px-1 py-0 font-normal"
        style={{
          borderColor: armed ? TREND_LINE_COLOR : border,
          color: active ? TREND_LINE_COLOR : muted,
          background: armed ? `${TREND_LINE_COLOR}22` : "transparent",
        }}
        title={
          armed
            ? pending
              ? "Click the second point (hold Shift for a horizontal line) — click here to cancel"
              : "Click the first point on the price pane — click here to cancel"
            : "Trend line: click two points on the chart (Shift on the 2nd = horizontal)"
        }
        aria-label="Draw trend line"
        aria-pressed={armed}
        onClick={onToggle}
      >
        <LineIcon />
        {/* Reserved width, so arming never reflows the toolbar (and resizes the chart). */}
        <span className="inline-block text-left" style={{ minWidth: "3ch" }}>
          {armed ? (pending ? "2/2" : "1/2") : count > 0 ? count : ""}
        </span>
      </button>
      {/* Always laid out (hidden when empty) so the first line never reflows the toolbar. */}
      <button
        type="button"
        className="shrink-0 border px-0.5 py-0"
        style={{ borderColor: border, color: muted, visibility: count > 0 ? "visible" : "hidden" }}
        title="Remove the last trend line"
        aria-label="Remove the last trend line"
        disabled={count === 0}
        onClick={onUndo}
      >
        ↶
      </button>
      <button
        type="button"
        className="shrink-0 border px-0.5 py-0"
        style={{ borderColor: border, color: muted, visibility: count > 0 ? "visible" : "hidden" }}
        title="Remove all trend lines on this chart"
        aria-label="Remove all trend lines on this chart"
        disabled={count === 0}
        onClick={onClear}
      >
        ×
      </button>
    </div>
  );
}
