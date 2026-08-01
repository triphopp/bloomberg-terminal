"use client";

import { ChevronDown, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useOptions } from "../hooks/useStockData";
import type { bloombergColors } from "../lib/theme-config";

// ── Types ────────────────────────────────────────────────────────────────────

type OptionRow = {
  contractSymbol: string;
  strike: number;
  lastPrice: number;
  bid: number;
  ask: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  inTheMoney: boolean;
  change: number;
  percentChange: number;
};

type ChainData = {
  spot: number;
  expiry: string;
  expirations: string[];
  calls: OptionRow[];
  puts: OptionRow[];
  ivCurrent: number;
};

export type BuilderLeg = {
  id: string;
  action: "BUY" | "SELL";
  kind: "CALL" | "PUT" | "SHARE";
  strike: number;
  expiry: string;
  premium: number;
  qty: number;
  iv: number;
};

type StrategyTemplate = {
  id: string;
  name: string;
  outlook: "BULLISH" | "BEARISH" | "NEUTRAL" | "VOLATILE" | "INCOME";
  description: string;
  multiExpiry: boolean;
  legs: TemplateLeg[];
};

type TemplateLeg = {
  action: "BUY" | "SELL";
  kind: "CALL" | "PUT" | "SHARE";
  strikeOffset: "ATM" | "OTM5" | "OTM10" | "ITM5" | "ITM10";
  expiryIndex: number; // 0 = near, 1 = far
  qty: number;
};

// ── Strategy templates ──────────────────────────────────────────────────────

const TEMPLATES: StrategyTemplate[] = [
  // ── BULLISH ──
  {
    id: "long-call",
    name: "Long Call",
    outlook: "BULLISH",
    description: "Unlimited upside, loss capped at premium",
    multiExpiry: false,
    legs: [{ action: "BUY", kind: "CALL", strikeOffset: "ATM", expiryIndex: 0, qty: 1 }],
  },
  {
    id: "bull-call-spread",
    name: "Bull Call Spread",
    outlook: "BULLISH",
    description: "Capped gain, lower cost than outright call",
    multiExpiry: false,
    legs: [
      { action: "BUY", kind: "CALL", strikeOffset: "ATM", expiryIndex: 0, qty: 1 },
      { action: "SELL", kind: "CALL", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
    ],
  },
  {
    id: "bull-put-spread",
    name: "Bull Put Spread",
    outlook: "BULLISH",
    description: "Credit spread; profit if stock stays above short put",
    multiExpiry: false,
    legs: [
      { action: "SELL", kind: "PUT", strikeOffset: "ATM", expiryIndex: 0, qty: 1 },
      { action: "BUY", kind: "PUT", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
    ],
  },
  // ── BEARISH ──
  {
    id: "long-put",
    name: "Long Put",
    outlook: "BEARISH",
    description: "Profits as stock falls, max loss is premium",
    multiExpiry: false,
    legs: [{ action: "BUY", kind: "PUT", strikeOffset: "ATM", expiryIndex: 0, qty: 1 }],
  },
  {
    id: "bear-put-spread",
    name: "Bear Put Spread",
    outlook: "BEARISH",
    description: "Debit spread for moderate downside",
    multiExpiry: false,
    legs: [
      { action: "BUY", kind: "PUT", strikeOffset: "ATM", expiryIndex: 0, qty: 1 },
      { action: "SELL", kind: "PUT", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
    ],
  },
  {
    id: "bear-call-spread",
    name: "Bear Call Spread",
    outlook: "BEARISH",
    description: "Credit spread; profit if stock stays below short call",
    multiExpiry: false,
    legs: [
      { action: "SELL", kind: "CALL", strikeOffset: "ATM", expiryIndex: 0, qty: 1 },
      { action: "BUY", kind: "CALL", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
    ],
  },
  // ── NEUTRAL ──
  {
    id: "iron-condor",
    name: "Iron Condor",
    outlook: "NEUTRAL",
    description: "Profit in range; 4-leg credit strategy",
    multiExpiry: false,
    legs: [
      { action: "SELL", kind: "CALL", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
      { action: "BUY", kind: "CALL", strikeOffset: "OTM10", expiryIndex: 0, qty: 1 },
      { action: "SELL", kind: "PUT", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
      { action: "BUY", kind: "PUT", strikeOffset: "OTM10", expiryIndex: 0, qty: 1 },
    ],
  },
  {
    id: "butterfly",
    name: "Butterfly Spread",
    outlook: "NEUTRAL",
    description: "Max profit at ATM; very low risk",
    multiExpiry: false,
    legs: [
      { action: "BUY", kind: "CALL", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
      { action: "SELL", kind: "CALL", strikeOffset: "ATM", expiryIndex: 0, qty: 2 },
      { action: "BUY", kind: "CALL", strikeOffset: "ITM5", expiryIndex: 0, qty: 1 },
    ],
  },
  {
    id: "iron-butterfly",
    name: "Iron Butterfly",
    outlook: "NEUTRAL",
    description: "ATM straddle + OTM wings; higher credit than condor",
    multiExpiry: false,
    legs: [
      { action: "SELL", kind: "CALL", strikeOffset: "ATM", expiryIndex: 0, qty: 1 },
      { action: "SELL", kind: "PUT", strikeOffset: "ATM", expiryIndex: 0, qty: 1 },
      { action: "BUY", kind: "CALL", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
      { action: "BUY", kind: "PUT", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
    ],
  },
  // ── VOLATILE ──
  {
    id: "long-straddle",
    name: "Long Straddle",
    outlook: "VOLATILE",
    description: "Profit from large move either direction",
    multiExpiry: false,
    legs: [
      { action: "BUY", kind: "CALL", strikeOffset: "ATM", expiryIndex: 0, qty: 1 },
      { action: "BUY", kind: "PUT", strikeOffset: "ATM", expiryIndex: 0, qty: 1 },
    ],
  },
  {
    id: "long-strangle",
    name: "Long Strangle",
    outlook: "VOLATILE",
    description: "Cheaper than straddle; needs bigger move",
    multiExpiry: false,
    legs: [
      { action: "BUY", kind: "CALL", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
      { action: "BUY", kind: "PUT", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
    ],
  },
  // ── INCOME ──
  {
    id: "covered-call",
    name: "Covered Call",
    outlook: "INCOME",
    description: "Own stock + sell OTM call for income",
    multiExpiry: false,
    legs: [
      { action: "BUY", kind: "SHARE", strikeOffset: "ATM", expiryIndex: 0, qty: 100 },
      { action: "SELL", kind: "CALL", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
    ],
  },
  {
    id: "cash-secured-put",
    name: "Cash-Secured Put",
    outlook: "INCOME",
    description: "Sell put to acquire stock cheaper or keep premium",
    multiExpiry: false,
    legs: [{ action: "SELL", kind: "PUT", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 }],
  },
  {
    id: "collar",
    name: "Collar",
    outlook: "INCOME",
    description: "Stock + protective put + covered call; limits both up & down",
    multiExpiry: false,
    legs: [
      { action: "BUY", kind: "SHARE", strikeOffset: "ATM", expiryIndex: 0, qty: 100 },
      { action: "BUY", kind: "PUT", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
      { action: "SELL", kind: "CALL", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
    ],
  },
  {
    id: "short-straddle",
    name: "Short Straddle",
    outlook: "INCOME",
    description: "Collect premium if stock stays near ATM (unlimited risk)",
    multiExpiry: false,
    legs: [
      { action: "SELL", kind: "CALL", strikeOffset: "ATM", expiryIndex: 0, qty: 1 },
      { action: "SELL", kind: "PUT", strikeOffset: "ATM", expiryIndex: 0, qty: 1 },
    ],
  },
  // ── MULTI-EXPIRY ──
  {
    id: "calendar-call",
    name: "Calendar Spread (Call)",
    outlook: "NEUTRAL",
    description: "Same K, different expiry; profit from time decay difference",
    multiExpiry: true,
    legs: [
      { action: "SELL", kind: "CALL", strikeOffset: "ATM", expiryIndex: 0, qty: 1 },
      { action: "BUY", kind: "CALL", strikeOffset: "ATM", expiryIndex: 1, qty: 1 },
    ],
  },
  {
    id: "calendar-put",
    name: "Calendar Spread (Put)",
    outlook: "NEUTRAL",
    description: "Same K, different expiry; put version",
    multiExpiry: true,
    legs: [
      { action: "SELL", kind: "PUT", strikeOffset: "ATM", expiryIndex: 0, qty: 1 },
      { action: "BUY", kind: "PUT", strikeOffset: "ATM", expiryIndex: 1, qty: 1 },
    ],
  },
  {
    id: "diagonal-call",
    name: "Diagonal Spread (Call)",
    outlook: "BULLISH",
    description: "Different K + different expiry; directional calendar",
    multiExpiry: true,
    legs: [
      { action: "SELL", kind: "CALL", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
      { action: "BUY", kind: "CALL", strikeOffset: "ATM", expiryIndex: 1, qty: 1 },
    ],
  },
  {
    id: "diagonal-put",
    name: "Diagonal Spread (Put)",
    outlook: "BEARISH",
    description: "Different K + different expiry; put diagonal",
    multiExpiry: true,
    legs: [
      { action: "SELL", kind: "PUT", strikeOffset: "OTM5", expiryIndex: 0, qty: 1 },
      { action: "BUY", kind: "PUT", strikeOffset: "ATM", expiryIndex: 1, qty: 1 },
    ],
  },
];

const OUTLOOK_COLORS: Record<string, string> = {
  BULLISH: "#16a34a",
  BEARISH: "#dc2626",
  NEUTRAL: "#9ca3af",
  VOLATILE: "#f59e0b",
  INCOME: "#6366f1",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function mid(o: OptionRow): number {
  return o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : o.lastPrice || 0;
}

function nearest(opts: OptionRow[], targetStrike: number): OptionRow | undefined {
  return opts.reduce<OptionRow | undefined>(
    (best, o) =>
      !best || Math.abs(o.strike - targetStrike) < Math.abs(best.strike - targetStrike) ? o : best,
    undefined
  );
}

function resolveStrike(spot: number, offset: TemplateLeg["strikeOffset"]): number {
  switch (offset) {
    case "ATM":
      return spot;
    case "OTM5":
      return spot * 1.05;
    case "OTM10":
      return spot * 1.1;
    case "ITM5":
      return spot * 0.95;
    case "ITM10":
      return spot * 0.9;
  }
}

function resolveStrikeForPut(spot: number, offset: TemplateLeg["strikeOffset"]): number {
  switch (offset) {
    case "ATM":
      return spot;
    case "OTM5":
      return spot * 0.95;
    case "OTM10":
      return spot * 0.9;
    case "ITM5":
      return spot * 1.05;
    case "ITM10":
      return spot * 1.1;
  }
}

function findContract(
  calls: OptionRow[],
  puts: OptionRow[],
  spot: number,
  kind: "CALL" | "PUT",
  offset: TemplateLeg["strikeOffset"]
): OptionRow | undefined {
  if (kind === "CALL") {
    const target = resolveStrike(spot, offset);
    return nearest(calls, target);
  }
  const target = resolveStrikeForPut(spot, offset);
  return nearest(puts, target);
}

let _legId = 0;
function nextLegId(): string {
  return `leg-${++_legId}-${Date.now()}`;
}

// ── Black-Scholes pricing for multi-expiry payoff ────────────────────────────

function normCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function bsPrice(
  S: number,
  K: number,
  T: number,
  r: number,
  sig: number,
  type: "call" | "put"
): number {
  if (T <= 0.001) return type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const s = sig <= 0 ? 0.001 : sig;
  const d1 = (Math.log(S / K) + (r + 0.5 * s * s) * T) / (s * Math.sqrt(T));
  const d2 = d1 - s * Math.sqrt(T);
  if (type === "call") return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

function daysToExpiry(expiryStr: string): number {
  const exp = new Date(`${expiryStr}T16:00:00`);
  const now = new Date();
  return Math.max(0, (exp.getTime() - now.getTime()) / 86_400_000);
}

// ── Payoff computation ───────────────────────────────────────────────────────

function legPnl(leg: BuilderLeg, S: number, spot: number, evalExpiry: string): number {
  const dir = leg.action === "BUY" ? 1 : -1;
  if (leg.kind === "SHARE") return dir * (S - spot) * (leg.qty / 100);

  // If leg expires at evaluation date → intrinsic only
  if (leg.expiry <= evalExpiry) {
    if (leg.kind === "CALL") return dir * (Math.max(S - leg.strike, 0) - leg.premium);
    if (leg.kind === "PUT") return dir * (Math.max(leg.strike - S, 0) - leg.premium);
  }

  // Far-dated leg still has time value → use BS pricing
  const remainingDays = daysToExpiry(leg.expiry) - daysToExpiry(evalExpiry);
  const T = Math.max(0.003, remainingDays / 365);
  const sig = leg.iv > 0 ? leg.iv : 0.3;
  const r = 0.05;
  const type = leg.kind.toLowerCase() as "call" | "put";
  const currentValue = bsPrice(S, leg.strike, T, r, sig, type);
  return dir * (currentValue - leg.premium);
}

function buildPayoff(legs: BuilderLeg[], spot: number, nPoints = 120) {
  // Evaluate at earliest expiry (near-term leg)
  const expiries = legs
    .filter((l) => l.kind !== "SHARE")
    .map((l) => l.expiry)
    .sort();
  const evalExpiry = expiries[0] || "";

  const lo = spot * 0.6;
  const hi = spot * 1.4;
  const step = (hi - lo) / nPoints;
  return Array.from({ length: nPoints + 1 }, (_, i) => {
    const S = lo + i * step;
    const pnl = legs.reduce((sum, l) => sum + legPnl(l, S, spot, evalExpiry), 0);
    return { price: +S.toFixed(2), pnl: +(pnl * 100).toFixed(2), label: `$${S.toFixed(0)}` };
  });
}

// ── Lognormal probability engine ─────────────────────────────────────────────

function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function lognormalPDF(S: number, mu: number, sigma: number): number {
  if (S <= 0 || sigma <= 0) return 0;
  return normPDF((Math.log(S) - mu) / sigma) / (S * sigma);
}

type StrategyMetrics = {
  netCost: number;
  maxProfit: number | null;
  maxLoss: number | null;
  breakevens: number[];
  pop: number; // Probability of Profit (0-100)
  expectedPnl: number; // E[P&L] in dollars (per contract ×100)
  riskReward: number; // E[P&L] / max_loss — positive = favorable
  kellyPct: number; // Kelly fraction suggestion (0-100)
  sharpeEst: number; // estimated Sharpe-like ratio
};

function computeStats(legs: BuilderLeg[], spot: number, ivAnnual: number): StrategyMetrics {
  const nGrid = 500;
  const payoff = buildPayoff(legs, spot, nGrid);
  const pnls = payoff.map((p) => p.pnl);
  const maxProfit = Math.max(...pnls);
  const maxLoss = Math.min(...pnls);

  const netCost = legs.reduce((sum, l) => {
    if (l.kind === "SHARE") return sum + (l.action === "BUY" ? 1 : -1) * spot * (l.qty / 100);
    return sum + (l.action === "BUY" ? 1 : -1) * l.premium;
  }, 0);

  // Breakevens
  const breakevens: number[] = [];
  for (let i = 1; i < payoff.length; i++) {
    if (
      (payoff[i - 1].pnl <= 0 && payoff[i].pnl >= 0) ||
      (payoff[i - 1].pnl >= 0 && payoff[i].pnl <= 0)
    ) {
      breakevens.push(payoff[i].price);
    }
  }

  const isUnlimitedProfit = maxProfit > spot * 30;
  const isUnlimitedLoss = maxLoss < -spot * 30;

  // Lognormal probability integration
  const expiries = legs
    .filter((l) => l.kind !== "SHARE")
    .map((l) => l.expiry)
    .sort();
  const T = expiries.length > 0 ? Math.max(0.003, daysToExpiry(expiries[0]) / 365) : 30 / 365;
  const sig = Math.max(0.05, ivAnnual > 0 ? ivAnnual : 0.3);
  const r = 0.05;
  const mu = Math.log(spot) + (r - 0.5 * sig * sig) * T;
  const sigT = sig * Math.sqrt(T);

  let probProfit = 0;
  let expectedPnl = 0;
  let expectedPnlSq = 0;
  let totalProb = 0;

  for (let i = 0; i < payoff.length; i++) {
    const S = payoff[i].price;
    const dS =
      i < payoff.length - 1 ? payoff[i + 1].price - S : payoff[i].price - payoff[i - 1].price;
    const prob = lognormalPDF(S, mu, sigT) * dS;
    totalProb += prob;

    const pnl = payoff[i].pnl;
    expectedPnl += pnl * prob;
    expectedPnlSq += pnl * pnl * prob;
    if (pnl > 0) probProfit += prob;
  }

  // Normalize (numerical integration may not sum to exactly 1)
  const norm = totalProb > 0 ? 1 / totalProb : 1;
  probProfit *= norm;
  expectedPnl *= norm;
  expectedPnlSq *= norm;

  const pop = probProfit * 100;
  const variance = expectedPnlSq - expectedPnl * expectedPnl;
  const stddev = Math.sqrt(Math.max(0, variance));

  // Risk/reward: E[P&L] relative to max loss
  const absMaxLoss = Math.abs(isUnlimitedLoss ? maxLoss : (maxLoss ?? 0));
  const riskReward = absMaxLoss > 0 ? expectedPnl / absMaxLoss : 0;

  // Kelly criterion: f* = (p × b - q) / b where p=PoP, q=1-p, b=avgWin/avgLoss
  let avgWin = 0;
  let avgLoss = 0;
  let winCount = 0;
  let lossCount = 0;
  for (let i = 0; i < payoff.length; i++) {
    const S = payoff[i].price;
    const dS =
      i < payoff.length - 1 ? payoff[i + 1].price - S : payoff[i].price - payoff[i - 1].price;
    const prob = lognormalPDF(S, mu, sigT) * dS * norm;
    if (payoff[i].pnl > 0) {
      avgWin += payoff[i].pnl * prob;
      winCount += prob;
    } else if (payoff[i].pnl < 0) {
      avgLoss += Math.abs(payoff[i].pnl) * prob;
      lossCount += prob;
    }
  }
  const bRatio =
    winCount > 0 && lossCount > 0 && avgLoss > 0 ? avgWin / winCount / (avgLoss / lossCount) : 0;
  const kellyPct =
    bRatio > 0
      ? Math.max(0, Math.min(100, ((probProfit * bRatio - (1 - probProfit)) / bRatio) * 100))
      : 0;

  // Sharpe-like: E[P&L] / σ(P&L) annualized
  const sharpeEst = stddev > 0 ? (expectedPnl / stddev) * Math.sqrt(252 / Math.max(1, T * 365)) : 0;

  return {
    netCost,
    maxProfit: isUnlimitedProfit ? null : maxProfit,
    maxLoss: isUnlimitedLoss ? null : maxLoss,
    breakevens,
    pop,
    expectedPnl,
    riskReward,
    kellyPct,
    sharpeEst,
  };
}

// ── Quick metrics for ranking all strategies ─────────────────────────────────

type QuickMetrics = {
  id: string;
  name: string;
  outlook: string;
  pop: number;
  expectedPnl: number;
  riskReward: number;
  kellyPct: number;
};

function buildLegsForTemplate(
  template: StrategyTemplate,
  calls: OptionRow[],
  puts: OptionRow[],
  spot: number,
  nearExpiry: string,
  farExpiry: string,
  farCalls?: OptionRow[],
  farPuts?: OptionRow[]
): BuilderLeg[] {
  const result: BuilderLeg[] = [];
  for (const tl of template.legs) {
    if (tl.kind === "SHARE") {
      result.push({
        id: `rank-${template.id}-${result.length}`,
        action: tl.action,
        kind: "SHARE",
        strike: spot,
        expiry: nearExpiry,
        premium: spot,
        qty: tl.qty,
        iv: 0,
      });
      continue;
    }
    const isNear = tl.expiryIndex === 0;
    const c = isNear ? calls : (farCalls ?? calls);
    const p = isNear ? puts : (farPuts ?? puts);
    const contract = findContract(c, p, spot, tl.kind, tl.strikeOffset);
    if (!contract) return []; // can't build → skip
    result.push({
      id: `rank-${template.id}-${result.length}`,
      action: tl.action,
      kind: tl.kind,
      strike: contract.strike,
      expiry: isNear ? nearExpiry : farExpiry,
      premium: mid(contract),
      qty: tl.qty,
      iv: contract.impliedVolatility,
    });
  }
  return result;
}

function rankAllStrategies(
  calls: OptionRow[],
  puts: OptionRow[],
  spot: number,
  iv: number,
  nearExpiry: string,
  farExpiry: string,
  farCalls?: OptionRow[],
  farPuts?: OptionRow[]
): QuickMetrics[] {
  const results: QuickMetrics[] = [];
  for (const t of TEMPLATES) {
    if (t.multiExpiry && (!farCalls || !farPuts)) continue;
    const legs = buildLegsForTemplate(
      t,
      calls,
      puts,
      spot,
      nearExpiry,
      farExpiry,
      farCalls,
      farPuts
    );
    if (legs.length === 0) continue;
    const stats = computeStats(legs, spot, iv);
    results.push({
      id: t.id,
      name: t.name,
      outlook: t.outlook,
      pop: stats.pop,
      expectedPnl: stats.expectedPnl,
      riskReward: stats.riskReward,
      kellyPct: stats.kellyPct,
    });
  }
  results.sort((a, b) => b.expectedPnl - a.expectedPnl);
  return results;
}

// ── OutlookBadge ─────────────────────────────────────────────────────────────

function OutlookBadge({ v }: { v: string }) {
  return (
    <span
      className="text-[8px] font-bold px-1 py-0.5 border"
      style={{ color: OUTLOOK_COLORS[v] ?? "#999", borderColor: OUTLOOK_COLORS[v] ?? "#999" }}
    >
      {v}
    </span>
  );
}

// ── Strategy Selector ────────────────────────────────────────────────────────

function StrategySelector({
  selected,
  onSelect,
  colors,
}: {
  selected: string;
  onSelect: (id: string) => void;
  colors: typeof bloombergColors.dark;
}) {
  const [filterOutlook, setFilterOutlook] = useState<string>("ALL");
  const outlooks = ["ALL", "BULLISH", "BEARISH", "NEUTRAL", "VOLATILE", "INCOME"];

  const visible =
    filterOutlook === "ALL" ? TEMPLATES : TEMPLATES.filter((t) => t.outlook === filterOutlook);

  return (
    <div className="space-y-2">
      <div className="flex gap-1 flex-wrap">
        {outlooks.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => setFilterOutlook(o)}
            className="px-2 py-0.5 text-[9px] font-bold border"
            style={{
              borderColor: filterOutlook === o ? colors.accent : colors.border,
              backgroundColor: filterOutlook === o ? colors.accent : "transparent",
              color: filterOutlook === o ? "#000" : colors.text,
            }}
          >
            {o}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5 max-h-[280px] overflow-y-auto pr-1">
        {visible.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            className="text-left p-2 border hover:opacity-80 transition-opacity"
            style={{
              borderColor: selected === t.id ? colors.accent : colors.border,
              backgroundColor: selected === t.id ? `${colors.accent}18` : colors.surface,
            }}
          >
            <div className="flex items-center gap-1 mb-0.5">
              <span
                className="text-[10px] font-bold truncate"
                style={{ color: selected === t.id ? colors.accent : colors.text }}
              >
                {t.name}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <OutlookBadge v={t.outlook} />
              {t.multiExpiry && (
                <span
                  className="text-[7px] font-bold px-1 py-0.5 border"
                  style={{ color: "#38bdf8", borderColor: "#38bdf8" }}
                >
                  MULTI-EXP
                </span>
              )}
            </div>
            <p className="text-[8px] mt-1 leading-tight" style={{ color: colors.textSecondary }}>
              {t.description}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Leg Editor ───────────────────────────────────────────────────────────────

function LegEditor({
  legs,
  availableStrikes,
  availableExpiries,
  spot,
  colors,
  onUpdateLeg,
  onRemoveLeg,
  onAddLeg,
}: {
  legs: BuilderLeg[];
  availableStrikes: number[];
  availableExpiries: string[];
  spot: number;
  colors: typeof bloombergColors.dark;
  onUpdateLeg: (id: string, updates: Partial<BuilderLeg>) => void;
  onRemoveLeg: (id: string) => void;
  onAddLeg: () => void;
}) {
  const sec = { color: colors.textSecondary };

  return (
    <div className="space-y-1.5">
      <table className="w-full text-[10px]">
        <thead>
          <tr style={{ color: colors.textSecondary }}>
            <th className="text-left font-normal pb-1 w-16">Action</th>
            <th className="text-left font-normal pb-1 w-14">Type</th>
            <th className="text-left font-normal pb-1">Strike</th>
            <th className="text-left font-normal pb-1">Expiry</th>
            <th className="text-right font-normal pb-1 w-16">Premium</th>
            <th className="text-right font-normal pb-1 w-10">Qty</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {legs.map((leg) => (
            <tr key={leg.id} style={{ borderTop: `1px solid ${colors.border}` }}>
              <td className="py-1">
                <select
                  value={leg.action}
                  onChange={(e) =>
                    onUpdateLeg(leg.id, { action: e.target.value as "BUY" | "SELL" })
                  }
                  className="text-[10px] font-bold px-1 py-0.5 border bg-transparent"
                  style={{
                    borderColor: colors.border,
                    color: leg.action === "BUY" ? colors.positive : colors.negative,
                  }}
                >
                  <option value="BUY">BUY</option>
                  <option value="SELL">SELL</option>
                </select>
              </td>
              <td className="py-1">
                <select
                  value={leg.kind}
                  onChange={(e) =>
                    onUpdateLeg(leg.id, { kind: e.target.value as "CALL" | "PUT" | "SHARE" })
                  }
                  className="text-[10px] font-mono px-1 py-0.5 border bg-transparent"
                  style={{ borderColor: colors.border, color: colors.text }}
                >
                  <option value="CALL">CALL</option>
                  <option value="PUT">PUT</option>
                  <option value="SHARE">SHARE</option>
                </select>
              </td>
              <td className="py-1">
                {leg.kind === "SHARE" ? (
                  <span className="text-[10px] font-mono" style={sec}>
                    SPOT
                  </span>
                ) : (
                  <select
                    value={leg.strike}
                    onChange={(e) =>
                      onUpdateLeg(leg.id, { strike: Number.parseFloat(e.target.value) })
                    }
                    className="text-[10px] font-mono px-1 py-0.5 border bg-transparent w-20"
                    style={{ borderColor: colors.border, color: colors.text }}
                  >
                    {availableStrikes.map((k) => (
                      <option key={k} value={k}>
                        {k}
                        {Math.abs(k - spot) / spot < 0.015 ? " ◀ATM" : ""}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td className="py-1">
                {leg.kind === "SHARE" ? (
                  <span className="text-[10px] font-mono" style={sec}>
                    —
                  </span>
                ) : (
                  <select
                    value={leg.expiry}
                    onChange={(e) => onUpdateLeg(leg.id, { expiry: e.target.value })}
                    className="text-[10px] font-mono px-1 py-0.5 border bg-transparent"
                    style={{ borderColor: colors.border, color: colors.text }}
                  >
                    {availableExpiries.map((exp) => (
                      <option key={exp} value={exp}>
                        {exp}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td className="py-1 text-right">
                <span className="text-[10px] font-mono" style={{ color: colors.text }}>
                  ${leg.premium.toFixed(2)}
                </span>
              </td>
              <td className="py-1 text-right">
                <input
                  type="number"
                  value={leg.qty}
                  onChange={(e) =>
                    onUpdateLeg(leg.id, { qty: Number.parseInt(e.target.value) || 1 })
                  }
                  className="text-[10px] font-mono text-right w-10 px-1 py-0.5 border bg-transparent"
                  style={{ borderColor: colors.border, color: colors.text }}
                  min={1}
                />
              </td>
              <td className="py-1 text-center">
                <button
                  type="button"
                  onClick={() => onRemoveLeg(leg.id)}
                  className="p-0.5 opacity-40 hover:opacity-100"
                  title="Remove leg"
                >
                  <Trash2 className="w-3 h-3" style={{ color: colors.negative }} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        onClick={onAddLeg}
        className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold border"
        style={{ borderColor: colors.border, color: colors.textSecondary }}
      >
        <Plus className="w-3 h-3" /> ADD LEG
      </button>
    </div>
  );
}

// ── Payoff Chart ─────────────────────────────────────────────────────────────

function popColor(pop: number): string {
  if (pop >= 65) return "#16a34a";
  if (pop >= 45) return "#f59e0b";
  return "#dc2626";
}

function epnlColor(v: number): string {
  if (v > 10) return "#16a34a";
  if (v > -10) return "#9ca3af";
  return "#dc2626";
}

function PayoffChart({
  legs,
  spot,
  ivAnnual,
  colors,
}: {
  legs: BuilderLeg[];
  spot: number;
  ivAnnual: number;
  colors: typeof bloombergColors.dark;
}) {
  const payoff = useMemo(() => buildPayoff(legs, spot), [legs, spot]);
  const stats = useMemo(() => computeStats(legs, spot, ivAnnual), [legs, spot, ivAnnual]);

  const maxY = Math.max(...payoff.map((d) => Math.abs(d.pnl)), 1);
  const domainY: [number, number] = [-maxY * 1.15, maxY * 1.15];

  const panel = { backgroundColor: colors.surface, borderColor: colors.border };
  const sec = { color: colors.textSecondary };

  return (
    <div className="space-y-3">
      {/* P&L stats row */}
      <div className="grid grid-cols-4 gap-2 text-[10px]">
        {[
          {
            label: "NET COST",
            value:
              stats.netCost > 0
                ? `Debit $${(stats.netCost * 100).toFixed(0)}`
                : `Credit $${(Math.abs(stats.netCost) * 100).toFixed(0)}`,
            col: stats.netCost > 0 ? colors.negative : colors.positive,
          },
          {
            label: "MAX PROFIT",
            value: stats.maxProfit == null ? "Unlimited" : `$${stats.maxProfit.toFixed(0)}`,
            col: colors.positive,
          },
          {
            label: "MAX LOSS",
            value: stats.maxLoss == null ? "Unlimited" : `$${Math.abs(stats.maxLoss).toFixed(0)}`,
            col: colors.negative,
          },
          {
            label: "BREAKEVEN",
            value:
              stats.breakevens.length > 0
                ? stats.breakevens.map((b) => `$${b.toFixed(0)}`).join(" / ")
                : "N/A",
            col: colors.text,
          },
        ].map(({ label, value, col }) => (
          <div
            key={label}
            className="p-1.5 border text-center"
            style={{ borderColor: colors.border }}
          >
            <div className="text-[8px] tracking-wider mb-0.5" style={sec}>
              {label}
            </div>
            <div className="font-bold font-mono" style={{ color: col, fontSize: 10 }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* Probability metrics row */}
      <div className="grid grid-cols-4 gap-2 text-[10px]">
        <div className="p-2 border text-center" style={{ borderColor: colors.border }}>
          <div className="text-[8px] tracking-wider mb-0.5" style={sec}>
            PROB OF PROFIT
          </div>
          <div className="text-sm font-bold font-mono" style={{ color: popColor(stats.pop) }}>
            {stats.pop.toFixed(1)}%
          </div>
          <div
            className="w-full h-1 mt-1 rounded overflow-hidden"
            style={{ backgroundColor: colors.border }}
          >
            <div
              className="h-full rounded"
              style={{
                width: `${Math.min(100, stats.pop)}%`,
                backgroundColor: popColor(stats.pop),
              }}
            />
          </div>
        </div>
        <div className="p-2 border text-center" style={{ borderColor: colors.border }}>
          <div className="text-[8px] tracking-wider mb-0.5" style={sec}>
            E[P&L]
          </div>
          <div
            className="text-sm font-bold font-mono"
            style={{ color: epnlColor(stats.expectedPnl) }}
          >
            {stats.expectedPnl >= 0 ? "+" : ""}${stats.expectedPnl.toFixed(0)}
          </div>
          <div className="text-[8px] mt-0.5" style={sec}>
            per contract
          </div>
        </div>
        <div className="p-2 border text-center" style={{ borderColor: colors.border }}>
          <div className="text-[8px] tracking-wider mb-0.5" style={sec}>
            RISK/REWARD
          </div>
          <div
            className="text-sm font-bold font-mono"
            style={{ color: stats.riskReward > 0 ? colors.positive : colors.negative }}
          >
            {stats.riskReward >= 0 ? "+" : ""}
            {(stats.riskReward * 100).toFixed(1)}%
          </div>
          <div className="text-[8px] mt-0.5" style={sec}>
            E[P&L] / MaxLoss
          </div>
        </div>
        <div className="p-2 border text-center" style={{ borderColor: colors.border }}>
          <div className="text-[8px] tracking-wider mb-0.5" style={sec}>
            KELLY %
          </div>
          <div
            className="text-sm font-bold font-mono"
            style={{ color: stats.kellyPct > 5 ? colors.positive : colors.textSecondary }}
          >
            {stats.kellyPct.toFixed(1)}%
          </div>
          <div className="text-[8px] mt-0.5" style={sec}>
            optimal sizing
          </div>
        </div>
      </div>

      {/* Verdict banner */}
      <div
        className="flex items-center gap-3 px-3 py-2 border text-[10px]"
        style={{
          borderColor: stats.expectedPnl > 0 ? "#16a34a44" : "#dc262644",
          backgroundColor: stats.expectedPnl > 0 ? "#16a34a0a" : "#dc26260a",
        }}
      >
        <span className="text-base">
          {stats.expectedPnl > 0 ? "+" : stats.expectedPnl > -20 ? "~" : "-"}
        </span>
        <div>
          <span
            className="font-bold"
            style={{
              color:
                stats.expectedPnl > 0 ? "#16a34a" : stats.expectedPnl > -20 ? "#f59e0b" : "#dc2626",
            }}
          >
            {stats.expectedPnl > 0
              ? "POSITIVE EDGE"
              : stats.expectedPnl > -20
                ? "NEAR NEUTRAL"
                : "NEGATIVE EDGE"}
          </span>
          <span className="ml-2" style={sec}>
            PoP {stats.pop.toFixed(0)}% · E[P&L] ${stats.expectedPnl.toFixed(0)} ·
            {stats.pop > 60 && stats.expectedPnl > 0
              ? " High probability + positive EV — favorable setup"
              : stats.pop > 50 && stats.expectedPnl > -20
                ? " Moderate edge — consider position sizing"
                : " Low probability or negative EV — review thesis before entry"}
          </span>
        </div>
      </div>

      {/* Payoff diagram */}
      <div className="p-3 border" style={panel}>
        <h4 className="text-[10px] font-bold tracking-widest mb-2" style={{ color: colors.accent }}>
          PAYOFF AT EXPIRATION (per contract = ×100)
        </h4>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={payoff} margin={{ top: 4, right: 8, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="2 2" stroke={colors.border} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 8, fill: colors.textSecondary }}
              tickLine={false}
              interval={Math.floor(payoff.length / 8)}
            />
            <YAxis
              tick={{ fontSize: 8, fill: colors.textSecondary }}
              tickLine={false}
              axisLine={false}
              width={50}
              tickFormatter={(v: number) => `$${v.toFixed(0)}`}
              domain={domainY}
            />
            <ReferenceLine y={0} stroke={colors.border} strokeWidth={1} />
            <ReferenceLine
              x={`$${spot.toFixed(0)}`}
              stroke={colors.accent}
              strokeDasharray="3 2"
              strokeWidth={1}
              label={{ value: "SPOT", fill: colors.accent, fontSize: 8 }}
            />
            {stats.breakevens.map((be) => (
              <ReferenceLine
                key={be}
                x={`$${be.toFixed(0)}`}
                stroke="#f59e0b"
                strokeDasharray="2 2"
                strokeWidth={1}
                label={{ value: "BE", fill: "#f59e0b", fontSize: 7 }}
              />
            ))}
            <Tooltip
              contentStyle={{
                backgroundColor: colors.surface,
                borderColor: colors.border,
                fontSize: 10,
                fontFamily: "monospace",
              }}
              formatter={(v: number) => [`$${v.toFixed(2)}`, "P&L"]}
            />
            <Area
              type="monotone"
              dataKey="pnl"
              stroke="none"
              fill={colors.positive}
              fillOpacity={0.2}
              isAnimationActive={false}
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
        <p className="text-[8px] mt-1" style={sec}>
          Probability model: lognormal (IV={((ivAnnual || 0.3) * 100).toFixed(0)}%, r=5%) · PoP and
          E[P&L] assume hold to near-term expiry
        </p>
      </div>
    </div>
  );
}

// ── Strategy Ranking Table ───────────────────────────────────────────────────

function RankingTable({
  rankings,
  selected,
  onSelect,
  colors,
}: {
  rankings: QuickMetrics[];
  selected: string;
  onSelect: (id: string) => void;
  colors: typeof bloombergColors.dark;
}) {
  const [sortBy, setSortBy] = useState<"expectedPnl" | "pop" | "riskReward" | "kellyPct">(
    "expectedPnl"
  );
  const sorted = useMemo(() => {
    return [...rankings].sort((a, b) => b[sortBy] - a[sortBy]);
  }, [rankings, sortBy]);

  const panel = { backgroundColor: colors.surface, borderColor: colors.border };
  const sec = { color: colors.textSecondary };
  const th = "text-[9px] font-bold tracking-wider py-1 px-2 cursor-pointer select-none";
  // Shared a11y wiring for the sortable column headers below — a <th onClick>
  // has no keyboard equivalent on its own, so give it a button role + Enter/Space.
  const sortHeaderProps = (col: typeof sortBy) => ({
    role: "button" as const,
    tabIndex: 0,
    onClick: () => setSortBy(col),
    onKeyDown: (e: KeyboardEvent<HTMLTableCellElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setSortBy(col);
      }
    },
  });

  return (
    <div className="p-3 border" style={panel}>
      <h4 className="text-[10px] font-bold tracking-widest mb-2" style={{ color: colors.accent }}>
        STRATEGY RANKING — ALL TEMPLATES
      </h4>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              <th className={`${th} text-left`} style={sec}>
                #
              </th>
              <th className={`${th} text-left`} style={sec}>
                STRATEGY
              </th>
              <th className={`${th} text-left`} style={sec}>
                OUTLOOK
              </th>
              <th
                className={`${th} text-right`}
                style={{ color: sortBy === "pop" ? colors.accent : colors.textSecondary }}
                {...sortHeaderProps("pop")}
              >
                PoP% {sortBy === "pop" ? "▼" : ""}
              </th>
              <th
                className={`${th} text-right`}
                style={{ color: sortBy === "expectedPnl" ? colors.accent : colors.textSecondary }}
                {...sortHeaderProps("expectedPnl")}
              >
                E[P&L] {sortBy === "expectedPnl" ? "▼" : ""}
              </th>
              <th
                className={`${th} text-right`}
                style={{ color: sortBy === "riskReward" ? colors.accent : colors.textSecondary }}
                {...sortHeaderProps("riskReward")}
              >
                R/R% {sortBy === "riskReward" ? "▼" : ""}
              </th>
              <th
                className={`${th} text-right`}
                style={{ color: sortBy === "kellyPct" ? colors.accent : colors.textSecondary }}
                {...sortHeaderProps("kellyPct")}
              >
                KELLY% {sortBy === "kellyPct" ? "▼" : ""}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr
                key={r.id}
                tabIndex={0}
                onClick={() => onSelect(r.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(r.id);
                  }
                }}
                className="cursor-pointer hover:opacity-80"
                style={{
                  borderBottom: `1px solid ${colors.border}`,
                  backgroundColor: selected === r.id ? `${colors.accent}18` : "transparent",
                }}
              >
                <td className="px-2 py-1 font-mono" style={sec}>
                  {i + 1}
                </td>
                <td
                  className="px-2 py-1 font-bold"
                  style={{ color: selected === r.id ? colors.accent : colors.text }}
                >
                  {r.name}
                </td>
                <td className="px-2 py-1">
                  <OutlookBadge v={r.outlook} />
                </td>
                <td className="px-2 py-1 text-right font-mono" style={{ color: popColor(r.pop) }}>
                  {r.pop.toFixed(1)}%
                </td>
                <td
                  className="px-2 py-1 text-right font-mono"
                  style={{ color: epnlColor(r.expectedPnl) }}
                >
                  {r.expectedPnl >= 0 ? "+" : ""}${r.expectedPnl.toFixed(0)}
                </td>
                <td
                  className="px-2 py-1 text-right font-mono"
                  style={{ color: r.riskReward > 0 ? colors.positive : colors.negative }}
                >
                  {(r.riskReward * 100).toFixed(1)}%
                </td>
                <td
                  className="px-2 py-1 text-right font-mono"
                  style={{ color: r.kellyPct > 5 ? colors.positive : colors.textSecondary }}
                >
                  {r.kellyPct.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[8px] mt-2" style={sec}>
        Click column header to sort · Click row to select strategy · Based on lognormal model with
        current ATM IV
      </p>
    </div>
  );
}

// ── Multi-expiry chain fetcher ───────────────────────────────────────────────

function useMultiExpiryChain(symbol: string, expiries: string[]) {
  const q0 = useOptions(symbol, expiries[0] || undefined);
  const q1 = useOptions(expiries.length > 1 ? symbol : null, expiries[1] || undefined);

  return { near: q0, far: q1 };
}

// ── Main StrategyBuilder component ───────────────────────────────────────────

export function StrategyBuilder({
  symbol,
  chainData,
  colors,
}: {
  symbol: string;
  chainData: ChainData;
  colors: typeof bloombergColors.dark;
}) {
  const [selectedTemplate, setSelectedTemplate] = useState<string>("long-call");
  const [legs, setLegs] = useState<BuilderLeg[]>([]);
  const [farExpiry, setFarExpiry] = useState<string>("");
  const [isCustom, setIsCustom] = useState(false);
  const [showRanking, setShowRanking] = useState(false);
  const [rankFetchFar, setRankFetchFar] = useState(false);

  const template = TEMPLATES.find((t) => t.id === selectedTemplate);
  const expirations = chainData.expirations;
  const spot = chainData.spot;

  // For multi-expiry: pick a reasonable far expiry (2nd or 3rd available)
  useEffect(() => {
    if (expirations.length > 1 && !farExpiry) {
      const farIdx = Math.min(2, expirations.length - 1);
      setFarExpiry(expirations[farIdx]);
    }
  }, [expirations, farExpiry]);

  // Fetch far-expiry chain for multi-expiry strategies or ranking
  const needFar = template?.multiExpiry || rankFetchFar;
  const farQuery = useOptions(needFar ? symbol : null, farExpiry || undefined);
  const farChain = farQuery.data as ChainData | undefined;

  // IV for probability model (decimal, e.g. 0.30)
  const ivAnnual = chainData.ivCurrent > 0 ? chainData.ivCurrent / 100 : 0.3;

  // Ranking computation
  const rankings = useMemo(() => {
    if (!showRanking) return [];
    return rankAllStrategies(
      chainData.calls,
      chainData.puts,
      spot,
      ivAnnual,
      chainData.expiry,
      farExpiry,
      farChain?.calls,
      farChain?.puts
    );
  }, [showRanking, chainData, spot, ivAnnual, farExpiry, farChain]);

  // Available strikes from current chain (± 20% of spot)
  const availableStrikes = useMemo(() => {
    const strikes = new Set<number>();
    for (const c of chainData.calls)
      if (Math.abs(c.strike - spot) / spot <= 0.2) strikes.add(c.strike);
    for (const p of chainData.puts)
      if (Math.abs(p.strike - spot) / spot <= 0.2) strikes.add(p.strike);
    if (farChain) {
      for (const c of farChain.calls)
        if (Math.abs(c.strike - spot) / spot <= 0.2) strikes.add(c.strike);
      for (const p of farChain.puts)
        if (Math.abs(p.strike - spot) / spot <= 0.2) strikes.add(p.strike);
    }
    return Array.from(strikes).sort((a, b) => a - b);
  }, [chainData, farChain, spot]);

  // Build legs from template when template changes
  const buildLegsFromTemplate = useCallback(() => {
    if (!template || isCustom) return;

    const newLegs: BuilderLeg[] = [];
    for (const tl of template.legs) {
      if (tl.kind === "SHARE") {
        newLegs.push({
          id: nextLegId(),
          action: tl.action,
          kind: "SHARE",
          strike: spot,
          expiry: chainData.expiry,
          premium: spot,
          qty: tl.qty,
          iv: 0,
        });
        continue;
      }

      const isNear = tl.expiryIndex === 0;
      const chain = isNear ? chainData : farChain;
      if (!chain) continue;

      const calls = chain.calls;
      const puts = chain.puts;
      const contract = findContract(calls, puts, spot, tl.kind, tl.strikeOffset);

      if (contract) {
        newLegs.push({
          id: nextLegId(),
          action: tl.action,
          kind: tl.kind,
          strike: contract.strike,
          expiry: isNear ? chainData.expiry : farExpiry,
          premium: mid(contract),
          qty: tl.qty,
          iv: contract.impliedVolatility,
        });
      }
    }

    setLegs(newLegs);
  }, [template, chainData, farChain, spot, farExpiry, isCustom]);

  useEffect(() => {
    buildLegsFromTemplate();
  }, [buildLegsFromTemplate]);

  // When user changes a leg's strike, look up the new premium
  const handleUpdateLeg = useCallback(
    (id: string, updates: Partial<BuilderLeg>) => {
      setLegs((prev) =>
        prev.map((l) => {
          if (l.id !== id) return l;
          const updated = { ...l, ...updates };

          // Re-lookup premium when strike changes
          if (updates.strike !== undefined && updated.kind !== "SHARE") {
            const chain = updated.expiry === farExpiry && farChain ? farChain : chainData;
            const opts = updated.kind === "CALL" ? chain.calls : chain.puts;
            const match = opts.find((o) => o.strike === updates.strike);
            if (match) {
              updated.premium = mid(match);
              updated.iv = match.impliedVolatility;
            }
          }

          // Re-lookup when kind changes
          if (updates.kind !== undefined && updates.kind !== "SHARE") {
            const chain = updated.expiry === farExpiry && farChain ? farChain : chainData;
            const opts = updates.kind === "CALL" ? chain.calls : chain.puts;
            const match = nearest(opts, updated.strike);
            if (match) {
              updated.strike = match.strike;
              updated.premium = mid(match);
              updated.iv = match.impliedVolatility;
            }
          }

          return updated;
        })
      );
    },
    [chainData, farChain, farExpiry]
  );

  const handleRemoveLeg = useCallback((id: string) => {
    setLegs((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const handleAddLeg = useCallback(() => {
    const atmCall = nearest(chainData.calls, spot);
    setLegs((prev) => [
      ...prev,
      {
        id: nextLegId(),
        action: "BUY",
        kind: "CALL",
        strike: atmCall?.strike ?? spot,
        expiry: chainData.expiry,
        premium: atmCall ? mid(atmCall) : 0,
        qty: 1,
        iv: atmCall?.impliedVolatility ?? 0,
      },
    ]);
  }, [chainData, spot]);

  const handleSelectTemplate = useCallback((id: string) => {
    setSelectedTemplate(id);
    setIsCustom(false);
  }, []);

  const handleCustomMode = useCallback(() => {
    setIsCustom(true);
    setSelectedTemplate("");
  }, []);

  const panel = { backgroundColor: colors.surface, borderColor: colors.border };
  const sec = { color: colors.textSecondary };

  return (
    <div className="space-y-3">
      {/* Template selector */}
      <div className="p-3 border" style={panel}>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[10px] font-bold tracking-widest" style={{ color: colors.accent }}>
            SELECT STRATEGY
          </h4>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => {
                setShowRanking((v) => !v);
                setRankFetchFar(true);
              }}
              className="px-2 py-0.5 text-[9px] font-bold border"
              style={{
                borderColor: showRanking ? "#f59e0b" : colors.border,
                backgroundColor: showRanking ? "#f59e0b" : "transparent",
                color: showRanking ? "#000" : "#f59e0b",
              }}
            >
              RANK
            </button>
            <button
              type="button"
              onClick={handleCustomMode}
              className="px-2 py-0.5 text-[9px] font-bold border"
              style={{
                borderColor: isCustom ? colors.accent : colors.border,
                backgroundColor: isCustom ? colors.accent : "transparent",
                color: isCustom ? "#000" : colors.textSecondary,
              }}
            >
              CUSTOM
            </button>
          </div>
        </div>
        <StrategySelector
          selected={selectedTemplate}
          onSelect={handleSelectTemplate}
          colors={colors}
        />
      </div>

      {/* Multi-expiry selector */}
      {template?.multiExpiry && (
        <div className="p-3 border" style={panel}>
          <div className="flex items-center gap-3">
            <span className="text-[9px] font-bold" style={{ color: colors.accent }}>
              NEAR EXPIRY:
            </span>
            <span className="text-[10px] font-mono" style={{ color: colors.text }}>
              {chainData.expiry}
            </span>
            <span className="text-[9px] font-bold ml-4" style={{ color: colors.accent }}>
              FAR EXPIRY:
            </span>
            <select
              value={farExpiry}
              onChange={(e) => setFarExpiry(e.target.value)}
              className="text-[10px] font-mono px-2 py-0.5 border bg-transparent"
              style={{ borderColor: colors.border, color: colors.text }}
            >
              {expirations
                .filter((e) => e > chainData.expiry)
                .map((exp) => (
                  <option key={exp} value={exp}>
                    {exp}
                  </option>
                ))}
            </select>
            {farQuery.isLoading && (
              <RefreshCw className="w-3 h-3 animate-spin" style={{ color: colors.textSecondary }} />
            )}
          </div>
        </div>
      )}

      {/* Leg editor */}
      <div className="p-3 border" style={panel}>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[10px] font-bold tracking-widest" style={{ color: colors.accent }}>
            {template ? template.name.toUpperCase() : "CUSTOM"} — LEGS
          </h4>
          {template && !isCustom && (
            <button
              type="button"
              onClick={buildLegsFromTemplate}
              className="flex items-center gap-1 px-2 py-0.5 text-[9px] border"
              style={{ borderColor: colors.border, color: colors.textSecondary }}
            >
              <RefreshCw className="w-3 h-3" /> RESET
            </button>
          )}
        </div>

        {legs.length === 0 ? (
          <div className="py-6 text-center text-[10px]" style={sec}>
            {template?.multiExpiry && farQuery.isLoading
              ? "Loading far-expiry chain..."
              : "No legs configured. Select a strategy or add legs manually."}
          </div>
        ) : (
          <LegEditor
            legs={legs}
            availableStrikes={availableStrikes}
            availableExpiries={expirations}
            spot={spot}
            colors={colors}
            onUpdateLeg={handleUpdateLeg}
            onRemoveLeg={handleRemoveLeg}
            onAddLeg={handleAddLeg}
          />
        )}
      </div>

      {/* Payoff chart + probability metrics */}
      {legs.length > 0 && (
        <PayoffChart legs={legs} spot={spot} ivAnnual={ivAnnual} colors={colors} />
      )}

      {/* Ranking table */}
      {showRanking && rankings.length > 0 && (
        <RankingTable
          rankings={rankings}
          selected={selectedTemplate}
          onSelect={(id) => {
            setSelectedTemplate(id);
            setIsCustom(false);
          }}
          colors={colors}
        />
      )}
    </div>
  );
}
