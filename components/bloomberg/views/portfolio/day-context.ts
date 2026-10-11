/**
 * Day context for PORT → POSITIONS — is today's move ordinary, and which rows
 * are worth the eye right now.
 *
 * Two questions, both answered without opening RISK:
 * - `zScore`: today's % move ÷ the daily sigma of that row / account / book
 *   (`/api/v2/portfolio/risk/sigma`, EWMA λ 0.94). 1.5σ on a book whose sigma is
 *   2% means +3% — a day to look at.
 * - `marketLive` / `focusOrder`: rows on a market that is shut are dimmed and
 *   their account sinks below the ones still trading. Nothing is hidden: the
 *   whole book stays on one screen.
 *
 * Pure — no React, no fetch. Tests: `npm run test:views`.
 */

export interface SigmaSymbol {
  /** Daily sigma of the price, % (local currency, no FX). null = under 60 bars. */
  sigma_pct: number | null;
  /** Same, but never below one price step where the step is known (SET). */
  sigma_eff_pct: number | null;
  tick_pct: number | null;
  /** One price step is over half a sigma — read the z-score as approximate. */
  coarse: boolean;
  obs: number;
}

export interface SigmaBlock {
  mv: number;
  n: number;
  n_covered: number;
  /** Share of the group's value that has enough history to be measured. */
  coverage_pct: number;
  sigma_pct: number | null;
  sigma_amt: number | null;
  /** 1-day VaR / CVaR at `confidence`, % of the group's value, FX included. */
  var_pct: number | null;
  var_amt: number | null;
  cvar_pct: number | null;
  cvar_amt: number | null;
  method: "filtered-historical" | "normal" | null;
  obs: number;
}

export interface SigmaPayload {
  base_currency: string;
  confidence: number;
  lambda: number;
  lookback: number;
  as_of: string | null;
  excluded: { symbol: string; reason: string; bars: number }[];
  /** Keyed by Yahoo symbol (`yf_symbol` of a position). */
  symbols: Record<string, SigmaSymbol>;
  /** Keyed by account_id. */
  accounts: Record<string, SigmaBlock>;
  /** Keyed `${account_id}::${sub_port}`. */
  sub_ports: Record<string, SigmaBlock>;
  total: SigmaBlock | null;
}

const finite = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Today's move in sigmas, signed. null when either side is missing. */
export function zScore(
  dayPct: number | null | undefined,
  sigmaPct: number | null | undefined
): number | null {
  if (!finite(dayPct) || !finite(sigmaPct) || sigmaPct <= 0) return null;
  return dayPct / sigmaPct;
}

/** quiet: inside 1σ (two days in three) · normal: 1–2σ · watch: 2σ or more (about one day in twenty). */
export type ZTone = "quiet" | "normal" | "watch";

export const WATCH_Z = 2;

export function zTone(z: number | null | undefined): ZTone | null {
  if (!finite(z)) return null;
  // Banded on the figure as printed (one decimal): a row that reads 2.0σ must
  // not be coloured as an ordinary day because it was 1.99.
  const a = Math.round(Math.abs(z) * 10) / 10;
  return a >= WATCH_Z ? "watch" : a >= 1 ? "normal" : "quiet";
}

/** "+1.5σ" / "−0.3σ"; `approx` prefixes ≈ (price moves in steps near its sigma). */
export function fmtZ(z: number | null | undefined, approx = false): string {
  if (!finite(z)) return "";
  const a = Math.abs(z);
  const body = a >= 10 ? a.toFixed(0) : a.toFixed(1);
  const sign = Number(body) === 0 ? "" : z > 0 ? "+" : "−";
  return `${approx ? "≈" : ""}${sign}${body}σ`;
}

/**
 * Is this instrument's market trading now? null = not known yet (no session
 * quote), which callers treat as live — never dim a row on missing data.
 *
 * Yahoo's marketState: REGULAR trades; PRE / POST trade only when an
 * extended-hours price is actually printing (`hasExtended`) — SET reports PRE
 * before its open with nothing trading; PREPRE / POSTPOST / CLOSED do not.
 */
export function marketLive(state: string | null | undefined, hasExtended: boolean): boolean | null {
  const st = (state || "").toUpperCase();
  if (!st) return null;
  if (st === "REGULAR") return true;
  if (st === "PRE" || st === "POST") return hasExtended;
  return false;
}

/**
 * Accounts with a market still trading first, the shut ones after — each half
 * keeps the order it came in. When nothing at all is live (a weekend) the order
 * is left alone, and so is the dimming: with no live row there is nothing to
 * focus ON.
 */
export function focusOrder<T>(groups: T[], isLive: (g: T) => boolean): T[] {
  const live = groups.filter(isLive);
  if (live.length === 0 || live.length === groups.length) return groups;
  return [...live, ...groups.filter((g) => !isLive(g))];
}
