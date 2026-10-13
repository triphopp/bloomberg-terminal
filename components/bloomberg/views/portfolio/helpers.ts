import { numberFormat } from "../../lib/number-format";
import type { bloombergColors } from "../../lib/theme-config";
import { subPortOf } from "./sub-ports";
import type { Trade } from "./types";

// Cached formatters (lib/number-format `numberFormat`) — these run per table cell.
export const fmt = (n: number, d = 2) => numberFormat(d, d).format(n);

/** Money amount, exact to the satang/cent: 1,234,567.89. No K/M rounding. */
export const fmtAmt = (n: number) => fmt(n, 2);

/** Chart axis ticks only — the one place a K/M suffix is worth the lost digits. */
export const fmtAxis = (n: number) => {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return fmt(n, 0);
};

/**
 * Per-unit price — entry, exit, current, target, stop, strike, premium.
 * House rule: at least 2 decimals, up to 4 (a ฿0.47 stock or a $0.05 option
 * premium moves in the 3rd–4th place).
 */
export const fmtPx = (n: number) => numberFormat(2, 4).format(n);

/**
 * Volume / quantity. House rule: up to 7 decimals (0.001 BTC, 27.295 fractional
 * shares), none shown when whole — 3,000 shares reads 3,000.
 * `toLocaleString()` alone stops at 3 decimals and would print 0.0012345 BTC as 0.001.
 */
export const fmtQty = (n: number) => numberFormat(undefined, 7).format(n);

export const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${fmt(n)}%`;

export const pnlColor = (n: number | null | undefined) =>
  n == null ? "#666" : n > 0 ? "#00FF00" : n < 0 ? "#FF4444" : "#888";

export const wlColor = (wl: string) =>
  wl === "W" ? "#00FF00" : wl === "L" ? "#FF4444" : "#ff9900";

export const FLAG: Record<string, string> = {
  TH: "🇹🇭",
  US: "🇺🇸",
  CRYPTO: "₿",
  EU: "🇪🇺",
  KR: "🇰🇷",
};

export function groupKey(p: Trade): string {
  if (p.account_id === "dime") return "Dime";
  if (p.account_id === "innovestx") return "InnovestX";
  return p.acc_name || p.account_id || "Unknown";
}

// note stores sub-port + freeform text + VAT joined by " | " (same pattern
// used for the VAT suffix). splitNote/composeNote let a form show sub-port
// and freeform text as two separate inputs while keeping one string field.
// The parsing itself lives in sub-ports.ts (pure, tested).
export { splitNote } from "./sub-ports";

export const composeNote = (subPort: string, rest: string) =>
  [subPort, rest].filter(Boolean).join(" | ");

// Sub-port label extracted from note, e.g. "Finansia (0153717)" → "0153717"
export function subPortLabel(p: Trade): string | null {
  return subPortOf(p.note) || null;
}

export type Colors = typeof bloombergColors.dark;

/** The `accountId` a tab gets is one of three things (backend/account_scope.py):
 *  "all" = the personal book, "fund:<id>" = a fund's book, else one account.
 *  A tab that means "the whole book, not one account" asks this — testing
 *  `accountId === "all"` alone treats a fund as if it were a single account. */
export const isBookScope = (accountId: string | null | undefined): boolean =>
  !accountId || accountId === "all" || accountId.startsWith("fund:");

/** The fund scope of an `accountId`, or undefined for the personal book / one account. */
export const fundScopeOf = (accountId: string | null | undefined): string | undefined =>
  accountId?.startsWith("fund:") ? accountId : undefined;

// The Python backend does a synchronous cloud-sync pull at import time, so on a
// cold machine boot it can take tens of seconds to bind its port while Next is
// already serving. A one-shot fetch that lands in that window gets a 503 from
// the proxy route and — with the old silent `.catch(() => {})` — left the whole
// view permanently blank. Retry with backoff on network errors and 5xx only;
// 4xx is a real answer and must not be retried.
export async function fetchRetry(
  url: string,
  {
    attempts = 6,
    baseDelayMs = 750,
    signal,
  }: { attempts?: number; baseDelayMs?: number; signal?: AbortSignal } = {}
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const r = await fetch(url, { signal });
      if (r.status < 500) return r;
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      lastErr = e;
    }
    if (i < attempts - 1) {
      const wait = Math.min(baseDelayMs * 2 ** i, 8_000);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Backend unavailable");
}
