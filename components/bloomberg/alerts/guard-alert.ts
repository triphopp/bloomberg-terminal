/**
 * TRADE GUARD / MARGIN alert presentation — shared by the toast
 * (useAlertNotifications) and the blocking modal (GuardAlertModal).
 *
 * The events arrive through the ordinary alert feed with rule_id
 * "guard:<CODE>" (backend/guard_scheduler.py) or "margin:<LEVEL>"
 * (backend/margin_scheduler.py). A RED event means "act now" — a stop broke,
 * the book hit its day-loss cap, margin is near liquidation — so it opens a
 * modal that stays until acknowledged. Everything else stays a toast.
 */

import { atom } from "jotai";
import type { AlertEvent } from "../hooks/useAlertRules";
import { fmtAmt, fmtPx } from "../views/portfolio/helpers";

export type AlertSeverity = "RED" | "YELLOW" | "INFO";

export const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  RED: "#FF4444",
  YELLOW: "#FFB300",
  INFO: "#FF6600",
};

/** Codes that interrupt with a modal. */
const MODAL_RULES = new Set([
  "guard:STOP_HIT",
  "guard:DAY_LOSS",
  "guard:DD_STOP",
  "margin:DANGER",
  "margin:LIQUIDATION",
]);

const YELLOW_RULES = new Set([
  "guard:NEAR_STOP",
  "guard:TIME",
  "guard:DD_HALF",
  "guard:STREAK",
  "margin:WATCH",
  "margin:WARNING",
]);

/** Short headline per code — the terminal's all-caps voice. */
const HEADLINE: Record<string, string> = {
  "guard:STOP_HIT": "STOP LOSS HIT",
  "guard:NEAR_STOP": "NEAR STOP",
  "guard:TIME": "TIME STOP",
  "guard:DAY_LOSS": "DAY LOSS LIMIT",
  "guard:DD_STOP": "DRAWDOWN STOP",
  "guard:DD_HALF": "DRAWDOWN — HALF SIZE",
  "guard:STREAK": "LOSING STREAK",
  "margin:WATCH": "MARGIN WATCH",
  "margin:WARNING": "MARGIN WARNING",
  "margin:DANGER": "MARGIN DANGER",
  "margin:LIQUIDATION": "MARGIN LIQUIDATION",
};

/** What the user should do next — one line, Thai like the guard card. */
const NEXT_STEP: Record<string, string> = {
  "guard:STOP_HIT": "ราคาหลุด stop แล้ว → ขายตามแผน หรือกด HOLD ใน PORT → RISK พร้อมเหตุผล",
  "guard:DAY_LOSS": "พอร์ตลงเกินเพดานรายวัน → หยุดเปิดไม้ใหม่วันนี้",
  "guard:DD_STOP": "NAV drawdown ≥10% → หยุดเปิดไม้ใหม่จนกว่าจะฟื้น",
  "margin:DANGER": "ใกล้โดน liquidate → ลดสถานะหรือเติมเงิน",
  "margin:LIQUIDATION": "excess liquidity ติดลบ → โบรกเกอร์จะบังคับขาย",
};

export function isGuardEvent(e: AlertEvent): boolean {
  return e.ruleId.startsWith("guard:") || e.ruleId.startsWith("margin:");
}

export function isModalEvent(e: AlertEvent): boolean {
  return MODAL_RULES.has(e.ruleId);
}

export function severityOf(e: AlertEvent): AlertSeverity {
  if (MODAL_RULES.has(e.ruleId)) return "RED";
  if (YELLOW_RULES.has(e.ruleId)) return "YELLOW";
  return "INFO";
}

export function headlineOf(e: AlertEvent): string {
  return HEADLINE[e.ruleId] ?? e.ruleName ?? e.ruleId;
}

export function nextStepOf(e: AlertEvent): string | null {
  // guard_scheduler sets hold_ended when a HOLD's review date passed or price
  // broke its floor — the line is loud again because of that, say so.
  if (e.snapshot.hold_ended) {
    return "HOLD ที่บันทึกไว้หมดอายุหรือหลุด floor แล้ว → ขาย หรือ HOLD ใหม่พร้อมวันทบทวน";
  }
  return NEXT_STEP[e.ruleId] ?? null;
}

const pct = (v: number | null | undefined, digits = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;

/** Labelled readings for the event, in display order. */
export function fieldsOf(e: AlertEvent): { label: string; value: string; color?: string }[] {
  const s = e.snapshot;
  const tone = (v: number | null | undefined) =>
    v == null ? undefined : v < 0 ? "#f87171" : "#4ade80";
  if (e.ruleId.startsWith("margin:")) {
    return [
      { label: "CUSHION", value: s.cushion == null ? "—" : `${(s.cushion * 100).toFixed(1)}%` },
      { label: "EXCESS LIQ", value: s.excess_liquidity == null ? "—" : fmtAmt(s.excess_liquidity) },
      { label: "NLV", value: s.nlv == null ? "—" : fmtAmt(s.nlv) },
    ];
  }
  if (e.symbol === "PORT") {
    return [
      { label: "DAY P&L", value: pct(s.day_pnl_pct, 2), color: tone(s.day_pnl_pct) },
      { label: "NAV DD", value: pct(s.nav_drawdown_pct), color: tone(s.nav_drawdown_pct) },
      { label: "STREAK", value: s.loss_streak == null ? "—" : String(s.loss_streak) },
    ];
  }
  const out = [
    { label: "PRICE", value: s.price == null ? "—" : fmtPx(s.price) },
    { label: "STOP", value: s.stop == null ? "—" : fmtPx(s.stop), color: "#FF4444" },
  ];
  // How deep under the stop — the number that grows while nobody decides.
  if (e.ruleId === "guard:STOP_HIT" && s.to_stop_pct != null) {
    out.push({ label: "UNDER", value: pct(s.to_stop_pct), color: "#FF4444" });
  }
  out.push({ label: "RETURN", value: pct(s.return_pct), color: tone(s.return_pct) });
  return out;
}

/** One-line description for a toast. */
export function describeGuard(e: AlertEvent): string {
  return fieldsOf(e)
    .map((f) => `${f.label} ${f.value}`)
    .join(" · ");
}

/** RED events waiting for the user, oldest first. Filled by
 *  useAlertNotifications, drained by GuardAlertModal. */
export const guardModalQueueAtom = atom<AlertEvent[]>([]);
