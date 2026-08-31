"use client";

import { type Colors, type StressResponse, fmtPct, fmtSignedPct } from "./types";

/**
 * Three ways to answer "what does 100bp do to the price", side by side, because
 * the disagreement between them is the point. Assumed-growth Gordon is shown
 * precisely so its failure is visible rather than hidden behind a guard.
 */
export function DurationSubTab({ data, colors }: { data: StressResponse; colors: Colors }) {
  const v = data.valuation;
  const beta = data.rate_beta;
  const spread = v.spread;
  const theta = v.theta;

  // Exact revaluation at 100bp, plus the linearisation it replaces.
  const dk = theta != null ? theta * 0.01 : null;
  const exact = spread && dk != null ? spread / (spread + dk) - 1 : null;
  const linear = spread && dk != null ? -dk / spread : null;
  const fullPass = spread ? spread / (spread + 0.01) - 1 : null;

  const th = "px-2 py-1 text-[10px] font-mono font-bold tracking-wider text-right";
  const td = "px-2 py-1 text-xs font-mono text-right whitespace-nowrap";

  const rows = [
    {
      method: "Gordon, growth assumed",
      spread: "—",
      duration: "—",
      impact: "unusable",
      note: "g = ROE × retention pushed 8 of 15 large caps into the g ≥ k_e guard; the mean came out at −46.9% per 100bp against −3.6% measured",
      dim: true,
    },
    {
      method: "Gordon inverted (implied g)",
      spread: fmtPct(spread, 2),
      duration: v.duration != null ? v.duration.toFixed(1) : "—",
      impact: fmtSignedPct(fullPass),
      note: "k_e − g read off the price as the shareholder yield; full pass-through θ = 1",
    },
    {
      method: `Gordon + measured θ = ${theta != null ? theta.toFixed(2) : "—"}`,
      spread: fmtPct(spread, 2),
      duration: v.duration != null ? v.duration.toFixed(1) : "—",
      impact: fmtSignedPct(exact),
      note: v.theta_source,
      emphasis: true,
    },
    {
      method: "Measured κ (regression)",
      spread: "—",
      duration: "—",
      impact:
        beta.status === "ok" && beta.significant
          ? fmtSignedPct((beta.kappa_10y_pct_per_100bp ?? 0) / 100)
          : "not significant",
      note:
        beta.status === "ok"
          ? `t = ${beta.kappa_10y_t?.toFixed(1) ?? "—"} · R² ${fmtPct(beta.r2_rate_only, 1)} · n = ${beta.n}`
          : beta.status,
    },
  ];

  const conflict = v.theta_fit?.status === "mechanism_conflict";

  return (
    <div>
      <div
        className="text-[11px] font-mono border px-2 py-1.5 mb-4"
        style={{ borderColor: colors.border, color: colors.textDimmed }}
      >
        Every figure here is <strong>per +100bp on the 10-year</strong>, from a risk-free rate of{" "}
        {fmtPct(v.risk_free, 2)}. Larger shocks are not proportional — the exact revaluation curves
        away from the linear one, which is why the SCENARIO tab recomputes rather than multiplying.
      </div>
      {conflict && (
        <div
          className="border px-3 py-2 text-[11px] font-mono mb-4"
          style={{ borderColor: colors.accentWarn, color: colors.accentWarn }}
        >
          MECHANISM CONFLICT — this name&apos;s price has risen when rates rose (κ ={" "}
          {(beta.kappa_10y_pct_per_100bp ?? 0).toFixed(2)}% per 100bp, t ={" "}
          {beta.kappa_10y_t?.toFixed(1) ?? "—"}). Discounting cannot produce that, so the fitted θ
          of {v.theta_fit?.rejected_theta?.toFixed(2)} is rejected and the sector default is used
          instead. The measured response is tracking something else that moves with rates, not the
          discount rate.
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              <th className={`${th} text-left`} style={{ color: colors.accent }}>
                METHOD
              </th>
              <th className={th} style={{ color: colors.accent }}>
                k_e − g
              </th>
              <th className={th} style={{ color: colors.accent }}>
                DURATION
              </th>
              <th className={th} style={{ color: colors.accent }}>
                Δ PRICE @ +100bp
              </th>
              <th className={`${th} text-left`} style={{ color: colors.accent }}>
                NOTE
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.method} style={{ borderBottom: `1px solid ${colors.border}` }}>
                <td
                  className={`${td} text-left`}
                  style={{ color: r.dim ? colors.textDimmed : colors.text }}
                >
                  {r.method}
                </td>
                <td className={td} style={{ color: colors.text }}>
                  {r.spread}
                </td>
                <td className={td} style={{ color: colors.text }}>
                  {r.duration}
                </td>
                <td
                  className={td}
                  style={{
                    color: r.dim ? colors.textDimmed : colors.text,
                    fontWeight: r.emphasis ? 700 : 400,
                  }}
                >
                  {r.impact}
                </td>
                <td
                  className="px-2 py-1 text-[10px] font-mono"
                  style={{ color: colors.textDimmed }}
                >
                  {r.note}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 text-xs font-mono grid grid-cols-2 gap-x-8 gap-y-1 max-w-2xl">
        <span style={{ color: colors.textDimmed }}>Risk-free (10Y)</span>
        <span style={{ color: colors.text }}>{fmtPct(v.risk_free, 2)}</span>
        <span style={{ color: colors.textDimmed }}>Market beta</span>
        <span style={{ color: colors.text }}>{v.beta?.toFixed(2) ?? "—"}</span>
        <span style={{ color: colors.textDimmed }}>k_e = r_f + β · ERP</span>
        <span style={{ color: colors.text }}>{fmtPct(v.k_e, 2)}</span>
        <span style={{ color: colors.textDimmed }}>Dividend yield</span>
        <span style={{ color: colors.text }}>{fmtPct(v.shareholder_yield.dividend, 2)}</span>
        <span style={{ color: colors.textDimmed }}>Buyback yield</span>
        <span style={{ color: colors.text }}>{fmtPct(v.shareholder_yield.buyback, 2)}</span>
        <span style={{ color: colors.textDimmed }}>Implied g</span>
        <span style={{ color: colors.text }}>{fmtPct(v.g_implied, 2)}</span>
        <span style={{ color: colors.textDimmed }}>Convexity (exact − linear) @100bp</span>
        <span style={{ color: colors.text }}>
          {exact != null && linear != null ? fmtSignedPct(exact - linear, 2) : "—"}
        </span>
      </div>

      <div
        className="mt-4 text-[10px] font-mono leading-relaxed"
        style={{ color: colors.textDimmed }}
      >
        θ is the share of a risk-free move that reaches the equity discount spread. Measured across
        15 large caps the median is 0.12 — a compressing risk premium and nominal growth moving with
        inflation absorb the rest, so the textbook θ = 1 overstates the hit by 8–30×. It absorbs
        everything that co-moves with rates (inflation, growth, risk appetite) and is not a causal
        pass-through: energy names carry a negative θ because rates rise with oil.
      </div>
    </div>
  );
}
