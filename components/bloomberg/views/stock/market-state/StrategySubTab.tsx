"use client";

/**
 * E — Strategy compatibility, and the validation that decides whether to
 * believe it.
 *
 * This is the DECISION layer and it is kept behind its own tab for a reason:
 * the four tabs before it describe the market and say nothing about what to do.
 * A reader who disagrees with the interpretation should be able to reject the
 * recommendation without rejecting the description, and vice versa.
 *
 * Two blocks, and the difference between them is the whole point:
 *
 *   in-sample   — the symbol's history inside the CURRENT state, labelled by a
 *                 model fitted on all of it. Descriptive. Shown by default.
 *   walk-forward— refits the model through history and asks the same questions
 *                 of labels the model could actually have produced at the time.
 *                 Expensive, so the user asks for it explicitly.
 *
 * Every score carries n and z. A 92/100 on forty bars is not a finding and the
 * table must not let it look like one.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { bloombergColors } from "../../../lib/theme-config";
import type { MarketStateResponse, StrategyItem, ValidationResponse } from "./types";

type Colors = typeof bloombergColors.dark;

/** |z| that counts as evidence rather than noise. */
const Z_STRONG = 2;

function scoreColor(score: number | null, reliable: boolean, colors: Colors): string {
  if (score == null) return colors.textDimmed;
  if (!reliable) return colors.textSecondary;
  if (score >= 60) return colors.positive;
  if (score <= 40) return colors.negative;
  return colors.textSecondary;
}

function Bar({ item, colors }: { item: StrategyItem; colors: Colors }) {
  const width = Math.max(0, Math.min(100, item.score ?? 0));
  const color = scoreColor(item.score, item.reliable, colors);
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline gap-2">
        <span
          className="text-[11px] font-mono font-bold w-32 shrink-0"
          style={{ color: colors.text }}
        >
          {item.name}
        </span>
        <span className="text-[13px] font-mono font-bold w-14" style={{ color }}>
          {item.score == null ? "—" : `${item.score.toFixed(0)}%`}
        </span>
        <span className="text-[9px] font-mono" style={{ color: colors.textDimmed }}>
          {item.metric} {item.value == null ? "—" : item.value.toFixed(3)} vs {item.baseline} · n=
          {item.n} · z={item.z == null ? "—" : item.z.toFixed(2)}
          {item.rho1 != null ? ` · ρ₁=${item.rho1.toFixed(3)}` : ""}
        </span>
        {!item.reliable && (
          <span className="text-[9px] font-mono" style={{ color: colors.accentWarn }}>
            thin sample
          </span>
        )}
        {item.reliable && item.z != null && Math.abs(item.z) >= Z_STRONG && (
          <span className="text-[9px] font-mono" style={{ color: colors.positive }}>
            |z| ≥ {Z_STRONG}
          </span>
        )}
      </div>
      <div className="h-2 border" style={{ borderColor: colors.borderFaint }}>
        <div
          className="h-full"
          style={{ width: `${width}%`, background: color, opacity: item.reliable ? 0.9 : 0.4 }}
        />
      </div>
      <div className="text-[9px] font-mono" style={{ color: colors.textDimmed }}>
        {item.detail}
      </div>
    </div>
  );
}

export function StrategySubTab({
  data,
  symbol,
  colors,
}: { data: MarketStateResponse; symbol: string; colors: Colors }) {
  const [runValidation, setRunValidation] = useState(false);
  const strategy = data.strategy;

  const validation = useQuery<ValidationResponse>({
    queryKey: ["market-state-validation", symbol],
    queryFn: () =>
      fetch(`/api/market-state/${encodeURIComponent(symbol)}/validation`).then((r) => r.json()),
    enabled: runValidation && Boolean(symbol),
    staleTime: 86_400_000,
    retry: false,
  });

  if (!strategy) return null;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-[9px] tracking-widest" style={{ color: colors.textDimmed }}>
            COMPATIBILITY INSIDE {strategy.state_label} — {strategy.state_bars} bars of history,{" "}
            {strategy.horizon}-bar horizon
          </span>
          <span className="text-[9px] font-mono" style={{ color: colors.accentWarn }}>
            {strategy.basis}
          </span>
        </div>
        <div className="space-y-3">
          {strategy.items.map((item) => (
            <Bar key={item.id} item={item} colors={colors} />
          ))}
        </div>
        <div
          className="text-[9px] font-mono mt-2 leading-relaxed"
          style={{ color: colors.textDimmed }}
        >
          Measured on this symbol's own bars in this state — not a rule table, and not a backtest:
          no costs, no sizing, no entry rule. The STRATEGY FIT tab answers the same question
          unconditionally, over the whole sample; this one conditions on the state the symbol is in
          right now.
        </div>
      </div>

      {/* ── Walk-forward ── */}
      <div className="border-t pt-3" style={{ borderColor: colors.border }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[9px] tracking-widest" style={{ color: colors.textDimmed }}>
            WALK-FORWARD VALIDATION — does the state mean anything out-of-sample
          </span>
          {!runValidation && (
            <button
              type="button"
              onClick={() => setRunValidation(true)}
              className="px-2 py-0.5 text-[9px] font-mono font-bold border"
              style={{ borderColor: colors.accent, color: colors.accent }}
            >
              RUN (~10-60s)
            </button>
          )}
        </div>

        {!runValidation && (
          <div className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
            Refits the model dozens of times through history and re-asks every question above with
            labels the model could have produced at the time. Nothing on the other tabs can answer
            this — they all share one model fitted on the whole sample.
          </div>
        )}

        {runValidation && validation.isLoading && (
          <div className="text-[10px] font-mono py-4" style={{ color: colors.textSecondary }}>
            Refitting through history…
          </div>
        )}

        {validation.data?.status === "insufficient" && (
          <div className="text-[10px] font-mono py-2" style={{ color: colors.accentWarn }}>
            {validation.data.detail ?? "Not enough history to validate."}
          </div>
        )}

        {validation.data?.status === "ok" && validation.data.verdict && (
          <div className="space-y-3">
            <div
              className="border p-2 text-[11px] font-mono"
              style={{
                borderColor: validation.data.verdict.states_separate
                  ? colors.positive
                  : colors.accentWarn,
                color: colors.text,
                background: validation.data.verdict.states_separate ? "#00ff0008" : "#ff660008",
              }}
            >
              {validation.data.verdict.reading}
            </div>

            <div>
              <div className="text-[9px] tracking-widest mb-1" style={{ color: colors.textDimmed }}>
                FORWARD RETURN AFTER EACH STATE (out-of-sample)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px] font-mono border-collapse">
                  <thead>
                    <tr style={{ color: colors.textDimmed }}>
                      <th className="text-left font-normal py-0.5">STATE</th>
                      <th className="text-right font-normal">H</th>
                      <th className="text-right font-normal">N</th>
                      <th className="text-right font-normal">MEAN</th>
                      <th className="text-right font-normal">BASE</th>
                      <th className="text-right font-normal">HIT</th>
                      <th
                        className="text-right font-normal"
                        title="Raw Welch t — inflated by overlapping windows"
                      >
                        t
                      </th>
                      <th
                        className="text-right font-normal"
                        title="t ÷ √horizon: the conservative correction for overlapping forward windows. This is the one the verdict uses."
                      >
                        t adj
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(validation.data.forward_returns ?? []).map((r) => (
                      <tr
                        key={`${r.state}-${r.horizon}`}
                        style={{
                          borderTop: `1px solid ${colors.borderFaint}`,
                          opacity: r.counts ? 1 : 0.5,
                        }}
                      >
                        <td className="py-0.5" style={{ color: colors.text }}>
                          {r.label}
                          {!r.counts && (
                            <span
                              style={{ color: colors.accentWarn }}
                              title="too few bars to count"
                            >
                              {" "}
                              ⚠
                            </span>
                          )}
                        </td>
                        <td className="text-right" style={{ color: colors.textSecondary }}>
                          {r.horizon}
                        </td>
                        <td className="text-right" style={{ color: colors.textSecondary }}>
                          {r.n}
                        </td>
                        <td
                          className="text-right"
                          style={{ color: r.mean_pct >= 0 ? colors.positive : colors.negative }}
                        >
                          {r.mean_pct >= 0 ? "+" : ""}
                          {r.mean_pct.toFixed(2)}%
                        </td>
                        <td className="text-right" style={{ color: colors.textDimmed }}>
                          {r.baseline_pct >= 0 ? "+" : ""}
                          {r.baseline_pct.toFixed(2)}%
                        </td>
                        <td className="text-right" style={{ color: colors.textSecondary }}>
                          {(r.hit_rate * 100).toFixed(0)}%
                        </td>
                        <td className="text-right" style={{ color: colors.textDimmed }}>
                          {r.t_vs_rest?.toFixed(2) ?? "—"}
                        </td>
                        <td
                          className="text-right"
                          style={{
                            color:
                              r.counts && r.t_adj != null && Math.abs(r.t_adj) >= Z_STRONG
                                ? colors.positive
                                : colors.textSecondary,
                          }}
                        >
                          {r.t_adj?.toFixed(2) ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <div className="text-[9px] tracking-widest mb-1" style={{ color: colors.textDimmed }}>
                BEST-SCORING STRATEGY PER STATE (out-of-sample)
              </div>
              <div className="flex flex-wrap gap-1">
                {(validation.data.strategy_by_state ?? []).map((s) => (
                  <span
                    key={s.state}
                    className="text-[9px] font-mono px-1 py-0.5 border"
                    style={{
                      borderColor: colors.border,
                      color:
                        s.bars >= (validation.data?.method?.min_state_bars ?? 100)
                          ? colors.text
                          : colors.textDimmed,
                    }}
                  >
                    {s.label}: {s.best ?? "—"}
                    {s.best_score != null ? ` ${s.best_score.toFixed(0)}%` : ""} · {s.bars}b
                  </span>
                ))}
              </div>
            </div>

            {validation.data.method && (
              <div
                className="text-[9px] font-mono leading-relaxed"
                style={{ color: colors.textDimmed }}
              >
                {validation.data.method.refits} refits · step {validation.data.method.step} ·
                embargo {validation.data.method.embargo} · {validation.data.method.labelled_bars} of{" "}
                {validation.data.method.total_bars} bars labelled out-of-sample.{" "}
                {validation.data.method.overlap_note} {validation.data.method.note}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
