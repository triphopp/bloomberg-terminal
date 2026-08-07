import type { bloombergColors } from "../../lib/theme-config";
import type { Trade } from "./types";

export const fmt = (n: number, d = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export const fmtK = (n: number) => {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return fmt(n, 0);
};

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
export function splitNote(note: string | undefined): { subPort: string; rest: string } {
  if (!note) return { subPort: "", rest: "" };
  const parts = note
    .split(" | ")
    .map((s) => s.trim())
    .filter(Boolean);
  const subIdx = parts.findIndex((p) => /^.+\s\([^)]+\)$/.test(p) && !p.startsWith("VAT:"));
  if (subIdx === -1) return { subPort: "", rest: note };
  const subPort = parts[subIdx];
  const rest = parts.filter((_, i) => i !== subIdx).join(" | ");
  return { subPort, rest };
}

export const composeNote = (subPort: string, rest: string) =>
  [subPort, rest].filter(Boolean).join(" | ");

// Sub-port label extracted from note, e.g. "Finansia (0153717)" → "0153717"
export function subPortLabel(p: Trade): string | null {
  const { subPort } = splitNote(p.note);
  if (!subPort) return null;
  const m = subPort.match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : null;
}

export type Colors = typeof bloombergColors.dark;

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
