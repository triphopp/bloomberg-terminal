"use client";

/**
 * PORT → RISK → สรุป: the risk numbers in plain Thai, one line each, plus what
 * to do next. Every figure here comes from /risk/metrics (computed elsewhere);
 * the detail tab (เชิงลึก) still shows the methods behind them.
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
  today_return_pct: number;
  breach_hist: boolean;
  breach_cf: boolean;
  breach_mc: boolean;
  assets: { symbol: string; weight_pct: number; risk_contribution_pct: number }[];
}

const REGIME: Record<RiskSummaryMetrics["vol_regime"], [string, string]> = {
  CALM: ["ปกติ", "#00C853"],
  ELEVATED: ["สูงกว่าปกติ", "#FFB300"],
  STRESSED: ["ตึงเครียด", "#FF4444"],
  UNKNOWN: ["ไม่ทราบ", "#888"],
};

export function RiskSummaryCard({
  metrics: m,
  rebal,
  colors,
  sym,
  onGo,
}: {
  metrics: RiskSummaryMetrics | null;
  rebal?: RebalData;
  colors: Colors;
  sym: string;
  onGo: (tab: "rebalance" | "whatif" | "detail") => void;
}) {
  const lines: { label: string; text: React.ReactNode; color?: string }[] = [];
  const todo: { text: string; tab?: "rebalance" | "whatif" | "detail"; tone: string }[] = [];

  if (m) {
    const score = m.risk_score;
    const [regLabel, regColor] = REGIME[m.vol_regime];
    const topRisk = [...m.assets].sort(
      (a, b) => b.risk_contribution_pct - a.risk_contribution_pct
    )[0];
    lines.push({
      label: "วันแย่ ๆ",
      text: (
        <>
          ใน 20 วันจะมีราว 1 วันที่แย่ที่สุด — วันแบบนั้นพอร์ตอาจลด{" "}
          <b>
            ≈{m.ensemble_conservative_pct.toFixed(1)}% ({sym}
            {fmtAmt(m.ensemble_conservative_amount)})
          </b>
        </>
      ),
    });
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
        text: `วันนี้พอร์ต ${m.today_return_pct.toFixed(2)}% — ลงเกินที่โมเดลคาดไว้ (VaR) ตรวจว่ามีอะไรผิดปกติ`,
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
        {m && (
          <span
            style={{
              color: m.today_return_pct >= 0 ? colors.positive : colors.negative,
              fontSize: 9,
            }}
          >
            วันนี้ {m.today_return_pct >= 0 ? "+" : ""}
            {m.today_return_pct.toFixed(2)}%
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1">
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
