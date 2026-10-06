"use client";

/**
 * ENTRY → buy: pick S / M / L instead of working out a volume.
 *
 * S / M / L = 3 / 6 / 10% of NAV (invested + cash of the account), scaled by
 * the TRADE GUARD size multiplier (half after a −5% NAV drawdown or a losing
 * streak, zero after −10%). Each button shows what the trade risks if the
 * auto stop (2×ATR, 5–12%) fills — the user never divides anything.
 * SET listings floor to the 100-share board lot.
 *
 * RISK row: type one number — "I can lose ฿X". The answer is the volume that
 * loses exactly X at the stop the form holds (auto or typed), buy + sell fees
 * included when the account has a fee schedule, and it fills VOLUME itself
 * (until the user types a volume). "ระยะ stop อื่น" opens the ladder: the same X
 * at other stop distances (ATR, unclamped), and "ลงเงิน ฿Y" → the stop Y implies.
 * NOISE / TIGHT = the stop sits within 1 / 2 daily ATRs — a normal day's swing.
 * Backend: GET /api/v2/portfolio/risk/guard/size (backend/trade_guard.py).
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { Colors } from "../helpers";
import { fmtAmt, fmtPx, fmtQty } from "../helpers";
import { NumInput } from "./NumInput";

const RISK_KEY = "bloomberg_risk_budget";

interface Bucket {
  pct_nav: number;
  notional_base: number;
  volume: number;
  risk_base: number;
  risk_pct_nav: number | null;
}

type Noise = "NOISE" | "TIGHT" | "OK" | null;

interface RiskRow {
  label: string;
  stop: number;
  stop_distance_pct: number;
  atr_mult: number | null;
  noise: Noise;
  volume: number;
  notional_base: number;
  pct_nav: number | null;
  over_weight_cap: boolean;
  loss_base: number;
  fees_base: number;
}

interface RiskPlan {
  risk_base: number;
  fees_included: boolean;
  fee_profile: string | null;
  atr_pct: number | null;
  rows: RiskRow[];
  notional_plan: {
    volume: number;
    stop: number | null;
    error?: string;
    notional_base?: number;
    pct_nav?: number | null;
    stop_distance_pct?: number;
    atr_mult?: number | null;
    noise?: Noise;
    fees_base?: number;
  } | null;
}

const NOISE_COLOR: Record<string, string> = { NOISE: "#FF4444", TIGHT: "#FFB300", OK: "#4ade80" };
const NOISE_TEXT: Record<string, string> = {
  NOISE: "อยู่ในระยะแกว่งปกติ 1 วัน — โดนง่าย",
  TIGHT: "แคบ — ต่ำกว่า 2 เท่าของการแกว่งปกติรายวัน",
  OK: "อยู่นอกระยะแกว่งปกติ",
};

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
  risk_plan?: RiskPlan;
}

/** Debounced copy of a typed number, so each keystroke is not a request. */
function useSettled(value: string, ms = 400): number | null {
  const [v, setV] = useState<number | null>(() => Number.parseFloat(value) || null);
  useEffect(() => {
    const t = setTimeout(() => setV(Number.parseFloat(value) || null), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function GuardSizePicker({
  symbol,
  price,
  currency,
  accountId,
  manualStop,
  formStop,
  colors,
  onVolume,
  onStop,
  onAutoStop,
  onAutoVolume,
}: {
  /** Resolved Yahoo symbol (AOT.BK, NVDA, BTC-USD). */
  symbol: string;
  /** Planned entry price in the instrument's currency; empty → last price. */
  price: number | null;
  currency: string | null;
  accountId: string;
  manualStop: number | null;
  /** STOP LOSS as the form holds it now (auto or typed) — the risk answer sizes to it. */
  formStop?: number | null;
  colors: Colors;
  onVolume: (volume: number) => void;
  onStop: (stop: number) => void;
  /** Called with the guard's auto stop whenever it changes (not for a manual
   *  stop) — the form fills STOP LOSS with it unless the user typed one. */
  onAutoStop?: (stop: number) => void;
  /** Called with the volume the risk budget buys at the form's stop — the form
   *  fills VOLUME with it unless the user typed one. */
  onAutoVolume?: (volume: number) => void;
}) {
  // Read in the initializer — the budget is a standing personal number.
  const [riskText, setRiskText] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try {
      return localStorage.getItem(RISK_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [notionalText, setNotionalText] = useState("");
  const [showLadder, setShowLadder] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(RISK_KEY, riskText);
    } catch {
      /* ignore */
    }
  }, [riskText]);
  const risk = useSettled(riskText);
  const notional = useSettled(notionalText);

  const { data, isFetching, error } = useQuery<SizeData>({
    queryKey: [
      "guard-size",
      symbol,
      price,
      currency,
      accountId,
      manualStop,
      risk,
      notional,
      formStop,
      showLadder,
    ],
    queryFn: async () => {
      const qs = new URLSearchParams({ symbol, account_id: accountId, base_currency: "THB" });
      if (price && price > 0) qs.set("price", String(price));
      if (currency) qs.set("currency", currency);
      if (manualStop && manualStop > 0) qs.set("stop", String(manualStop));
      if (risk && risk > 0) {
        qs.set("risk", String(risk));
        if (formStop && formStop > 0) qs.set("risk_stop", String(formStop));
        if (showLadder && notional && notional > 0) qs.set("notional", String(notional));
      }
      const r = await fetch(`/api/v2/portfolio/risk/guard/size?${qs}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!symbol,
    staleTime: 60_000,
    // Keep the rows on screen while a new budget is fetched.
    placeholderData: (prev) => prev,
  });

  const autoStop = data?.ok && data.stop_source !== "MANUAL" ? data.stop : null;
  // onAutoStop is a fresh closure each render; the value is what matters.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire on a new stop, not a new callback
  useEffect(() => {
    if (autoStop != null && autoStop > 0) onAutoStop?.(autoStop);
  }, [autoStop]);

  // The one answer: the form's stop, else 2×ATR, else the first rung.
  const rows = data?.ok ? (data.risk_plan?.rows ?? []) : [];
  const answer =
    rows.find((r) => r.label === "STOP") ??
    rows.find((r) => r.label === "2×ATR") ??
    rows[0] ??
    null;
  const answerVol = answer?.volume ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire on a new volume, not a new callback
  useEffect(() => {
    if (answerVol != null && answerVol > 0) onAutoVolume?.(answerVol);
  }, [answerVol]);

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
      <RiskRows
        plan={data.risk_plan}
        answer={answer}
        showLadder={showLadder}
        setShowLadder={setShowLadder}
        sym={sym}
        riskText={riskText}
        setRiskText={setRiskText}
        notionalText={notionalText}
        setNotionalText={setNotionalText}
        multiplier={data.multiplier}
        colors={colors}
        onPick={(volume, stop) => {
          onVolume(volume);
          onStop(stop);
        }}
      />
    </div>
  );
}

function RiskRows({
  plan,
  answer,
  showLadder,
  setShowLadder,
  sym,
  riskText,
  setRiskText,
  notionalText,
  setNotionalText,
  multiplier,
  colors,
  onPick,
}: {
  plan: RiskPlan | undefined;
  answer: RiskRow | null;
  showLadder: boolean;
  setShowLadder: (v: boolean) => void;
  sym: string;
  riskText: string;
  setRiskText: (v: string) => void;
  notionalText: string;
  setNotionalText: (v: string) => void;
  multiplier: number;
  colors: Colors;
  onPick: (volume: number, stop: number) => void;
}) {
  const field = "w-20 px-1 bg-transparent border outline-none tabular-nums text-right";
  const fieldStyle = { borderColor: colors.border, color: colors.text, fontSize: 9 };
  const np = plan?.notional_plan;
  return (
    <div className="flex flex-col gap-0.5 mt-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span style={{ color: colors.textSecondary, letterSpacing: "0.1em" }}>RISK</span>
        <span style={{ color: colors.textSecondary }}>เสียได้ {sym}</span>
        <NumInput
          className={field}
          style={fieldStyle}
          placeholder="20,000"
          value={riskText}
          onChange={(e) => setRiskText(e.target.value)}
          aria-label="Money you accept to lose"
        />
        {answer && answer.volume > 0 && (
          <button
            type="button"
            className="text-left"
            onClick={() => onPick(answer.volume, answer.stop)}
            title={`ใส่ VOLUME ${fmtQty(answer.volume)} และ STOP ${fmtPx(answer.stop)}${answer.noise ? ` · ${NOISE_TEXT[answer.noise]}` : ""}`}
          >
            <span style={{ color: colors.textSecondary }}>→ ซื้อ </span>
            <span style={{ color: colors.text, fontWeight: 700 }}>{fmtQty(answer.volume)}</span>
            <span style={{ color: colors.textSecondary }}>
              {" "}
              หุ้น · {sym}
              {fmtAmt(answer.notional_base)}
              {answer.pct_nav != null && ` · ${answer.pct_nav.toFixed(1)}% NAV`} · stop{" "}
            </span>
            <span style={{ color: "#f87171" }}>
              {fmtPx(answer.stop)} (−{answer.stop_distance_pct.toFixed(1)}%)
            </span>
            {answer.noise && (
              <span style={{ color: NOISE_COLOR[answer.noise] }}>
                {" "}
                {answer.atr_mult?.toFixed(1)}×ATR {answer.noise}
              </span>
            )}
          </button>
        )}
        {answer && !(answer.volume > 0) && (
          <span style={{ color: "#FF4444" }}>งบนี้ซื้อไม่ได้แม้ 1 หน่วย/ล็อต</span>
        )}
        {plan && (
          <button
            aria-pressed={showLadder}
            type="button"
            onClick={() => setShowLadder(!showLadder)}
            style={{ color: colors.accent, fontSize: 8 }}
          >
            {showLadder ? "▴ ซ่อน" : "▾ ระยะ stop อื่น / ลงเงินเท่านี้"}
          </button>
        )}
      </div>
      {plan && (
        <div style={{ color: colors.textSecondary, fontSize: 8 }}>
          {answer?.label === "STOP" ? "ใช้ STOP LOSS ในฟอร์ม" : "ใช้ stop 2×ATR"}
          {plan.fees_included
            ? " · รวมค่าธรรมเนียมซื้อ+ขายแล้ว"
            : " · ไม่รวมค่าธรรมเนียม (บัญชีนี้ไม่มีตารางค่าธรรมเนียม)"}
          {plan.atr_pct != null && ` · ATR ${plan.atr_pct.toFixed(2)}%/วัน`}
          {answer?.over_weight_cap && (
            <span style={{ color: "#FFB300" }}> · เกินเพดาน TRADE GUARD 10% ต่อตัว</span>
          )}
        </div>
      )}
      {showLadder && (
        <div className="flex items-center gap-2" style={{ fontSize: 9 }}>
          <span style={{ color: colors.textSecondary }}>ลงเงิน {sym}</span>
          <NumInput
            className={field}
            style={fieldStyle}
            placeholder="ไม่ใส่ก็ได้"
            value={notionalText}
            onChange={(e) => setNotionalText(e.target.value)}
            aria-label="Money you want to put in"
          />
        </div>
      )}
      {showLadder && np && (
        <div style={{ fontSize: 9 }}>
          {np.stop == null ? (
            <span style={{ color: "#FF4444" }}>ลงเงินนี้ไม่ได้ — {np.error}</span>
          ) : (
            <button
              type="button"
              onClick={() => onPick(np.volume, np.stop as number)}
              title="คลิกเพื่อใส่ VOLUME และ STOP LOSS"
              className="text-left"
            >
              <span style={{ color: colors.textSecondary }}>
                ลง {sym}
                {fmtAmt(np.notional_base ?? 0)} = {fmtQty(np.volume)} หุ้น → stop ต้องอยู่ที่{" "}
              </span>
              <span style={{ color: "#f87171" }}>
                {fmtPx(np.stop)} (−{np.stop_distance_pct?.toFixed(1)}%)
              </span>
              {np.atr_mult != null && np.noise && (
                <span style={{ color: NOISE_COLOR[np.noise] }} title={NOISE_TEXT[np.noise]}>
                  {" "}
                  {np.atr_mult.toFixed(1)}×ATR {np.noise}
                </span>
              )}
            </button>
          )}
        </div>
      )}
      {showLadder && plan && plan.rows.length > 0 && (
        <table className="text-[9px] tabular-nums" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ color: colors.textSecondary, fontSize: 8 }}>
              <th className="text-left pr-2 font-normal">STOP</th>
              <th className="text-right pr-2 font-normal">ราคา stop</th>
              <th className="text-right pr-2 font-normal">ห่าง</th>
              <th className="text-right pr-2 font-normal">จำนวนหุ้น</th>
              <th className="text-right pr-2 font-normal">ลงเงิน</th>
              <th className="text-right pr-2 font-normal">% NAV</th>
              <th className="text-right pr-2 font-normal">เสียถ้าโดน</th>
              <th className="text-left font-normal" />
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((r) => (
              <tr
                key={r.label}
                className="hover:bg-white/5"
                title={r.noise ? NOISE_TEXT[r.noise] : undefined}
                style={{ color: r.volume > 0 ? colors.text : colors.textDimmed }}
              >
                <td className="pr-2">
                  <button
                    type="button"
                    disabled={!(r.volume > 0)}
                    onClick={() => onPick(r.volume, r.stop)}
                    title={`ใส่ VOLUME ${fmtQty(r.volume)} และ STOP ${fmtPx(r.stop)}`}
                    style={{ color: r.volume > 0 ? colors.accent : colors.textDimmed }}
                  >
                    {r.label} →
                  </button>
                </td>
                <td className="text-right pr-2" style={{ color: "#f87171" }}>
                  {fmtPx(r.stop)}
                </td>
                <td className="text-right pr-2">−{r.stop_distance_pct.toFixed(1)}%</td>
                <td className="text-right pr-2">{fmtQty(r.volume)}</td>
                <td className="text-right pr-2">
                  {sym}
                  {fmtAmt(r.notional_base)}
                </td>
                <td
                  className="text-right pr-2"
                  style={{ color: r.over_weight_cap ? "#FFB300" : undefined }}
                  title={r.over_weight_cap ? "เกินเพดาน TRADE GUARD 10% ต่อตัว" : undefined}
                >
                  {r.pct_nav == null ? "—" : `${r.pct_nav.toFixed(1)}%`}
                </td>
                <td className="text-right pr-2">
                  {sym}
                  {fmtAmt(r.loss_base)}
                  {r.fees_base > 0 && (
                    <span style={{ color: colors.textSecondary }}>
                      {" "}
                      (fee {fmtAmt(r.fees_base)})
                    </span>
                  )}
                </td>
                <td style={{ color: r.noise ? NOISE_COLOR[r.noise] : colors.textSecondary }}>
                  {r.noise ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {plan && multiplier !== 1 && (
        <div style={{ color: "#FFB300", fontSize: 8 }}>
          RISK ใช้งบที่คุณใส่ตรงๆ — TRADE GUARD ตอนนี้ให้ไซซ์ ×{multiplier} (ถ้าทำตาม ใส่งบครึ่งหนึ่ง)
        </div>
      )}
    </div>
  );
}
