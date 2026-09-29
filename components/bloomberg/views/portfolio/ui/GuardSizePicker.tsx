"use client";

/**
 * ENTRY → buy: pick S / M / L instead of working out a volume.
 *
 * S / M / L = 3 / 6 / 10% of NAV (invested + cash of the account), scaled by
 * the TRADE GUARD size multiplier (half after a −5% NAV drawdown or a losing
 * streak, zero after −10%). Each button shows what the trade risks if the
 * auto stop (2×ATR, 5–12%) fills — the user never divides anything.
 * SET listings floor to the 100-share board lot.
 * Backend: GET /api/v2/portfolio/risk/guard/size (backend/trade_guard.py).
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import type { Colors } from "../helpers";
import { fmtAmt, fmtPx, fmtQty } from "../helpers";

interface Bucket {
  pct_nav: number;
  notional_base: number;
  volume: number;
  risk_base: number;
  risk_pct_nav: number | null;
}

interface SizeData {
  ok: boolean;
  error?: string;
  symbol: string;
  price: number;
  currency: string;
  base_currency: string;
  nav_value: number;
  nav_includes_cash: boolean;
  light: "GREEN" | "YELLOW" | "RED";
  multiplier: number;
  multiplier_why: string[];
  buckets: Record<"S" | "M" | "L", Bucket>;
  stop: number;
  stop_distance_pct: number;
  stop_source: "MANUAL" | "ATR" | "DEFAULT";
  atr_pct: number | null;
  lot: number | null;
}

export function GuardSizePicker({
  symbol,
  price,
  currency,
  accountId,
  manualStop,
  colors,
  onVolume,
  onStop,
  onAutoStop,
}: {
  /** Resolved Yahoo symbol (AOT.BK, NVDA, BTC-USD). */
  symbol: string;
  /** Planned entry price in the instrument's currency; empty → last price. */
  price: number | null;
  currency: string | null;
  accountId: string;
  manualStop: number | null;
  colors: Colors;
  onVolume: (volume: number) => void;
  onStop: (stop: number) => void;
  /** Called with the guard's auto stop whenever it changes (not for a manual
   *  stop) — the form fills STOP LOSS with it unless the user typed one. */
  onAutoStop?: (stop: number) => void;
}) {
  const { data, isFetching, error } = useQuery<SizeData>({
    queryKey: ["guard-size", symbol, price, currency, accountId, manualStop],
    queryFn: async () => {
      const qs = new URLSearchParams({ symbol, account_id: accountId, base_currency: "THB" });
      if (price && price > 0) qs.set("price", String(price));
      if (currency) qs.set("currency", currency);
      if (manualStop && manualStop > 0) qs.set("stop", String(manualStop));
      const r = await fetch(`/api/v2/portfolio/risk/guard/size?${qs}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!symbol,
    staleTime: 60_000,
  });

  const autoStop = data?.ok && data.stop_source !== "MANUAL" ? data.stop : null;
  // onAutoStop is a fresh closure each render; the value is what matters.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire on a new stop, not a new callback
  useEffect(() => {
    if (autoStop != null && autoStop > 0) onAutoStop?.(autoStop);
  }, [autoStop]);

  const label = <span style={{ color: colors.textSecondary, letterSpacing: "0.1em" }}>SIZE</span>;

  if (!symbol) return null;
  if (error || (data && !data.ok)) {
    return (
      <div className="text-[8px] font-mono flex gap-2" style={{ color: colors.textSecondary }}>
        {label} unavailable — {data?.error ?? String(error)}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="text-[8px] font-mono flex gap-2" style={{ color: colors.textSecondary }}>
        {label} {isFetching ? "…" : ""}
      </div>
    );
  }

  const blocked = data.multiplier === 0;
  const sym = data.base_currency === "THB" ? "฿" : "$";

  return (
    <div className="text-[9px] font-mono flex flex-col gap-0.5">
      <div className="flex items-baseline gap-3 flex-wrap">
        {label}
        {(["S", "M", "L"] as const).map((k) => {
          const b = data.buckets[k];
          const disabled = blocked || !(b.volume > 0);
          return (
            <button
              type="button"
              key={k}
              disabled={disabled}
              onClick={() => onVolume(b.volume)}
              title={`${b.pct_nav}% ของ NAV${data.multiplier !== 1 ? ` × ${data.multiplier}` : ""} = ${sym}${fmtAmt(b.notional_base)} · ถ้าโดน stop เสีย ${sym}${fmtAmt(b.risk_base)}`}
              style={{ color: disabled ? colors.textDimmed : colors.accent }}
            >
              <span style={{ fontWeight: 700 }}>{k}</span>{" "}
              <span
                className="tabular-nums"
                style={{ color: disabled ? colors.textDimmed : colors.text }}
              >
                {fmtQty(b.volume)}
              </span>{" "}
              <span style={{ color: colors.textSecondary }}>
                risk {b.risk_pct_nav == null ? "—" : `${b.risk_pct_nav.toFixed(2)}%`}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onStop(data.stop)}
          title={
            data.stop_source === "ATR"
              ? `2×ATR ${data.atr_pct?.toFixed(2)}% → ห่าง ${data.stop_distance_pct.toFixed(1)}% (ช่วง 5–12%)`
              : data.stop_source === "MANUAL"
                ? "stop ที่ใส่เอง"
                : "ไม่มีประวัติราคา — ใช้ 8%"
          }
          style={{ color: "#f87171" }}
        >
          stop {fmtPx(data.stop)} (−{data.stop_distance_pct.toFixed(1)}%)
          {data.stop_source !== "MANUAL" && " → ใช้"}
        </button>
      </div>
      <div style={{ color: colors.textSecondary, fontSize: 8 }}>
        S/M/L = {data.buckets.S.pct_nav}/{data.buckets.M.pct_nav}/{data.buckets.L.pct_nav}% ของ NAV{" "}
        {sym}
        {fmtAmt(data.nav_value)}
        {!data.nav_includes_cash && " (ไม่รวมเงินสด)"}
        {data.lot ? ` · ปัดลงเป็นล็อต ${data.lot} หุ้น` : ""}
        {data.multiplier !== 1 && (
          <span style={{ color: blocked ? "#FF4444" : "#FFB300" }}>
            {" "}
            · {blocked ? "หยุดเปิดไม้ใหม่" : `ไซซ์ ×${data.multiplier}`} (
            {data.multiplier_why.join(", ")})
          </span>
        )}
        {data.light === "RED" && !blocked && (
          <span style={{ color: "#FF4444" }}> · TRADE GUARD แดง — ดู PORT → RISK ก่อน</span>
        )}
      </div>
    </div>
  );
}
