"use client";

/**
 * PORT → RISK: one traffic light for a fast-turnover book.
 *
 * Every open long gets a stop without the user typing one (manual S/L wins;
 * else 2×ATR14 at the entry date, clamped 5–12%), plus a time stop, a 10%
 * size cap and a 25% sector cap. Book level: day loss, REAL-NAV drawdown
 * (−5% half size, −10% stop) and a losing streak. The card says WHAT TO DO;
 * HOLD records a "hold anyway" with a reason (drops the line to grey), and the
 * REPORT shows whether following the rules has paid, in R-multiples.
 * Backend: /api/v2/portfolio/risk/guard[/override|/report] (backend/trade_guard.py).
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { Colors } from "../helpers";
import { fmtAmt, fmtPx } from "../helpers";

type Light = "GREEN" | "YELLOW" | "RED";

interface GuardOverride {
  id: string;
  codes: string[];
  reason: string;
  created_at: string;
}

interface GuardAction {
  level: "RED" | "YELLOW" | "INFO";
  code: string;
  symbol: string | null;
  text: string;
  account_id?: string;
  yf_symbol?: string;
  first_entry?: string;
  override_id?: string;
}

interface GuardRow {
  account_id: string;
  symbol: string;
  yf_symbol: string;
  currency: string;
  sector: string;
  strategy: string | null;
  first_entry: string;
  entry_price: number;
  price: number;
  stop: number;
  stop_distance_pct: number;
  stop_source: "MANUAL" | "ATR" | "DEFAULT";
  atr_pct: number | null;
  return_pct: number;
  to_stop_pct: number | null;
  days_held: number | null;
  weight_pct: number;
  risk_to_stop: number;
  flags: string[];
  override: GuardOverride | null;
}

interface GuardData {
  light: Light;
  actions: GuardAction[];
  positions: GuardRow[];
  invested_value: number;
  cash_value: number | null;
  nav_value: number | null;
  day_pnl_pct: number | null;
  nav_drawdown_pct: number | null;
  loss_streak: number;
  size_multiplier: number;
  size_multiplier_why: string[];
  heat_value: number;
  heat_pct: number | null;
  counts: Record<string, number>;
  skipped: { symbol: string; reason: string }[];
  atr_pending: string[];
  base_currency: string;
  rules: Record<string, number>;
}

interface StopPlan {
  dry_run: boolean;
  lots: number;
  backup?: string;
  plan: { symbol: string; stop: number; stop_distance_pct: number; below_stop: boolean; lot_ids: string[] }[];
  skipped: { symbol: string; reason: string }[];
}

interface RStats {
  n: number;
  win_pct: number | null;
  avg_return_pct: number | null;
  expectancy_r: number | null;
  avg_win_r: number | null;
  avg_loss_r: number | null;
}

interface ReportTrade {
  symbol: string;
  strategy: string | null;
  date_entry: string;
  date_exit: string;
  days_held: number | null;
  return_pct: number;
  stop_distance_pct: number;
  r: number;
  breaks: string[];
  overridden: boolean;
  mae_pct: number | null;
  mfe_pct: number | null;
  cf_return_pct: number | null;
  cf_stopped: boolean;
  entry_mismatch: boolean;
}

interface CfStats {
  n: number;
  actual_avg_pct?: number;
  stop_avg_pct?: number;
  actual_sum_pct?: number;
  stop_sum_pct?: number;
  actual_win_pct?: number;
  stop_win_pct?: number;
  actual_worst_pct?: number;
  stop_worst_pct?: number;
  stopped_pct?: number;
  winners_cut?: number;
  losses_saved?: number;
}

interface GuardReport {
  summary: RStats;
  followed: RStats;
  broke: RStats;
  overridden: RStats;
  capped_expectancy_r: number | null;
  break_counts: Record<string, number>;
  manual_stop_pct: number | null;
  monthly: (RStats & { month: string; breaks: number })[];
  by_strategy: (RStats & { strategy: string; breaks: number })[];
  worst: ReportTrade[];
  atr_pending: string[];
  counterfactual?: CfStats & {
    coverage_pct: number;
    entry_mismatch: { symbol: string; date_entry: string; return_pct: number }[];
  };
  sweep?: (CfStats & { kind: "pct" | "atr"; value: number })[];
}

const LIGHT_COLOR: Record<Light, string> = {
  GREEN: "#00C853",
  YELLOW: "#FFB300",
  RED: "#FF4444",
};

const LEVEL_COLOR: Record<GuardAction["level"], string> = {
  RED: "#FF4444",
  YELLOW: "#FFB300",
  INFO: "#666666",
};

const LIGHT_LABEL: Record<Light, string> = {
  GREEN: "ปกติ",
  YELLOW: "ระวัง",
  RED: "หยุดเปิดไม้ใหม่ — จัดการรายการสีแดงก่อน",
};

const FLAG_COLOR: Record<string, string> = {
  STOP_HIT: "#FF4444",
  NEAR_STOP: "#FFB300",
  TIME: "#FFB300",
  OVERWEIGHT: "#FF8800",
};

/** Codes a HOLD can silence — the per-holding exit signals. */
const HOLDABLE = new Set(["STOP_HIT", "NEAR_STOP", "TIME"]);

const fmtR = (r: number | null) => (r == null ? "—" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`);

export function TradeGuardCard({
  accountId,
  currency,
  colors,
}: {
  accountId: string;
  currency: "THB" | "USD";
  colors: Colors;
}) {
  const qc = useQueryClient();
  const [showTable, setShowTable] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [holding, setHolding] = useState<string | null>(null); // action key being held
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const [stopPlan, setStopPlan] = useState<StopPlan | null>(null);

  const queryKey = ["risk-guard", accountId, currency];
  const { data, isLoading, error } = useQuery<GuardData>({
    queryKey,
    queryFn: async () => {
      const qs = new URLSearchParams({ base_currency: currency });
      if (accountId !== "all") qs.set("account_id", accountId);
      const r = await fetch(`/api/v2/portfolio/risk/guard?${qs}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const report = useQuery<GuardReport>({
    queryKey: ["risk-guard-report", accountId],
    queryFn: async () => {
      const qs = accountId !== "all" ? `?account_id=${encodeURIComponent(accountId)}` : "";
      const r = await fetch(`/api/v2/portfolio/risk/guard/report${qs}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: showReport,
    staleTime: 15 * 60_000,
  });

  const sym = currency === "THB" ? "฿" : "$";
  const actionKey = (a: GuardAction) => `${a.account_id}|${a.yf_symbol}|${a.first_entry}`;

  const submitHold = async (a: GuardAction) => {
    const row = data?.positions.find(
      (p) => p.account_id === a.account_id && p.yf_symbol === a.yf_symbol
    );
    // Hold every exit signal the holding shows now, not only the clicked line —
    // one decision per holding.
    const codes = (row?.flags ?? [a.code]).filter((f) => HOLDABLE.has(f));
    setBusy(true);
    setActErr(null);
    try {
      const r = await fetch("/api/v2/portfolio/risk/guard/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: a.account_id,
          yf_symbol: a.yf_symbol,
          first_entry: a.first_entry,
          symbol: a.symbol,
          codes: codes.length ? codes : [a.code],
          reason: reason.trim(),
        }),
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
      setHolding(null);
      setReason("");
      await qc.invalidateQueries({ queryKey });
    } catch (e) {
      setActErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runStops = async (dryRun: boolean) => {
    setBusy(true);
    setActErr(null);
    try {
      const r = await fetch("/api/v2/portfolio/risk/guard/apply-stops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountId !== "all" ? accountId : null,
          dry_run: dryRun,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setStopPlan(d);
      if (!dryRun) await qc.invalidateQueries({ queryKey: ["risk-guard"] });
    } catch (e) {
      setActErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const undoHold = async (id: string) => {
    setBusy(true);
    setActErr(null);
    try {
      const r = await fetch(`/api/v2/portfolio/risk/guard/override/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await qc.invalidateQueries({ queryKey });
    } catch (e) {
      setActErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded p-2 mb-2 flex flex-col gap-1 font-mono"
      style={{ border: `1px solid ${colors.border}` }}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span style={{ color: colors.textSecondary, fontSize: 10, letterSpacing: "0.12em" }}>
          TRADE GUARD
        </span>
        {data && (
          <>
            <span style={{ color: LIGHT_COLOR[data.light], fontSize: 12, fontWeight: 700 }}>
              ● {data.light}
            </span>
            <span style={{ color: LIGHT_COLOR[data.light], fontSize: 10 }}>
              {LIGHT_LABEL[data.light]}
            </span>
            <span
              className="ml-auto tabular-nums"
              style={{ color: colors.textSecondary, fontSize: 9 }}
            >
              today{" "}
              <span
                style={{
                  color:
                    data.day_pnl_pct == null
                      ? colors.textSecondary
                      : data.day_pnl_pct >= 0
                        ? colors.positive
                        : colors.negative,
                }}
              >
                {data.day_pnl_pct == null
                  ? "—"
                  : `${data.day_pnl_pct >= 0 ? "+" : ""}${data.day_pnl_pct.toFixed(2)}%`}
              </span>
              {" · "}
              <span title="NAV จริง (time-weighted) เทียบจุดสูงสุดใน 1 ปี — −5% ครึ่งไซซ์, −10% หยุด">
                DD {data.nav_drawdown_pct == null ? "—" : `${data.nav_drawdown_pct.toFixed(1)}%`}
              </span>
              {" · "}
              <span title="ไม้ที่ปิดล่าสุดเสียติดกันกี่ไม้ — ครบ 4 ครึ่งไซซ์">
                streak {data.loss_streak}
              </span>
              {" · "}
              <span title="เงินที่จะเสียเพิ่มจากราคาตอนนี้ ถ้าทุกตัวลงไปถึง stop">
                heat {data.heat_pct == null ? "—" : `${data.heat_pct.toFixed(1)}%`} ({sym}
                {fmtAmt(data.heat_value)})
              </span>
              {" · "}
              <span
                style={{
                  color:
                    data.size_multiplier === 1
                      ? colors.textSecondary
                      : data.size_multiplier === 0
                        ? "#FF4444"
                        : "#FFB300",
                }}
                title={data.size_multiplier_why.join(" · ") || "ไซซ์ปกติ"}
              >
                size ×{data.size_multiplier}
              </span>
            </span>
          </>
        )}
      </div>

      {isLoading ? (
        <span style={{ color: colors.textSecondary, fontSize: 10 }}>loading…</span>
      ) : error || !data ? (
        <span style={{ color: colors.negative, fontSize: 10 }}>
          unavailable — {String(error ?? "no data")}
        </span>
      ) : (
        <>
          {data.actions.length === 0 ? (
            <span style={{ color: colors.textSecondary, fontSize: 10 }}>
              ไม่มีอะไรต้องทำ — ทุกตัวอยู่เหนือ stop, ไม่มีตัวค้างนาน, ขนาดไม่เกินเพดาน
            </span>
          ) : (
            <ul className="flex flex-col gap-0.5" style={{ fontSize: 10 }}>
              {data.actions.map((a, i) => {
                const k = a.yf_symbol ? actionKey(a) : null;
                const canHold = a.level !== "INFO" && HOLDABLE.has(a.code) && !!k;
                return (
                  <li
                    key={`${a.code}-${a.symbol}-${i}`}
                    style={{ color: a.level === "INFO" ? colors.textSecondary : colors.text }}
                  >
                    <span style={{ color: LEVEL_COLOR[a.level], marginRight: 6 }}>●</span>
                    {a.text}
                    {canHold && holding !== k && (
                      <button
                        type="button"
                        onClick={() => {
                          setHolding(k);
                          setReason("");
                        }}
                        className="ml-2"
                        style={{ color: colors.accent, fontSize: 9 }}
                        title="บันทึกว่าตั้งใจถือต่อ พร้อมเหตุผล — บรรทัดนี้จะเป็นสีเทาและไม่นับในไฟ จนกว่าจะขายหมด"
                      >
                        HOLD
                      </button>
                    )}
                    {a.level === "INFO" && a.override_id && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => undoHold(a.override_id!)}
                        className="ml-2"
                        style={{ color: colors.textSecondary, fontSize: 9 }}
                        title="ยกเลิก HOLD (กดผิด) — กลับมาเตือนตามปกติ"
                      >
                        UNDO
                      </button>
                    )}
                    {canHold && holding === k && (
                      <span className="ml-2 inline-flex items-baseline gap-1">
                        <input
                          // biome-ignore lint/a11y/noAutofocus: opened by an explicit click
                          autoFocus
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && reason.trim()) submitHold(a);
                            if (e.key === "Escape") setHolding(null);
                          }}
                          placeholder="เหตุผลที่ถือต่อ (บังคับ)"
                          className="px-1"
                          style={{
                            fontSize: 9,
                            width: 220,
                            background: "transparent",
                            color: colors.text,
                            borderBottom: `1px solid ${colors.border}`,
                          }}
                        />
                        <button
                          type="button"
                          disabled={busy || !reason.trim()}
                          onClick={() => submitHold(a)}
                          style={{
                            color: reason.trim() ? colors.accent : colors.textDimmed,
                            fontSize: 9,
                          }}
                        >
                          SAVE
                        </button>
                        <button
                          type="button"
                          onClick={() => setHolding(null)}
                          style={{ color: colors.textSecondary, fontSize: 9 }}
                        >
                          CANCEL
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {actErr && <span style={{ color: colors.negative, fontSize: 9 }}>{actErr}</span>}

          <div className="flex items-baseline gap-3 flex-wrap" style={{ fontSize: 9 }}>
            <button
              type="button"
              onClick={() => setShowTable((v) => !v)}
              style={{ color: colors.accent }}
            >
              {showTable ? "▾ HIDE STOPS" : `▸ STOPS (${data.positions.length})`}
            </button>
            <button
              type="button"
              onClick={() => setShowReport((v) => !v)}
              style={{ color: colors.accent }}
            >
              {showReport ? "▾ HIDE REPORT" : "▸ REPORT"}
            </button>
            {(data.counts.manual_stops ?? 0) < (data.counts.positions ?? 0) && !stopPlan && (
              <button
                type="button"
                disabled={busy}
                onClick={() => runStops(true)}
                style={{ color: colors.accent }}
                title="เขียน stop อัตโนมัติ (ATR) ลงช่อง S/L ของไม้ที่ยังไม่มี — ดูรายการก่อนยืนยัน"
              >
                WRITE STOPS
              </button>
            )}
            <span style={{ color: colors.textSecondary }}>
              S/L ใส่เอง {data.counts.manual_stops ?? 0}/{data.counts.positions ?? 0} ·
              ที่เหลือใช้ stop อัตโนมัติ
              {(data.counts.overrides ?? 0) > 0 && ` · HOLD ${data.counts.overrides}`}
            </span>
            {data.atr_pending.length > 0 && (
              <span
                style={{ color: "#B06000" }}
                title="ประวัติราคายังโหลดไม่เสร็จ — ใช้ stop 8% ชั่วคราว"
              >
                ATR pending: {data.atr_pending.join(", ")}
              </span>
            )}
            {data.skipped.length > 0 && (
              <span
                style={{ color: colors.textSecondary }}
                title={data.skipped.map((s) => `${s.symbol}: ${s.reason}`).join("\n")}
              >
                skipped {data.skipped.length}
              </span>
            )}
          </div>

          {stopPlan && (
            <div
              className="flex flex-col gap-0.5 pt-1"
              style={{ borderTop: `1px solid ${colors.border}`, fontSize: 9 }}
            >
              {stopPlan.dry_run ? (
                stopPlan.lots === 0 ? (
                  <span style={{ color: colors.textSecondary }}>ไม่มีไม้ที่ต้องเขียน stop</span>
                ) : (
                  <>
                    <span style={{ color: colors.text }}>
                      จะเขียน S/L ลง {stopPlan.lots} ไม้ ({stopPlan.plan.length} ตัว) — สำรอง DB ก่อนเขียน,
                      ไม้ที่มี S/L อยู่แล้วไม่แตะ:
                    </span>
                    <span className="tabular-nums" style={{ color: colors.textSecondary }}>
                      {stopPlan.plan
                        .map(
                          (p) =>
                            `${p.symbol} ${fmtPx(p.stop)} (−${p.stop_distance_pct.toFixed(1)}%${p.below_stop ? ", หลุดแล้ว" : ""})`
                        )
                        .join(" · ")}
                    </span>
                  </>
                )
              ) : (
                <span style={{ color: colors.positive }}>
                  เขียน S/L แล้ว {stopPlan.lots} ไม้ · backup {stopPlan.backup?.split(/[\\/]/).pop()}
                </span>
              )}
              {stopPlan.skipped.length > 0 && (
                <span style={{ color: colors.textSecondary }}>
                  ข้าม: {stopPlan.skipped.map((s) => `${s.symbol} (${s.reason})`).join(", ")}
                </span>
              )}
              <span className="flex gap-3">
                {stopPlan.dry_run && stopPlan.lots > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => runStops(false)}
                    style={{ color: colors.accent }}
                  >
                    CONFIRM WRITE
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setStopPlan(null)}
                  style={{ color: colors.textSecondary }}
                >
                  {stopPlan.dry_run ? "CANCEL" : "CLOSE"}
                </button>
              </span>
            </div>
          )}

          {showTable && <StopsTable rows={data.positions} colors={colors} />}
          {showReport && (
            <ReportPanel
              data={report.data}
              loading={report.isLoading}
              error={report.error}
              colors={colors}
            />
          )}

          <span
            style={{ color: colors.textSecondary, fontSize: 8.5, opacity: 0.7, lineHeight: 1.5 }}
          >
            stop = S/L ที่ใส่เอง หรือ 2×ATR ตอนเข้า (5–12% จากทุน) · ถือ ≥{data.rules.time_stop_days}{" "}
            วันแต่กำไร &lt;{data.rules.time_stop_min_gain_pct}% = ค้าง (strategy Value/Core ยกเว้น) ·
            ตัวเดียว ≤{data.rules.max_weight_pct}% · กลุ่ม ≤{data.rules.max_sector_pct}% · วันละไม่เกิน −
            {data.rules.day_loss_limit_pct}% · NAV DD −{data.rules.dd_half_pct}% ครึ่งไซซ์ / −
            {data.rules.dd_stop_pct}% หยุด · เสียติด {data.rules.loss_streak} ไม้ ครึ่งไซซ์.
            ระบบแค่เตือน (ticker + toast เมื่อมีธงใหม่) ไม่ส่งคำสั่งขาย. ตัวเลขเป็นค่าตั้งต้น
            ไม่ได้ผ่าน backtest.
          </span>
        </>
      )}
    </div>
  );
}

function StopsTable({ rows, colors }: { rows: GuardRow[]; colors: Colors }) {
  return (
    <div
      className="grid items-baseline gap-x-3"
      style={{
        gridTemplateColumns: "minmax(60px,1fr) repeat(7, auto) minmax(90px,1.5fr)",
        fontSize: 10,
      }}
    >
      {["SYMBOL", "ENTRY", "LAST", "STOP", "SRC", "P&L", "TO STOP", "DAYS", "FLAGS"].map((h, i) => (
        <span
          key={h}
          style={{
            color: colors.textSecondary,
            fontSize: 8.5,
            textAlign: i && i < 8 ? "right" : "left",
          }}
        >
          {h}
        </span>
      ))}
      {rows.map((r) => (
        <div key={`${r.account_id}-${r.symbol}`} className="contents">
          <span
            style={{ color: colors.text }}
            title={`${r.sector}${r.strategy ? ` · ${r.strategy}` : ""} · ${r.weight_pct.toFixed(1)}% of book${r.override ? `\nHOLD: ${r.override.reason}` : ""}`}
          >
            {r.symbol}
            {r.override && (
              <span style={{ color: colors.textSecondary, fontSize: 8.5 }}> hold</span>
            )}
          </span>
          <span
            className="tabular-nums"
            style={{ textAlign: "right", color: colors.textSecondary }}
          >
            {fmtPx(r.entry_price)}
          </span>
          <span className="tabular-nums" style={{ textAlign: "right", color: colors.text }}>
            {fmtPx(r.price)}
          </span>
          <span className="tabular-nums" style={{ textAlign: "right", color: colors.text }}>
            {fmtPx(r.stop)}
          </span>
          <span
            style={{ textAlign: "right", color: colors.textSecondary, fontSize: 8.5 }}
            title={
              r.stop_source === "ATR"
                ? `2×ATR ${r.atr_pct?.toFixed(2)}% ตอนเข้า → stop ห่าง ${r.stop_distance_pct.toFixed(1)}%`
                : r.stop_source === "MANUAL"
                  ? "S/L ที่ใส่เอง"
                  : "ไม่มีประวัติราคา — ใช้ 8%"
            }
          >
            {r.stop_source === "MANUAL"
              ? "S/L"
              : r.stop_source === "ATR"
                ? `-${r.stop_distance_pct.toFixed(0)}%`
                : "8%"}
          </span>
          <span
            className="tabular-nums"
            style={{
              textAlign: "right",
              color: r.return_pct >= 0 ? colors.positive : colors.negative,
            }}
          >
            {r.return_pct >= 0 ? "+" : ""}
            {r.return_pct.toFixed(1)}%
          </span>
          <span className="tabular-nums" style={{ textAlign: "right", color: colors.text }}>
            {r.to_stop_pct == null ? "—" : `${r.to_stop_pct.toFixed(1)}%`}
          </span>
          <span
            className="tabular-nums"
            style={{ textAlign: "right", color: colors.textSecondary }}
          >
            {r.days_held ?? "—"}
          </span>
          <span>
            {r.flags.length === 0 ? (
              <span style={{ color: colors.textSecondary }}>—</span>
            ) : (
              r.flags.map((f) => (
                <span
                  key={f}
                  style={{
                    color: r.override?.codes.includes(f)
                      ? colors.textSecondary
                      : (FLAG_COLOR[f] ?? colors.text),
                    marginRight: 6,
                  }}
                >
                  {f.replace("_", " ")}
                </span>
              ))
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function StatCell({ label, s, colors }: { label: string; s: RStats; colors: Colors }) {
  return (
    <div className="flex flex-col" style={{ minWidth: 110 }}>
      <span style={{ color: colors.textSecondary, fontSize: 8.5 }}>{label}</span>
      <span
        className="tabular-nums"
        style={{
          color:
            s.expectancy_r == null
              ? colors.textSecondary
              : s.expectancy_r >= 0
                ? colors.positive
                : colors.negative,
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        {fmtR(s.expectancy_r)}
      </span>
      <span className="tabular-nums" style={{ color: colors.textSecondary, fontSize: 8.5 }}>
        n {s.n} · win {s.win_pct == null ? "—" : `${s.win_pct}%`}
      </span>
    </div>
  );
}

function ReportPanel({
  data,
  loading,
  error,
  colors,
}: {
  data: GuardReport | undefined;
  loading: boolean;
  error: unknown;
  colors: Colors;
}) {
  if (loading)
    return (
      <span style={{ color: colors.textSecondary, fontSize: 10 }}>
        loading report… (ครั้งแรกโหลดประวัติราคาทุกตัวที่เคยเทรด)
      </span>
    );
  if (error || !data)
    return (
      <span style={{ color: colors.negative, fontSize: 10 }}>
        report unavailable — {String(error ?? "no data")}
      </span>
    );

  const th = (h: string, right = true) => (
    <span
      key={h}
      style={{ color: colors.textSecondary, fontSize: 8.5, textAlign: right ? "right" : "left" }}
    >
      {h}
    </span>
  );
  const num = (v: string, color?: string) => (
    <span className="tabular-nums" style={{ textAlign: "right", color: color ?? colors.text }}>
      {v}
    </span>
  );
  const rColor = (r: number | null) =>
    r == null ? colors.textSecondary : r >= 0 ? colors.positive : colors.negative;

  return (
    <div
      className="flex flex-col gap-2 pt-1"
      style={{ borderTop: `1px solid ${colors.border}`, fontSize: 10 }}
    >
      <span style={{ color: colors.textSecondary, fontSize: 9 }}>
        ไม้ที่ปิดแล้ว วัดเป็น R (1R = ระยะ stop ที่ระบบจะตั้งตอนเข้า) · ผิดกติกา = เสียเกิน 1.5R
        หรือถือตัวขาดทุน ≥28 วัน
      </span>
      <div className="flex gap-4 flex-wrap">
        <StatCell label="ทั้งหมด" s={data.summary} colors={colors} />
        <StatCell label="ทำตามกติกา" s={data.followed} colors={colors} />
        <StatCell label="ผิดกติกา" s={data.broke} colors={colors} />
        {data.overridden.n > 0 && <StatCell label="HOLD" s={data.overridden} colors={colors} />}
        <div className="flex flex-col" style={{ minWidth: 150 }}>
          <span style={{ color: colors.textSecondary, fontSize: 8.5 }}>ถ้าตัดทุกไม้ที่ −1R</span>
          <span
            className="tabular-nums"
            style={{ color: rColor(data.capped_expectancy_r), fontSize: 12, fontWeight: 700 }}
          >
            {fmtR(data.capped_expectancy_r)}
          </span>
          <span style={{ color: colors.textSecondary, fontSize: 8.5 }}>
            เพดานบน: สมมติ stop ได้ราคาพอดี
          </span>
        </div>
      </div>
      <span style={{ color: colors.textSecondary, fontSize: 9 }}>
        เสียเกิน stop {data.break_counts.LOSS_PAST_STOP ?? 0} · ถือตัวขาดทุนนาน{" "}
        {data.break_counts.HELD_LOSER ?? 0} · ใส่ S/L เอง{" "}
        {data.manual_stop_pct == null ? "—" : `${data.manual_stop_pct}%`} ของไม้
        {data.atr_pending.length > 0 && ` · ATR pending ${data.atr_pending.length} ตัว (ใช้ 8%)`}
      </span>

      {data.counterfactual && data.counterfactual.n > 0 && (
        <CounterfactualBlock data={data} colors={colors} />
      )}

      <div className="flex gap-6 flex-wrap items-start">
        <div
          className="grid gap-x-3"
          style={{ gridTemplateColumns: "auto repeat(4, auto)", alignItems: "baseline" }}
        >
          {th("MONTH", false)}
          {th("N")}
          {th("WIN")}
          {th("EXP")}
          {th("BREAKS")}
          {data.monthly.slice(0, 12).map((m) => (
            <div key={m.month} className="contents">
              <span style={{ color: colors.text }}>{m.month}</span>
              {num(String(m.n))}
              {num(m.win_pct == null ? "—" : `${m.win_pct}%`)}
              {num(fmtR(m.expectancy_r), rColor(m.expectancy_r))}
              {num(String(m.breaks), m.breaks ? "#FFB300" : colors.textSecondary)}
            </div>
          ))}
        </div>

        <div
          className="grid gap-x-3"
          style={{ gridTemplateColumns: "auto repeat(4, auto)", alignItems: "baseline" }}
        >
          {th("STRATEGY", false)}
          {th("N")}
          {th("WIN")}
          {th("EXP")}
          {th("BREAKS")}
          {data.by_strategy.map((s) => (
            <div key={s.strategy} className="contents">
              <span
                style={{ color: s.strategy === "(none)" ? "#FFB300" : colors.text }}
                title={s.strategy === "(none)" ? "ไม้ที่ไม่ได้ระบุ strategy" : undefined}
              >
                {s.strategy}
              </span>
              {num(String(s.n))}
              {num(s.win_pct == null ? "—" : `${s.win_pct}%`)}
              {num(fmtR(s.expectancy_r), rColor(s.expectancy_r))}
              {num(String(s.breaks), s.breaks ? "#FFB300" : colors.textSecondary)}
            </div>
          ))}
        </div>

        <div
          className="grid gap-x-3"
          style={{ gridTemplateColumns: "auto repeat(7, auto)", alignItems: "baseline" }}
        >
          {th("WORST", false)}
          {th("R")}
          {th("RET")}
          {th("MAE")}
          {th("MFE")}
          {th("WITH STOP")}
          {th("DAYS")}
          {th("WHY")}
          {data.worst.slice(0, 6).map((t) => (
            <div key={`${t.symbol}-${t.date_entry}-${t.date_exit}`} className="contents">
              <span style={{ color: colors.text }} title={`${t.date_entry} → ${t.date_exit}`}>
                {t.symbol}
              </span>
              {num(fmtR(t.r), rColor(t.r))}
              {num(`${t.return_pct.toFixed(1)}%`, rColor(t.return_pct))}
              {num(t.mae_pct == null ? "—" : `${t.mae_pct.toFixed(1)}%`)}
              {num(t.mfe_pct == null ? "—" : `${t.mfe_pct.toFixed(1)}%`)}
              {t.entry_mismatch
                ? num("AVCO?", "#B06000")
                : num(
                    t.cf_return_pct == null ? "—" : `${t.cf_return_pct.toFixed(1)}%`,
                    t.cf_return_pct == null ? undefined : rColor(t.cf_return_pct)
                  )}
              {num(t.days_held == null ? "—" : String(t.days_held))}
              <span style={{ color: "#FFB300", fontSize: 8.5 }}>
                {t.breaks
                  .map((b) => (b === "LOSS_PAST_STOP" ? "past stop" : "held loser"))
                  .join(" · ")}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CounterfactualBlock({ data, colors }: { data: GuardReport; colors: Colors }) {
  const cf = data.counterfactual!;
  const sweep = data.sweep ?? [];
  const pc = (v: number | undefined, d = 2) =>
    v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
  const col = (v: number | undefined) =>
    v == null ? colors.textSecondary : v >= 0 ? colors.positive : colors.negative;
  const best = sweep.reduce<(typeof sweep)[number] | null>(
    (b, r) => (r.n && (b == null || (r.stop_avg_pct ?? -1e9) > (b.stop_avg_pct ?? -1e9)) ? r : b),
    null
  );
  const th = (h: string, left = false) => (
    <span key={h} style={{ color: colors.textSecondary, fontSize: 8.5, textAlign: left ? "left" : "right" }}>
      {h}
    </span>
  );
  return (
    <div className="flex flex-col gap-1" style={{ borderTop: `1px dashed ${colors.border}`, paddingTop: 4 }}>
      <span style={{ color: colors.text, fontSize: 9.5 }}>
        ถ้าทำตาม stop จริง — เล่นซ้ำทีละวันจากราคาจริง (รวมไม้ชนะที่ stop จะตัดทิ้ง และวันเปิดกระโดดทะลุ stop)
      </span>
      <div className="flex gap-6 flex-wrap tabular-nums" style={{ fontSize: 10 }}>
        <span>
          <span style={{ color: colors.textSecondary }}>เฉลี่ย/ไม้ จริง </span>
          <span style={{ color: col(cf.actual_avg_pct) }}>{pc(cf.actual_avg_pct)}</span>
          <span style={{ color: colors.textSecondary }}> → ทำตาม stop </span>
          <span style={{ color: col(cf.stop_avg_pct), fontWeight: 700 }}>{pc(cf.stop_avg_pct)}</span>
        </span>
        <span>
          <span style={{ color: colors.textSecondary }}>ไม้แย่สุด </span>
          <span style={{ color: colors.negative }}>{pc(cf.actual_worst_pct, 1)}</span>
          <span style={{ color: colors.textSecondary }}> → </span>
          <span style={{ color: colors.negative, fontWeight: 700 }}>{pc(cf.stop_worst_pct, 1)}</span>
        </span>
        <span style={{ color: colors.textSecondary }}>
          win {cf.actual_win_pct}% → {cf.stop_win_pct}% · โดน stop {cf.stopped_pct}% ของไม้ · ไม้ชนะที่ถูกตัด{" "}
          <span style={{ color: "#FFB300" }}>{cf.winners_cut}</span> · ไม้ที่ stop ช่วย{" "}
          <span style={{ color: colors.positive }}>{cf.losses_saved}</span> · n {cf.n} ({cf.coverage_pct}% ของไม้)
        </span>
      </div>
      {cf.entry_mismatch.length > 0 && (
        <span style={{ color: "#B06000", fontSize: 8.5 }}>
          เล่นซ้ำไม่ได้ {cf.entry_mismatch.length} ไม้ — ราคาเข้าไม่ตรงกับราคาตลาดวันนั้น (น่าจะเป็นต้นทุนเฉลี่ย AVCO
          จากไม้ก่อนหน้า): {cf.entry_mismatch.map((m) => `${m.symbol} ${m.date_entry} (${m.return_pct.toFixed(1)}%)`).join(", ")}
        </span>
      )}
      {sweep.length > 0 && (
        <div
          className="grid gap-x-3 items-baseline"
          style={{ gridTemplateColumns: "repeat(7, auto)", justifyContent: "start", fontSize: 9.5 }}
        >
          {th("STOP", true)}
          {th("เฉลี่ย/ไม้")}
          {th("รวม")}
          {th("แย่สุด")}
          {th("โดน stop")}
          {th("ชนะถูกตัด")}
          {th("ช่วยได้")}
          <div className="contents">
            <span style={{ color: colors.textSecondary }}>ไม่มี stop (จริง)</span>
            <span className="tabular-nums" style={{ textAlign: "right", color: col(cf.actual_avg_pct) }}>
              {pc(cf.actual_avg_pct)}
            </span>
            <span className="tabular-nums" style={{ textAlign: "right" }}>{pc(cf.actual_sum_pct, 1)}</span>
            <span className="tabular-nums" style={{ textAlign: "right" }}>{pc(cf.actual_worst_pct, 1)}</span>
            <span />
            <span />
            <span />
          </div>
          {sweep.map((r) => (
            <div key={`${r.kind}-${r.value}`} className="contents">
              <span style={{ color: r === best ? colors.accent : colors.text }}>
                {r.kind === "pct" ? `−${r.value}%` : `${r.value}×ATR`}
                {r.kind === "atr" && r.value === 2 && (
                  <span style={{ color: colors.textSecondary, fontSize: 8 }}> (ปัจจุบัน*)</span>
                )}
                {r === best && <span style={{ fontSize: 8 }}> ดีสุด</span>}
              </span>
              <span className="tabular-nums" style={{ textAlign: "right", color: col(r.stop_avg_pct) }}>
                {pc(r.stop_avg_pct)}
              </span>
              <span className="tabular-nums" style={{ textAlign: "right" }}>{pc(r.stop_sum_pct, 1)}</span>
              <span className="tabular-nums" style={{ textAlign: "right" }}>{pc(r.stop_worst_pct, 1)}</span>
              <span className="tabular-nums" style={{ textAlign: "right", color: colors.textSecondary }}>
                {r.stopped_pct?.toFixed(0)}%
              </span>
              <span className="tabular-nums" style={{ textAlign: "right", color: "#FFB300" }}>{r.winners_cut}</span>
              <span className="tabular-nums" style={{ textAlign: "right", color: colors.positive }}>
                {r.losses_saved}
              </span>
            </div>
          ))}
        </div>
      )}
      <span style={{ color: colors.textSecondary, fontSize: 8.5, opacity: 0.75 }}>
        * ระบบใช้ 2×ATR แต่บีบให้อยู่ใน 5–12% ตารางนี้ไม่บีบ. ทุกแถวใช้ไม้ชุดเดียวกัน. ไม่คิดค่าธรรมเนียม/การซื้อกลับ —
        stop ที่ตัดไม้ชนะในตารางนี้ คือไม่ได้กลับเข้าไปใหม่.
      </span>
    </div>
  );
}
