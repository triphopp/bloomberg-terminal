"use client";

import type { TimePeriod, BarInterval } from "./types";
import { INTERVAL_VALID_RANGES } from "./types";
import { TIME_PERIODS, BAR_INTERVALS, PERIOD_LABEL, INTERVAL_LABEL } from "./useChartTimeframe";

interface Colors {
  accent:        string;
  border:        string;
  textSecondary: string;
  background:    string;
  text:          string;
}

export interface ChartTimeframeBarProps {
  timePeriod:         TimePeriod;
  barInterval:        BarInterval;
  chartType:          "area" | "candle";
  colors:             Colors;
  onPeriodChange:     (p: TimePeriod) => void;
  onIntervalChange:   (iv: BarInterval) => void;
  /** Subset of TIME_PERIODS to show. Defaults to all seven. */
  periods?:           TimePeriod[];
}

export function ChartTimeframeBar({
  timePeriod,
  barInterval,
  chartType,
  colors,
  onPeriodChange,
  onIntervalChange,
  periods = TIME_PERIODS,
}: ChartTimeframeBarProps) {
  return (
    <div className="flex flex-col gap-1">
      {/* ── Period row ── */}
      <div className="flex gap-1 flex-wrap">
        {periods.map((p) => {
          const validRanges = chartType === "candle" ? INTERVAL_VALID_RANGES[barInterval] : null;
          const disabled    = !!validRanges && !validRanges.includes(p);
          const active      = timePeriod === p;
          return (
            <button
              key={p}
              type="button"
              disabled={disabled}
              onClick={() => onPeriodChange(p)}
              className="px-1.5 py-0.5 border text-[9px] font-mono transition-colors"
              style={{
                borderColor:     active   ? colors.accent : colors.border,
                backgroundColor: active   ? `${colors.accent}22` : "transparent",
                color:           disabled ? `${colors.textSecondary}44`
                                 : active ? colors.accent
                                 : colors.textSecondary,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
            >
              {PERIOD_LABEL[p]}
            </button>
          );
        })}
      </div>

      {/* ── Bar interval row (candle only) ── */}
      {chartType === "candle" && (
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-mono mr-1" style={{ color: colors.textSecondary }}>
            TF
          </span>
          {BAR_INTERVALS.map((iv) => {
            const active = barInterval === iv;
            return (
              <button
                key={iv}
                type="button"
                onClick={() => onIntervalChange(iv)}
                className="px-2 py-0.5 text-[9px] font-mono border transition-colors"
                style={{
                  borderColor:     active ? colors.accent : colors.border,
                  backgroundColor: active ? colors.accent : "transparent",
                  color:           active ? colors.background : colors.textSecondary,
                  fontWeight:      active ? 700 : 400,
                }}
              >
                {INTERVAL_LABEL[iv]}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
