"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { bloombergColors } from "../lib/theme-config";
import { useOptions, useOptionsSurface } from "../hooks/useStockData";
import { StrategyBuilder } from "./strategy-builder";

// ── Types ──────────────────────────────────────────────────────────────────────

type OptionRow = {
  contractSymbol: string;
  strike: number;
  lastPrice: number;
  bid: number;
  ask: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number; // decimal e.g. 0.25
  inTheMoney: boolean;
  change: number;
  percentChange: number;
};

type Leg = {
  action: "BUY" | "SELL";
  kind: "CALL" | "PUT" | "SHARE";
  strike?: number;
  premium: number; // per-share premium (mid price)
  qty: number;
};

type Strategy = {
  id: string;
  name: string;
  outlook: "BULLISH" | "BEARISH" | "NEUTRAL" | "VOLATILE" | "INCOME";
  legs: Leg[];
  netCost: number;       // positive = debit, negative = credit
  maxProfit: number | null;  // null = unlimited
  maxLoss: number | null;    // null = unlimited
  beLow?: number;
  beHigh?: number;
  notes: string;
};

type SubView = "chain" | "strategies" | "builder" | "greeks" | "surface";
type OutlookFilter = "ALL" | "BULLISH" | "BEARISH" | "NEUTRAL" | "VOLATILE" | "INCOME";

// ── Helpers ───────────────────────────────────────────────────────────────────

function mid(o: OptionRow): number {
  return o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : o.lastPrice || 0;
}

function nearest(opts: OptionRow[], targetStrike: number): OptionRow | undefined {
  return opts.reduce<OptionRow | undefined>(
    (best, o) => (!best || Math.abs(o.strike - targetStrike) < Math.abs(best.strike - targetStrike) ? o : best),
    undefined,
  );
}

function atm(opts: OptionRow[], spot: number): OptionRow | undefined {
  return nearest(opts, spot);
}

function fmt2(v: number | null): string {
  if (v == null) return "N/A";
  return v.toFixed(2);
}

function fmtDollar(v: number | null): string {
  if (v == null) return "N/A";
  return `$${Math.abs(v).toFixed(2)}`;
}

function daysToExpiry(expiryStr: string): number {
  const exp = new Date(expiryStr + "T16:00:00");
  const now = new Date();
  return Math.max(0, (exp.getTime() - now.getTime()) / 86_400_000);
}

// ── Strategy Scanner ──────────────────────────────────────────────────────────

function buildStrategies(calls: OptionRow[], puts: OptionRow[], spot: number): Strategy[] {
  const strats: Strategy[] = [];

  const atmCall = atm(calls, spot);
  const atmPut  = atm(puts,  spot);
  if (!atmCall || !atmPut) return strats;

  // OTM ~5%, Far OTM ~10%
  const otmCall5  = nearest(calls.filter(c => c.strike > spot),          spot * 1.05);
  const otmPut5   = nearest(puts.filter(p => p.strike < spot),           spot * 0.95);
  const otmCall10 = nearest(calls.filter(c => c.strike > spot * 1.07),   spot * 1.10);
  const otmPut10  = nearest(puts.filter(p => p.strike < spot * 0.93),    spot * 0.90);

  // ── 1. Long Call ───────────────────────────────────────────────────────────
  (() => {
    const c = atmCall;
    const cost = c.ask;
    strats.push({
      id: "long-call", name: "Long Call", outlook: "BULLISH",
      legs: [{ action: "BUY", kind: "CALL", strike: c.strike, premium: mid(c), qty: 1 }],
      netCost: cost, maxProfit: null, maxLoss: cost,
      beLow: c.strike + cost,
      notes: "Unlimited upside if stock rallies, loss capped at premium paid",
    });
  })();

  // ── 2. Long Put ────────────────────────────────────────────────────────────
  (() => {
    const p = atmPut;
    const cost = p.ask;
    strats.push({
      id: "long-put", name: "Long Put", outlook: "BEARISH",
      legs: [{ action: "BUY", kind: "PUT", strike: p.strike, premium: mid(p), qty: 1 }],
      netCost: cost, maxProfit: p.strike - cost, maxLoss: cost,
      beLow: p.strike - cost,
      notes: "Profits as stock falls, max loss is premium paid",
    });
  })();

  // ── 3. Bull Call Spread ────────────────────────────────────────────────────
  if (otmCall5) (() => {
    const buy = atmCall, sell = otmCall5;
    const debit = buy.ask - sell.bid;
    const width = sell.strike - buy.strike;
    strats.push({
      id: "bull-call-spread", name: "Bull Call Spread", outlook: "BULLISH",
      legs: [
        { action: "BUY",  kind: "CALL", strike: buy.strike,  premium: mid(buy),  qty: 1 },
        { action: "SELL", kind: "CALL", strike: sell.strike, premium: mid(sell), qty: 1 },
      ],
      netCost: debit, maxProfit: width - debit, maxLoss: debit,
      beLow: buy.strike + debit,
      notes: `Capped gain at ${sell.strike.toFixed(1)}, lower cost than outright call`,
    });
  })();

  // ── 4. Bear Put Spread ─────────────────────────────────────────────────────
  if (otmPut5) (() => {
    const buy = atmPut, sell = otmPut5;
    const debit = buy.ask - sell.bid;
    const width = buy.strike - sell.strike;
    strats.push({
      id: "bear-put-spread", name: "Bear Put Spread", outlook: "BEARISH",
      legs: [
        { action: "BUY",  kind: "PUT", strike: buy.strike,  premium: mid(buy),  qty: 1 },
        { action: "SELL", kind: "PUT", strike: sell.strike, premium: mid(sell), qty: 1 },
      ],
      netCost: debit, maxProfit: width - debit, maxLoss: debit,
      beLow: buy.strike - debit,
      notes: `Profit maximised below ${sell.strike.toFixed(1)}`,
    });
  })();

  // ── 5. Long Straddle ───────────────────────────────────────────────────────
  (() => {
    const cost = atmCall.ask + atmPut.ask;
    const k = atmCall.strike;
    strats.push({
      id: "long-straddle", name: "Long Straddle", outlook: "VOLATILE",
      legs: [
        { action: "BUY", kind: "CALL", strike: atmCall.strike, premium: mid(atmCall), qty: 1 },
        { action: "BUY", kind: "PUT",  strike: atmPut.strike,  premium: mid(atmPut),  qty: 1 },
      ],
      netCost: cost, maxProfit: null, maxLoss: cost,
      beLow: k - cost, beHigh: k + cost,
      notes: "Profits from large move either direction (earnings play)",
    });
  })();

  // ── 6. Long Strangle ───────────────────────────────────────────────────────
  if (otmCall5 && otmPut5) (() => {
    const cost = otmCall5.ask + otmPut5.ask;
    strats.push({
      id: "long-strangle", name: "Long Strangle", outlook: "VOLATILE",
      legs: [
        { action: "BUY", kind: "CALL", strike: otmCall5.strike, premium: mid(otmCall5), qty: 1 },
        { action: "BUY", kind: "PUT",  strike: otmPut5.strike,  premium: mid(otmPut5),  qty: 1 },
      ],
      netCost: cost, maxProfit: null, maxLoss: cost,
      beLow: otmPut5.strike - cost, beHigh: otmCall5.strike + cost,
      notes: "Cheaper than straddle — needs a bigger move to be profitable",
    });
  })();

  // ── 7. Iron Condor ─────────────────────────────────────────────────────────
  if (otmCall5 && otmPut5 && otmCall10 && otmPut10) (() => {
    const credit = otmCall5.bid + otmPut5.bid - otmCall10.ask - otmPut10.ask;
    const callW  = otmCall10.strike - otmCall5.strike;
    const putW   = otmPut5.strike   - otmPut10.strike;
    const risk   = Math.max(callW, putW) - Math.max(0, credit);
    strats.push({
      id: "iron-condor", name: "Iron Condor", outlook: "NEUTRAL",
      legs: [
        { action: "SELL", kind: "CALL", strike: otmCall5.strike,  premium: mid(otmCall5),  qty: 1 },
        { action: "BUY",  kind: "CALL", strike: otmCall10.strike, premium: mid(otmCall10), qty: 1 },
        { action: "SELL", kind: "PUT",  strike: otmPut5.strike,   premium: mid(otmPut5),   qty: 1 },
        { action: "BUY",  kind: "PUT",  strike: otmPut10.strike,  premium: mid(otmPut10),  qty: 1 },
      ],
      netCost: -Math.max(0, credit),
      maxProfit: Math.max(0, credit),
      maxLoss: risk,
      beLow:  otmPut5.strike  - Math.max(0, credit),
      beHigh: otmCall5.strike + Math.max(0, credit),
      notes: `Profit zone: ${otmPut5.strike.toFixed(1)} – ${otmCall5.strike.toFixed(1)}`,
    });
  })();

  // ── 8. Short Straddle (income) ─────────────────────────────────────────────
  (() => {
    const credit = atmCall.bid + atmPut.bid;
    const k = atmCall.strike;
    strats.push({
      id: "short-straddle", name: "Short Straddle", outlook: "INCOME",
      legs: [
        { action: "SELL", kind: "CALL", strike: atmCall.strike, premium: mid(atmCall), qty: 1 },
        { action: "SELL", kind: "PUT",  strike: atmPut.strike,  premium: mid(atmPut),  qty: 1 },
      ],
      netCost: -credit,
      maxProfit: credit, maxLoss: null,
      beLow: k - credit, beHigh: k + credit,
      notes: "⚠ Unlimited risk — collect premium if stock stays near ATM",
    });
  })();

  // ── 9. Covered Call ────────────────────────────────────────────────────────
  if (otmCall5) (() => {
    const income = otmCall5.bid;
    strats.push({
      id: "covered-call", name: "Covered Call", outlook: "INCOME",
      legs: [
        { action: "BUY",  kind: "SHARE",                           premium: spot,          qty: 100 },
        { action: "SELL", kind: "CALL", strike: otmCall5.strike,   premium: mid(otmCall5), qty: 1   },
      ],
      netCost: spot - income,
      maxProfit: otmCall5.strike - spot + income,
      maxLoss: spot - income,
      beLow: spot - income,
      notes: `Reduced cost basis by $${income.toFixed(2)}, capped upside at ${otmCall5.strike.toFixed(1)}`,
    });
  })();

  // ── 10. Cash-Secured Put ───────────────────────────────────────────────────
  if (otmPut5) (() => {
    const income = otmPut5.bid;
    strats.push({
      id: "cash-secured-put", name: "Cash-Secured Put", outlook: "INCOME",
      legs: [
        { action: "SELL", kind: "PUT", strike: otmPut5.strike, premium: mid(otmPut5), qty: 1 },
      ],
      netCost: -income,
      maxProfit: income,
      maxLoss: otmPut5.strike - income,
      beLow: otmPut5.strike - income,
      notes: `Acquire stock at ${otmPut5.strike.toFixed(1)} if assigned, keep premium otherwise`,
    });
  })();

  return strats;
}

// ── Payoff calculation ─────────────────────────────────────────────────────────

function legPnl(leg: Leg, S: number, spot: number): number {
  const dir = leg.action === "BUY" ? 1 : -1;
  if (leg.kind === "SHARE") return dir * (S - spot) * (leg.qty / 100);
  if (leg.kind === "CALL")  return dir * (Math.max(S - (leg.strike ?? S), 0) - leg.premium);
  if (leg.kind === "PUT")   return dir * (Math.max((leg.strike ?? S) - S, 0) - leg.premium);
  return 0;
}

function buildPayoff(strat: Strategy, spot: number, nPoints = 100) {
  const lo = spot * 0.60, hi = spot * 1.40;
  const step = (hi - lo) / nPoints;
  return Array.from({ length: nPoints + 1 }, (_, i) => {
    const S = lo + i * step;
    const pnl = strat.legs.reduce((sum, l) => sum + legPnl(l, S, spot), 0);
    return { price: +S.toFixed(2), pnl: +pnl.toFixed(4), label: `$${S.toFixed(0)}` };
  });
}

// ── Black-Scholes Greeks ───────────────────────────────────────────────────────

function normCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}
function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function bsD1(S: number, K: number, T: number, r: number, sig: number) {
  return (Math.log(S / K) + (r + 0.5 * sig * sig) * T) / (sig * Math.sqrt(T));
}
function bsDelta(S: number, K: number, T: number, r: number, sig: number, type: "call" | "put"): number {
  if (T <= 0 || sig <= 0 || K <= 0) return type === "call" ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
  const d = bsD1(S, K, T, r, sig);
  return type === "call" ? normCDF(d) : normCDF(d) - 1;
}
function bsGamma(S: number, K: number, T: number, r: number, sig: number): number {
  if (T <= 0 || sig <= 0 || K <= 0) return 0;
  return normPDF(bsD1(S, K, T, r, sig)) / (S * sig * Math.sqrt(T));
}
function bsTheta(S: number, K: number, T: number, r: number, sig: number, type: "call" | "put"): number {
  if (T <= 0 || sig <= 0 || K <= 0) return 0;
  const d1v = bsD1(S, K, T, r, sig);
  const d2v = d1v - sig * Math.sqrt(T);
  const base = -(S * normPDF(d1v) * sig) / (2 * Math.sqrt(T));
  return type === "call"
    ? (base - r * K * Math.exp(-r * T) * normCDF(d2v)) / 365
    : (base + r * K * Math.exp(-r * T) * normCDF(-d2v)) / 365;
}
function bsVega(S: number, K: number, T: number, r: number, sig: number): number {
  if (T <= 0 || sig <= 0 || K <= 0) return 0;
  return S * normPDF(bsD1(S, K, T, r, sig)) * Math.sqrt(T) / 100;
}

function buildGreeks(strat: Strategy, spot: number, T: number, iv: number, r = 0.05) {
  const sig = Math.max(0.01, iv / 100);
  const nPts = 60;
  const lo = spot * 0.70, hi = spot * 1.30;
  const step = (hi - lo) / nPts;

  return Array.from({ length: nPts + 1 }, (_, i) => {
    const S = lo + i * step;
    let delta = 0, gamma = 0, theta = 0, vega = 0;
    for (const leg of strat.legs) {
      if (leg.kind === "SHARE") {
        delta += (leg.action === "BUY" ? 1 : -1) * (leg.qty / 100);
        continue;
      }
      if (!leg.strike) continue;
      const type = leg.kind.toLowerCase() as "call" | "put";
      const dir = leg.action === "BUY" ? 1 : -1;
      const legSig = sig;
      delta += dir * bsDelta(S, leg.strike, T, r, legSig, type);
      gamma += dir * bsGamma(S, leg.strike, T, r, legSig);
      theta += dir * bsTheta(S, leg.strike, T, r, legSig, type);
      vega  += dir * bsVega(S, leg.strike, T, r, legSig);
    }
    return {
      price: +S.toFixed(2), label: `$${S.toFixed(0)}`,
      delta: +delta.toFixed(4), gamma: +gamma.toFixed(6),
      theta: +theta.toFixed(4), vega:  +vega.toFixed(4),
    };
  });
}

// ── Volatility surface bucketing ───────────────────────────────────────────────

const MONO_BUCKETS = [-20, -15, -10, -7, -5, -3, -1, 0, 1, 3, 5, 7, 10, 15, 20];

function bucketMoneyness(m: number): number {
  return MONO_BUCKETS.reduce((best, b) => Math.abs(b - m) < Math.abs(best - m) ? b : best);
}

function buildSurfaceGrid(
  surfacePoints: { expiry: string; moneyness: number; iv: number; type: string }[],
  expirations: string[],
) {
  type Cell = { iv: number; n: number };
  const grid: Record<string, Record<number, Cell>> = {};

  for (const pt of surfacePoints) {
    const b = bucketMoneyness(pt.moneyness);
    if (!grid[pt.expiry]) grid[pt.expiry] = {};
    if (!grid[pt.expiry][b]) grid[pt.expiry][b] = { iv: 0, n: 0 };
    grid[pt.expiry][b].iv += pt.iv;
    grid[pt.expiry][b].n  += 1;
  }

  const usedExpiries = expirations.filter(e => grid[e]);
  const allIVs = Object.values(grid).flatMap(row => Object.values(row)).map(c => c.iv / c.n);
  const minIV = Math.min(...allIVs.filter(Boolean));
  const maxIV = Math.max(...allIVs.filter(Boolean));

  return { grid, usedExpiries, minIV, maxIV };
}

function ivColor(iv: number, minIV: number, maxIV: number): string {
  if (!iv || iv <= 0) return "transparent";
  const t = Math.min(1, Math.max(0, (iv - minIV) / (maxIV - minIV || 1)));
  // Blue → Cyan → Green → Yellow → Red
  if (t < 0.25)  return `hsl(${220 + t * 4 * 60}, 80%, 55%)`;   // blue→cyan
  if (t < 0.5)   return `hsl(${160 - (t - 0.25) * 4 * 60}, 80%, 50%)`; // cyan→green
  if (t < 0.75)  return `hsl(${100 - (t - 0.5) * 4 * 60}, 85%, 48%)`; // green→yellow
  return         `hsl(${40 - (t - 0.75) * 4 * 40}, 90%, 48%)`;         // yellow→red
}

// ── Small sub-components ───────────────────────────────────────────────────────

function OutlookBadge({ v }: { v: Strategy["outlook"] }) {
  const colors: Record<string, string> = {
    BULLISH: "#16a34a", BEARISH: "#dc2626",
    NEUTRAL: "#9ca3af", VOLATILE: "#f59e0b", INCOME: "#6366f1",
  };
  return (
    <span
      className="text-[9px] font-bold px-1 py-0.5 border"
      style={{ color: colors[v], borderColor: colors[v] }}
    >
      {v}
    </span>
  );
}

function StatCard({
  label, value, sub, col, colors,
}: { label: string; value: string; sub?: string; col?: string; colors: typeof bloombergColors.dark }) {
  return (
    <div className="flex-1 p-2 border text-center min-w-[90px]" style={{ borderColor: colors.border }}>
      <div className="text-[9px] tracking-wider mb-0.5" style={{ color: colors.textSecondary }}>{label}</div>
      <div className="text-sm font-bold font-mono" style={{ color: col ?? colors.text }}>{value}</div>
      {sub && <div className="text-[9px] mt-0.5" style={{ color: colors.textSecondary }}>{sub}</div>}
    </div>
  );
}

// ── Chain sub-view ─────────────────────────────────────────────────────────────

function ChainView({
  calls, puts, spot, colors,
}: { calls: OptionRow[]; puts: OptionRow[]; spot: number; colors: typeof bloombergColors.dark }) {
  // Filter to strikes within ±18% of spot
  const filtered = Array.from(
    new Set([...calls, ...puts].map(o => o.strike)),
  ).filter(s => Math.abs(s - spot) / spot <= 0.18).sort((a, b) => a - b);

  const callMap = new Map(calls.map(c => [c.strike, c]));
  const putMap  = new Map(puts.map(p  => [p.strike, p]));

  const th = "text-[9px] font-bold tracking-wider py-1 px-2";
  const td = "text-[10px] font-mono py-1 px-2";

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr style={{ backgroundColor: colors.surface, color: colors.accent }}>
            {/* Calls */}
            <th className={`${th} text-right`}>Bid</th>
            <th className={`${th} text-right`}>Ask</th>
            <th className={`${th} text-right`}>IV%</th>
            <th className={`${th} text-right`}>OI</th>
            {/* Strike */}
            <th className={`${th} text-center`} style={{ borderLeft: `1px solid ${colors.accent}`, borderRight: `1px solid ${colors.accent}` }}>STRIKE</th>
            {/* Puts */}
            <th className={`${th} text-right`}>Bid</th>
            <th className={`${th} text-right`}>Ask</th>
            <th className={`${th} text-right`}>IV%</th>
            <th className={`${th} text-right`}>OI</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(strike => {
            const c = callMap.get(strike);
            const p = putMap.get(strike);
            const isATM = Math.abs(strike - spot) / spot < 0.015;
            const rowBg = isATM ? `${colors.accent}22` : "transparent";
            const callITM = c?.inTheMoney;
            const putITM  = p?.inTheMoney;

            return (
              <tr key={strike} style={{ backgroundColor: rowBg, borderBottom: `1px solid ${colors.border}` }}>
                {/* CALL cells */}
                <td className={`${td} text-right`} style={{ color: callITM ? colors.positive : colors.text }}>{c ? fmt2(c.bid) : "—"}</td>
                <td className={`${td} text-right`} style={{ color: callITM ? colors.positive : colors.text }}>{c ? fmt2(c.ask) : "—"}</td>
                <td className={`${td} text-right`} style={{ color: colors.textSecondary }}>{c ? `${(c.impliedVolatility * 100).toFixed(1)}%` : "—"}</td>
                <td className={`${td} text-right`} style={{ color: colors.textSecondary }}>{c ? (c.openInterest ?? 0).toLocaleString() : "—"}</td>
                {/* Strike */}
                <td
                  className={`${td} text-center font-bold`}
                  style={{
                    borderLeft: `1px solid ${colors.accent}`,
                    borderRight: `1px solid ${colors.accent}`,
                    color: isATM ? colors.accent : colors.text,
                    backgroundColor: isATM ? `${colors.accent}11` : undefined,
                  }}
                >
                  {isATM ? `▶ ${strike}` : strike}
                </td>
                {/* PUT cells */}
                <td className={`${td} text-right`} style={{ color: putITM ? colors.negative : colors.text }}>{p ? fmt2(p.bid) : "—"}</td>
                <td className={`${td} text-right`} style={{ color: putITM ? colors.negative : colors.text }}>{p ? fmt2(p.ask) : "—"}</td>
                <td className={`${td} text-right`} style={{ color: colors.textSecondary }}>{p ? `${(p.impliedVolatility * 100).toFixed(1)}%` : "—"}</td>
                <td className={`${td} text-right`} style={{ color: colors.textSecondary }}>{p ? (p.openInterest ?? 0).toLocaleString() : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[9px] mt-2" style={{ color: colors.textSecondary }}>
        ▶ = ATM (near spot ${spot.toFixed(2)}) · Green = call ITM · Red = put ITM · Showing ±18% of spot
      </p>
    </div>
  );
}

// ── Strategies sub-view ────────────────────────────────────────────────────────

function StrategiesView({
  strategies, spot, expiry, ivCurrent, colors,
}: {
  strategies: Strategy[];
  spot: number;
  expiry: string;
  ivCurrent: number;
  colors: typeof bloombergColors.dark;
}) {
  const [filter, setFilter] = useState<OutlookFilter>("ALL");
  const [selected, setSelected] = useState<string>(strategies[0]?.id ?? "");
  const [greekMode, setGreekMode] = useState<"delta" | "gamma" | "theta" | "vega">("delta");

  const T = daysToExpiry(expiry) / 365;
  const visible = filter === "ALL" ? strategies : strategies.filter(s => s.outlook === filter);
  const strat = strategies.find(s => s.id === selected) ?? visible[0];

  const payoff = useMemo(() => strat ? buildPayoff(strat, spot) : [], [strat, spot]);
  const greeks = useMemo(() => strat ? buildGreeks(strat, spot, T, ivCurrent) : [], [strat, spot, T, ivCurrent]);

  const outlooks: OutlookFilter[] = ["ALL", "BULLISH", "BEARISH", "NEUTRAL", "VOLATILE", "INCOME"];
  const panel = { backgroundColor: colors.surface, borderColor: colors.border };
  const sec = { color: colors.textSecondary };

  if (!strat) return (
    <div className="py-12 text-center text-xs" style={sec}>No options data to build strategies</div>
  );

  const maxY = Math.max(...payoff.map(d => Math.abs(d.pnl)));
  const domainY: [number, number] = [-maxY * 1.1, maxY * 1.1];

  return (
    <div className="space-y-3">
      {/* Outlook filter */}
      <div className="flex gap-1 flex-wrap">
        {outlooks.map(o => (
          <button
            key={o}
            type="button"
            onClick={() => setFilter(o)}
            className="px-2 py-0.5 text-[10px] font-bold border"
            style={{
              borderColor: filter === o ? colors.accent : colors.border,
              backgroundColor: filter === o ? colors.accent : "transparent",
              color: filter === o ? "#000" : colors.text,
            }}
          >
            {o}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Strategy list */}
        <div className="space-y-2 lg:col-span-1 max-h-[520px] overflow-y-auto pr-1">
          {visible.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelected(s.id)}
              className="w-full text-left p-3 border hover:opacity-80 transition-opacity"
              style={{
                borderColor: selected === s.id ? colors.accent : colors.border,
                backgroundColor: selected === s.id ? `${colors.accent}18` : colors.surface,
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold" style={{ color: selected === s.id ? colors.accent : colors.text }}>
                  {s.name}
                </span>
                <OutlookBadge v={s.outlook} />
              </div>
              <div className="flex gap-3 text-[10px]" style={sec}>
                <span>Cost: <span className="font-mono" style={{ color: s.netCost > 0 ? colors.negative : colors.positive }}>
                  {s.netCost > 0 ? `Dr $${s.netCost.toFixed(2)}` : `Cr $${Math.abs(s.netCost).toFixed(2)}`}
                </span></span>
                <span>Max P: <span className="font-mono" style={{ color: colors.positive }}>
                  {s.maxProfit == null ? "∞" : `$${s.maxProfit.toFixed(2)}`}
                </span></span>
              </div>
            </button>
          ))}
        </div>

        {/* Right panel: payoff + Greeks */}
        <div className="lg:col-span-2 space-y-3">
          {/* Strategy detail */}
          <div className="p-3 border" style={panel}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold tracking-wider" style={{ color: colors.accent }}>{strat.name.toUpperCase()}</span>
              <OutlookBadge v={strat.outlook} />
            </div>
            {/* Legs */}
            <table className="w-full mb-2 text-[10px]">
              <thead>
                <tr style={{ color: colors.textSecondary }}>
                  <th className="text-left font-normal pb-1">Action</th>
                  <th className="text-left font-normal pb-1">Type</th>
                  <th className="text-right font-normal pb-1">Strike</th>
                  <th className="text-right font-normal pb-1">Premium</th>
                  <th className="text-right font-normal pb-1">Qty</th>
                </tr>
              </thead>
              <tbody>
                {strat.legs.map((l, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${colors.border}` }}>
                    <td className="py-0.5 font-bold" style={{ color: l.action === "BUY" ? colors.positive : colors.negative }}>
                      {l.action}
                    </td>
                    <td className="py-0.5 font-mono">{l.kind}</td>
                    <td className="py-0.5 font-mono text-right">{l.strike ?? "—"}</td>
                    <td className="py-0.5 font-mono text-right">${l.premium.toFixed(2)}</td>
                    <td className="py-0.5 text-right">{l.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* P&L stats */}
            <div className="grid grid-cols-4 gap-2 text-[10px]">
              {[
                { label: "Net Cost", value: strat.netCost > 0 ? `Debit $${strat.netCost.toFixed(2)}` : `Credit $${Math.abs(strat.netCost).toFixed(2)}`, col: strat.netCost > 0 ? colors.negative : colors.positive },
                { label: "Max Profit", value: strat.maxProfit == null ? "Unlimited" : `$${strat.maxProfit.toFixed(2)}`, col: colors.positive },
                { label: "Max Loss",   value: strat.maxLoss   == null ? "Unlimited" : `$${strat.maxLoss.toFixed(2)}`,   col: colors.negative },
                { label: "Breakeven",  value: strat.beLow != null ? (strat.beHigh != null ? `${strat.beLow.toFixed(1)} / ${strat.beHigh.toFixed(1)}` : `$${strat.beLow.toFixed(2)}`) : "N/A", col: colors.text },
              ].map(({ label, value, col }) => (
                <div key={label} className="p-1.5 border text-center" style={{ borderColor: colors.border }}>
                  <div style={sec} className="text-[8px] tracking-wider mb-0.5">{label}</div>
                  <div className="font-bold font-mono" style={{ color: col, fontSize: 10 }}>{value}</div>
                </div>
              ))}
            </div>
            <p className="text-[9px] mt-2" style={sec}>{strat.notes}</p>
          </div>

          {/* Payoff diagram */}
          <div className="p-3 border" style={panel}>
            <h4 className="text-[10px] font-bold tracking-widest mb-2" style={{ color: colors.accent }}>
              PAYOFF AT EXPIRATION — {expiry}
            </h4>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={payoff} margin={{ top: 4, right: 8, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="2 2" stroke={colors.border} />
                <XAxis dataKey="label" tick={{ fontSize: 8, fill: colors.textSecondary }} tickLine={false} interval={Math.floor(payoff.length / 8)} />
                <YAxis tick={{ fontSize: 8, fill: colors.textSecondary }} tickLine={false} axisLine={false} width={44}
                  tickFormatter={(v: number) => `$${v.toFixed(1)}`} domain={domainY} />
                <ReferenceLine y={0} stroke={colors.border} strokeWidth={1} />
                {spot && <ReferenceLine x={`$${spot.toFixed(0)}`} stroke={colors.accent} strokeDasharray="3 2" strokeWidth={1} label={{ value: "Spot", fill: colors.accent, fontSize: 8 }} />}
                {strat.beLow != null && <ReferenceLine x={`$${strat.beLow.toFixed(0)}`} stroke={colors.textSecondary} strokeDasharray="2 2" strokeWidth={1} />}
                {strat.beHigh != null && <ReferenceLine x={`$${strat.beHigh.toFixed(0)}`} stroke={colors.textSecondary} strokeDasharray="2 2" strokeWidth={1} />}
                <Tooltip
                  contentStyle={{ backgroundColor: colors.surface, borderColor: colors.border, fontSize: 10, fontFamily: "monospace" }}
                  formatter={(v: number) => [`$${v.toFixed(3)}`, "P&L"]}
                />
                <Area
                  type="monotone"
                  dataKey="pnl"
                  stroke="none"
                  fill={colors.positive}
                  fillOpacity={0.25}
                  isAnimationActive={false}
                  // Only fill above zero
                  baseValue={0}
                />
                <Line
                  type="monotone"
                  dataKey="pnl"
                  stroke={colors.accent}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Greeks */}
          <div className="p-3 border" style={panel}>
            <div className="flex items-center gap-2 mb-2">
              <h4 className="text-[10px] font-bold tracking-widest" style={{ color: colors.accent }}>GREEKS vs STOCK PRICE</h4>
              <div className="flex gap-1 ml-auto">
                {(["delta", "gamma", "theta", "vega"] as const).map(g => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGreekMode(g)}
                    className="px-2 py-0.5 text-[10px] border"
                    style={{
                      borderColor: greekMode === g ? colors.accent : colors.border,
                      backgroundColor: greekMode === g ? colors.accent : "transparent",
                      color: greekMode === g ? "#000" : colors.text,
                    }}
                  >
                    {g.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[9px] mb-2" style={sec}>
              {greekMode === "delta" && "Δ — Rate of change of option price per $1 move in underlying"}
              {greekMode === "gamma" && "Γ — Rate of change of delta per $1 move in underlying"}
              {greekMode === "theta" && "Θ — Daily time decay (negative = value lost per day)"}
              {greekMode === "vega"  && "ν — Value change per 1% increase in implied volatility"}
            </p>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={greeks} margin={{ top: 4, right: 8, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="2 2" stroke={colors.border} />
                <XAxis dataKey="label" tick={{ fontSize: 8, fill: colors.textSecondary }} tickLine={false} interval={10} />
                <YAxis tick={{ fontSize: 8, fill: colors.textSecondary }} tickLine={false} axisLine={false} width={44}
                  tickFormatter={(v: number) => v.toFixed(3)} />
                <ReferenceLine y={0} stroke={colors.border} />
                {spot && <ReferenceLine x={`$${spot.toFixed(0)}`} stroke={colors.accent} strokeDasharray="3 2" strokeWidth={1} />}
                <Tooltip
                  contentStyle={{ backgroundColor: colors.surface, borderColor: colors.border, fontSize: 10, fontFamily: "monospace" }}
                  formatter={(v: number) => [v.toFixed(5), greekMode.toUpperCase()]}
                />
                <Line type="monotone" dataKey={greekMode} stroke={colors.accent} strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Surface metric types & helpers ────────────────────────────────────────────

type SurfaceMetric = "iv" | "call_delta" | "put_delta" | "gamma" | "theta" | "vega";

const SURFACE_METRICS: { id: SurfaceMetric; label: string; desc: string }[] = [
  { id: "iv",         label: "IV%",    desc: "Implied Volatility — the market's expected annual move" },
  { id: "call_delta", label: "Call Δ", desc: "Call Delta (0→1): how much call price moves per $1 in spot" },
  { id: "put_delta",  label: "Put Δ",  desc: "Put Delta (-1→0): how much put price moves per $1 in spot" },
  { id: "gamma",      label: "Γ",      desc: "Gamma: rate of delta change — peaks at ATM, near zero far OTM/ITM" },
  { id: "theta",      label: "Θ/day",  desc: "Theta: daily time decay (negative = option loses value per day)" },
  { id: "vega",       label: "ν/1%",   desc: "Vega: value change per +1% in IV — highest at ATM & long-dated" },
];

/** Compute a surface metric value given a cell's raw avg IV, strike approx from moneyness */
function computeSurfaceMetric(
  metric: SurfaceMetric,
  spot: number,
  monoPercent: number,   // moneyness bucket %
  expiry: string,
  avgIV: number,         // IV in % (e.g. 25.0)
): number {
  if (!avgIV || avgIV <= 0) return 0;
  if (metric === "iv") return avgIV;

  const K   = spot * (1 + monoPercent / 100);
  const T   = Math.max(0.003, daysToExpiry(expiry) / 365);  // min 1 day
  const sig = Math.max(0.005, avgIV / 100);
  const r   = 0.05;

  switch (metric) {
    case "call_delta": return +bsDelta(spot, K, T, r, sig, "call").toFixed(4);
    case "put_delta":  return +bsDelta(spot, K, T, r, sig, "put").toFixed(4);
    case "gamma":      return +bsGamma(spot, K, T, r, sig).toFixed(6);
    case "theta":      return +bsTheta(spot, K, T, r, sig, "call").toFixed(4); // daily (already /365 in fn)
    case "vega":       return +bsVega(spot, K, T, r, sig).toFixed(4);
    default:           return 0;
  }
}

/** Format a cell value for display (short) */
function fmtCell(v: number, metric: SurfaceMetric): string {
  if (!v) return "·";
  switch (metric) {
    case "iv":         return `${v.toFixed(0)}`;
    case "call_delta": return v.toFixed(2);
    case "put_delta":  return v.toFixed(2);
    case "gamma":      return v < 0.001 ? v.toExponential(1) : v.toFixed(4);
    case "theta":      return v.toFixed(3);
    case "vega":       return v.toFixed(2);
  }
}

/** Full tooltip label */
function fmtCellFull(v: number, metric: SurfaceMetric): string {
  switch (metric) {
    case "iv":         return `${v.toFixed(2)}%`;
    case "call_delta": return `Δ = ${v.toFixed(4)}`;
    case "put_delta":  return `Δ = ${v.toFixed(4)}`;
    case "gamma":      return `Γ = ${v.toFixed(6)}`;
    case "theta":      return `Θ = ${v.toFixed(4)} $/day`;
    case "vega":       return `ν = ${v.toFixed(4)} $/1%IV`;
  }
}

/** Per-metric color mapping */
function metricColor(v: number, metric: SurfaceMetric, minV: number, maxV: number): string {
  if (!v && v !== 0) return "transparent";
  const span = maxV - minV || 1;
  const t = Math.min(1, Math.max(0, (v - minV) / span));

  switch (metric) {
    case "iv":
      // Blue(low) → Cyan → Green → Yellow → Red(high)
      if (t < 0.25) return `hsl(${220 + t * 4 * 20}, 80%, 55%)`;
      if (t < 0.5)  return `hsl(${220 - (t - 0.25) * 4 * 120}, 80%, 50%)`;
      if (t < 0.75) return `hsl(${100 - (t - 0.5)  * 4 * 60},  85%, 48%)`;
      return              `hsl(${40  - (t - 0.75)   * 4 * 40},  90%, 44%)`;

    case "call_delta":
      // 0 (deep OTM) → teal (ATM ~0.5) → green (deep ITM ~1)
      return `hsl(${160 + (1 - t) * 60}, 70%, ${42 + t * 15}%)`;

    case "put_delta": {
      // -1 (deep ITM) → -0.5 (ATM) → 0 (deep OTM)
      // t=0 means most negative (deep ITM) → red; t=1 means near-zero (OTM) → pale
      const tt = 1 - t;  // flip: high t = OTM = pale
      return `hsl(${10 + tt * 20}, ${50 + tt * 30}%, ${38 + tt * 24}%)`;
    }

    case "gamma":
      // 0 (flat, OTM/ITM) → orange/yellow peak (ATM, highest gamma)
      return `hsl(${50 - t * 50}, ${60 + t * 30}%, ${38 + t * 20}%)`;

    case "theta":
      // Theta is negative; minV is most-negative (biggest decay = ATM short-dated)
      // t=0 → most negative → most red; t=1 → near-zero → pale
      return `hsl(${15 + t * 15}, ${70 - t * 30}%, ${35 + t * 28}%)`;

    case "vega":
      // 0 (short-dated OTM) → deep blue/teal (long-dated ATM, highest vega)
      return `hsl(${200 + t * 30}, ${60 + t * 25}%, ${60 - t * 22}%)`;
  }
}

// ── Surface sub-view ───────────────────────────────────────────────────────────

function SurfaceView({
  symbol, calls, puts, spot, expirations, colors,
}: {
  symbol: string;
  calls: OptionRow[];
  puts: OptionRow[];
  spot: number;
  expirations: string[];
  colors: typeof bloombergColors.dark;
}) {
  const [surfaceEnabled, setSurfaceEnabled] = useState(false);
  const [metric, setMetric] = useState<SurfaceMetric>("iv");
  const surfaceQuery = useOptionsSurface(symbol, surfaceEnabled);

  // ── IV Smile (current expiry, calls + puts) ────────────────────────────────
  const smileCalls = calls
    .filter(c => Math.abs(c.strike - spot) / spot <= 0.25 && c.impliedVolatility > 0.01)
    .sort((a, b) => a.strike - b.strike)
    .map(c => ({ strike: c.strike, callIV: +(c.impliedVolatility * 100).toFixed(2), label: `$${c.strike}` }));

  const putIVmap = new Map(
    puts
      .filter(p => p.impliedVolatility > 0.01)
      .map(p => [p.strike, +(p.impliedVolatility * 100).toFixed(2)]),
  );

  const smileMerged = smileCalls.map(s => ({ ...s, putIV: putIVmap.get(s.strike) ?? null }));

  // ── Surface grid (raw IV per cell) ─────────────────────────────────────────
  const surfaceData: { expiry: string; moneyness: number; iv: number; type: string }[] =
    surfaceQuery.data?.surface ?? [];

  const { grid, usedExpiries } = useMemo(
    () => buildSurfaceGrid(surfaceData, expirations),
    [surfaceData, expirations],
  );

  // ── Compute metric values for every cell ───────────────────────────────────
  const { cellValues, minV, maxV } = useMemo(() => {
    const vals: Record<string, Record<number, number>> = {};
    let lo = Infinity, hi = -Infinity;

    for (const exp of usedExpiries) {
      vals[exp] = {};
      for (const b of MONO_BUCKETS) {
        const cell = grid[exp]?.[b];
        if (!cell) { vals[exp][b] = 0; continue; }
        const avgIV = cell.iv / cell.n;
        const v = computeSurfaceMetric(metric, spot, b, exp, avgIV);
        vals[exp][b] = v;
        if (v !== 0) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
    }
    return { cellValues: vals, minV: isFinite(lo) ? lo : 0, maxV: isFinite(hi) ? hi : 1 };
  }, [grid, usedExpiries, metric, spot]);

  const currentMetricInfo = SURFACE_METRICS.find(m => m.id === metric)!;
  const panel = { backgroundColor: colors.surface, borderColor: colors.border };
  const sec   = { color: colors.textSecondary };

  return (
    <div className="space-y-4">

      {/* ── IV Smile ──────────────────────────────────────────────────────── */}
      <div className="p-4 border" style={panel}>
        <h4 className="text-[10px] font-bold tracking-widest mb-3" style={{ color: colors.accent }}>
          IV SMILE — NEAR-TERM EXPIRY
        </h4>
        {smileMerged.length === 0 ? (
          <div className="py-8 text-center text-xs" style={sec}>No IV data for current expiry</div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={210}>
              <LineChart data={smileMerged} margin={{ top: 4, right: 12, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="2 2" stroke={colors.border} />
                <XAxis dataKey="label" tick={{ fontSize: 8, fill: colors.textSecondary }} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 8, fill: colors.textSecondary }} tickLine={false} axisLine={false} width={34}
                  tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                <ReferenceLine x={`$${spot.toFixed(0)}`} stroke={colors.accent} strokeDasharray="3 2"
                  label={{ value: "ATM", fill: colors.accent, fontSize: 8, position: "top" }} />
                <Tooltip
                  contentStyle={{ backgroundColor: colors.surface, borderColor: colors.border, fontSize: 10, fontFamily: "monospace" }}
                  formatter={(v: number, name: string) => [`${v.toFixed(2)}%`, name === "callIV" ? "Call IV" : "Put IV"]}
                />
                <Line type="monotone" dataKey="callIV" stroke={colors.positive} strokeWidth={1.5} dot={false} isAnimationActive={false} name="callIV" />
                <Line type="monotone" dataKey="putIV"  stroke={colors.negative} strokeWidth={1.5} dot={false} isAnimationActive={false} name="putIV" />
              </LineChart>
            </ResponsiveContainer>
            <p className="text-[9px] mt-1" style={sec}>
              Green = Calls · Red = Puts ·{" "}
              <span style={{ color: colors.text }}>Skew</span> (puts pricier than calls) = market pricing in downside risk
            </p>
          </>
        )}
      </div>

      {/* ── Greek / IV Surface Heatmap ─────────────────────────────────────── */}
      <div className="p-4 border" style={panel}>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h4 className="text-[10px] font-bold tracking-widest" style={{ color: colors.accent }}>
            SURFACE HEATMAP  (Strike × Expiry → Z)
          </h4>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Metric selector */}
            {SURFACE_METRICS.map(m => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMetric(m.id)}
                className="px-2 py-0.5 text-[10px] font-bold border"
                style={{
                  borderColor:     metric === m.id ? colors.accent : colors.border,
                  backgroundColor: metric === m.id ? colors.accent : "transparent",
                  color:           metric === m.id ? "#000" : colors.textSecondary,
                }}
              >
                {m.label}
              </button>
            ))}
            {/* Load button */}
            {!surfaceEnabled && (
              <button
                type="button"
                onClick={() => setSurfaceEnabled(true)}
                className="px-3 py-0.5 text-[10px] border font-bold"
                style={{ borderColor: colors.positive, color: colors.positive }}
              >
                LOAD
              </button>
            )}
            {surfaceEnabled && surfaceQuery.isLoading && (
              <span className="flex items-center gap-1 text-[10px]" style={sec}>
                <RefreshCw className="h-3 w-3 animate-spin" /> loading…
              </span>
            )}
          </div>
        </div>

        {/* Metric description */}
        <p className="text-[9px] mb-3" style={sec}>
          <span style={{ color: colors.accent }}>{currentMetricInfo.label}</span>
          {" — "}{currentMetricInfo.desc}
        </p>

        {surfaceEnabled && surfaceQuery.isSuccess && usedExpiries.length > 0 && (
          <div className="overflow-x-auto">
            {/* Colour legend */}
            <div className="flex items-center gap-2 mb-3 text-[9px]" style={sec}>
              <span>Low</span>
              <div className="flex h-3 rounded overflow-hidden" style={{ width: 160 }}>
                {Array.from({ length: 24 }, (_, i) => {
                  const v = minV + (maxV - minV) * (i / 23);
                  return (
                    <div key={i} className="flex-1 h-3" style={{ backgroundColor: metricColor(v, metric, minV, maxV) }} />
                  );
                })}
              </div>
              <span>High</span>
              <span className="ml-2 font-mono">
                [{fmtCellFull(minV, metric)} → {fmtCellFull(maxV, metric)}]
              </span>
            </div>

            {/* Heatmap table */}
            <table className="text-[9px] border-collapse">
              <thead>
                <tr>
                  <th className="text-right pr-2 py-1 font-normal whitespace-nowrap" style={sec}>
                    Expiry ↓ \ Moneyness →
                  </th>
                  {MONO_BUCKETS.map(b => (
                    <th
                      key={b}
                      className="text-center px-0.5 py-1 font-normal w-8"
                      style={{ color: b === 0 ? colors.accent : colors.textSecondary }}
                    >
                      {b > 0 ? `+${b}` : `${b}`}%
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {usedExpiries.map(exp => (
                  <tr key={exp}>
                    <td className="text-right pr-2 py-0.5 font-mono whitespace-nowrap" style={sec}>{exp}</td>
                    {MONO_BUCKETS.map(b => {
                      const rawCell = grid[exp]?.[b];
                      const rawIV   = rawCell ? rawCell.iv / rawCell.n : 0;
                      const v       = cellValues[exp]?.[b] ?? 0;
                      const bg      = v ? metricColor(v, metric, minV, maxV) : "transparent";
                      const tooltip = rawIV > 0
                        ? `${fmtCellFull(v, metric)} | IV=${rawIV.toFixed(1)}%`
                        : "—";
                      return (
                        <td
                          key={b}
                          className="text-center px-0.5 py-0.5 w-8 cursor-default font-bold"
                          title={tooltip}
                          style={{
                            backgroundColor: bg,
                            color: v ? "#fff" : colors.border,
                            fontSize: 8,
                          }}
                        >
                          {fmtCell(v, metric)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="text-[9px] mt-2" style={sec}>
              X = moneyness from ATM (0%) · Y = expiration · Color intensity = {currentMetricInfo.label} magnitude ·
              Greeks computed with Black-Scholes (r=5%, IV from market)
            </p>
          </div>
        )}

        {surfaceEnabled && surfaceQuery.isSuccess && usedExpiries.length === 0 && (
          <p className="text-xs py-6 text-center" style={sec}>No surface data available for {symbol}</p>
        )}
        {surfaceEnabled && surfaceQuery.isError && (
          <p className="text-xs py-6 text-center" style={{ color: colors.negative }}>
            Failed to load surface — check backend connection
          </p>
        )}
        {!surfaceEnabled && (
          <div className="py-8 text-center space-y-2">
            <p className="text-xs" style={sec}>
              Surface requires fetching all expirations (~10 API calls). Click <strong>LOAD</strong> to proceed.
            </p>
            <p className="text-[9px]" style={sec}>
              Once loaded, switch between IV / Δ / Γ / Θ / ν to see each Greek's shape across the surface
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Greeks standalone sub-view component ──────────────────────────────────────
// (Must be a proper component so hooks are legal)

function GreeksView({
  strategies, spot, expiry, ivCurrent, colors,
}: {
  strategies: Strategy[];
  spot: number;
  expiry: string;
  ivCurrent: number;
  colors: typeof bloombergColors.dark;
}) {
  const [gs, setGs] = useState(strategies[0]?.id ?? "");
  const [gm, setGm] = useState<"delta" | "gamma" | "theta" | "vega">("delta");

  const T = daysToExpiry(expiry) / 365;
  const strat = strategies.find(s => s.id === gs) ?? strategies[0];
  const gData = strat ? buildGreeks(strat, spot, T, ivCurrent) : [];

  const panel = { backgroundColor: colors.surface, borderColor: colors.border };
  const sec   = { color: colors.textSecondary };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-[9px]" style={sec}>Strategy:</span>
        <select
          value={gs}
          onChange={e => setGs(e.target.value)}
          className="text-[10px] border px-2 py-0.5 font-mono"
          style={{ borderColor: colors.border, backgroundColor: colors.surface, color: colors.text }}
        >
          {strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span className="text-[9px] ml-2" style={sec}>Greek:</span>
        <div className="flex gap-1">
          {(["delta", "gamma", "theta", "vega"] as const).map(g => (
            <button key={g} type="button" onClick={() => setGm(g)}
              className="px-2 py-0.5 text-[10px] border"
              style={{ borderColor: gm === g ? colors.accent : colors.border, backgroundColor: gm === g ? colors.accent : "transparent", color: gm === g ? "#000" : colors.text }}>
              {g.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="p-4 border" style={panel}>
        <p className="text-[9px] mb-2" style={sec}>
          {gm === "delta" && "Δ — rate of change of strategy value per $1 in underlying"}
          {gm === "gamma" && "Γ — convexity (how fast delta changes); high gamma = big swings"}
          {gm === "theta" && "Θ — daily time decay; negative = losing value each day"}
          {gm === "vega"  && "ν — sensitivity to 1% change in implied volatility"}
        </p>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={gData} margin={{ top: 4, right: 8, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="2 2" stroke={colors.border} />
            <XAxis dataKey="label" tick={{ fontSize: 8, fill: colors.textSecondary }} tickLine={false} interval={10} />
            <YAxis tick={{ fontSize: 8, fill: colors.textSecondary }} tickLine={false} axisLine={false} width={48}
              tickFormatter={(v: number) => v.toFixed(4)} />
            <ReferenceLine y={0} stroke={colors.border} />
            <ReferenceLine x={`$${spot.toFixed(0)}`} stroke={colors.accent} strokeDasharray="3 2" strokeWidth={1} />
            <Tooltip
              contentStyle={{ backgroundColor: colors.surface, borderColor: colors.border, fontSize: 10, fontFamily: "monospace" }}
              formatter={(v: number) => [v.toFixed(5), gm.toUpperCase()]}
            />
            <Line type="monotone" dataKey={gm} stroke={colors.accent} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {strat && (
        <div className="p-3 border" style={panel}>
          <div className="text-[10px] font-bold tracking-wider mb-2" style={{ color: colors.accent }}>
            STRATEGY: {strat.name.toUpperCase()}
          </div>
          <div className="flex gap-3 flex-wrap text-[10px]">
            {strat.legs.map((l, i) => (
              <span key={i} style={{ color: l.action === "BUY" ? colors.positive : colors.negative }}>
                {l.action} {l.qty}× {l.kind}{l.strike ? ` @${l.strike}` : ""}
              </span>
            ))}
          </div>
          <p className="text-[9px] mt-1" style={sec}>
            T = {daysToExpiry(expiry).toFixed(0)} days · IV = {ivCurrent.toFixed(1)}% · r = 5%
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main OptionsTab component ──────────────────────────────────────────────────

export function OptionsTab({
  symbol, colors,
}: { symbol: string; colors: typeof bloombergColors.dark }) {
  const [selectedExpiry, setSelectedExpiry] = useState<string | undefined>(undefined);
  const [subView, setSubView] = useState<SubView>("chain");

  const query = useOptions(symbol, selectedExpiry);
  const data = query.data as {
    spot: number;
    expiry: string;
    expirations: string[];
    calls: OptionRow[];
    puts: OptionRow[];
    ivCurrent: number;
    pcRatio: number;
    callOI: number;
    putOI: number;
    callVolume: number;
    putVolume: number;
    error?: string;
  } | undefined;

  // Set expiry once data arrives
  useEffect(() => {
    if (data?.expiry && !selectedExpiry) setSelectedExpiry(data.expiry);
  }, [data?.expiry, selectedExpiry]);

  const strategies = useMemo(
    () => data ? buildStrategies(data.calls, data.puts, data.spot) : [],
    [data],
  );

  const panel = { backgroundColor: colors.surface, borderColor: colors.border };
  const sec = { color: colors.textSecondary };

  if (query.isLoading) return (
    <div className="flex items-center justify-center py-24">
      <RefreshCw className="h-5 w-5 animate-spin mr-3" style={{ color: colors.accent }} />
      <span className="text-sm" style={sec}>Loading options data for {symbol}…</span>
    </div>
  );

  if (query.isError || data?.error) return (
    <div className="py-12 text-center space-y-2">
      <AlertTriangle className="h-8 w-8 mx-auto" style={{ color: colors.negative }} />
      <p className="text-sm" style={{ color: colors.negative }}>Options data unavailable for {symbol}</p>
      <p className="text-xs" style={sec}>{data?.error ?? "Options may not trade on this security"}</p>
    </div>
  );

  if (!data) return null;

  const subViews: { id: SubView; label: string }[] = [
    { id: "chain",      label: "CHAIN"      },
    { id: "strategies", label: "STRATEGIES" },
    { id: "builder",    label: "BUILDER"    },
    { id: "greeks",     label: "GREEKS"     },
    { id: "surface",    label: "VOL SURFACE"},
  ];

  return (
    <div className="space-y-3">
      {/* Summary stats */}
      <div className="flex flex-wrap gap-2">
        <StatCard label="SPOT" value={`$${data.spot.toFixed(2)}`} colors={colors} />
        <StatCard label="ATM IV"  value={`${data.ivCurrent.toFixed(1)}%`} colors={colors} />
        <StatCard label="P/C RATIO" value={data.pcRatio.toFixed(2)} sub={data.pcRatio > 1 ? "Put-heavy" : "Call-heavy"} col={data.pcRatio > 1 ? colors.negative : colors.positive} colors={colors} />
        <StatCard label="CALL OI"   value={data.callOI.toLocaleString()}  sub="open interest" col={colors.positive} colors={colors} />
        <StatCard label="PUT OI"    value={data.putOI.toLocaleString()}   sub="open interest" col={colors.negative} colors={colors} />
        <StatCard label="CALL VOL"  value={(data.callVolume ?? 0).toLocaleString()} sub="volume today" colors={colors} />
        <StatCard label="PUT VOL"   value={(data.putVolume  ?? 0).toLocaleString()} sub="volume today" colors={colors} />
      </div>

      {/* Expiry pills */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-[9px] font-bold tracking-wider mr-1" style={sec}>EXPIRY:</span>
        {(data.expirations.slice(0, 12)).map(exp => (
          <button
            key={exp}
            type="button"
            onClick={() => setSelectedExpiry(exp)}
            className="px-2 py-0.5 text-[10px] border font-mono"
            style={{
              borderColor: selectedExpiry === exp ? colors.accent : colors.border,
              backgroundColor: selectedExpiry === exp ? `${colors.accent}20` : "transparent",
              color: selectedExpiry === exp ? colors.accent : colors.textSecondary,
            }}
          >
            {exp}
          </button>
        ))}
        {data.expirations.length > 12 && (
          <span className="text-[9px]" style={sec}>+{data.expirations.length - 12} more</span>
        )}
      </div>

      {/* Sub-view tabs */}
      <div className="flex gap-1 border-b" style={{ borderColor: colors.border }}>
        {subViews.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setSubView(id)}
            className="px-3 py-1.5 text-[10px] font-bold border-b-2 -mb-px"
            style={{
              borderColor: subView === id ? colors.accent : "transparent",
              color: subView === id ? colors.accent : colors.textSecondary,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Sub-view content */}
      {subView === "chain" && (
        <ChainView calls={data.calls} puts={data.puts} spot={data.spot} colors={colors} />
      )}

      {subView === "strategies" && (
        <StrategiesView
          strategies={strategies}
          spot={data.spot}
          expiry={data.expiry}
          ivCurrent={data.ivCurrent}
          colors={colors}
        />
      )}

      {subView === "builder" && (
        <StrategyBuilder
          symbol={symbol}
          chainData={{
            spot: data.spot,
            expiry: data.expiry,
            expirations: data.expirations,
            calls: data.calls,
            puts: data.puts,
            ivCurrent: data.ivCurrent,
          }}
          colors={colors}
        />
      )}

      {subView === "greeks" && (
        <GreeksView
          strategies={strategies}
          spot={data.spot}
          expiry={data.expiry}
          ivCurrent={data.ivCurrent}
          colors={colors}
        />
      )}

      {subView === "surface" && (
        <SurfaceView
          symbol={symbol}
          calls={data.calls}
          puts={data.puts}
          spot={data.spot}
          expirations={data.expirations}
          colors={colors}
        />
      )}
    </div>
  );
}
