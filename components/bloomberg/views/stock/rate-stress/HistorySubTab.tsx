"use client";

import type { Colors } from "./types";

/**
 * Theory-versus-outcome, once the validation harness exists.
 *
 * This tab is deliberately empty rather than populated with a live-data
 * approximation. Every row it will show has to be built from the filings that
 * were public on the as-of date — the first-filed revision, not today's
 * restatement — and yfinance carries neither the filing date nor enough history
 * to reconstruct that. Rebuilding it per request would take minutes, so the
 * harness writes the runs to `ir_stress_predictions` and this tab reads them.
 *
 * Spec: memory/plans/cirst-validation-harness.md
 */

const COLUMNS = [
  "as_of",
  "Δ10Y actual",
  "interest: predicted",
  "interest: actual",
  "error",
  "price: model",
  "price: measured",
  "price: actual",
  "error",
];

const SUMMARY = [
  ["Bias", "systematic over- or under-statement, in dollars and percentage points"],
  ["MAE / RMSE", "typical miss per as-of date"],
  [
    "Calibration slope",
    "1.0 means the size is right; 0.3 means the direction is right and the magnitude is three times too small",
  ],
  ["Hit rate", "share of quarters where the sign was right"],
  [
    "vs null models",
    "against persistence, full repricing, and debt × Δy — with a Diebold-Mariano test, clustered by as-of because every company shares one shock",
  ],
];

export function HistorySubTab({ symbol, colors }: { symbol: string; colors: Colors }) {
  return (
    <div>
      <div
        className="border px-3 py-2 text-xs font-mono mb-4"
        style={{ borderColor: colors.accentWarn, color: colors.accentWarn }}
      >
        NOT YET AVAILABLE — needs the point-in-time backtest harness
      </div>

      <div className="text-[11px] font-mono leading-relaxed mb-4" style={{ color: colors.text }}>
        This tab will show, for each quarter over five years, what the model would have said about{" "}
        {symbol} using only what was public that day, next to what actually happened. It is empty
        rather than approximate on purpose: rebuilding it from today&apos;s restated filings would
        make the model look better than it is, because it would be reading numbers that had not been
        published yet.
      </div>

      <div
        className="text-[10px] font-mono font-bold tracking-widest mb-1 pb-1 border-b"
        style={{ color: colors.accent, borderColor: colors.border }}
      >
        COLUMNS PLANNED
      </div>
      <div className="text-[11px] font-mono mb-4" style={{ color: colors.textDimmed }}>
        {COLUMNS.join("  ·  ")}
      </div>

      <div
        className="text-[10px] font-mono font-bold tracking-widest mb-1 pb-1 border-b"
        style={{ color: colors.accent, borderColor: colors.border }}
      >
        ERROR SUMMARY PLANNED
      </div>
      <div className="text-[11px] font-mono" style={{ color: colors.textDimmed }}>
        {SUMMARY.map(([k, v]) => (
          <div key={k} className="flex py-0.5">
            <span className="w-40 shrink-0" style={{ color: colors.text }}>
              {k}
            </span>
            <span className="flex-1">{v}</span>
          </div>
        ))}
      </div>

      <div
        className="mt-4 text-[10px] font-mono leading-relaxed"
        style={{ color: colors.textDimmed }}
      >
        Blocked on: storing the FRED curve as a daily series rather than a single latest value, and
        reading XBRL facts by filing date. Spec in memory/plans/cirst-validation-harness.md.
      </div>
    </div>
  );
}
