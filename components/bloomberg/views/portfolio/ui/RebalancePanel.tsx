"use client";

/**
 * PORT → RISK → REBALANCE: "this winner has grown too big a slice — take some off".
 *
 * Target per holding = the slice of money the user put in (cost weight), or an
 * explicit target set in ANALYTICS → ALLOCATION. A holding is ready to trim when
 * its gain ≥ min_gain, its weight is past the 5/25 band, and the timing rules
 * pass (min hold, gap since last sell, earnings blackout). Rows are grouped by
 * what the user should do: ขายได้เลย · รอเวลา · เล็กกว่า 1 lot · เฝ้าดู · ปกติ.
 * "จำลองใน WHAT-IF" hands the TRIM rows to the simulator.
 *
 * "ยังไม่ขาย" on a TRIM row records why not, with a review date — the same idea
 * as HOLD on a stop in TRADE GUARD. The row moves to ถือต่อ, leaves the sell
 * totals and the weekly alert, and comes back as a TRIM when the date passes.
 * The reason is kept in the decision journal (ui/DecisionJournalPanel.tsx).
 *
 * Backend: GET /api/v2/portfolio/risk/rebalance, PUT|DELETE …/rebalance/rules
 * (backend/rebalance.py), POST|DELETE …/risk/decisions (backend/risk_journal.py).
 * Alerts: guard_scheduler writes "guard:REBALANCE" once a week per holding
 * while it stays a TRIM.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";

import type { Colors } from "../helpers";
import { fmtAmt, fmtQty } from "../helpers";
import { endRiskDecision, postRiskDecision } from "./DecisionJournalPanel";
import { NumInput } from "./NumInput";

export type RebalStatus = "TRIM" | "HOLD" | "WAIT" | "SMALL" | "WATCH" | "OK" | "SKIP";

/** A "not yet" decision on a TRIM row (risk_decisions, kind REBALANCE). */
export interface RebalHold {
  id: string;
  reason: string;
  review_on: string | null;
  created_at: string | null;
}

/** Review periods offered when declining a trim (days). */
const HOLD_DAYS = [7, 14, 30, 60] as const;

export interface RebalRules {
  min_gain_pct: number;
  band_abs_pp: number;
  band_rel_pct: number;
  rebal_to: "half" | "band" | "target";
  min_hold_days: number;
  min_gap_days: number;
  earn_before_days: number;
  earn_after_days: number;
}

export interface RebalRow {
  symbol: string;
  yf_symbol?: string | null;
  price?: number | null;
  /** Live "not yet" decision — the row's status is HOLD while it stands. */
  hold?: RebalHold | null;
  /** A hold whose review date passed: the row is a TRIM again, decision due. */
  hold_ended?: RebalHold | null;
  sector: string | null;
  weight_pct: number;
  target_pct: number;
  target_source: "explicit" | "cost_weight";
  band_pp: number;
  over_pp: number;
  growth_pct: number | null;
  market_value: number | null;
  volume: number;
  lot_size: number;
  held_days: number | null;
  last_sell: string | null;
  earnings_window: [string, string] | null;
  status: RebalStatus;
  reasons: string[];
  ready_on: string | null;
  sell_shares: number;
  sell_value: number;
  est_realized: number;
  new_weight_pct: number;
}

/** Symbol-level trade; the WHAT-IF panel spreads it over the accounts holding it. */
export interface RebalTrade {
  symbol: string;
  delta_shares: number;
}

export interface RebalData {
  rules: RebalRules;
  as_of: string;
  total_value: number;
  rows: RebalRow[];
  counts: Record<RebalStatus, number>;
  sell_value: number;
  est_realized: number;
  trades: RebalTrade[];
  error?: string;
}

export function useRebalance(accountId: string) {
  return useQuery<RebalData>({
    queryKey: ["rebalance", accountId],
    queryFn: async () => {
      const qs = accountId !== "all" ? `?account_id=${accountId}` : "";
      const r = await fetch(`/api/v2/portfolio/risk/rebalance${qs}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
}

const GROUPS: {
  status: RebalStatus[];
  title: string;
  hint: string;
  tone: "act" | "wait" | "dim";
}[] = [
  { status: ["TRIM"], title: "ขายทำกำไรได้เลย", hint: "ผ่านทุกเงื่อนไข", tone: "act" },
  {
    status: ["HOLD"],
    title: "ถือต่อ — ยังไม่ขาย",
    hint: "ถึงเกณฑ์ขายแล้ว แต่คุณบันทึกเหตุผลไว้ · กลับมาเตือนเมื่อถึงวันทบทวน",
    tone: "wait",
  },
  { status: ["WAIT"], title: "รอเวลา", hint: "ถึงเกณฑ์แล้ว แต่ยังไม่ถึงจังหวะ", tone: "wait" },
  { status: ["SMALL"], title: "เล็กกว่า 1 lot", hint: "ถึงเกณฑ์ แต่ขายจริงไม่ได้", tone: "dim" },
  { status: ["WATCH"], title: "เฝ้าดู", hint: "ผ่านแล้ว 1 ข้อ หรือใกล้ band", tone: "dim" },
];

const REBAL_TO_LABEL: Record<RebalRules["rebal_to"], string> = {
  half: "ครึ่งทางถึงเป้า",
  band: "ขอบ band",
  target: "เป้าพอดี",
};

const pct = (v: number | null | undefined, d = 1) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;

export function RebalancePanel({
  accountId,
  colors,
  onSimulate,
}: {
  accountId: string;
  colors: Colors;
  onSimulate?: (trades: RebalTrade[]) => void;
}) {
  const { data, isFetching, error, refetch } = useRebalance(accountId);
  const [showRules, setShowRules] = useState(false);
  const [showOk, setShowOk] = useState(false);
  const ACT = colors.positive;
  const WAIT = "#FFB300";

  const shell = (body: React.ReactNode) => (
    <div
      className="rounded p-2 flex flex-col gap-2 font-mono"
      style={{ border: `1px solid ${colors.border}`, fontSize: 10 }}
    >
      {body}
    </div>
  );

  if (error)
    return shell(
      <span style={{ color: colors.negative }}>REBALANCE unavailable — {String(error)}</span>
    );
  if (!data)
    return shell(<span style={{ color: colors.textSecondary }}>กำลังคำนวณ rebalance…</span>);

  const r = data.rules;
  const trims = data.rows.filter((x) => x.status === "TRIM");
  const rest = data.rows.filter((x) => x.status === "OK" || x.status === "SKIP");

  return shell(
    <>
      {/* ── Header ── */}
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="font-bold" style={{ color: colors.accent, letterSpacing: "0.08em" }}>
          REBALANCE · ขายทำกำไรตัวที่โตเกินสัดส่วน
        </span>
        <div className="flex items-baseline gap-3 ml-auto" style={{ fontSize: 9 }}>
          <button
            aria-pressed={showRules}
            type="button"
            onClick={() => setShowRules((v) => !v)}
            style={{ color: colors.accent }}
          >
            {showRules ? "▾ กฎ" : "▸ กฎ"}
          </button>
          <button type="button" onClick={() => refetch()} style={{ color: colors.textSecondary }}>
            {isFetching ? "กำลังโหลด…" : "REFRESH"}
          </button>
        </div>
      </div>

      {/* ── How it decides, in one sentence ── */}
      <div style={{ color: colors.textSecondary, fontSize: 9.5, lineHeight: 1.5 }}>
        เป้าของแต่ละตัว = <b style={{ color: colors.text }}>สัดส่วนเงินที่คุณลงไป</b> (หรือเป้าที่ตั้งเองใน
        ANALYTICS → ALLOCATION) · เตือนเมื่อ{" "}
        <b style={{ color: colors.text }}>กำไร ≥ {r.min_gain_pct}%</b> และ{" "}
        <b style={{ color: colors.text }}>
          น้ำหนักโตเกินเป้า &gt; {r.band_abs_pp} จุด หรือ &gt; {r.band_rel_pct}% ของเป้า
        </b>{" "}
        · ขายกลับไป {REBAL_TO_LABEL[r.rebal_to]} · ไม่ขายถ้าถือยังไม่ถึง {r.min_hold_days} วัน, เพิ่งขายไปไม่ถึง{" "}
        {r.min_gap_days} วัน หรืออยู่ในช่วง {r.earn_before_days} วันก่อน – {r.earn_after_days}{" "}
        วันหลังประกาศงบ
      </div>

      {showRules && <RulesEditor rules={r} colors={colors} onSaved={() => refetch()} />}

      {/* ── KPI strip ── */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 items-baseline">
        <Kpi
          label="ขายได้เลย"
          value={`${data.counts.TRIM} ตัว`}
          color={data.counts.TRIM ? ACT : colors.text}
          colors={colors}
        />
        <Kpi label="มูลค่าที่ขาย" value={`฿${fmtAmt(data.sell_value)}`} colors={colors} />
        <Kpi
          label="กำไรที่จะรับรู้"
          value={`฿${fmtAmt(data.est_realized)}`}
          color={data.est_realized > 0 ? ACT : colors.text}
          colors={colors}
        />
        <Kpi
          label="เงินสดเพิ่ม"
          value={
            data.total_value
              ? `${((data.sell_value / data.total_value) * 100).toFixed(1)}% ของพอร์ต`
              : "—"
          }
          colors={colors}
        />
        {!!data.counts.HOLD && (
          <Kpi label="ถือต่อ (มีเหตุผล)" value={`${data.counts.HOLD}`} color={WAIT} colors={colors} />
        )}
        <Kpi
          label="รอเวลา"
          value={`${data.counts.WAIT}`}
          color={data.counts.WAIT ? WAIT : colors.text}
          colors={colors}
        />
        <Kpi label="เฝ้าดู" value={`${data.counts.WATCH}`} colors={colors} />
        {onSimulate && (
          <button
            type="button"
            disabled={!trims.length}
            onClick={() => onSimulate(data.trades)}
            className="ml-auto px-2 py-0.5 border font-bold"
            style={{
              borderColor: trims.length ? colors.accent : colors.border,
              color: trims.length ? colors.accent : colors.textSecondary,
              fontSize: 9.5,
            }}
            title="เปิด WHAT-IF โดยติ๊กเฉพาะการขายในแผนนี้ เทียบกับถือเหมือนเดิม"
          >
            จำลองแผนนี้ใน WHAT-IF →
          </button>
        )}
      </div>

      {/* ── Groups ── */}
      {GROUPS.map((g) => {
        const rows = data.rows.filter((x) => g.status.includes(x.status));
        if (!rows.length) return null;
        const tone = g.tone === "act" ? ACT : g.tone === "wait" ? WAIT : colors.textSecondary;
        return (
          <div key={g.title}>
            <div className="flex items-baseline gap-2 mb-0.5" style={{ fontSize: 9 }}>
              <span className="font-bold" style={{ color: tone }}>
                ● {g.title} ({rows.length})
              </span>
              <span style={{ color: colors.textSecondary }}>{g.hint}</span>
            </div>
            <RebalTable rows={rows} colors={colors} tone={tone} accountId={accountId} />
          </div>
        );
      })}
      {data.counts.TRIM +
        (data.counts.HOLD ?? 0) +
        data.counts.WAIT +
        data.counts.SMALL +
        data.counts.WATCH ===
        0 && (
        <div style={{ color: colors.textSecondary }}>
          ยังไม่มีตัวไหนกำไรมากพอและโตเกินสัดส่วน — ไม่ต้องทำอะไร
        </div>
      )}

      {rest.length > 0 && (
        <div>
          <button
            aria-pressed={showOk}
            type="button"
            onClick={() => setShowOk((v) => !v)}
            style={{ color: colors.accent, fontSize: 9 }}
          >
            {showOk ? "▾" : "▸"} ตัวอื่นที่ยังอยู่ในสัดส่วน ({rest.length})
          </button>
          {showOk && (
            <RebalTable
              rows={rest}
              colors={colors}
              tone={colors.textSecondary}
              accountId={accountId}
            />
          )}
        </div>
      )}

      <div style={{ color: colors.textSecondary, opacity: 0.75, fontSize: 8.5 }}>
        ราคาวันนี้ · ยังไม่รวมค่าธรรมเนียม/ภาษี · ปัดลงตาม board lot (SET 100 หุ้น) · ณ {data.as_of}
      </div>
    </>
  );
}

function Kpi({
  label,
  value,
  color,
  colors,
}: { label: string; value: string; color?: string; colors: Colors }) {
  return (
    <span>
      <span style={{ color: colors.textSecondary, fontSize: 9 }}>{label} </span>
      <span
        className="font-bold tabular-nums"
        style={{ color: color ?? colors.text, fontSize: 12 }}
      >
        {value}
      </span>
    </span>
  );
}

/** Weight vs target: target tick, band shaded, current weight as the bar. */
function WeightBar({ row, colors, tone }: { row: RebalRow; colors: Colors; tone: string }) {
  const max = Math.max(row.weight_pct, row.target_pct + row.band_pp) * 1.15 || 1;
  const x = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  return (
    <div className="relative" style={{ height: 8, width: 110, background: `${colors.border}55` }}>
      <div
        className="absolute top-0 bottom-0"
        style={{
          left: x(row.target_pct),
          width: `calc(${x(row.band_pp)})`,
          background: `${colors.textSecondary}33`,
        }}
      />
      <div
        className="absolute top-0 bottom-0"
        style={{ left: 0, width: x(row.weight_pct), background: tone, opacity: 0.75 }}
      />
      {row.sell_value > 0 && (
        <div
          className="absolute"
          style={{
            left: x(row.new_weight_pct),
            top: -1,
            bottom: -1,
            width: 1.5,
            background: colors.text,
          }}
          title={`หลังขาย ${row.new_weight_pct.toFixed(1)}%`}
        />
      )}
      <div
        className="absolute"
        style={{
          left: x(row.target_pct),
          top: -2,
          bottom: -2,
          width: 1,
          background: colors.accent,
        }}
      />
    </div>
  );
}

function RebalTable({
  rows,
  colors,
  tone,
  accountId,
}: { rows: RebalRow[]; colors: Colors; tone: string; accountId: string }) {
  const qc = useQueryClient();
  // One "ยังไม่ขาย" form open at a time, like HOLD in TRADE GUARD.
  const [holdFor, setHoldFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [days, setDays] = useState<number>(14);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["rebalance"] }),
      qc.invalidateQueries({ queryKey: ["risk-decisions"] }),
    ]);
  const openHold = (symbol: string) => {
    setHoldFor((cur) => (cur === symbol ? null : symbol));
    setReason("");
    setDays(14);
    setErr(null);
  };
  const submitHold = async (row: RebalRow) => {
    if (!reason.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await postRiskDecision({
        kind: "REBALANCE",
        decision: "HOLD",
        reason: reason.trim(),
        symbol: row.symbol,
        yf_symbol: row.yf_symbol ?? null,
        account_id: accountId !== "all" ? accountId : null,
        review_days: days,
        // What was declined, as it stood: the reason is read against these.
        snapshot: {
          weight_pct: row.weight_pct,
          target_pct: row.target_pct,
          growth_pct: row.growth_pct,
          sell_shares: row.sell_shares,
          sell_value: row.sell_value,
          est_realized: row.est_realized,
          price: row.price ?? null,
        },
      });
      setHoldFor(null);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const endHold = async (id: string) => {
    setBusy(true);
    setErr(null);
    try {
      await endRiskDecision(id);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const th = (h: string, right = true, title?: string) => (
    <th
      key={h}
      title={title}
      className={`${right ? "text-right" : "text-left"} font-normal px-1 py-0.5`}
      style={{ color: colors.textSecondary }}
    >
      {h}
    </th>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full tabular-nums" style={{ fontSize: 9.5 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
            {th("หุ้น", false)}
            {th("กำไร", true, "มูลค่าตลาด เทียบ ต้นทุน (รวมค่าเงิน)")}
            {th("น้ำหนัก → เป้า", true, "ตอนนี้ / เป้า (± band)")}
            {th("", false)}
            {th("ขาย", true, "จำนวนหุ้นที่ขาย ปัดลงตาม lot")}
            {th("มูลค่า")}
            {th("กำไรที่รับรู้")}
            {th("เหตุผล / พร้อมเมื่อ", false)}
            {th("ตัดสินใจ")}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={row.symbol}>
              <tr style={{ borderBottom: `1px solid ${colors.border}33` }}>
                <td className="px-1 py-0.5 whitespace-nowrap">
                  <span className="font-bold" style={{ color: colors.text }}>
                    {row.symbol}
                  </span>
                  {row.target_source === "explicit" && (
                    <span
                      className="ml-1"
                      style={{ color: colors.accent, fontSize: 8 }}
                      title="เป้าที่ตั้งเอง"
                    >
                      SET
                    </span>
                  )}
                </td>
                <td
                  className="px-1 text-right"
                  style={{ color: (row.growth_pct ?? 0) >= 0 ? colors.positive : colors.negative }}
                >
                  {pct(row.growth_pct)}
                </td>
                <td className="px-1 text-right whitespace-nowrap" style={{ color: colors.text }}>
                  {row.weight_pct.toFixed(1)}% → {row.target_pct.toFixed(1)}%
                  <span style={{ color: colors.textSecondary }}> ±{row.band_pp.toFixed(1)}</span>
                </td>
                <td className="px-1">
                  <WeightBar row={row} colors={colors} tone={tone} />
                </td>
                <td
                  className="px-1 text-right"
                  style={{ color: row.sell_shares ? tone : colors.textSecondary }}
                >
                  {row.sell_shares ? `−${fmtQty(row.sell_shares)}` : "—"}
                </td>
                <td className="px-1 text-right" style={{ color: colors.text }}>
                  {row.sell_value ? `฿${fmtAmt(row.sell_value)}` : "—"}
                </td>
                <td
                  className="px-1 text-right"
                  style={{ color: row.est_realized > 0 ? colors.positive : colors.textSecondary }}
                >
                  {row.est_realized ? `฿${fmtAmt(row.est_realized)}` : "—"}
                </td>
                <td className="px-1" style={{ color: colors.textSecondary, fontSize: 9 }}>
                  {row.hold && (
                    <span className="mr-1" style={{ color: colors.text }}>
                      <b style={{ color: "#FFB300" }}>ถือต่อถึง {row.hold.review_on ?? "—"}</b> —{" "}
                      {row.hold.reason || "ไม่ระบุเหตุผล"} ·
                    </span>
                  )}
                  {row.hold_ended && (
                    <span className="font-bold mr-1" style={{ color: "#FF4444" }}>
                      ครบวันทบทวน {row.hold_ended.review_on} ("{row.hold_ended.reason}") → ตัดสินใจใหม่
                      ·
                    </span>
                  )}
                  {row.ready_on && (
                    <span className="font-bold mr-1" style={{ color: "#FFB300" }}>
                      พร้อม {row.ready_on} ·
                    </span>
                  )}
                  {row.reasons.join(" · ")}
                </td>
                <td className="px-1 whitespace-nowrap text-right" style={{ fontSize: 9 }}>
                  {row.status === "TRIM" && (
                    <button
                      aria-pressed={holdFor === row.symbol}
                      type="button"
                      onClick={() => openHold(row.symbol)}
                      style={{ color: colors.accent }}
                      title="บันทึกว่ายังไม่ขายตอนนี้ พร้อมเหตุผลและวันทบทวน — ถึงวันนั้นจะกลับมาเตือน"
                    >
                      ยังไม่ขาย
                    </button>
                  )}
                  {row.status === "HOLD" && row.hold && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => row.hold && endHold(row.hold.id)}
                      style={{ color: colors.textSecondary }}
                      title="จบการถือต่อ — กลับไปอยู่ในรายการขายได้เลย (เหตุผลยังอยู่ในบันทึก)"
                    >
                      เลิกถือต่อ
                    </button>
                  )}
                </td>
              </tr>
              {holdFor === row.symbol && row.status === "TRIM" && (
                <tr style={{ background: colors.surfaceDeep }}>
                  <td colSpan={9} className="px-1 py-1">
                    <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: 9.5 }}>
                      <span style={{ color: colors.textSecondary }}>ทำไมยังไม่ขาย {row.symbol}</span>
                      <input
                        // biome-ignore lint/a11y/noAutofocus: the form opens on a click to type here
                        autoFocus
                        className="min-w-0 flex-1 border px-1 outline-none"
                        style={{
                          background: "transparent",
                          color: colors.text,
                          borderColor: colors.border,
                        }}
                        placeholder="เหตุผล เช่น รองบ Q3 / thesis ยังไม่จบ / รอแนวต้าน"
                        aria-label={`Reason for not selling ${row.symbol}`}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void submitHold(row);
                          else if (e.key === "Escape") setHoldFor(null);
                        }}
                      />
                      <span style={{ color: colors.textSecondary }}>ทบทวนใน</span>
                      {HOLD_DAYS.map((d) => (
                        <button
                          aria-pressed={days === d}
                          type="button"
                          key={d}
                          onClick={() => setDays(d)}
                          style={{
                            color: days === d ? colors.accent : colors.textSecondary,
                            textDecoration: days === d ? "underline" : "none",
                          }}
                        >
                          {d} วัน
                        </button>
                      ))}
                      <button
                        type="button"
                        disabled={busy || !reason.trim()}
                        onClick={() => void submitHold(row)}
                        className="px-2 border font-bold"
                        style={{
                          borderColor: reason.trim() ? colors.accent : colors.border,
                          color: reason.trim() ? colors.accent : colors.textSecondary,
                        }}
                      >
                        {busy ? "…" : "บันทึก"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setHoldFor(null)}
                        style={{ color: colors.textSecondary }}
                      >
                        ยกเลิก
                      </button>
                    </div>
                    {err && <div style={{ color: colors.negative, fontSize: 9 }}>{err}</div>}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const RULE_FIELDS: {
  key: Exclude<keyof RebalRules, "rebal_to">;
  label: string;
  unit: string;
  hint: string;
}[] = [
  { key: "min_gain_pct", label: "กำไรขั้นต่ำ", unit: "%", hint: "ต่ำกว่านี้ไม่ถือว่าเป็นการขายทำกำไร" },
  { key: "band_abs_pp", label: "band", unit: "จุด", hint: "น้ำหนักเกินเป้ากี่จุดเปอร์เซ็นต์" },
  { key: "band_rel_pct", label: "หรือ", unit: "% ของเป้า", hint: "อันไหนถึงก่อนนับอันนั้น (กฎ 5/25)" },
  { key: "min_hold_days", label: "ถือขั้นต่ำ", unit: "วัน", hint: "นับจาก lot แรก" },
  { key: "min_gap_days", label: "เว้นหลังขาย", unit: "วัน", hint: "ระยะห่างระหว่าง rebalance ตัวเดียวกัน" },
  { key: "earn_before_days", label: "งดก่อนงบ", unit: "วัน", hint: "ช่วงก่อนประกาศงบ" },
  { key: "earn_after_days", label: "งดหลังงบ", unit: "วัน", hint: "ราคามักแกว่งแรง 1–5 วันหลังงบ" },
];

function RulesEditor({
  rules,
  colors,
  onSaved,
}: { rules: RebalRules; colors: Colors; onSaved: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<RebalRules>(rules);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(rules);

  const send = async (method: "PUT" | "DELETE") => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/v2/portfolio/risk/rebalance/rules", {
        method,
        headers: method === "PUT" ? { "Content-Type": "application/json" } : undefined,
        body: method === "PUT" ? JSON.stringify(draft) : undefined,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail ?? `HTTP ${r.status}`);
      setDraft(d.rules);
      await qc.invalidateQueries({ queryKey: ["rebalance"] });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const iStyle = { background: "transparent", color: colors.text, borderColor: colors.border };
  return (
    <div
      className="p-2 flex flex-col gap-1.5"
      style={{ background: colors.surfaceDeep, fontSize: 9.5 }}
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {RULE_FIELDS.map((f) => (
          <div key={f.key} className="flex items-center gap-1" title={f.hint}>
            <span style={{ color: colors.textSecondary }}>{f.label}</span>
            <NumInput
              value={draft[f.key]}
              aria-label={`${f.label} (${f.unit})`}
              min={0}
              className="w-12 text-right border px-1 outline-none"
              style={iStyle}
              onChange={(e) =>
                setDraft((d) => ({ ...d, [f.key]: Number.parseFloat(e.target.value) || 0 }))
              }
            />
            <span style={{ color: colors.textSecondary }}>{f.unit}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span style={{ color: colors.textSecondary }}>ขายกลับไป</span>
        {(Object.keys(REBAL_TO_LABEL) as RebalRules["rebal_to"][]).map((k) => (
          <button
            type="button"
            key={k}
            onClick={() => setDraft((d) => ({ ...d, rebal_to: k }))}
            className="px-1.5 border"
            style={{
              borderColor: draft.rebal_to === k ? colors.accent : colors.border,
              color: draft.rebal_to === k ? colors.accent : colors.textSecondary,
            }}
          >
            {REBAL_TO_LABEL[k]}
          </button>
        ))}
        <span className="ml-auto flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => send("DELETE")}
            style={{ color: colors.textSecondary }}
          >
            ค่าเริ่มต้น
          </button>
          <button
            type="button"
            disabled={!dirty || busy}
            onClick={() => send("PUT")}
            className="px-2 border font-bold"
            style={{
              borderColor: dirty ? colors.accent : colors.border,
              color: dirty ? colors.accent : colors.textSecondary,
            }}
          >
            {busy ? "…" : "บันทึก"}
          </button>
        </span>
      </div>
      {err && <span style={{ color: colors.negative }}>{err}</span>}
      <span style={{ color: colors.textSecondary, opacity: 0.8, fontSize: 8.5 }}>
        กฎเดียวกันนี้ใช้กับการแจ้งเตือน (สัปดาห์ละครั้งต่อหุ้น ขณะที่ยังเข้าเกณฑ์ขาย) · ครึ่งทาง = ลดจำนวนครั้งที่ต้องเทรด
      </span>
    </div>
  );
}
