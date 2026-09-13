"use client";

/**
 * DIAGNOSTICS — the feature redundancy check the brief asks for, plus the model
 * card.
 *
 * This tab exists so the feature set can be ARGUED WITH. The model uses five
 * features and leaves seven candidates out; two different reasons apply, and
 * the table prints which one applies to each with the measured correlation
 * beside it:
 *
 *   "redundant"                     — |r| ≥ 0.80 with something already in
 *   "same axis, kept out for parsimony" — correlated but not redundant, excluded
 *                                     to keep a 4-state full-covariance fit from
 *                                     estimating more than the data supports
 *
 * The second is a judgement, not a measurement, and is labelled as one.
 */

import type { bloombergColors } from "../../../lib/theme-config";
import type { MarketStateResponse } from "./types";

type Colors = typeof bloombergColors.dark;

function corrColor(r: number, colors: Colors): string {
  const a = Math.abs(r);
  if (a >= 0.8) return colors.negative;
  if (a >= 0.6) return colors.accentWarn;
  if (a >= 0.4) return colors.textSecondary;
  return colors.textDimmed;
}

export function DiagnosticsSubTab({ data, colors }: { data: MarketStateResponse; colors: Colors }) {
  const diag = data.diagnostics;
  if (!diag) return null;
  const rep = diag.redundancy;
  const model = diag.model;

  return (
    <div className="space-y-4">
      {/* ── Model card ── */}
      <div>
        <div className="text-[9px] tracking-widest mb-1" style={{ color: colors.textDimmed }}>
          MODEL
        </div>
        <div className="text-[10px] font-mono space-y-0.5" style={{ color: colors.textSecondary }}>
          <div>
            {model.family} · {model.n_states} states · {model.covariance} covariance · hysteresis{" "}
            {model.hysteresis} bars
          </div>
          <div>
            {model.bars_used} usable bars from {model.bars_in} ({model.bars_in - model.bars_used}{" "}
            burned by the feature warm-up)
          </div>
          <div>
            features: <span style={{ color: colors.text }}>{model.features.join(", ")}</span>
            {model.dropped_features.length > 0 && (
              <span style={{ color: colors.accentWarn }}>
                {" "}
                · dropped: {model.dropped_features.join(", ")} (no data on this symbol)
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Transition matrix ── */}
      <div>
        <div className="text-[9px] tracking-widest mb-1" style={{ color: colors.textDimmed }}>
          TRANSITION MATRIX — P(row → column) per bar
        </div>
        <div className="overflow-x-auto">
          <table className="text-[10px] font-mono border-collapse">
            <thead>
              <tr style={{ color: colors.textDimmed }}>
                <th className="text-left font-normal pr-2">FROM \ TO</th>
                {model.state_labels.map((l) => (
                  <th key={l} className="text-right font-normal px-2">
                    {l.split(" ")[0]}
                  </th>
                ))}
                <th
                  className="text-right font-normal px-2"
                  title="1/(1−p) — mean bars before leaving"
                >
                  ~LIFE
                </th>
              </tr>
            </thead>
            <tbody>
              {model.transition_matrix.map((row, i) => (
                <tr
                  key={model.state_labels[i]}
                  style={{ borderTop: `1px solid ${colors.borderFaint}` }}
                >
                  <td className="pr-2 py-0.5" style={{ color: colors.text }}>
                    {model.state_labels[i]}
                  </td>
                  {row.map((p, j) => (
                    <td
                      key={`${model.state_labels[i]}-${model.state_labels[j]}`}
                      className="text-right px-2"
                      style={{ color: i === j ? colors.accentSelected : colors.textSecondary }}
                    >
                      {(p * 100).toFixed(1)}
                    </td>
                  ))}
                  <td className="text-right px-2" style={{ color: colors.textSecondary }}>
                    {model.expected_durations[i] == null ? "—" : `${model.expected_durations[i]}b`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Redundancy check ── */}
      {rep.status === "ok" && (
        <>
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-[9px] tracking-widest" style={{ color: colors.textDimmed }}>
                FEATURE REDUNDANCY — inside the model
              </span>
              <span
                className="text-[9px] font-mono"
                style={{
                  color:
                    (rep.max_model_abs_corr ?? 0) >= (rep.threshold ?? 0.8)
                      ? colors.negative
                      : colors.positive,
                }}
              >
                max |r| = {rep.max_model_abs_corr?.toFixed(3)} (threshold {rep.threshold})
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="text-[10px] font-mono border-collapse">
                <thead>
                  <tr style={{ color: colors.textDimmed }}>
                    <th className="text-left font-normal pr-2" />
                    {rep.model_matrix?.names.map((n) => (
                      <th key={n} className="text-right font-normal px-2">
                        {n}
                      </th>
                    ))}
                    <th
                      className="text-right font-normal px-2"
                      title="Variance inflation factor — >5 means this feature is mostly a combination of the others"
                    >
                      VIF
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rep.model_matrix?.names.map((a, i) => (
                    <tr key={a} style={{ borderTop: `1px solid ${colors.borderFaint}` }}>
                      <td
                        className="pr-2 py-0.5"
                        style={{ color: colors.text }}
                        title={rep.feature_doc?.[a]}
                      >
                        {a}
                      </td>
                      {rep.model_matrix?.values[i].map((r, j) => (
                        <td
                          key={`${a}-${rep.model_matrix?.names[j]}`}
                          className="text-right px-2"
                          style={{ color: i === j ? colors.textDimmed : corrColor(r, colors) }}
                        >
                          {r.toFixed(2)}
                        </td>
                      ))}
                      <td
                        className="text-right px-2"
                        style={{
                          color: (rep.vif?.[a] ?? 0) > 5 ? colors.negative : colors.textSecondary,
                        }}
                      >
                        {rep.vif?.[a]?.toFixed(2) ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-[9px] font-mono mt-1" style={{ color: colors.textDimmed }}>
              {rep.model_features?.map((f) => `${f}: ${rep.feature_doc?.[f] ?? ""}`).join(" · ")}
            </div>
          </div>

          <div>
            <div className="text-[9px] tracking-widest mb-1" style={{ color: colors.textDimmed }}>
              CANDIDATES LEFT OUT — and how close each is to something in the model
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[10px] font-mono border-collapse">
                <thead>
                  <tr style={{ color: colors.textDimmed }}>
                    <th className="text-left font-normal py-0.5">CANDIDATE</th>
                    <th className="text-left font-normal">CLOSEST IN MODEL</th>
                    <th className="text-right font-normal">r</th>
                    <th className="text-left font-normal pl-3">VERDICT</th>
                  </tr>
                </thead>
                <tbody>
                  {rep.rejected_vs_model?.map((row) => (
                    <tr
                      key={row.feature}
                      style={{ borderTop: `1px solid ${colors.borderFaint}` }}
                      title={row.reason}
                    >
                      <td className="py-0.5" style={{ color: colors.text }}>
                        {row.feature}
                      </td>
                      <td style={{ color: colors.textSecondary }}>{row.closest_model_feature}</td>
                      <td className="text-right" style={{ color: corrColor(row.r, colors) }}>
                        {row.r.toFixed(3)}
                      </td>
                      <td
                        className="pl-3"
                        style={{
                          color: row.verdict === "redundant" ? colors.negative : colors.accentWarn,
                        }}
                      >
                        {row.verdict}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div
              className="text-[9px] font-mono mt-1 leading-relaxed"
              style={{ color: colors.textDimmed }}
            >
              "redundant" is measured: |r| ≥ {rep.threshold} with a feature already in the model.
              "same axis, kept out for parsimony" is a judgement — those candidates are correlated
              but not duplicates, and are excluded because a {model.n_states}-state full-covariance
              fit already estimates{" "}
              {model.n_states * ((model.features.length * (model.features.length + 1)) / 2)}{" "}
              covariance parameters on {model.features.length} features. If you think one of them
              earns its place, this table is the argument to have.
            </div>
          </div>
        </>
      )}

      {rep.status === "insufficient" && (
        <div className="text-[10px] font-mono" style={{ color: colors.accentWarn }}>
          Not enough overlapping bars ({rep.bars}) to compute the redundancy report.
        </div>
      )}
    </div>
  );
}
