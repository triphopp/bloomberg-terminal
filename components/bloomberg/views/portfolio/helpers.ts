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
  if (p.note?.startsWith("Finansia")) return p.note;
  if (p.account_id === "dime") return "Dime";
  if (p.account_id === "innovestx") return "InnovestX";
  return p.acc_name || p.account_id || "Unknown";
}

export type Colors = typeof bloombergColors.dark;
