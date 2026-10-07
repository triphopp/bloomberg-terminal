"use client";

/**
 * PORT → RISK → สรุป: the risk numbers in plain Thai, one line each, plus what
 * to do next. Every figure here comes from /risk/metrics (computed elsewhere);
 * the methods behind them (เชิงลึก) sit at the foot of the same page — "detail"
 * scrolls there.
 */

import type { Colors } from "../helpers";
import { fmtAmt } from "../helpers";
import type { RebalData } from "./RebalancePanel";

export interface RiskSummaryMetrics {
  risk_score: number;
  portfolio_value: number;
  ensemble_conservative_pct: number;
  ensemble_conservative_amount: number;
  ensemble_signal: "STABLE" | "FAT_TAIL_RISK" | "CORRELATION_RISK";
  vol_regime: "CALM" | "ELEVATED" | "STRESSED" | "UNKNOWN";
  volatility_annual_pct: number;
  current_drawdown_pct: number;
  max_drawdown_pct: number;
  effective_n: number;
  n_positions: number;
  /** Return of the last COMPLETED daily bar of the model's history (today's
   *  basket, close to close) — not the live day. See `last_return_date`. */
  today_return_pct: number;
  last_return_date?: string | null;
  var_historical_pct: number;
  var_historical_amount: number;
  cvar_pct: number;
  cvar_amount: number;
  cvar_stressed_pct: number;
  cvar_stressed_amount: number;
  confidence: number;
  breach_hist: boolean;
  breach_cf: boolean;
  breach_mc: boolean;
  assets: { symbol: string; weight_pct: number; risk_contribution_pct: number }[];
}

type SummaryTarget = "rebalance" | "exposure" | "whatif" | "detail";

const REGIME: Record<RiskSummaryMetrics["vol_regime"], [string, string]> = {
  CALM: ["ปกติ", "#00C853"],
  ELEVATED: ["สูงกว่าปกติ", "#FFB300"],
  STRESSED: ["ตึงเครียด", "#FF4444"],
  UNKNOWN: ["ไม่ทราบ", "#888"],
};

export function RiskSummaryCard({
  metrics: m,
  rebal,
  budgetOver = 0,
  dayPnlPct,
  colors,
  sym,
  onGo,
}: {
  /** The live day: every holding's price against its previous close (TRADE GUARD). */
  dayPnlPct?: number | null;
  metrics: RiskSummaryMetrics | null;
  rebal?: RebalData;
  /** Buckets (and the book's volatility cap) past their risk budget. */
  budgetOver?: number;
  colors: Colors;
  sym: string;
  onGo: (tab: SummaryTarget) => void;
}) {
  const lines: { label: string; text: React.ReactNode; color?: string }[] = [];
  const todo: { text: string; tab?: SummaryTarget; tone: string }[] = [];

  if (m) {
    const score = m.risk_score;
    const [regLabel, regColor] = REGIME[m.vol_regime];
    const topRisk = [...m.assets].sort(
      (a, b) => b.risk_contribution_pct - a.risk_contribution_pct
    )[0];
    lines.push({
      label: "ความผันผวน",
      text: (
        <>
          <b style={{ color: regColor }}>{regLabel}</b> · แกว่งปีละ ±
          {m.volatility_annual_pct.toFixed(0)}% (1 SD)
        </>
      ),
    });
    lines.push({
      label: "จากจุดสูงสุด",
      text: (
        <>
          ตอนนี้ต่ำกว่ายอดพอร์ตสูงสุด <b>{m.current_drawdown_pct.toFixed(1)}%</b> · แย่สุดในรอบปี{" "}
          {m.max_drawdown_pct.toFixed(1)}%
        </>
      ),
      color:
        m.current_drawdown_pct >= 10
          ? "#FF4444"
          : m.current_drawdown_pct >= 5
            ? "#FFB300"
            : undefined,
    });
    lines.push({
      label: "กระจายตัว",
      text: (
        <>
          ถือ {m.n_positions} ตัว แต่ความเสี่ยงเท่ากับถือ <b>~{m.effective_n.toFixed(1)} ตัว</b>ที่น้ำหนักเท่ากัน
          {topRisk && (
            <>
              {" "}
              · ความเสี่ยงมาจาก <b>{topRisk.symbol}</b> {topRisk.risk_contribution_pct.toFixed(0)}%
            </>
          )}
        </>
      ),
      color: m.effective_n < 3 ? "#FFB300" : undefined,
    });

    if (m.breach_hist || m.breach_cf || m.breach_mc)
      todo.push({
        text: `วันปิดล่าสุด${m.last_return_date ? ` (${m.last_return_date})` : ""} พอร์ต ${m.today_return_pct.toFixed(2)}% — ลงเกินที่โมเดลคาดไว้ (VaR) ตรวจว่ามีอะไรผิดปกติ`,
        tab: "detail",
        tone: "#FF4444",
      });
    if (m.ensemble_signal === "FAT_TAIL_RISK")
      todo.push({
        text: "ผลตอบแทนมีหางอ้วน — วันที่ลงแรงเกิดบ่อยกว่าที่การกระจายปกติบอก",
        tab: "detail",
        tone: "#FFB300",
      });
    if (m.ensemble_signal === "CORRELATION_RISK")
      todo.push({
        text: "หุ้นในพอร์ตเริ่มขยับไปทางเดียวกัน — การกระจายช่วยได้น้อยลง",
        tab: "detail",
        tone: "#FFB300",
      });
    if (score >= 60)
      todo.push({
        text: "คะแนนความเสี่ยงสูง — ลองจำลองลดขนาดใน WHAT-IF",
        tab: "whatif",
        tone: "#FF4444",
      });
  }
  if (rebal?.counts.TRIM)
    todo.unshift({
      text: `${rebal.counts.TRIM} ตัวกำไรโตเกินสัดส่วน — ขายทำกำไรได้ ${sym}${fmtAmt(rebal.sell_value)} (กำไรที่รับรู้ ${sym}${fmtAmt(rebal.est_realized)})`,
      tab: "rebalance",
      tone: colors.positive,
    });
  if (budgetOver > 0)
    todo.push({
      text: `${budgetOver} กองใช้ความเสี่ยงเกินงบที่ตั้งไว้ — ดูว่าต้องลดเท่าไร`,
      tab: "exposure",
      tone: "#FF4444",
    });
  // A "not yet" whose review date has passed is a decision that is due again.
  const holdsDue = rebal?.rows.filter((r) => r.status === "TRIM" && r.hold_ended).length ?? 0;
  if (holdsDue)
    todo.unshift({
      text: `${holdsDue} ตัวที่เคยบันทึกว่ายังไม่ขาย ครบวันทบทวนแล้ว — ขาย หรือบันทึกเหตุผลใหม่`,
      tab: "rebalance",
      tone: "#FF4444",
    });
  if (rebal?.counts.HOLD)
    todo.push({
      text: `${rebal.counts.HOLD} ตัวถึงเกณฑ์ขายทำกำไร แต่ถือต่อโดยมีเหตุผลบันทึกไว้`,
      tab: "rebalance",
      tone: "#FFB300",
    });
  if (rebal?.counts.WAIT)
    todo.push({
      text: `${rebal.counts.WAIT} ตัวถึงเกณฑ์ rebalance แต่ยังไม่ถึงจังหวะ (เพิ่งซื้อ/เพิ่งขาย/ช่วงงบ)`,
      tab: "rebalance",
      tone: "#FFB300",
    });

  const score = m?.risk_score;
  const scoreColor =
    score == null
      ? colors.textSecondary
      : score < 30
        ? "#00C853"
        : score < 60
          ? "#FFB300"
          : "#FF4444";
  const scoreLabel = score == null ? "…" : score < 30 ? "ต่ำ" : score < 60 ? "ปานกลาง" : "สูง";

  return (
    <div
      className="rounded p-2 grid gap-3 font-mono md:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]"
      style={{ border: `1px solid ${colors.border}`, fontSize: 10 }}
    >
      <div
        className="flex flex-col items-start gap-0.5 pr-3"
        style={{ borderRight: `1px solid ${colors.border}` }}
      >
        <span style={{ color: colors.textSecondary, fontSize: 9 }}>ความเสี่ยงพอร์ต</span>
        <span
          className="font-bold tabular-nums"
          style={{ color: scoreColor, fontSize: 26, lineHeight: 1 }}
        >
          {score == null ? "—" : score.toFixed(0)}
          <span style={{ fontSize: 10, color: colors.textSecondary }}>/100</span>
        </span>
        <span className="font-bold" style={{ color: scoreColor }}>
          {scoreLabel}
        </span>
        {dayPnlPct != null && (
          <span
            style={{ color: dayPnlPct >= 0 ? colors.positive : colors.negative, fontSize: 9 }}
            title="ราคาตอนนี้ เทียบราคาปิดครั้งก่อน ของทุกตัวที่ถือ — ตัวเดียวกับ TODAY ใน TRADE GUARD"
          >
            วันนี้ {dayPnlPct >= 0 ? "+" : ""}
            {dayPnlPct.toFixed(2)}%
          </span>
        )}
        {m && (
          <span
            style={{ color: colors.textSecondary, fontSize: 8.5 }}
            title="ผลตอบแทนของแท่งวันล่าสุดที่ปิดแล้ว คิดจากพอร์ตน้ำหนักวันนี้ (รวมค่าเงิน) — เป็นตัวที่โมเดล VaR ใช้ตรวจว่าลงเกินคาดหรือไม่ ไม่ใช่กำไรขาดทุนของวันนี้"
          >
            วันปิดล่าสุด{m.last_return_date ? ` ${m.last_return_date.slice(5)}` : ""}{" "}
            {m.today_return_pct >= 0 ? "+" : ""}
            {m.today_return_pct.toFixed(2)}%
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        {m && (
          <div
            className="flex flex-wrap gap-x-5 gap-y-1 pb-1 mb-0.5"
            style={{ borderBottom: `1px solid ${colors.border}55` }}
          >
            {(
              [
                [
                  `VaR ${(m.confidence * 100).toFixed(0)}% · 1 วัน`,
                  m.var_historical_pct,
                  m.var_historical_amount,
                  "ใน 20 วันมีราว 1 วันที่ขาดทุนเกินเส้นนี้ (historical)",
                  colors.text,
                ],
                [
                  `CVaR ${(m.confidence * 100).toFixed(0)}% · 1 วัน`,
                  m.cvar_pct,
                  m.cvar_amount,
                  "ขาดทุนเฉลี่ยของวันที่แย่ที่สุด 5% — เมื่อหลุดเส้น VaR แล้ว โดยเฉลี่ยเสียเท่านี้",
                  "#FFB300",
                ],
                [
                  "CVaR ช่วงตึงเครียด",
                  m.cvar_stressed_pct,
                  m.cvar_stressed_amount,
                  "CVaR เดียวกัน แต่ใช้ความผันผวนและสหสัมพันธ์ของช่วงตลาดตึงเครียด",
                  "#FF4444",
                ],
              ] as [string, number, number, string, string][]
            ).map(([label, p, amt, title, tone]) => (
              <div key={label} title={title}>
                <div style={{ color: colors.textSecondary, fontSize: 8.5 }}>{label}</div>
                <div className="tabular-nums font-bold" style={{ color: tone, fontSize: 13 }}>
                  −{p.toFixed(2)}%
                </div>
                <div className="tabular-nums" style={{ color: colors.textSecondary, fontSize: 9 }}>
                  −{sym}
                  {fmtAmt(amt)}
                </div>
              </div>
            ))}
          </div>
        )}
        {m ? (
          lines.map((l) => (
            <div key={l.label} className="flex gap-2" style={{ lineHeight: 1.4 }}>
              <span className="shrink-0" style={{ color: colors.textSecondary, width: 70 }}>
                {l.label}
              </span>
              <span style={{ color: l.color ?? colors.text }}>{l.text}</span>
            </div>
          ))
        ) : (
          <span style={{ color: colors.textSecondary }}>กำลังโหลดตัวเลขความเสี่ยง…</span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span style={{ color: colors.textSecondary, fontSize: 9 }}>ควรทำอะไร</span>
        {todo.length === 0 && m && (
          <span style={{ color: colors.positive }}>ไม่มีอะไรเร่งด่วน (ดู TRADE GUARD ด้านล่างด้วย)</span>
        )}
        {todo.map((t) => (
          <button
            type="button"
            key={t.text}
            onClick={() => t.tab && onGo(t.tab)}
            className="text-left flex gap-1.5"
            style={{ color: colors.text, lineHeight: 1.4 }}
          >
            <span style={{ color: t.tone }}>●</span>
            <span>
              {t.text}
              {t.tab && <span style={{ color: colors.accent }}> →</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
