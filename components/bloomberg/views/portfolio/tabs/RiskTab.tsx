"use client";
import {
  Activity,
  AlertTriangle,
  Clock,
  Infinity as InfinityIcon,
  Loader2,
  RefreshCw,
  Shield,
  TrendingDown,
} from "lucide-react";
import React, { useState, useCallback, useEffect, useMemo } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { type Colors, fmt, fmtK, pnlColor } from "../helpers";

type SubTab = "overview" | "options";

interface RiskSnapshot {
  snapshot_date: string;
  today_return_pct: number;
  breach_count: number;
  ensemble_signal: string;
  vol_regime: string;
  cf_hist_ratio: number;
  mc_hist_ratio: number;
  ci_width_ratio: number;
  avg_correlation: number;
  current_drawdown_pct: number;
  var_backtest_rate: number;
  risk_score: number;
  ews: number;
  is_fat_tail_event: number;
  regime_label: string;
  avg_wedge: number;
}

interface RiskMetrics {
  portfolio_value: number;
  n_positions: number;
  lookback_days: number;
  confidence: number;
  // Legacy Gaussian VaR (reference)
  var_parametric_pct: number;
  var_parametric_amount: number;
  var_historical_pct: number;
  var_historical_amount: number;
  // Historical CVaR (Basel IV standard)
  cvar_pct: number;
  cvar_amount: number;
  // Cornish-Fisher VaR (fat-tail adjusted)
  var_cf_pct: number;
  var_cf_amount: number;
  // Monte Carlo CVaR
  cvar_mc_pct: number;
  cvar_mc_amount: number;
  // Stressed CVaR (stressed covariance)
  cvar_stressed_pct: number;
  cvar_stressed_amount: number;
  // Bootstrap CI on historical CVaR (90%)
  cvar_ci_lo: number;
  cvar_ci_hi: number;
  cvar_ci_width_ratio: number;
  // Ensemble
  ensemble_signal: "STABLE" | "FAT_TAIL_RISK" | "CORRELATION_RISK";
  ensemble_conservative_pct: number;
  ensemble_conservative_amount: number;
  // Backtest
  var_backtest_exceptions: number;
  var_backtest_rate: number;
  var_backtest_signal: "GREEN" | "YELLOW" | "RED" | "INSUFFICIENT_DATA";
  // Vol regime
  vol_regime: "CALM" | "ELEVATED" | "STRESSED" | "UNKNOWN";
  volatility_daily_pct: number;
  volatility_annual_pct: number;
  max_drawdown_pct: number;
  current_drawdown_pct: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  calmar_ratio: number;
  diversification_ratio: number;
  effective_n: number;
  herfindahl_index: number;
  risk_score: number;
  assets: {
    symbol: string;
    weight_pct: number;
    risk_contribution_pct: number;
    volatility_annual: number;
    var_contribution: number;
  }[];
  correlation_matrix: { symbols: string[]; matrix: number[][] };
  trim_signals: {
    symbol: string;
    action: "TRIM" | "BUY";
    reason: string;
    excess_rc_pct: number;
    suggested_trim_pct: number;
    current_shares: number | null;
    shares_to_trim: number | null;
    trim_value: number | null;
    trim_pnl: number | null;
    trim_pnl_pct: number | null;
    avg_entry_price: number | null;
    shares_to_buy: number | null;
    buy_value: number | null;
    current_price: number | null;
  }[];
  // Breach checker
  today_return_pct: number;
  breach_hist: boolean;
  breach_cf: boolean;
  breach_mc: boolean;
  kupiec_pvalue: number;
  kupiec_pass: boolean;
  account_breakdown?: Record<
    string,
    {
      portfolio_value: number;
      var_parametric_pct: number;
      cvar_pct: number;
      volatility_annual_pct: number;
      max_drawdown_pct: number;
      sharpe_ratio: number;
      risk_score: number;
      n_positions: number;
    }
  >;
}

interface ParityData {
  current_weights: { symbol: string; weight_pct: number }[];
  optimal_weights: { symbol: string; weight_pct: number }[];
  rebalance_actions: {
    symbol: string;
    action: string;
    current_weight_pct: number;
    optimal_weight_pct: number;
    drift_pct: number;
    trade_value: number;
    shares_change?: number;
    current_price?: number;
  }[];
  method: string;
  portfolio_value?: number;
}

// ── Options risk types ────────────────────────────────────────────────────────

interface GreeksRow {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  price_adj: number;
  delta_adj: number;
  gamma_adj: number;
  theta_adj: number;
  vega_adj: number;
  rho_adj: number;
  delta_diff: number;
  gamma_diff: number;
  theta_diff: number;
  vega_diff: number;
  T_years: number;
  days_to_exp: number;
  iv: number;
  skew_input: number;
  kurt_input: number;
  error?: string;
}

interface OptionsRiskPosition {
  id: string;
  underlying: string;
  expiry: string;
  strike: number;
  option_type: "call" | "put";
  quantity: number;
  entry_price: number;
  max_loss: number | null;
  unlimited_loss: boolean;
  greeks: GreeksRow;
}

interface OptionsRiskData {
  positions: OptionsRiskPosition[];
  portfolio: {
    net_delta_by_underlying: Record<string, { bs: number; adj: number }>;
    total_theta_day: number;
    total_theta_adj_day: number;
    total_premium_at_risk: number;
    has_short_positions: boolean;
    expiry_alerts: {
      id: string;
      underlying: string;
      strike: number;
      option_type: string;
      expiry: string;
      days_to_exp: number;
      level: "critical" | "warn";
    }[];
  };
  freshness: { is_realtime: boolean; delay_minutes: number; warning: string };
}

export function RiskTab({
  accountId,
  currency,
  colors,
}: {
  accountId: string;
  currency: "THB" | "USD";
  colors: Colors;
}) {
  const [subTab, setSubTab] = useState<SubTab>("overview");
  const [metrics, setMetrics] = useState<RiskMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optionsRisk, setOptionsRisk] = useState<OptionsRiskData | null>(null);
  const [loadingOpts, setLoadingOpts] = useState(false);

  const loadMetrics = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const qs = accountId !== "all" ? `&account_id=${accountId}` : "";
        const r = await fetch(`/api/v2/portfolio/risk/metrics?confidence=0.95&lookback=252${qs}`, {
          signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setMetrics(await r.json());
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
        setError((e as Error)?.message || "Failed to load risk metrics");
      } finally {
        setLoading(false);
      }
    },
    [accountId]
  );

  useEffect(() => {
    const ac = new AbortController();
    loadMetrics(ac.signal);
    return () => ac.abort();
  }, [loadMetrics]);

  const loadOptionsRisk = useCallback(
    async (signal?: AbortSignal) => {
      setLoadingOpts(true);
      try {
        const qs = accountId !== "all" ? `?account_id=${accountId}` : "";
        const r = await fetch(`/api/options/greeks/portfolio${qs}`, { signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setOptionsRisk(await r.json());
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      } finally {
        setLoadingOpts(false);
      }
    },
    [accountId]
  );

  useEffect(() => {
    if (subTab !== "options") return;
    const ac = new AbortController();
    loadOptionsRisk(ac.signal);
    return () => ac.abort();
  }, [subTab, loadOptionsRisk]);

  const sym = currency === "THB" ? "฿" : "$";
  const SUB_TABS: { id: SubTab; label: string }[] = [
    { id: "overview", label: "OVERVIEW" },
    { id: "options", label: "OPTIONS RISK" },
  ];

  const riskColor = (score: number) =>
    score < 30 ? "#00FF00" : score < 60 ? "#ff9900" : "#FF4444";

  return (
    <div className="overflow-y-auto px-2 py-1" style={{ maxHeight: "calc(100vh - 220px)" }}>
      {/* Sub-tabs */}
      <div className="flex items-center gap-1 mb-2">
        {SUB_TABS.map((t) => (
          <button
            type="button"
            key={t.id}
            className="text-[9px] px-2 py-0.5 font-bold"
            style={{
              color: subTab === t.id ? colors.accent : colors.textSecondary,
              borderBottom:
                subTab === t.id ? `2px solid ${colors.accent}` : "2px solid transparent",
            }}
            onClick={() => setSubTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => loadMetrics()}
          disabled={loading}
          className="ml-auto p-0.5"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" style={{ color: colors.textSecondary }} />
          ) : (
            <RefreshCw className="h-3 w-3" style={{ color: colors.textSecondary }} />
          )}
        </button>
      </div>

      {!metrics && loading && (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
        </div>
      )}

      {!metrics && !loading && error && (
        <div
          className="flex flex-col items-center gap-2 py-10 px-4 text-center"
          style={{ color: colors.textSecondary }}
        >
          <AlertTriangle className="h-5 w-5" style={{ color: "#FF4444" }} />
          <div className="text-[10px] font-bold" style={{ color: "#FF4444" }}>
            Failed to load risk metrics ({error})
          </div>
          <div className="text-[8px]">Check that the Python backend is running, then retry.</div>
          <button
            type="button"
            onClick={() => loadMetrics()}
            className="mt-1 text-[9px] px-3 py-1 border font-bold"
            style={{ borderColor: colors.accent, color: colors.accent }}
          >
            RETRY
          </button>
        </div>
      )}

      {metrics && subTab === "overview" && (
        <OverviewSection
          metrics={metrics}
          colors={colors}
          sym={sym}
          riskColor={riskColor}
          accountId={accountId}
        />
      )}
      {subTab === "options" && (
        <OptionsRiskSection
          data={optionsRisk}
          loading={loadingOpts}
          colors={colors}
          onRefresh={loadOptionsRisk}
        />
      )}
    </div>
  );
}

// ── EWS History Heatmap ──────────────────────────────────────────────────────

function EWSHistorySection({ accountId, colors }: { accountId: string; colors: Colors }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<RiskSnapshot[]>([]);
  const [fatDates, setFatDates] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const qs = accountId !== "all" ? `&account_id=${accountId}` : "";
        const r = await fetch(`/api/v2/portfolio/risk/history?days=30${qs}`, { signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        setHistory(d.snapshots ?? []);
        setFatDates(d.fat_tail_dates ?? []);
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      } finally {
        setLoading(false);
      }
    },
    [accountId]
  );

  useEffect(() => {
    if (!open || history.length > 0) return;
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [open, history.length, load]);

  // ── Signal color helpers ──
  const ewsColor = (v: number) =>
    v >= 12 ? "#FF4444" : v >= 8 ? "#ff6600" : v >= 5 ? "#ff9900" : v >= 2 ? "#ccaa00" : "#00AA44";

  const volColor = (r: string) =>
    r === "STRESSED"
      ? "#FF4444"
      : r === "ELEVATED"
        ? "#ff9900"
        : r === "CALM"
          ? "#00AA44"
          : "#444444";

  const ensColor = (s: string) =>
    s === "FAT_TAIL_RISK" ? "#ff9900" : s === "CORRELATION_RISK" ? "#FF4444" : "#00AA44";

  const cfColor = (v: number) =>
    v >= 1.3 ? "#FF4444" : v >= 1.2 ? "#ff9900" : v >= 1.1 ? "#ccaa00" : "#00AA44";

  const breachColor = (n: number) =>
    n === 3 ? "#FF4444" : n === 2 ? "#ff6600" : n === 1 ? "#ff9900" : "#00AA44";

  const ddColor = (pct: number) =>
    pct >= 15 ? "#FF4444" : pct >= 7 ? "#ff9900" : pct >= 3 ? "#ccaa00" : "#00AA44";

  const SIGNALS = [
    {
      label: "EWS",
      getValue: (s: RiskSnapshot) => ewsColor(s.ews),
      getText: (s: RiskSnapshot) => String(s.ews),
    },
    {
      label: "Vol",
      getValue: (s: RiskSnapshot) => volColor(s.vol_regime),
      getText: (s: RiskSnapshot) => s.vol_regime[0],
    },
    {
      label: "Ensemble",
      getValue: (s: RiskSnapshot) => ensColor(s.ensemble_signal),
      getText: (s: RiskSnapshot) =>
        s.ensemble_signal === "STABLE" ? "S" : s.ensemble_signal === "FAT_TAIL_RISK" ? "F" : "C",
    },
    {
      label: "CF/Hist",
      getValue: (s: RiskSnapshot) => cfColor(s.cf_hist_ratio),
      getText: (s: RiskSnapshot) => s.cf_hist_ratio.toFixed(2),
    },
    {
      label: "Breach",
      getValue: (s: RiskSnapshot) => breachColor(s.breach_count),
      getText: (s: RiskSnapshot) => String(s.breach_count),
    },
    {
      label: "Drawdown",
      getValue: (s: RiskSnapshot) => ddColor(s.current_drawdown_pct),
      getText: (s: RiskSnapshot) => `${s.current_drawdown_pct.toFixed(1)}%`,
    },
  ];

  const abbr = (d: string) => d.slice(5); // "MM-DD"

  return (
    <div
      className="rounded"
      style={{ border: `1px solid ${colors.border}`, background: "#0a0a0a" }}
    >
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2 py-1.5"
        onClick={() => setOpen((o) => !o)}
      >
        <Clock className="h-3 w-3" style={{ color: colors.textSecondary }} />
        <span className="text-[8px] font-bold" style={{ color: colors.textSecondary }}>
          EWS SIGNAL HISTORY
        </span>
        <span className="text-[7px] px-1 rounded" style={{ background: "#1a1a1a", color: "#555" }}>
          30d · auto-logged daily
        </span>
        {fatDates.length > 0 && (
          <span
            className="text-[7px] px-1 rounded font-bold"
            style={{ background: "#2a0000", border: "1px solid #FF444444", color: "#FF4444" }}
          >
            {fatDates.length} fat tail event{fatDates.length > 1 ? "s" : ""}
          </span>
        )}
        <a
          href={`/api/v2/portfolio/risk/history/export?days=365${accountId !== "all" ? `&account_id=${accountId}` : ""}`}
          download
          onClick={(e) => e.stopPropagation()}
          className="text-[7px] px-1.5 py-0.5 rounded ml-1"
          style={{ background: "#111", border: "1px solid #333333", color: "#555555" }}
          title="Download full 365d history as CSV"
        >
          ↓ CSV
        </a>
        <span className="ml-1 text-[8px]" style={{ color: colors.textSecondary }}>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="px-2 pb-2">
          {loading && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin" style={{ color: colors.accent }} />
            </div>
          )}

          {!loading && history.length === 0 && (
            <div className="py-4 text-center text-[8px]" style={{ color: colors.textSecondary }}>
              No snapshots yet — data accumulates after first daily metrics fetch.
            </div>
          )}

          {!loading && history.length > 0 && (
            <>
              {/* EWS threshold legend */}
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                {[
                  { color: "#00AA44", label: "Normal (0–4)" },
                  { color: "#ccaa00", label: "Warning (5–7)" },
                  { color: "#ff9900", label: "Alert (8–11)" },
                  { color: "#FF4444", label: "Critical (12+)" },
                ].map((l) => (
                  <div key={l.label} className="flex items-center gap-1">
                    <div className="w-2.5 h-2.5 rounded-sm" style={{ background: l.color }} />
                    <span className="text-[7px]" style={{ color: "#666" }}>
                      {l.label}
                    </span>
                  </div>
                ))}
                <div className="flex items-center gap-1 ml-2">
                  <div
                    className="w-2.5 h-2.5 rounded-sm"
                    style={{ background: "#FF444433", border: "1px solid #FF4444" }}
                  />
                  <span className="text-[7px]" style={{ color: "#FF6666" }}>
                    Fat tail event
                  </span>
                </div>
              </div>

              {/* Heatmap grid */}
              <div className="overflow-x-auto">
                <table style={{ borderCollapse: "separate", borderSpacing: "2px 2px" }}>
                  <thead>
                    <tr>
                      <th style={{ width: 64, minWidth: 64 }} />
                      {history.map((s) => (
                        <th
                          key={s.snapshot_date}
                          className="text-[6px] text-center pb-0.5 font-normal"
                          style={{
                            color: fatDates.includes(s.snapshot_date) ? "#FF6666" : "#444",
                            minWidth: 20,
                            width: 20,
                          }}
                        >
                          {abbr(s.snapshot_date)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {SIGNALS.map((sig) => (
                      <tr key={sig.label}>
                        <td
                          className="text-[7px] pr-1.5 text-right font-bold"
                          style={{ color: "#555", width: 64 }}
                        >
                          {sig.label}
                        </td>
                        {history.map((s) => {
                          const isFat = fatDates.includes(s.snapshot_date);
                          const col = sig.getValue(s);
                          return (
                            <td
                              key={s.snapshot_date}
                              title={`${s.snapshot_date}\n${sig.label}: ${sig.getText(s)}\nEWS: ${s.ews}${isFat ? "\n⚠ FAT TAIL EVENT" : ""}`}
                              style={{
                                width: 20,
                                height: 16,
                                background: `${col}55`,
                                border: isFat ? "1px solid #FF4444" : `1px solid ${col}33`,
                                borderRadius: 2,
                                cursor: "default",
                              }}
                            />
                          );
                        })}
                      </tr>
                    ))}

                    {/* Return row (positive/negative bar) */}
                    <tr>
                      <td
                        className="text-[7px] pr-1.5 text-right font-bold"
                        style={{ color: "#555" }}
                      >
                        Return
                      </td>
                      {history.map((s) => {
                        const pos = s.today_return_pct >= 0;
                        const isFat = fatDates.includes(s.snapshot_date);
                        return (
                          <td
                            key={s.snapshot_date}
                            title={`${s.snapshot_date}\nReturn: ${s.today_return_pct.toFixed(2)}%`}
                            style={{
                              width: 20,
                              height: 16,
                              background: pos ? "#00FF0033" : "#FF444433",
                              border: isFat ? "1px solid #FF4444" : "1px solid transparent",
                              borderRadius: 2,
                            }}
                          />
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Fat tail event annotations */}
              {fatDates.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {history
                    .filter((s) => s.is_fat_tail_event)
                    .map((s) => (
                      <div
                        key={s.snapshot_date}
                        className="flex items-center gap-2 text-[7px] px-1.5 py-0.5 rounded"
                        style={{ background: "#2a0000", border: "1px solid #FF444444" }}
                      >
                        <span style={{ color: "#FF4444" }}>⚠ {s.snapshot_date}</span>
                        <span style={{ color: "#888" }}>—</span>
                        <span style={{ color: "#FF6666" }}>3/3 VaR breached · EWS {s.ews}</span>
                        <span style={{ color: "#888" }}>·</span>
                        <span style={{ color: colors.textSecondary }}>
                          {s.vol_regime} · {s.ensemble_signal} · DD{" "}
                          {s.current_drawdown_pct.toFixed(1)}%
                        </span>
                        <span style={{ color: "#ff9900", marginLeft: "auto" }}>
                          return {s.today_return_pct.toFixed(2)}%
                        </span>
                      </div>
                    ))}
                </div>
              )}

              {/* Pre-event signal check: days before fat tail where EWS was elevated */}
              {fatDates.length > 0 &&
                (() => {
                  const preWarnings: { date: string; ews: number; signals: string[] }[] = [];
                  history.forEach((s, i) => {
                    if (!s.is_fat_tail_event && s.ews >= 5) {
                      // Check if a fat tail event follows within 5 days
                      const upcoming = history.slice(i + 1, i + 6).some((f) => f.is_fat_tail_event);
                      if (upcoming) {
                        const sigs: string[] = [];
                        if (s.vol_regime === "STRESSED") sigs.push("Vol STRESSED");
                        if (s.ensemble_signal !== "STABLE") sigs.push(s.ensemble_signal);
                        if (s.cf_hist_ratio >= 1.1)
                          sigs.push(`CF/Hist ${s.cf_hist_ratio.toFixed(2)}`);
                        if (s.breach_count > 0) sigs.push(`Breach ${s.breach_count}/3`);
                        preWarnings.push({ date: s.snapshot_date, ews: s.ews, signals: sigs });
                      }
                    }
                  });
                  if (preWarnings.length === 0) return null;
                  return (
                    <div className="mt-2">
                      <div className="text-[7px] font-bold mb-1" style={{ color: "#ff9900" }}>
                        PRE-EVENT WARNINGS DETECTED
                      </div>
                      {preWarnings.map((w) => (
                        <div
                          key={w.date}
                          className="flex items-center gap-1.5 text-[7px] py-0.5"
                          style={{ color: colors.textSecondary }}
                        >
                          <span style={{ color: "#ff9900" }}>{w.date}</span>
                          <span>EWS={w.ews}</span>
                          {w.signals.map((sg) => (
                            <span
                              key={sg}
                              className="px-1 rounded"
                              style={{ background: "#1a1000", color: "#ff9900" }}
                            >
                              {sg}
                            </span>
                          ))}
                        </div>
                      ))}
                    </div>
                  );
                })()}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── VaR Breach Checker ───────────────────────────────────────────────────────

function VaRBreachChecker({
  metrics,
  colors,
  sym,
}: {
  metrics: RiskMetrics;
  colors: Colors;
  sym: string;
}) {
  const {
    today_return_pct,
    breach_hist,
    breach_cf,
    breach_mc,
    kupiec_pvalue,
    kupiec_pass,
    var_historical_pct,
    var_cf_pct,
    cvar_mc_pct,
    var_backtest_exceptions,
    var_backtest_rate,
    lookback_days,
    var_backtest_signal,
    confidence,
  } = metrics;

  const isLoss = today_return_pct < 0;
  const anyBreach = breach_hist || breach_cf || breach_mc;
  const allBreach = breach_hist && breach_cf && breach_mc;
  const breachCount = [breach_hist, breach_cf, breach_mc].filter(Boolean).length;

  const methods = [
    { label: "Hist CVaR", threshold: var_historical_pct, breached: breach_hist, note: "Basel IV" },
    { label: "CF VaR", threshold: var_cf_pct, breached: breach_cf, note: "Fat-tail adj" },
    { label: "MC CVaR", threshold: cvar_mc_pct, breached: breach_mc, note: "Monte Carlo" },
  ];

  const kupiecColor = kupiec_pass ? "#00FF00" : "#FF4444";
  const kupiecLabel = kupiec_pass ? "PASS" : "FAIL";
  const expectedRate = ((1 - confidence) * 100).toFixed(1);

  return (
    <div className="space-y-3">
      {/* ── Step 1: Today's return ── */}
      <div
        className="p-2 rounded"
        style={{ background: "#111", border: `1px solid ${colors.border}` }}
      >
        <div className="text-[8px] font-bold mb-1.5" style={{ color: colors.textSecondary }}>
          STEP 1 — MOST RECENT SESSION RETURN
        </div>
        <div className="flex items-center gap-3">
          <span
            className="text-lg font-bold font-mono"
            style={{ color: isLoss ? "#FF4444" : "#00FF00" }}
          >
            {today_return_pct >= 0 ? "+" : ""}
            {today_return_pct.toFixed(3)}%
          </span>
          {anyBreach ? (
            <span
              className="text-[8px] px-2 py-0.5 rounded font-bold"
              style={{ background: "#2a0000", border: "1px solid #FF4444", color: "#FF4444" }}
            >
              ⚠ VaR BREACH — {breachCount}/3 methods exceeded
            </span>
          ) : (
            <span
              className="text-[8px] px-2 py-0.5 rounded font-bold"
              style={{ background: "#001a00", border: "1px solid #00FF0044", color: "#00FF00" }}
            >
              ✓ NO BREACH
            </span>
          )}
        </div>
      </div>

      {/* ── Step 2: Per-method breach table ── */}
      <div
        className="p-2 rounded"
        style={{ background: "#111", border: `1px solid ${colors.border}` }}
      >
        <div className="text-[8px] font-bold mb-1.5" style={{ color: colors.textSecondary }}>
          STEP 2 — 3-METHOD BREACH CHECK (95% 1D VaR)
        </div>
        <table className="w-full text-[8px]">
          <thead>
            <tr style={{ color: colors.textSecondary }}>
              <th className="text-left font-normal pb-1">Method</th>
              <th className="text-right font-normal pb-1">Threshold</th>
              <th className="text-right font-normal pb-1">Today's loss</th>
              <th className="text-right font-normal pb-1">Note</th>
              <th className="text-right font-normal pb-1">Status</th>
            </tr>
          </thead>
          <tbody>
            {methods.map((m) => (
              <tr key={m.label} className="border-t" style={{ borderColor: colors.border }}>
                <td className="py-1 font-bold" style={{ color: colors.text }}>
                  {m.label}
                </td>
                <td className="py-1 text-right font-mono" style={{ color: colors.textSecondary }}>
                  {m.threshold.toFixed(2)}%
                </td>
                <td
                  className="py-1 text-right font-mono"
                  style={{ color: isLoss ? "#FF4444" : "#00FF00" }}
                >
                  {Math.abs(today_return_pct).toFixed(3)}%
                </td>
                <td className="py-1 text-right text-[7px]" style={{ color: "#555" }}>
                  {m.note}
                </td>
                <td className="py-1 text-right">
                  {m.breached ? (
                    <span className="font-bold" style={{ color: "#FF4444" }}>
                      ✗ EXCEEDED
                    </span>
                  ) : (
                    <span style={{ color: "#00FF00" }}>✓ WITHIN</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Decision node */}
        <div className="mt-2 pt-2 border-t" style={{ borderColor: colors.border }}>
          {!anyBreach && (
            <div
              className="flex items-center gap-2 p-1.5 rounded"
              style={{ background: "#001a00", border: "1px solid #00FF0044" }}
            >
              <span className="text-[8px] font-bold" style={{ color: "#00FF00" }}>
                ✓ 0/3 methods breached — Normal session
              </span>
            </div>
          )}
          {anyBreach && allBreach && (
            <div
              className="p-1.5 rounded"
              style={{ background: "#2a0000", border: "1px solid #FF4444" }}
            >
              <div className="text-[8px] font-bold" style={{ color: "#FF4444" }}>
                ⚠ 3/3 methods breached → TAIL EVENT
              </div>
              <div className="text-[8px] mt-0.5" style={{ color: "#ff9900" }}>
                → Reduce exposure 50% + log breach date + re-check sizing
              </div>
            </div>
          )}
          {anyBreach && !allBreach && (
            <div
              className="p-1.5 rounded"
              style={{ background: "#1a1000", border: "1px solid #ff9900" }}
            >
              <div className="text-[8px] font-bold" style={{ color: "#ff9900" }}>
                ⚠ {breachCount}/3 methods breached → MODEL-SPECIFIC ISSUE
              </div>
              <div className="text-[8px] mt-0.5 space-y-0.5">
                {!breach_hist && (breach_cf || breach_mc) && (
                  <div style={{ color: colors.textSecondary }}>
                    → Hist CVaR within limit — fat-tail / correlation model diverging
                  </div>
                )}
                {breach_hist && !breach_cf && !breach_mc && (
                  <div style={{ color: colors.textSecondary }}>
                    → Historical model flagging — Cornish-Fisher + MC agree loss is normal
                  </div>
                )}
                {methods
                  .filter((m) => m.breached)
                  .map((m) => (
                    <div key={m.label} style={{ color: "#ff9900" }}>
                      → Review {m.label} lookback/calibration
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Step 3: Kupiec test ── */}
      <div
        className="p-2 rounded"
        style={{ background: "#111", border: `1px solid ${colors.border}` }}
      >
        <div className="text-[8px] font-bold mb-1.5" style={{ color: colors.textSecondary }}>
          STEP 3 — KUPIEC POF TEST (model validation, {lookback_days}d window)
        </div>

        {var_backtest_signal === "INSUFFICIENT_DATA" ? (
          <div className="text-[8px]" style={{ color: colors.textSecondary }}>
            Insufficient data (&lt;30 days) — cannot run Kupiec test
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 mb-2">
              <div className="p-1.5 rounded text-center" style={{ background: "#0a0a0a" }}>
                <div className="text-[7px]" style={{ color: colors.textSecondary }}>
                  Exceptions
                </div>
                <div className="text-[11px] font-bold font-mono" style={{ color: colors.text }}>
                  {var_backtest_exceptions}/{lookback_days}
                </div>
              </div>
              <div className="p-1.5 rounded text-center" style={{ background: "#0a0a0a" }}>
                <div className="text-[7px]" style={{ color: colors.textSecondary }}>
                  Exception rate
                </div>
                <div
                  className="text-[11px] font-bold font-mono"
                  style={{
                    color:
                      var_backtest_rate > Number.parseFloat(expectedRate) ? "#FF4444" : "#00FF00",
                  }}
                >
                  {var_backtest_rate.toFixed(1)}%
                  <span className="text-[7px] ml-1" style={{ color: colors.textSecondary }}>
                    (exp {expectedRate}%)
                  </span>
                </div>
              </div>
              <div className="p-1.5 rounded text-center" style={{ background: "#0a0a0a" }}>
                <div className="text-[7px]" style={{ color: colors.textSecondary }}>
                  Kupiec p-value
                </div>
                <div className="text-[11px] font-bold font-mono" style={{ color: kupiecColor }}>
                  {kupiec_pvalue.toFixed(3)}
                </div>
              </div>
            </div>

            {/* Decision */}
            <div
              className="p-1.5 rounded flex items-center gap-2"
              style={{
                background: kupiec_pass ? "#001a00" : "#1a0000",
                border: `1px solid ${kupiecColor}44`,
              }}
            >
              <span className="text-[8px] font-bold" style={{ color: kupiecColor }}>
                {kupiec_pass
                  ? `✓ PASS (p=${kupiec_pvalue.toFixed(3)} > 0.05) — Model adequate, keep`
                  : `✗ FAIL (p=${kupiec_pvalue.toFixed(3)} ≤ 0.05) — Recalibrate lookback/method`}
              </span>
            </div>

            {!kupiec_pass && (
              <div
                className="mt-1.5 text-[7px] space-y-0.5"
                style={{ color: colors.textSecondary }}
              >
                <div>→ Try shorter lookback (63d or 126d) to adapt to current regime</div>
                <div>→ Switch from Gaussian to Historical VaR as primary model</div>
                <div>→ Consider higher confidence level (97.5%) if tail events cluster</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Breach log note ── */}
      <div className="text-[7px] px-1" style={{ color: "#444" }}>
        "Most recent session" = last trading day in yfinance data (~15–30min delayed). Kupiec POF
        test uses {lookback_days}d historical exception count vs binomial null H₀.
      </div>
    </div>
  );
}

// ── VaR horizon scaling (square-root-of-time) ───────────────────────────────
const VAR_HORIZONS = [
  { label: "1D", days: 1 },
  { label: "1W", days: 5 },
  { label: "1M", days: 21 },
  { label: "3M", days: 63 },
  { label: "6M", days: 126 },
] as const;

// ── Ensemble helper components ───────────────────────────────────────────────

function EnsembleSignalBadge({ signal }: { signal: RiskMetrics["ensemble_signal"] }) {
  const cfg = {
    STABLE: { label: "STABLE", bg: "#001a00", border: "#00FF0044", color: "#00FF00" },
    FAT_TAIL_RISK: { label: "FAT TAIL ⚠", bg: "#1a1000", border: "#ff990077", color: "#ff9900" },
    CORRELATION_RISK: {
      label: "CORR RISK ⚠",
      bg: "#1a0000",
      border: "#FF444477",
      color: "#FF4444",
    },
  }[signal];
  return (
    <span
      className="text-[7px] px-1 py-0.5 rounded font-bold"
      style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color }}
    >
      {cfg.label}
    </span>
  );
}

function BacktestBadge({
  signal,
  exceptions,
  rate,
  lookback,
}: {
  signal: RiskMetrics["var_backtest_signal"];
  exceptions: number;
  rate: number;
  lookback: number;
}) {
  if (signal === "INSUFFICIENT_DATA") return null;
  const color = signal === "GREEN" ? "#00FF00" : signal === "YELLOW" ? "#ff9900" : "#FF4444";
  const dot = signal === "GREEN" ? "🟢" : signal === "YELLOW" ? "🟡" : "🔴";
  return (
    <span
      className="text-[7px] px-1 py-0.5 rounded font-mono"
      title={`VaR Backtest: ${exceptions} exceptions / ${lookback}d (${rate.toFixed(1)}%)`}
      style={{ background: "#111", border: `1px solid ${color}44`, color }}
    >
      {dot} BT {rate.toFixed(1)}%
    </span>
  );
}

function EnsembleRow({
  label,
  pct,
  amt,
  note,
  color,
  sym,
}: {
  label: string;
  pct: number;
  amt: number;
  note: string;
  color: string;
  sym: string;
}) {
  return (
    <tr>
      <td className="py-0.5 font-bold" style={{ color }}>
        {label}
      </td>
      <td className="text-right py-0.5 font-mono" style={{ color }}>
        {pct.toFixed(2)}%
      </td>
      <td className="text-right py-0.5 font-mono text-[7px]" style={{ color: "#888" }}>
        {sym}
        {fmtK(amt)}
      </td>
      <td className="text-right py-0.5 text-[7px]" style={{ color: "#666" }}>
        {note}
      </td>
    </tr>
  );
}

function RegimeBadge({
  regime,
  stressedPct,
  stressedAmt,
  sym,
}: {
  regime: RiskMetrics["vol_regime"];
  stressedPct: number;
  stressedAmt: number;
  sym: string;
}) {
  const cfg = {
    CALM: { color: "#00FF00", label: "Vol: CALM" },
    ELEVATED: { color: "#ff9900", label: "Vol: ELEVATED" },
    STRESSED: { color: "#FF4444", label: "Vol: STRESSED" },
    UNKNOWN: { color: "#666", label: "Vol: UNKNOWN" },
  }[regime];
  return (
    <span style={{ color: cfg.color }}>
      {cfg.label}
      {(regime === "STRESSED" || regime === "ELEVATED") && stressedPct > 0 && (
        <span style={{ color: "#FF4444", marginLeft: 4 }}>
          · Stressed CVaR: {stressedPct.toFixed(2)}% ({sym}
          {fmtK(stressedAmt)})
        </span>
      )}
    </span>
  );
}

// ── Overview Section ─────────────────────────────────────────────────────────

function OverviewSection({
  metrics,
  colors,
  sym,
  riskColor,
  accountId,
}: {
  metrics: RiskMetrics;
  colors: Colors;
  sym: string;
  riskColor: (s: number) => string;
  accountId: string;
}) {
  const [varHorizon, setVarHorizon] = useState<(typeof VAR_HORIZONS)[number]>(VAR_HORIZONS[0]);
  const [acctOpen, setAcctOpen] = useState(false);
  const [chartView, setChartView] = useState<"contrib" | "parity">("contrib");
  const [parity, setParity] = useState<ParityData | null>(null);
  const [parityLoading, setParityLoading] = useState(false);
  const scoreColor = riskColor(metrics.risk_score);

  useEffect(() => {
    if (chartView !== "parity" || parity || parityLoading) return;
    const ac = new AbortController();
    setParityLoading(true);
    const qs = accountId !== "all" ? `&account_id=${accountId}` : "";
    fetch(`/api/v2/portfolio/risk/risk-parity?lookback=252${qs}`, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((d) => setParity(d))
      .catch((e) => {
        if (e?.name === "AbortError") return;
      })
      .finally(() => setParityLoading(false));
    return () => ac.abort();
  }, [chartView, parity, parityLoading, accountId]);
  const scale = Math.sqrt(varHorizon.days);
  const breachCount = [metrics.breach_hist, metrics.breach_cf, metrics.breach_mc].filter(
    Boolean
  ).length;

  return (
    <div className="space-y-1.5">
      {/* ── HEADER: Score · Regime · Vol · Horizon · Today · Trim ── */}
      <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: "#111" }}>
        {/* Risk score */}
        <div className="flex items-baseline gap-1 shrink-0">
          <span className="text-base font-bold font-mono" style={{ color: scoreColor }}>
            {metrics.risk_score.toFixed(0)}
          </span>
          <span className="text-[6px]" style={{ color: colors.textSecondary }}>
            RISK
          </span>
        </div>
        <div className="w-px h-4 shrink-0" style={{ background: colors.border }} />
        {/* Vol regime */}
        {metrics.vol_regime !== "UNKNOWN" && (
          <div className="text-[7px] shrink-0">
            <RegimeBadge
              regime={metrics.vol_regime}
              stressedPct={metrics.cvar_stressed_pct * scale}
              sym={sym}
              stressedAmt={metrics.cvar_stressed_amount * scale}
            />
          </div>
        )}
        {/* Vol */}
        <span className="text-[7px] font-mono shrink-0" style={{ color: colors.textSecondary }}>
          σ {metrics.volatility_annual_pct.toFixed(1)}%ann ·{" "}
          {metrics.volatility_daily_pct.toFixed(3)}%d
        </span>
        {/* Horizon selector */}
        <div className="flex items-center gap-0 ml-auto shrink-0">
          <span className="text-[6px] mr-1" style={{ color: colors.textSecondary }}>
            HRZ
          </span>
          {VAR_HORIZONS.map((h) => (
            <button
              type="button"
              key={h.label}
              className="text-[7px] px-1.5 py-0.5 font-bold"
              style={{
                color: varHorizon.label === h.label ? colors.accent : colors.textSecondary,
                borderBottom:
                  varHorizon.label === h.label
                    ? `1px solid ${colors.accent}`
                    : "1px solid transparent",
              }}
              onClick={() => setVarHorizon(h)}
            >
              {h.label}
            </button>
          ))}
        </div>
        <div className="w-px h-4 shrink-0" style={{ background: colors.border }} />
        {/* Today return */}
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[6px]" style={{ color: colors.textSecondary }}>
            TODAY
          </span>
          <span
            className="text-[8px] font-mono font-bold"
            style={{ color: metrics.today_return_pct >= 0 ? "#00FF00" : "#FF4444" }}
          >
            {metrics.today_return_pct >= 0 ? "+" : ""}
            {metrics.today_return_pct.toFixed(2)}%
          </span>
        </div>
        {/* Trim chips */}
        {metrics.trim_signals.length > 0 && (
          <>
            <div className="w-px h-4 shrink-0" style={{ background: colors.border }} />
            <div className="flex items-center gap-0.5 flex-wrap">
              <AlertTriangle className="h-2.5 w-2.5 shrink-0" style={{ color: "#FF4444" }} />
              {metrics.trim_signals.map((s) => (
                <span
                  key={s.symbol}
                  className="text-[6px] px-1 py-0.5 rounded font-mono"
                  style={{
                    background: s.action === "TRIM" ? "#2a0000" : "#001a00",
                    border: `1px solid ${s.action === "TRIM" ? "#FF444433" : "#00FF0033"}`,
                    color: s.action === "TRIM" ? "#FF6666" : "#4ade80",
                  }}
                  title={s.reason}
                >
                  {s.action === "TRIM"
                    ? `${s.symbol} −${s.suggested_trim_pct}%${s.shares_to_trim != null ? ` (${s.shares_to_trim}sh)` : ""}`
                    : `${s.symbol} BUY${s.shares_to_buy != null ? ` +${s.shares_to_buy}sh` : ""}`}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── REBALANCE SIGNALS detail panel ── */}
      {metrics.trim_signals.length > 0 &&
        (() => {
          const trimList = metrics.trim_signals.filter((s) => s.action === "TRIM");
          const buyList = metrics.trim_signals.filter((s) => s.action === "BUY");
          const rcTarget = (100 / metrics.n_positions).toFixed(1);
          const rowBg = (action: string) => (action === "TRIM" ? "#140000" : "#001400");
          const accentColor = (action: string) => (action === "TRIM" ? "#FF6666" : "#4ade80");
          return (
            <div className="rounded space-y-0" style={{ border: "1px solid #333" }}>
              {/* Header */}
              <div
                className="flex items-center gap-2 px-2 py-1 rounded-t"
                style={{ background: "#0d0d0d" }}
              >
                <AlertTriangle className="h-3 w-3" style={{ color: "#ff9900" }} />
                <span className="text-[8px] font-bold" style={{ color: "#ff9900" }}>
                  ERC REBALANCE SIGNALS
                </span>
                {trimList.length > 0 && (
                  <span
                    className="text-[7px] px-1 rounded font-bold"
                    style={{
                      background: "#2a0000",
                      border: "1px solid #FF444433",
                      color: "#FF4444",
                    }}
                  >
                    {trimList.length} TRIM
                  </span>
                )}
                {buyList.length > 0 && (
                  <span
                    className="text-[7px] px-1 rounded font-bold"
                    style={{
                      background: "#001a00",
                      border: "1px solid #00FF0033",
                      color: "#4ade80",
                    }}
                  >
                    {buyList.length} BUY
                  </span>
                )}
                <span className="ml-auto text-[7px]" style={{ color: "#555" }}>
                  ERC target = {rcTarget}% · threshold ±5pp
                </span>
              </div>

              {/* Table */}
              <table className="w-full text-[8px] font-mono">
                <thead>
                  <tr style={{ color: "#555", background: "#0a0a0a" }}>
                    <th className="text-left px-2 py-1 font-normal">Action</th>
                    <th className="text-left px-2 py-1 font-normal">Symbol</th>
                    <th className="text-right px-2 py-1 font-normal">RC now</th>
                    <th className="text-right px-2 py-1 font-normal">RC target</th>
                    <th className="text-right px-2 py-1 font-normal">Held shares</th>
                    <th className="text-right px-2 py-1 font-normal">Trade shares</th>
                    <th className="text-right px-2 py-1 font-normal">Mkt price</th>
                    <th className="text-right px-2 py-1 font-normal">Avg cost</th>
                    <th className="text-right px-2 py-1 font-normal">Trade value</th>
                    <th className="text-right px-2 py-1 font-normal">P&amp;L if executed</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.trim_signals.map((s, i) => {
                    const rcNow = (
                      Math.abs(s.excess_rc_pct) +
                      (s.action === "TRIM" ? Number.parseFloat(rcTarget) : 0) -
                      (s.action === "BUY" ? Number.parseFloat(rcTarget) : 0) +
                      Number.parseFloat(rcTarget)
                    ).toFixed(1);
                    const pnlColor =
                      s.trim_pnl == null ? "#555" : s.trim_pnl >= 0 ? "#4ade80" : "#FF4444";
                    return (
                      <tr
                        key={s.symbol}
                        className="border-t"
                        style={{ borderColor: "#222", background: rowBg(s.action) }}
                      >
                        <td
                          className="px-2 py-1 font-bold"
                          style={{ color: accentColor(s.action) }}
                        >
                          {s.action}
                        </td>
                        <td
                          className="px-2 py-1 font-bold"
                          style={{ color: accentColor(s.action) }}
                        >
                          {s.symbol}
                        </td>
                        <td
                          className="px-2 py-1 text-right"
                          style={{ color: s.action === "TRIM" ? "#FF4444" : "#4ade80" }}
                        >
                          {(Number.parseFloat(rcTarget) + s.excess_rc_pct).toFixed(1)}%
                        </td>
                        <td className="px-2 py-1 text-right" style={{ color: "#666" }}>
                          {rcTarget}%
                        </td>
                        <td className="px-2 py-1 text-right" style={{ color: "#aaa" }}>
                          {s.current_shares != null ? s.current_shares.toFixed(2) : "—"}
                        </td>
                        <td
                          className="px-2 py-1 text-right font-bold"
                          style={{ color: accentColor(s.action) }}
                        >
                          {s.action === "TRIM" && s.shares_to_trim != null
                            ? `−${s.shares_to_trim.toFixed(2)}`
                            : s.action === "BUY" && s.shares_to_buy != null
                              ? `+${s.shares_to_buy.toFixed(2)}`
                              : "—"}
                        </td>
                        <td className="px-2 py-1 text-right" style={{ color: "#888" }}>
                          {s.current_price != null
                            ? `${sym}${s.current_price.toLocaleString()}`
                            : "—"}
                        </td>
                        <td className="px-2 py-1 text-right" style={{ color: "#666" }}>
                          {s.avg_entry_price != null
                            ? `${sym}${s.avg_entry_price.toLocaleString()}`
                            : "—"}
                        </td>
                        <td className="px-2 py-1 text-right" style={{ color: "#aaa" }}>
                          {(s.action === "TRIM" ? s.trim_value : s.buy_value) != null
                            ? `${sym}${((s.action === "TRIM" ? s.trim_value : s.buy_value) ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                            : "—"}
                        </td>
                        <td className="px-2 py-1 text-right font-bold" style={{ color: pnlColor }}>
                          {s.action === "TRIM" && s.trim_pnl != null ? (
                            `${s.trim_pnl >= 0 ? "+" : ""}${sym}${s.trim_pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}${s.trim_pnl_pct != null ? ` (${s.trim_pnl_pct >= 0 ? "+" : ""}${s.trim_pnl_pct.toFixed(1)}%)` : ""}`
                          ) : s.action === "BUY" ? (
                            <span style={{ color: "#555" }}>n/a</span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div
                className="px-2 py-1 text-[7px] rounded-b"
                style={{ color: "#444", background: "#0a0a0a" }}
              >
                P&amp;L if executed = (mkt price − avg cost) × shares · based on weighted avg entry
                price across all lots
              </div>
            </div>
          );
        })()}

      {/* ── ROW 2: 9-col compact stats ── */}
      <div className="grid grid-cols-9 gap-px">
        {(
          [
            {
              label: "SHARPE",
              value: metrics.sharpe_ratio.toFixed(2),
              good: metrics.sharpe_ratio > 1,
            },
            {
              label: "SORTINO",
              value: metrics.sortino_ratio.toFixed(2),
              good: metrics.sortino_ratio > 1.5,
            },
            {
              label: "CALMAR",
              value: metrics.calmar_ratio.toFixed(2),
              good: metrics.calmar_ratio > 1,
            },
            {
              label: "MAX DD",
              value: `${metrics.max_drawdown_pct.toFixed(1)}%`,
              good: metrics.max_drawdown_pct < 15,
            },
            {
              label: "CUR DD",
              value: `${metrics.current_drawdown_pct.toFixed(1)}%`,
              good: metrics.current_drawdown_pct < 5,
            },
            {
              label: "DIV",
              value: metrics.diversification_ratio.toFixed(2),
              good: metrics.diversification_ratio > 1.5,
            },
            {
              label: "EFF N",
              value: metrics.effective_n.toFixed(1),
              good: metrics.effective_n > 3,
            },
            { label: "BREACH", value: `${breachCount}/3`, good: breachCount === 0 },
            {
              label: "KUPIEC",
              value: metrics.kupiec_pass ? "PASS" : "FAIL",
              good: metrics.kupiec_pass,
            },
          ] as const
        ).map(({ label, value, good }) => (
          <div
            key={label}
            className="flex flex-col items-center justify-center py-1 rounded"
            style={{ background: "#111" }}
          >
            <span className="text-[6px]" style={{ color: colors.textSecondary }}>
              {label}
            </span>
            <span
              className="text-[8px] font-mono font-bold"
              style={{ color: good ? "#00FF00" : "#FF4444" }}
            >
              {value}
            </span>
          </div>
        ))}
      </div>

      {/* ── ROW 3: 2-col layout — Left: VaR detail | Right: Chart + Correlation ── */}
      <div className="grid grid-cols-5 gap-2">
        {/* LEFT 2/5: VaR table + backtest block */}
        <div className="col-span-2 space-y-1.5">
          <div
            className="p-2 rounded"
            style={{ background: "#111", border: `1px solid ${colors.border}` }}
          >
            <div className="flex items-center gap-1 mb-1">
              <TrendingDown className="h-3 w-3" style={{ color: colors.textSecondary }} />
              <span className="text-[7px]" style={{ color: colors.textSecondary }}>
                ENSEMBLE VaR/CVaR 95%
              </span>
              <EnsembleSignalBadge signal={metrics.ensemble_signal} />
              <BacktestBadge
                signal={metrics.var_backtest_signal}
                exceptions={metrics.var_backtest_exceptions}
                rate={metrics.var_backtest_rate}
                lookback={metrics.lookback_days}
              />
            </div>
            <table className="w-full text-[7px]">
              <thead>
                <tr style={{ color: colors.textSecondary }}>
                  <th className="text-left font-normal pb-0.5">Method</th>
                  <th className="text-right font-normal pb-0.5">%</th>
                  <th className="text-right font-normal pb-0.5">{sym}</th>
                  <th className="text-right font-normal pb-0.5">●</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    {
                      label: "Hist CVaR",
                      pct: metrics.cvar_pct * scale,
                      amt: metrics.cvar_amount * scale,
                      color: "#ff9900",
                      breach: metrics.breach_hist,
                    },
                    {
                      label: "CF VaR",
                      pct: metrics.var_cf_pct * scale,
                      amt: metrics.var_cf_amount * scale,
                      color: metrics.ensemble_signal === "FAT_TAIL_RISK" ? "#FF4444" : colors.text,
                      breach: metrics.breach_cf,
                    },
                    {
                      label: "MC CVaR",
                      pct: metrics.cvar_mc_pct * scale,
                      amt: metrics.cvar_mc_amount * scale,
                      color:
                        metrics.ensemble_signal === "CORRELATION_RISK" ? "#FF4444" : colors.text,
                      breach: metrics.breach_mc,
                    },
                  ] as const
                ).map((row) => (
                  <tr key={row.label}>
                    <td style={{ color: colors.textSecondary }}>{row.label}</td>
                    <td className="text-right font-mono" style={{ color: row.color }}>
                      {row.pct.toFixed(2)}%
                    </td>
                    <td
                      className="text-right font-mono text-[6px]"
                      style={{ color: colors.textSecondary }}
                    >
                      {sym}
                      {fmtK(row.amt)}
                    </td>
                    <td
                      className="text-right"
                      style={{ color: row.breach ? "#FF4444" : "#444444" }}
                    >
                      ●
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div
              className="mt-1 pt-1 border-t flex items-baseline justify-between"
              style={{ borderColor: colors.border }}
            >
              <span className="text-[6px]" style={{ color: colors.textSecondary }}>
                Conservative
              </span>
              <span className="text-[9px] font-bold" style={{ color: "#FF4444" }}>
                {(metrics.ensemble_conservative_pct * scale).toFixed(2)}%
              </span>
              <span className="text-[6px]" style={{ color: colors.textSecondary }}>
                {sym}
                {fmtK(metrics.ensemble_conservative_amount * scale)}
              </span>
            </div>
            {metrics.cvar_ci_lo > 0 && (
              <div
                className="text-[6px] mt-0.5"
                style={{ color: metrics.cvar_ci_width_ratio > 1.5 ? "#ff9900" : "#555" }}
              >
                CI {(metrics.cvar_ci_lo * scale).toFixed(2)}%–
                {(metrics.cvar_ci_hi * scale).toFixed(2)}%
                {metrics.cvar_ci_width_ratio > 1.5 && " ⚠ wide"}
                {varHorizon.days > 1 && <span className="opacity-40"> ×√{varHorizon.days}</span>}
              </div>
            )}
          </div>

          {/* Backtest / Kupiec block */}
          <div
            className="px-2 py-1.5 rounded text-[7px] space-y-0.5"
            style={{ background: "#111" }}
          >
            <div className="flex items-center justify-between">
              <span style={{ color: colors.textSecondary }}>Backtest rate</span>
              <span
                className="font-mono"
                style={{
                  color:
                    metrics.var_backtest_signal === "GREEN"
                      ? "#00FF00"
                      : metrics.var_backtest_signal === "YELLOW"
                        ? "#ff9900"
                        : "#FF4444",
                }}
              >
                {(metrics.var_backtest_rate * 100).toFixed(1)}%
              </span>
              <span style={{ color: colors.textSecondary }}>
                ({metrics.var_backtest_exceptions} exc / {metrics.lookback_days}d)
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span style={{ color: colors.textSecondary }}>Kupiec p-val</span>
              <span
                className="font-mono"
                style={{ color: metrics.kupiec_pass ? "#00FF00" : "#FF4444" }}
              >
                {metrics.kupiec_pvalue?.toFixed(3) ?? "—"}
              </span>
              <span style={{ color: metrics.kupiec_pass ? "#00FF00" : "#FF4444" }}>
                {metrics.kupiec_pass ? "PASS" : "FAIL"}
              </span>
            </div>
          </div>
        </div>

        {/* RIGHT 3/5: Chart toggle + Correlation */}
        <div className="col-span-3 space-y-1.5">
          {metrics.assets.length > 0 && (
            <div>
              <div className="flex items-center gap-0 mb-1">
                {(["contrib", "parity"] as const).map((v) => (
                  <button
                    type="button"
                    key={v}
                    onClick={() => setChartView(v)}
                    className="text-[7px] px-1.5 py-0.5 font-bold"
                    style={{
                      color: chartView === v ? colors.accent : colors.textSecondary,
                      borderBottom:
                        chartView === v ? `1px solid ${colors.accent}` : "1px solid transparent",
                    }}
                  >
                    {v === "contrib" ? "RISK CONTRIB" : "ERC PARITY"}
                  </button>
                ))}
              </div>

              {chartView === "contrib" && (
                <ResponsiveContainer width="100%" height={Math.max(70, metrics.assets.length * 14)}>
                  <BarChart data={metrics.assets} layout="vertical" margin={{ left: 56, right: 6 }}>
                    <XAxis type="number" tick={{ fontSize: 7, fill: colors.textSecondary }} />
                    <YAxis
                      type="category"
                      dataKey="symbol"
                      tick={{ fontSize: 7, fill: colors.text }}
                      width={54}
                      interval={0}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#111",
                        border: `1px solid ${colors.border}`,
                        fontSize: 8,
                      }}
                    />
                    <Bar dataKey="weight_pct" name="Weight %" fill="#3b82f6" barSize={5} />
                    <Bar dataKey="risk_contribution_pct" name="Risk Contrib %" barSize={5}>
                      {metrics.assets.map((a) => (
                        <Cell
                          key={a.symbol}
                          fill={
                            a.risk_contribution_pct > a.weight_pct * 1.5 ? "#FF4444" : "#ff9900"
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}

              {chartView === "parity" && (
                <>
                  {parityLoading && (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin" style={{ color: colors.accent }} />
                    </div>
                  )}
                  {!parityLoading &&
                    parity &&
                    parity.current_weights.length > 0 &&
                    (() => {
                      const combined = parity.current_weights.map((c, i) => ({
                        symbol: c.symbol,
                        current: c.weight_pct,
                        optimal: parity.optimal_weights[i]?.weight_pct ?? 0,
                      }));
                      return (
                        <>
                          <ResponsiveContainer
                            width="100%"
                            height={Math.max(70, combined.length * 14)}
                          >
                            <BarChart
                              data={combined}
                              layout="vertical"
                              margin={{ left: 56, right: 6 }}
                            >
                              <XAxis
                                type="number"
                                tick={{ fontSize: 7, fill: colors.textSecondary }}
                                unit="%"
                              />
                              <YAxis
                                type="category"
                                dataKey="symbol"
                                tick={{ fontSize: 7, fill: colors.text }}
                                width={54}
                                interval={0}
                              />
                              <Tooltip
                                contentStyle={{
                                  background: "#111",
                                  border: `1px solid ${colors.border}`,
                                  fontSize: 8,
                                }}
                              />
                              <Bar dataKey="current" name="Current %" fill="#3b82f6" barSize={5} />
                              <Bar
                                dataKey="optimal"
                                name="Optimal ERC %"
                                fill="#00FF00"
                                barSize={5}
                              />
                            </BarChart>
                          </ResponsiveContainer>
                          {parity.rebalance_actions.length > 0 ? (
                            <div className="mt-1 space-y-0.5">
                              {parity.rebalance_actions.map((a) => (
                                <div
                                  key={a.symbol}
                                  className="flex items-center gap-1 text-[7px] px-1 py-0.5 rounded"
                                  style={{ background: "#111" }}
                                >
                                  <span
                                    className="w-7 font-bold"
                                    style={{ color: a.action === "BUY" ? "#00FF00" : "#FF4444" }}
                                  >
                                    {a.action}
                                  </span>
                                  <span className="font-bold" style={{ color: colors.text }}>
                                    {a.symbol}
                                  </span>
                                  <span style={{ color: colors.textSecondary }}>
                                    {a.current_weight_pct.toFixed(1)}%→
                                    {a.optimal_weight_pct.toFixed(1)}%
                                  </span>
                                  <span
                                    className="ml-auto font-mono"
                                    style={{ color: a.drift_pct > 0 ? "#00FF00" : "#FF4444" }}
                                  >
                                    {a.drift_pct > 0 ? "+" : ""}
                                    {a.drift_pct.toFixed(1)}%
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div
                              className="flex items-center gap-1 text-[7px] mt-1"
                              style={{ color: "#00FF00" }}
                            >
                              <Shield className="h-2.5 w-2.5" /> Within ERC tolerance
                            </div>
                          )}
                        </>
                      );
                    })()}
                  {!parityLoading && (!parity || parity.current_weights.length === 0) && (
                    <div
                      className="text-[7px] py-4 text-center"
                      style={{ color: colors.textSecondary }}
                    >
                      Need ≥2 positions with price history
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          <CorrelationSection metrics={metrics} colors={colors} />
        </div>
      </div>

      {/* ── ROW 4: EWS History Heatmap ── */}
      <EWSHistorySection accountId={accountId} colors={colors} />

      {/* ── ROW 5: Account breakdown (collapsible) ── */}
      {accountId === "all" && metrics.account_breakdown && (
        <div className="rounded" style={{ border: `1px solid ${colors.border}` }}>
          <button
            type="button"
            className="w-full flex items-center gap-2 px-2 py-1"
            onClick={() => setAcctOpen((o) => !o)}
          >
            <span className="text-[8px] font-bold" style={{ color: colors.textSecondary }}>
              ACCOUNT BREAKDOWN
            </span>
            <span className="ml-auto text-[8px]" style={{ color: colors.textSecondary }}>
              {acctOpen ? "▾" : "▸"}
            </span>
          </button>
          {acctOpen && (
            <div className="grid grid-cols-3 gap-1 px-2 pb-2">
              {Object.entries(metrics.account_breakdown).map(([aid, m]) => (
                <div key={aid} className="p-1.5 rounded" style={{ background: "#111" }}>
                  <div className="text-[8px] font-bold" style={{ color: colors.accent }}>
                    {aid.toUpperCase()}
                  </div>
                  <div
                    className="text-[7px] mt-0.5 space-y-0.5"
                    style={{ color: colors.textSecondary }}
                  >
                    <div>
                      VaR {m.var_parametric_pct.toFixed(2)}% · Vol{" "}
                      {m.volatility_annual_pct.toFixed(1)}%
                    </div>
                    <div>
                      Sharpe {m.sharpe_ratio.toFixed(2)} · DD {m.max_drawdown_pct.toFixed(1)}%
                    </div>
                    <div style={{ color: riskColor(m.risk_score) }}>
                      Score {m.risk_score.toFixed(0)} · N={m.n_positions}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── VaR Breach compact card (used inline in Overview) ────────────────────────

function VaRBreachCompact({ metrics, colors }: { metrics: RiskMetrics; colors: Colors }) {
  const {
    today_return_pct,
    breach_hist,
    breach_cf,
    breach_mc,
    kupiec_pvalue,
    kupiec_pass,
    var_backtest_exceptions,
    var_backtest_rate,
    lookback_days,
    var_backtest_signal,
    confidence,
  } = metrics;

  const breachCount = [breach_hist, breach_cf, breach_mc].filter(Boolean).length;
  const anyBreach = breachCount > 0;
  const allBreach = breachCount === 3;
  const expectedRate = ((1 - confidence) * 100).toFixed(1);
  const kupiecColor = kupiec_pass ? "#00FF00" : "#FF4444";

  const Dot = ({ on }: { on: boolean }) => (
    <span style={{ color: on ? "#FF4444" : "#00FF00", fontSize: 9 }}>●</span>
  );

  return (
    <div
      className="p-2 rounded flex flex-col gap-1.5"
      style={{ background: "#111", border: `1px solid ${colors.border}` }}
    >
      <div className="text-[7px] font-bold" style={{ color: colors.textSecondary }}>
        VaR BREACH CHECK
      </div>

      {/* Today's return + breach badge */}
      <div className="flex items-center gap-1.5">
        <span
          className="text-[12px] font-bold font-mono"
          style={{ color: today_return_pct >= 0 ? "#00FF00" : "#FF4444" }}
        >
          {today_return_pct >= 0 ? "+" : ""}
          {today_return_pct.toFixed(2)}%
        </span>
        {anyBreach ? (
          <span
            className="text-[7px] px-1 py-0.5 rounded font-bold"
            style={{
              background: allBreach ? "#2a0000" : "#1a1000",
              border: `1px solid ${allBreach ? "#FF444455" : "#ff990044"}`,
              color: allBreach ? "#FF4444" : "#ff9900",
            }}
          >
            {allBreach ? "TAIL" : `${breachCount}/3`}
          </span>
        ) : (
          <span
            className="text-[7px] px-1 rounded font-bold"
            style={{ background: "#001a00", border: "1px solid #00FF0033", color: "#00FF00" }}
          >
            OK
          </span>
        )}
      </div>

      {/* Per-method dots */}
      <div className="flex items-center gap-2 text-[7px]" style={{ color: colors.textSecondary }}>
        <Dot on={breach_hist} /> Hist
        <Dot on={breach_cf} /> CF
        <Dot on={breach_mc} /> MC
      </div>

      {/* Kupiec */}
      {var_backtest_signal !== "INSUFFICIENT_DATA" && (
        <div className="pt-1 border-t space-y-0.5" style={{ borderColor: colors.border }}>
          <div className="flex items-center justify-between text-[7px]">
            <span style={{ color: colors.textSecondary }}>Kupiec POF</span>
            <span className="font-bold font-mono" style={{ color: kupiecColor }}>
              {kupiec_pass ? "✓" : "✗"} p={kupiec_pvalue.toFixed(3)}
            </span>
          </div>
          <div className="text-[7px]" style={{ color: colors.textSecondary }}>
            {var_backtest_exceptions}/{lookback_days}d · {var_backtest_rate.toFixed(1)}% exc (exp{" "}
            {expectedRate}%)
          </div>
          {!kupiec_pass && (
            <div className="text-[7px] font-bold" style={{ color: "#FF4444" }}>
              → recalibrate lookback
            </div>
          )}
          {anyBreach && allBreach && (
            <div className="text-[7px] font-bold" style={{ color: "#FF4444" }}>
              → reduce exposure 50%
            </div>
          )}
          {anyBreach && !allBreach && (
            <div className="text-[7px]" style={{ color: "#ff9900" }}>
              → review{" "}
              {[breach_hist && "Hist", breach_cf && "CF", breach_mc && "MC"]
                .filter(Boolean)
                .join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Correlation Matrix ───────────────────────────────────────────────────────

function CorrelationSection({ metrics, colors }: { metrics: RiskMetrics; colors: Colors }) {
  const [open, setOpen] = useState(false);
  const { symbols, matrix } = metrics.correlation_matrix;
  if (!symbols.length) return null;

  const n = symbols.length;
  const abbr = (s: string) => (s.length > 7 ? s.slice(0, 6) : s);

  // Off-diagonal values only
  const offDiag: number[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) offDiag.push(matrix[i][j]);

  const avgCorr = offDiag.length > 0 ? offDiag.reduce((a, b) => a + b, 0) / offDiag.length : 0;

  // High-correlation pairs (> 0.7, upper triangle only)
  const highPairs: { a: string; b: string; v: number }[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (matrix[i][j] >= 0.7) highPairs.push({ a: symbols[i], b: symbols[j], v: matrix[i][j] });
  highPairs.sort((a, b) => b.v - a.v);

  // Cell background: heatmap blend
  const cellBg = (v: number): string => {
    if (v >= 0.8) return "rgba(255,68,68,0.35)";
    if (v >= 0.6) return "rgba(255,68,68,0.18)";
    if (v >= 0.4) return "rgba(255,153,0,0.20)";
    if (v >= 0.2) return "rgba(255,204,0,0.15)";
    if (v >= -0.2) return "rgba(80,80,80,0.10)";
    if (v >= -0.5) return "rgba(59,130,246,0.18)";
    return "rgba(59,130,246,0.32)";
  };
  const cellFg = (v: number): string => {
    if (v >= 0.8) return "#FF6666";
    if (v >= 0.6) return "#ff9900";
    if (v >= 0.4) return "#ffcc00";
    if (v >= 0.2) return "#aaa";
    if (v >= -0.2) return "#555";
    return "#60a5fa";
  };

  const avgColor = avgCorr >= 0.6 ? "#FF4444" : avgCorr >= 0.4 ? "#ff9900" : "#00FF00";

  return (
    <div
      className="rounded"
      style={{ border: `1px solid ${colors.border}`, background: "#0c0c0c" }}
    >
      {/* Header — clickable to collapse */}
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2 py-1.5"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-[9px] font-bold" style={{ color: colors.textSecondary }}>
          CORRELATION MATRIX
        </span>
        <span
          className="text-[7px] px-1 rounded"
          style={{ background: "#1a1a1a", color: colors.textSecondary }}
        >
          Ledoit-Wolf
        </span>
        {/* Summary stats */}
        <span className="text-[8px] font-mono ml-1" style={{ color: avgColor }}>
          avg {avgCorr.toFixed(2)}
        </span>
        {highPairs.length > 0 && (
          <span
            className="text-[7px] px-1 rounded font-bold"
            style={{ background: "#1a0000", border: "1px solid #FF444444", color: "#FF4444" }}
          >
            {highPairs.length} high-corr pair{highPairs.length > 1 ? "s" : ""}
          </span>
        )}
        <span className="ml-auto text-[8px]" style={{ color: colors.textSecondary }}>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="px-2 pb-2">
          {/* High-correlation warnings */}
          {highPairs.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {highPairs.map((p) => (
                <span
                  key={`${p.a}/${p.b}`}
                  className="text-[7px] px-1.5 py-0.5 rounded font-mono font-bold"
                  style={{
                    background: p.v >= 0.85 ? "#2a0000" : "#1a0800",
                    border: `1px solid ${p.v >= 0.85 ? "#FF444444" : "#ff990033"}`,
                    color: p.v >= 0.85 ? "#FF6666" : "#ff9900",
                  }}
                >
                  {abbr(p.a)}/{abbr(p.b)} {p.v.toFixed(2)}
                </span>
              ))}
            </div>
          )}

          {/* Heatmap table */}
          <div className="overflow-x-auto">
            <table style={{ borderCollapse: "separate", borderSpacing: 2 }}>
              <thead>
                <tr>
                  <th style={{ width: 52 }} />
                  {symbols.map((s) => (
                    <th
                      key={s}
                      className="text-center text-[7px] font-bold pb-1"
                      style={{ color: colors.textSecondary, minWidth: 34 }}
                    >
                      {abbr(s)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.map((row, i) => (
                  <tr key={symbols[i]}>
                    <td
                      className="text-[7px] font-bold pr-1.5 text-right"
                      style={{
                        color: colors.text,
                        maxWidth: 52,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {abbr(symbols[i])}
                    </td>
                    {row.map((v, j) => (
                      <td
                        key={symbols[j]}
                        className="text-center font-mono text-[7px]"
                        style={{
                          width: 34,
                          height: 22,
                          background: i === j ? "#1a1a1a" : cellBg(v),
                          color: i === j ? "#333" : cellFg(v),
                          borderRadius: 3,
                          fontWeight: i !== j && Math.abs(v) >= 0.6 ? 700 : 400,
                        }}
                      >
                        {i === j ? "·" : v.toFixed(2)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {[
              { bg: "rgba(255,68,68,0.35)", fg: "#FF6666", label: "≥0.8" },
              { bg: "rgba(255,153,0,0.20)", fg: "#ff9900", label: "0.4–0.8" },
              { bg: "rgba(80,80,80,0.10)", fg: "#555", label: "±0.2" },
              { bg: "rgba(59,130,246,0.32)", fg: "#60a5fa", label: "≤-0.5" },
            ].map((l) => (
              <div key={l.label} className="flex items-center gap-1">
                <div
                  className="w-3 h-3 rounded-sm"
                  style={{ background: l.bg, border: `1px solid ${l.fg}44` }}
                />
                <span className="text-[7px]" style={{ color: l.fg }}>
                  {l.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Risk Parity ──────────────────────────────────────────────────────────────

function ParitySection({
  parity,
  colors,
  sym,
}: { parity: ParityData | null; colors: Colors; sym: string }) {
  if (!parity)
    return (
      <Loader2 className="h-4 w-4 animate-spin mx-auto mt-4" style={{ color: colors.accent }} />
    );

  if (!parity.current_weights.length) {
    return (
      <div className="text-[9px] p-4" style={{ color: colors.textSecondary }}>
        Need at least 2 positions with price history
      </div>
    );
  }

  const combined = parity.current_weights.map((c, i) => ({
    symbol: c.symbol,
    current: c.weight_pct,
    optimal: parity.optimal_weights[i]?.weight_pct ?? 0,
  }));

  return (
    <div>
      <h3 className="text-[9px] font-bold mb-1" style={{ color: colors.textSecondary }}>
        RISK PARITY (ERC) — Current vs Optimal Weights
      </h3>
      <div className="text-[8px] mb-2" style={{ color: colors.textSecondary }}>
        Method: {parity.method} | Equal Risk Contribution via Cyclical Coordinate Descent
      </div>

      <ResponsiveContainer width="100%" height={Math.max(120, combined.length * 24)}>
        <BarChart data={combined} layout="vertical" margin={{ left: 60, right: 10 }}>
          <XAxis type="number" tick={{ fontSize: 8, fill: colors.textSecondary }} unit="%" />
          <YAxis
            type="category"
            dataKey="symbol"
            tick={{ fontSize: 8, fill: colors.text }}
            width={58}
            interval={0}
          />
          <Tooltip
            contentStyle={{ background: "#111", border: `1px solid ${colors.border}`, fontSize: 9 }}
          />
          <Bar dataKey="current" name="Current %" fill="#3b82f6" barSize={5} />
          <Bar dataKey="optimal" name="Optimal (ERC) %" fill="#00FF00" barSize={5} />
        </BarChart>
      </ResponsiveContainer>

      {/* Rebalance Actions */}
      {parity.rebalance_actions.length > 0 && (
        <div className="mt-2">
          <h3 className="text-[9px] font-bold mb-1" style={{ color: colors.textSecondary }}>
            REBALANCE ACTIONS (drift &gt; 3%)
          </h3>
          <div className="space-y-0.5">
            {parity.rebalance_actions.map((a) => (
              <div
                key={a.symbol}
                className="text-[8px] p-1.5 rounded"
                style={{ background: "#111" }}
              >
                <div className="flex items-center">
                  <span
                    className="w-10 font-bold"
                    style={{ color: a.action === "BUY" ? "#00FF00" : "#FF4444" }}
                  >
                    {a.action}
                  </span>
                  <span className="w-16 font-bold" style={{ color: colors.text }}>
                    {a.symbol}
                  </span>
                  <span style={{ color: colors.textSecondary }}>
                    {a.current_weight_pct.toFixed(1)}% → {a.optimal_weight_pct.toFixed(1)}%
                  </span>
                  <span
                    className="ml-auto font-bold"
                    style={{ color: a.drift_pct > 0 ? "#00FF00" : "#FF4444" }}
                  >
                    {a.drift_pct > 0 ? "+" : ""}
                    {a.drift_pct.toFixed(1)}%
                  </span>
                  <span className="ml-2" style={{ color: colors.textSecondary }}>
                    {sym}
                    {fmtK(Math.abs(a.trade_value))}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 pl-10">
                  {a.shares_change != null && a.shares_change !== 0 ? (
                    <span
                      className="font-mono"
                      style={{ color: a.action === "BUY" ? "#4ade80" : "#f87171" }}
                    >
                      {a.action === "BUY" ? "+" : ""}
                      {a.shares_change > 0 ? "+" : ""}
                      {Math.abs(a.shares_change).toFixed(2)} shares
                    </span>
                  ) : a.current_price != null && a.current_price > 0 ? (
                    <span
                      className="font-mono"
                      style={{ color: a.action === "BUY" ? "#4ade80" : "#f87171" }}
                    >
                      {a.action === "BUY" ? "+" : "−"}
                      {Math.abs(a.trade_value / a.current_price).toFixed(2)} shares
                    </span>
                  ) : null}
                  {a.current_price != null && (
                    <span style={{ color: colors.textSecondary }}>
                      @ {sym}
                      {fmt(a.current_price)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {parity.rebalance_actions.length === 0 && (
        <div
          className="mt-2 flex items-center gap-1 text-[9px] p-2 rounded"
          style={{ background: "#001a00", border: "1px solid #00FF0044" }}
        >
          <Shield className="h-3 w-3" style={{ color: "#00FF00" }} />
          <span style={{ color: "#00FF00" }}>
            Portfolio is within risk parity tolerance (drift &lt; 3%)
          </span>
        </div>
      )}
    </div>
  );
}

// ── Shared Components ────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  sub,
  colors,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  colors: Colors;
  icon: React.ReactNode;
}) {
  return (
    <div
      className="p-2 rounded"
      style={{ background: "#111", border: `1px solid ${colors.border}` }}
    >
      <div className="flex items-center gap-1 mb-0.5">
        <span style={{ color: colors.textSecondary }}>{icon}</span>
        <span className="text-[8px]" style={{ color: colors.textSecondary }}>
          {label}
        </span>
      </div>
      <div className="text-[10px] font-bold" style={{ color: colors.text }}>
        {value}
      </div>
      <div className="text-[8px]" style={{ color: colors.textSecondary }}>
        {sub}
      </div>
    </div>
  );
}

function MiniMetric({
  label,
  value,
  good,
  colors,
}: {
  label: string;
  value: string;
  good: boolean;
  colors: Colors;
}) {
  return (
    <div className="text-center p-1 rounded" style={{ background: "#111" }}>
      <div className="text-[8px]" style={{ color: colors.textSecondary }}>
        {label}
      </div>
      <div className="text-[9px] font-bold" style={{ color: good ? "#00FF00" : "#ff9900" }}>
        {value}
      </div>
    </div>
  );
}

// ── OPTIONS RISK SECTION ──────────────────────────────────────────────────────

function gFmt(v: number | undefined, d = 4): string {
  if (v == null) return "—";
  return v >= 0 ? `+${v.toFixed(d)}` : v.toFixed(d);
}

function DiffCell({ diff, d = 4 }: { diff: number | undefined; d?: number }) {
  if (diff == null)
    return (
      <td className="px-1 py-1 text-right text-[8px]" style={{ color: "#555" }}>
        —
      </td>
    );
  const abs = Math.abs(diff);
  const color = abs < 0.0001 ? "#555" : diff > 0 ? "#00FF00" : "#FF4444";
  return (
    <td className="px-1 py-1 text-right text-[8px] font-mono" style={{ color }}>
      {diff >= 0 ? "+" : ""}
      {diff.toFixed(d)}
    </td>
  );
}

function OptionsRiskSection({
  data,
  loading,
  colors,
  onRefresh,
}: { data: OptionsRiskData | null; loading: boolean; colors: Colors; onRefresh: () => void }) {
  const [expandGreeks, setExpandGreeks] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
      </div>
    );
  }
  if (!data) return null;
  if (data.positions.length === 0) {
    return (
      <div className="py-8 text-center text-[10px]" style={{ color: colors.textSecondary }}>
        No open option positions
      </div>
    );
  }

  const { positions, portfolio } = data;
  const thetaColor = portfolio.total_theta_adj_day < 0 ? "#FF4444" : "#00FF00";

  return (
    <div className="space-y-3">
      {/* Expiry alerts */}
      {portfolio.expiry_alerts.length > 0 && (
        <div className="space-y-1">
          {portfolio.expiry_alerts.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-2 px-2 py-1 rounded text-[9px] border"
              style={{
                background: a.level === "critical" ? "#FF444411" : "#ff990011",
                borderColor: a.level === "critical" ? "#FF4444" : "#ff9900",
                color: a.level === "critical" ? "#FF4444" : "#ff9900",
              }}
            >
              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
              <span className="font-bold">
                {a.underlying} {a.strike}
                {a.option_type === "call" ? "C" : "P"}
              </span>
              <span>expires {a.expiry}</span>
              <span className="font-bold ml-auto">{a.days_to_exp}d remaining</span>
            </div>
          ))}
        </div>
      )}

      {/* Short position warning */}
      {portfolio.has_short_positions && (
        <div
          className="flex items-center gap-2 px-2 py-1.5 rounded text-[9px] border"
          style={{ background: "#FF444411", borderColor: "#FF4444", color: "#FF4444" }}
        >
          <AlertTriangle className="h-3 w-3 flex-shrink-0" />
          <span className="font-bold">
            SHORT positions detected — potential unlimited loss on short calls
          </span>
        </div>
      )}

      {/* Portfolio summary cards */}
      <div className="grid grid-cols-3 gap-2">
        <div
          className="p-2 rounded"
          style={{ background: "#111", border: `1px solid ${colors.border}` }}
        >
          <div className="text-[8px] mb-1" style={{ color: colors.textSecondary }}>
            PREMIUM AT RISK
          </div>
          <div className="text-[12px] font-bold font-mono" style={{ color: "#FF4444" }}>
            ${portfolio.total_premium_at_risk.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </div>
          <div className="text-[8px]" style={{ color: colors.textSecondary }}>
            max loss (long only)
          </div>
        </div>
        <div
          className="p-2 rounded"
          style={{ background: "#111", border: `1px solid ${colors.border}` }}
        >
          <div className="text-[8px] mb-1" style={{ color: colors.textSecondary }}>
            DAILY THETA BLEED (Adj)
          </div>
          <div className="text-[12px] font-bold font-mono" style={{ color: thetaColor }}>
            {portfolio.total_theta_adj_day >= 0 ? "+" : ""}$
            {Math.abs(portfolio.total_theta_adj_day).toFixed(2)}
          </div>
          <div className="text-[8px]" style={{ color: colors.textSecondary }}>
            BS: {portfolio.total_theta_day >= 0 ? "+" : ""}$
            {Math.abs(portfolio.total_theta_day).toFixed(2)}/day
          </div>
        </div>
        <div
          className="p-2 rounded"
          style={{ background: "#111", border: `1px solid ${colors.border}` }}
        >
          <div className="text-[8px] mb-1" style={{ color: colors.textSecondary }}>
            POSITIONS
          </div>
          <div className="text-[12px] font-bold font-mono" style={{ color: colors.text }}>
            {positions.length}
          </div>
          <div className="text-[8px]" style={{ color: colors.textSecondary }}>
            {positions.filter((p) => p.quantity > 0).length} long ·{" "}
            {positions.filter((p) => p.quantity < 0).length} short
          </div>
        </div>
      </div>

      {/* Net delta by underlying */}
      {Object.keys(portfolio.net_delta_by_underlying).length > 0 && (
        <div>
          <div className="text-[9px] font-bold mb-1" style={{ color: colors.accent }}>
            NET DELTA (shares equivalent)
          </div>
          <table className="w-full text-[9px] font-mono">
            <thead>
              <tr style={{ color: colors.textSecondary }}>
                <th className="text-left px-1 py-0.5">Underlying</th>
                <th className="text-right px-1 py-0.5">BS Delta</th>
                <th className="text-right px-1 py-0.5">Adj Delta (GC)</th>
                <th className="text-right px-1 py-0.5">Fat-tail impact</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(portfolio.net_delta_by_underlying).map(([sym, d]) => (
                <tr key={sym} className="border-b" style={{ borderColor: colors.border }}>
                  <td className="px-1 py-1 font-bold" style={{ color: colors.text }}>
                    {sym}
                  </td>
                  <td
                    className="px-1 py-1 text-right"
                    style={{ color: d.bs >= 0 ? "#00FF00" : "#FF4444" }}
                  >
                    {d.bs >= 0 ? "+" : ""}
                    {d.bs.toFixed(1)}
                  </td>
                  <td
                    className="px-1 py-1 text-right font-bold"
                    style={{ color: d.adj >= 0 ? "#00FF00" : "#FF4444" }}
                  >
                    {d.adj >= 0 ? "+" : ""}
                    {d.adj.toFixed(1)}
                  </td>
                  <DiffCell diff={d.adj - d.bs} d={1} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-position Greeks table */}
      <div>
        <div className="text-[9px] font-bold mb-1" style={{ color: colors.accent }}>
          GREEKS PER POSITION
          <span className="font-normal ml-2 opacity-60">click row to expand BS vs Adj</span>
        </div>
        <div className="text-[8px] mb-1 flex items-center gap-1" style={{ color: "#f59e0b" }}>
          <Clock className="h-2.5 w-2.5" />
          Adj = Gram-Charlier fat-tail correction · skew + excess kurtosis from 252d history
        </div>
        <table className="w-full text-[9px] font-mono">
          <thead>
            <tr style={{ color: colors.textSecondary }}>
              {[
                "Contract",
                "Qty",
                "DTE",
                "IV%",
                "Δ adj",
                "Γ adj",
                "Θ adj/day",
                "V adj",
                "Max loss",
              ].map((h) => (
                <th
                  key={h}
                  className={`px-1 py-0.5 ${h === "Contract" ? "text-left" : "text-right"}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const g = p.greeks;
              const isExpanded = expandGreeks === p.id;
              const typeColor = p.option_type === "call" ? "#00FF00" : "#FF4444";
              const hasGreeks = g && !g.error && g.iv != null && g.delta_adj != null;
              return (
                <React.Fragment key={p.id}>
                  <tr
                    className="border-b cursor-pointer hover:opacity-80"
                    style={{ borderColor: colors.border }}
                    onClick={() => setExpandGreeks(isExpanded ? null : p.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ")
                        setExpandGreeks(isExpanded ? null : p.id);
                    }}
                  >
                    <td className="px-1 py-1">
                      <span className="font-bold" style={{ color: colors.text }}>
                        {p.underlying}
                      </span>
                      <span
                        className="text-[8px] ml-1 px-0.5 rounded"
                        style={{ color: typeColor, border: `1px solid ${typeColor}` }}
                      >
                        {p.option_type === "call" ? "C" : "P"}
                      </span>
                      <span className="text-[8px] ml-1" style={{ color: colors.textSecondary }}>
                        {p.strike}
                      </span>
                    </td>
                    <td
                      className="px-1 py-1 text-right"
                      style={{ color: p.quantity > 0 ? "#00FF00" : "#FF4444" }}
                    >
                      {p.quantity > 0 ? "+" : ""}
                      {p.quantity}
                    </td>
                    <td
                      className="px-1 py-1 text-right"
                      style={{
                        color: hasGreeks && g.days_to_exp <= 7 ? "#FF4444" : colors.textSecondary,
                      }}
                    >
                      {hasGreeks ? g.days_to_exp : "—"}
                    </td>
                    <td className="px-1 py-1 text-right" style={{ color: colors.textSecondary }}>
                      {hasGreeks ? `${g.iv.toFixed(1)}%` : "—"}
                    </td>
                    <td className="px-1 py-1 text-right font-bold" style={{ color: colors.text }}>
                      {hasGreeks ? gFmt(g.delta_adj) : "—"}
                    </td>
                    <td className="px-1 py-1 text-right" style={{ color: colors.text }}>
                      {hasGreeks ? gFmt(g.gamma_adj, 5) : "—"}
                    </td>
                    <td
                      className="px-1 py-1 text-right"
                      style={{ color: hasGreeks && g.theta_adj < 0 ? "#FF4444" : "#00FF00" }}
                    >
                      {hasGreeks
                        ? `$${(g.theta_adj * Math.abs(p.quantity) * 100).toFixed(2)}`
                        : "—"}
                    </td>
                    <td className="px-1 py-1 text-right" style={{ color: colors.text }}>
                      {hasGreeks ? gFmt(g.vega_adj) : "—"}
                    </td>
                    <td className="px-1 py-1 text-right">
                      {p.unlimited_loss ? (
                        <span style={{ color: "#FF4444" }} title="Unlimited — short call">
                          ∞
                        </span>
                      ) : p.max_loss != null ? (
                        <span style={{ color: "#FF4444" }}>
                          ${p.max_loss.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>

                  {isExpanded && hasGreeks && (
                    <tr style={{ background: "#0a0a0a" }}>
                      <td colSpan={9} className="px-3 py-2">
                        <div className="text-[8px] mb-1 font-bold" style={{ color: colors.accent }}>
                          {p.underlying} {p.strike}
                          {p.option_type === "call" ? "C" : "P"}
                          {" · "}skew={g.skew_input} · kurt={g.kurt_input} · T=
                          {g.T_years.toFixed(3)}yr
                        </div>
                        <table className="text-[8px] font-mono w-auto">
                          <thead>
                            <tr style={{ color: colors.textSecondary }}>
                              <th className="px-2 text-left">Greek</th>
                              <th className="px-2 text-right">BS</th>
                              <th className="px-2 text-right">Adj (GC)</th>
                              <th className="px-2 text-right">Fat-tail Δ</th>
                              <th className="px-2 text-left pl-3 opacity-50">Interpretation</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(
                              [
                                [
                                  "Delta",
                                  g.delta,
                                  g.delta_adj,
                                  g.delta_diff,
                                  "directional per share",
                                ],
                                [
                                  "Gamma",
                                  g.gamma,
                                  g.gamma_adj,
                                  g.gamma_diff,
                                  "delta change per $1 move",
                                ],
                                [
                                  "Theta",
                                  g.theta,
                                  g.theta_adj,
                                  g.theta_diff,
                                  "daily time decay (per contract)",
                                ],
                                ["Vega", g.vega, g.vega_adj, g.vega_diff, "per 1pp IV change"],
                                ["Rho", g.rho, g.rho_adj, undefined, "per 1pp rate change"],
                              ] as [string, number, number, number | undefined, string][]
                            ).map(([name, bs, adj, diff, note]) => (
                              <tr key={name}>
                                <td
                                  className="px-2 py-0.5 font-bold"
                                  style={{ color: colors.text }}
                                >
                                  {name}
                                </td>
                                <td
                                  className="px-2 py-0.5 text-right"
                                  style={{ color: colors.textSecondary }}
                                >
                                  {bs.toFixed(4)}
                                </td>
                                <td
                                  className="px-2 py-0.5 text-right font-bold"
                                  style={{ color: colors.text }}
                                >
                                  {adj.toFixed(4)}
                                </td>
                                <DiffCell diff={diff} d={4} />
                                <td
                                  className="px-2 py-0.5 pl-3"
                                  style={{ color: colors.textSecondary }}
                                >
                                  {note}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Freshness note */}
      <div className="flex items-center gap-1 text-[8px]" style={{ color: "#f59e0b" }}>
        <Clock className="h-2.5 w-2.5" />~{data.freshness.delay_minutes}m delayed · Greeks cached
        5min · {data.freshness.warning}
        <button type="button" onClick={onRefresh} className="ml-auto opacity-60 hover:opacity-100">
          <RefreshCw className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}
