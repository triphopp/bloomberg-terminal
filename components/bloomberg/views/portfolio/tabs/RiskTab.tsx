"use client";
import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import {
  Activity,
  AlertTriangle,
  Clock,
  Infinity as InfinityIcon,
  Loader2,
  RefreshCw,
  Shield,
} from "lucide-react";
import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { riskSubTabRequestAtom } from "../../../atoms";
import { type Colors, fmt, fmtAmt, fmtPx, fmtQty, pnlColor } from "../helpers";
import { BearPathPanel, BearPathStrip, useBearTilt } from "../ui/BearPathPanel";
import { CotCrowdingPanel } from "../ui/CotCrowdingPanel";
import { DecisionJournalPanel } from "../ui/DecisionJournalPanel";
import { FactorExposurePanel } from "../ui/FactorExposurePanel";
import { MarginCard } from "../ui/MarginCard";
import { MonteCarloPanel } from "../ui/MonteCarloPanel";
import { RebalancePanel, useRebalance } from "../ui/RebalancePanel";
import { RiskBalanceBlock } from "../ui/RiskBalanceBlock";
import { RiskBudgetPanel, useBudgetScope, useRiskBudget } from "../ui/RiskBudgetPanel";
import {
  type BacktestDay,
  CoMoveBlock,
  LossLadderBlock,
  ModelTrustBlock,
  WhoCarriesRiskBlock,
} from "../ui/RiskDetailBlocks";
import { RiskSummaryCard } from "../ui/RiskSummaryCard";
import { TradeGuardCard } from "../ui/TradeGuardCard";
import { VarValidationCard } from "../ui/VarValidationCard";
import { WhatIfSimPanel } from "../ui/WhatIfSimPanel";

/**
 * PORT → RISK. One look at the first page has to show the book and the risk it
 * carries — no going back and forth (2026-10-07, eight pages → six):
 *   สรุป             — everything at once: the risk in plain words and what to do, what a run
 *                      of down days would cost, margin, TRADE GUARD, the decisions on record,
 *                      then the methods behind the numbers (ex-เชิงลึก: VaR/CVaR ensemble,
 *                      correlation, ERC, EWS, COT)
 *   REBALANCE        — which winners grew past their slice; how much to take off, or why not yet
 *   BUDGET · FACTOR  — where the risk comes from: share of the book's risk per holding / sector /
 *                      thesis against its budget, then what the book is betting on (betas)
 *   WHAT-IF          — do vs don't, simulated on the real book
 *   MONTE CARLO      — hold as is: down-tilted paths at 3/5/7/21/42 days, then the neutral
 *                      distribution over thousands of paths
 *   OPTIONS          — greeks
 * Another component can ask for a page through riskSubTabRequestAtom
 * (a guard:REBALANCE alert → REBALANCE).
 */
type SubTab = "summary" | "rebalance" | "exposure" | "whatif" | "mc" | "options";

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
  /** Out-of-sample days scored (rolling window) — 2026-09-29. */
  var_backtest_obs?: number;
  var_backtest_method?: string;
  /** The days behind the rolling test: return vs that day's VaR line. */
  var_backtest_series?: BacktestDay[];
  // NAV basis — 2026-09-29
  nav_value?: number;
  cash_value?: number;
  gross_exposure_pct?: number | null;
  net_exposure_pct?: number | null;
  short_value?: number;
  option_delta_value?: number;
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
  // Breach checker — the last COMPLETED daily bar, not the live day
  today_return_pct: number;
  last_return_date?: string | null;
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
  // Start on the requested page (alert link → REBALANCE) rather than flipping
  // to it in an effect, which would mount the summary for one throwaway render.
  const [subRequest, setSubRequest] = useAtom(riskSubTabRequestAtom);
  const [subTab, setSubTab] = useState<SubTab>(() => subRequest ?? "summary");
  // WHAT-IF mounts on first visit and then stays mounted (hidden), so ticks
  // and typed quantities survive a trip to another sub-tab.
  const [whatIfSeen, setWhatIfSeen] = useState(subRequest === "whatif");
  useEffect(() => {
    if (!subRequest) return;
    if (subRequest === "whatif") setWhatIfSeen(true);
    setSubTab(subRequest);
    setSubRequest(null);
  }, [subRequest, setSubRequest]);
  const [bearTilt, setBearTilt] = useBearTilt();
  // The live day (price vs previous close). Same key as TradeGuardCard, so the
  // summary card and the guard card read one request.
  const { data: guardDay } = useQuery<{ day_pnl_pct: number | null }>({
    queryKey: ["risk-guard", accountId, currency],
    queryFn: async () => {
      const qs = new URLSearchParams({ base_currency: currency });
      if (accountId !== "all") qs.set("account_id", accountId);
      const r = await fetch(`/api/v2/portfolio/risk/guard?${qs}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const detailRef = useRef<HTMLDivElement>(null);
  const [simFocus, setSimFocus] = useState(0);
  const rebal = useRebalance(accountId);
  const [budgetScope, setBudgetScope] = useBudgetScope();
  const budget = useRiskBudget(accountId, currency, budgetScope);
  const go = (t: SubTab) => {
    if (t === "whatif") setWhatIfSeen(true);
    setSubTab(t);
  };
  /** The methods live at the foot of the summary page now: go there. */
  const goDetail = () => {
    setSubTab("summary");
    requestAnimationFrame(() =>
      detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
  };
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
  const trimCount = rebal.data?.counts.TRIM ?? 0;
  const overBudget = (budget.data?.counts.OVER ?? 0) + (budget.data?.vol.status === "OVER" ? 1 : 0);
  const SUB_TABS: {
    id: SubTab;
    label: string;
    badge?: number;
    badgeTitle?: string;
    badgeColor?: string;
  }[] = [
    { id: "summary", label: "สรุป" },
    { id: "rebalance", label: "REBALANCE", badge: trimCount, badgeTitle: "ตัวที่ขายทำกำไรได้" },
    {
      id: "exposure",
      label: "BUDGET · FACTOR",
      badge: overBudget,
      badgeTitle: "กองที่ใช้ความเสี่ยงเกินงบ",
      badgeColor: "#FF4444",
    },
    { id: "whatif", label: "WHAT-IF" },
    { id: "mc", label: "MONTE CARLO · ขาลง" },
    { id: "options", label: "OPTIONS" },
  ];

  const riskColor = (score: number) =>
    score < 30 ? "#00FF00" : score < 60 ? "#ff9900" : "#FF4444";

  return (
    <div className="overflow-y-auto px-2 py-1" style={{ maxHeight: "calc(100vh - 220px)" }}>
      {/* Sub-tabs */}
      <div className="flex items-center gap-1 mb-2">
        {SUB_TABS.map((t) => (
          <button
            aria-pressed={subTab === t.id}
            type="button"
            key={t.id}
            className="text-[9px] px-2 py-0.5 font-bold"
            style={{
              color: subTab === t.id ? colors.accent : colors.textSecondary,
              borderBottom:
                subTab === t.id ? `2px solid ${colors.accent}` : "2px solid transparent",
            }}
            onClick={() => go(t.id)}
          >
            {t.label}
            {!!t.badge && (
              <span
                className="ml-1 px-1 rounded"
                style={{ background: t.badgeColor ?? colors.positive, color: "#000", fontSize: 8 }}
                title={t.badgeTitle}
              >
                {t.badge}
              </span>
            )}
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

      {subTab === "summary" && (
        <div className="space-y-2 mb-2">
          <RiskSummaryCard
            metrics={metrics}
            rebal={rebal.data}
            budgetOver={overBudget}
            dayPnlPct={guardDay?.day_pnl_pct}
            colors={colors}
            sym={sym}
            onGo={(t) => (t === "detail" ? goDetail() : go(t))}
          />
          <BearPathStrip
            accountId={accountId}
            currency={currency}
            colors={colors}
            tilt={bearTilt}
            onTilt={setBearTilt}
            onOpen={() => go("mc")}
          />
          <MarginCard scope="port" accountId={accountId} colors={colors} />
          <TradeGuardCard accountId={accountId} currency={currency} colors={colors} />
          <DecisionJournalPanel accountId={accountId} colors={colors} />
        </div>
      )}

      {subTab === "rebalance" && (
        <div className="space-y-2 mb-2">
          <RebalancePanel
            accountId={accountId}
            colors={colors}
            onSimulate={() => {
              setSimFocus((n) => n + 1);
              go("whatif");
            }}
          />
        </div>
      )}

      {subTab === "exposure" && (
        <div className="space-y-2 mb-2">
          <RiskBudgetPanel
            accountId={accountId}
            currency={currency}
            colors={colors}
            scope={budgetScope}
            onScope={setBudgetScope}
          />
          <FactorExposurePanel accountId={accountId} currency={currency} colors={colors} />
        </div>
      )}

      {whatIfSeen && (
        <div
          className="space-y-2 mb-2"
          style={{ display: subTab === "whatif" ? undefined : "none" }}
        >
          <WhatIfSimPanel
            accountId={accountId}
            colors={colors}
            erc={metrics?.trim_signals}
            rebalance={rebal.data?.trades}
            focus={simFocus}
          />
        </div>
      )}

      {subTab === "mc" && (
        <div className="space-y-2 mb-2">
          <BearPathPanel
            accountId={accountId}
            currency={currency}
            colors={colors}
            tilt={bearTilt}
            onTilt={setBearTilt}
          />
          <MonteCarloPanel accountId={accountId} currency={currency} colors={colors} />
        </div>
      )}

      {/* The methods behind the summary (ex-เชิงลึก) — same page, below it. */}
      {subTab === "summary" && (
        <div
          ref={detailRef}
          className="flex items-baseline gap-2 mt-3 mb-1 font-mono"
          style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 6, fontSize: 10 }}
        >
          <span className="font-bold" style={{ color: colors.accent, letterSpacing: "0.08em" }}>
            เชิงลึก · วิธีคิดเบื้องหลังตัวเลข
          </span>
          <span style={{ color: colors.textSecondary, fontSize: 9 }}>
            VaR / CVaR หลายวิธี · สหสัมพันธ์ · ERC · EWS · COT
          </span>
        </div>
      )}
      {subTab === "summary" && !metrics && loading && (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
        </div>
      )}

      {subTab === "summary" && !metrics && !loading && error && (
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

      {metrics && subTab === "summary" && (
        <OverviewSection
          metrics={metrics}
          colors={colors}
          sym={sym}
          riskColor={riskColor}
          accountId={accountId}
          currency={currency}
          validation={
            <VarValidationCard
              embedded
              accountId={accountId}
              colors={colors}
              sym={sym}
              rolling={{
                exceptions: metrics.var_backtest_exceptions,
                obs: metrics.var_backtest_obs,
                rate: metrics.var_backtest_rate,
                signal: metrics.var_backtest_signal,
                kupiec: metrics.kupiec_pvalue,
              }}
              nav={metrics}
            />
          }
        />
      )}
      {subTab === "summary" && (
        <CotCrowdingPanel accountId={accountId} currency={currency} colors={colors} />
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
        aria-pressed={open}
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
    var_backtest_obs,
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
          STEP 3 — KUPIEC POF TEST (rolling out-of-sample: each day vs the VaR of the days before it
          · current basket replayed · live log in VAR VALIDATION)
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
                  {var_backtest_exceptions}/{var_backtest_obs ?? lookback_days}
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

// ── Ensemble helper components ───────────────────────────────────────────────

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
        {fmtAmt(amt)}
      </td>
      <td className="text-right py-0.5 text-[7px]" style={{ color: "#666" }}>
        {note}
      </td>
    </tr>
  );
}

// ── Overview Section ─────────────────────────────────────────────────────────

function OverviewSection({
  metrics,
  colors,
  sym,
  riskColor,
  accountId,
  currency,
  validation,
}: {
  metrics: RiskMetrics;
  colors: Colors;
  sym: string;
  riskColor: (s: number) => string;
  accountId: string;
  currency: "THB" | "USD";
  /** The live VaR forecast log — sits inside the "can the model be trusted" block. */
  validation?: React.ReactNode;
}) {
  const [acctOpen, setAcctOpen] = useState(false);

  return (
    <div className="space-y-2">
      {/* Four questions, each one sentence + one picture (ui/RiskDetailBlocks.tsx). */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 items-start">
        <WhoCarriesRiskBlock assets={metrics.assets} colors={colors} />
        <LossLadderBlock metrics={metrics} colors={colors} sym={sym} />
        <ModelTrustBlock
          series={metrics.var_backtest_series}
          rolling={{
            exceptions: metrics.var_backtest_exceptions,
            obs: metrics.var_backtest_obs,
            rate: metrics.var_backtest_rate,
            signal: metrics.var_backtest_signal,
            kupiec: metrics.kupiec_pvalue,
          }}
          confidence={metrics.confidence}
          colors={colors}
        >
          {validation}
        </ModelTrustBlock>
        <CoMoveBlock
          symbols={metrics.correlation_matrix.symbols}
          matrix={metrics.correlation_matrix.matrix}
          colors={colors}
        />
      </div>

      {/* The follow-up to "who carries the risk": what to trade to even it out. */}
      <RiskBalanceBlock accountId={accountId} currency={currency} colors={colors} />

      {/* Performance of TODAY'S basket replayed backwards — hindsight, not risk:
          the names held now are the ones that did well. Kept, but said so. */}
      <div
        className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-2 font-mono"
        style={{ fontSize: 9, color: colors.textSecondary }}
        title="คำนวณจากตะกร้าที่ถืออยู่วันนี้ย้อนหลัง 1 ปี — ตัวที่ถืออยู่คือตัวที่ผ่านมาทำได้ดี ตัวเลขจึงดูดีกว่าผลงานจริงของพอร์ต (ดู ANALYTICS)"
      >
        <span>ย้อนหลังของตะกร้าวันนี้ (ไม่ใช่ผลงานจริง):</span>
        {(
          [
            ["Sharpe", metrics.sharpe_ratio],
            ["Sortino", metrics.sortino_ratio],
            ["Calmar", metrics.calmar_ratio],
            ["Diversification", metrics.diversification_ratio],
          ] as const
        ).map(([label, value]) => (
          <span key={label}>
            {label} <span style={{ color: colors.text }}>{value.toFixed(2)}</span>
          </span>
        ))}
      </div>

      <EWSHistorySection accountId={accountId} colors={colors} />

      {accountId === "all" && metrics.account_breakdown && (
        <div className="rounded" style={{ border: `1px solid ${colors.border}` }}>
          <button
            aria-pressed={acctOpen}
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
                    {fmtAmt(Math.abs(a.trade_value))}
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
                      {fmtPx(a.current_price)}
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
            ${fmtAmt(portfolio.total_premium_at_risk)}
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
                      {fmtQty(p.quantity)}
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
                        <span style={{ color: "#FF4444" }}>${fmtAmt(p.max_loss)}</span>
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
