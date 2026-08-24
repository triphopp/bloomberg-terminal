"use client";

/**
 * TimeframeRow — the MKT chart's period + bar-interval control, shared.
 *
 * Period and interval are the same "what timeframe" decision, so they share one
 * row that never wraps; the interval collapses into a dropdown because nine
 * spelled-out buttons were what forced this row onto a second line.
 *
 * This is the control the MKT panel uses, extracted so a popped-out chart gets
 * the identical one instead of a second, differently-shaped timeframe bar.
 */

import { Check, ChevronDown } from "lucide-react";
import type { bloombergColors } from "../lib/theme-config";
import type { BarInterval, TimePeriod } from "./types";
import { INTERVAL_DEFAULT_RANGE, INTERVAL_VALID_RANGES } from "./types";
import { useAnchoredPanel } from "./useAnchoredPanel";
import { BAR_INTERVALS, INTERVAL_LABEL, PERIOD_LABEL, TIME_PERIODS } from "./useChartTimeframe";

type Colors = typeof bloombergColors.dark;

/**
 * Bar interval as a dropdown rather than nine inline buttons.
 *
 * Intervals that don't cover the selected period are still listed, marked with
 * the range they'd switch to — picking one is legal (the interval handler moves
 * the period to a valid one), so hiding them would obscure a working path.
 */
export function IntervalPicker({
  colors,
  barInterval,
  timePeriod,
  onChange,
}: {
  colors: Colors;
  barInterval: BarInterval;
  timePeriod: TimePeriod;
  onChange: (iv: BarInterval) => void;
}) {
  const { open, setOpen, toggle, pos, wrapRef, triggerRef } = useAnchoredPanel();

  return (
    <div
      className="shrink-0 ml-2 pl-2 flex items-center gap-1"
      style={{ borderLeft: `1px solid ${colors.border}` }}
      ref={wrapRef}
    >
      <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
        TF
      </span>
      <button
        ref={triggerRef}
        type="button"
        className="flex items-center gap-0.5 text-[9px] font-bold font-mono px-1.5 py-0.5 border transition-colors"
        style={{
          borderColor: colors.accent,
          backgroundColor: `${colors.accent}22`,
          color: colors.accent,
        }}
        onClick={toggle}
        title="Bar interval"
      >
        {INTERVAL_LABEL[barInterval]}
        <ChevronDown className="h-2.5 w-2.5" />
      </button>
      {open && pos && (
        <div
          className="fixed z-50 border min-w-[110px]"
          style={{
            left: pos.left,
            top: pos.top,
            background: colors.surface,
            borderColor: colors.border,
          }}
        >
          {BAR_INTERVALS.map((iv) => {
            const active = barInterval === iv;
            const fitsPeriod = INTERVAL_VALID_RANGES[iv].includes(timePeriod);
            return (
              <button
                key={iv}
                type="button"
                className="w-full flex items-center justify-between gap-2 px-2 py-1 text-[9px] font-mono border-b hover:opacity-70"
                style={{
                  borderColor: `${colors.border}44`,
                  color: active ? colors.accent : colors.text,
                  background: active ? `${colors.accent}14` : "transparent",
                }}
                onClick={() => {
                  onChange(iv);
                  setOpen(false);
                }}
              >
                <span className="font-bold">{INTERVAL_LABEL[iv]}</span>
                {!fitsPeriod && (
                  <span className="text-[8px] opacity-40">
                    →{PERIOD_LABEL[INTERVAL_DEFAULT_RANGE[iv]]}
                  </span>
                )}
                {active && <Check className="h-2.5 w-2.5" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface TimeframeRowProps {
  colors: Colors;
  timePeriod: TimePeriod;
  barInterval: BarInterval;
  /** Area charts have no bars, so the interval picker is hidden for them. */
  chartType?: "area" | "candle";
  onPeriodChange: (p: TimePeriod) => void;
  onIntervalChange: (iv: BarInterval) => void;
  /** Rendered at the right end of the row (chart-type toggle, window buttons…). */
  trailing?: React.ReactNode;
}

export function TimeframeRow({
  colors,
  timePeriod,
  barInterval,
  chartType = "candle",
  onPeriodChange,
  onIntervalChange,
  trailing,
}: TimeframeRowProps) {
  return (
    // Scrollbar hidden rather than thin: a classic scrollbar adds ~13px of
    // height, which would re-create the very second row this merge removed.
    <div
      className="flex flex-nowrap items-center gap-0 px-1 py-0.5 shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ background: "#050505", borderBottom: `1px solid ${colors.border}` }}
    >
      {TIME_PERIODS.map((p) => {
        const active = p === timePeriod;
        const validRanges = chartType === "candle" ? INTERVAL_VALID_RANGES[barInterval] : null;
        const disabled = validRanges ? !validRanges.includes(p) : false;
        return (
          <button
            key={p}
            type="button"
            className="text-[9px] font-bold font-mono px-1.5 py-0.5 shrink-0"
            disabled={disabled}
            style={{
              background: active ? colors.accent : "transparent",
              color: disabled
                ? `${colors.textSecondary}44`
                : active
                  ? "#000"
                  : colors.textSecondary,
              cursor: disabled ? "not-allowed" : "pointer",
            }}
            onClick={() => onPeriodChange(p)}
          >
            {PERIOD_LABEL[p]}
          </button>
        );
      })}
      {chartType === "candle" && (
        <IntervalPicker
          colors={colors}
          barInterval={barInterval}
          timePeriod={timePeriod}
          onChange={onIntervalChange}
        />
      )}
      {trailing && <div className="ml-auto shrink-0 flex items-center gap-1">{trailing}</div>}
    </div>
  );
}
