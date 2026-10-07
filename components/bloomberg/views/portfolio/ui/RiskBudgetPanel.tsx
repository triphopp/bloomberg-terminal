"use client";

/**
 * PORT → RISK → BUDGET · FACTOR (upper panel): how much of the book's risk each bucket uses, against
 * the share the user allows it.
 *
 * Risk in use = the bucket's contribution to the book's volatility (size ×
 * own volatility × how much it moves with the rest); all buckets add to 100%.
 * Buckets are holdings, sectors or theses. Over budget by more than the band →
 * the row says how much to sell to land on the budget (solved, others held
 * still); under → how much room is left. The book as a whole has its own
 * budget: a cap on annual volatility.
 *
 * Budgets are the user's: nothing here sets one or trades. Saved per book view
 * on this machine. Backend: GET|PUT|DELETE /api/v2/portfolio/risk/budget
 * (backend/risk_budget.py).
 */

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";

import type { Colors } from "../helpers";
import { fmtAmt } from "../helpers";
import { NumInput } from "./NumInput";

export type BudgetScope = "symbol" | "sector" | "thesis";
export type BudgetStatus = "OVER" | "UNDER" | "OK" | "UNSET" | "EMPTY";

export interface BudgetRow {
  key: string;
  label: string;
  conviction?: number | null;
  n: number;
  weight_pct: number;
  value: number;
  risk_pct: number;
  risk_vol_pp: number;
  budget_pct: number | null;
  over_pp: number | null;
  status: BudgetStatus;
  trim_pct: number | null;
  trim_value: number | null;
  add_value: number | null;
  members: { symbol: string; weight_pct: number; risk_pct: number; value: number }[];
}

export interface BudgetData {
  account_id: string;
  base_currency: string;
  as_of: string;
  scope: BudgetScope;
  nav: number;
  lookback_days: number;
  band_pp: number;
  vol: {
    used_pct: number;
    cap_pct: number | null;
    status: "OVER" | "OK" | "UNSET";
    derisk_pct: number | null;
    derisk_value: number | null;
  };
  budget_total_pct: number;
  unallocated_pct: number;
  rows: BudgetRow[];
  counts: Record<BudgetStatus, number>;
  excluded: { symbol: string; reason: string; bars: number }[];
}

const SCOPES: { id: BudgetScope; label: string }[] = [
  { id: "symbol", label: "รายหุ้น" },
  { id: "sector", label: "SECTOR" },
  { id: "thesis", label: "THESIS" },
];
const SCOPE_KEY = "bloomberg_risk_budget_scope";
const OVER = "#FF4444";
const LABEL_MAX = 280; // a thesis title can be a whole sentence

const STATUS_LABEL: Record<BudgetStatus, string> = {
  OVER: "เกินงบ",
  UNDER: "มีที่เหลือ",
  OK: "อยู่ในงบ",
  UNSET: "ยังไม่ตั้งงบ",
  EMPTY: "ยังไม่ถือ",
};

/** The bucket type the user last looked at — the tab badge counts the same one. */
export function useBudgetScope() {
  const [scope, setScope] = useState<BudgetScope>(() => {
    if (typeof window === "undefined") return "symbol";
    try {
      const s = localStorage.getItem(SCOPE_KEY);
      if (s && SCOPES.some((x) => x.id === s)) return s as BudgetScope;
    } catch {
      /* ignore */
    }
    return "symbol";
  });
  useEffect(() => {
    try {
      localStorage.setItem(SCOPE_KEY, scope);
    } catch {
      /* ignore */
    }
  }, [scope]);
  return [scope, setScope] as const;
}

export function useRiskBudget(accountId: string, currency: "THB" | "USD", scope: BudgetScope) {
  return useQuery<BudgetData>({
    queryKey: ["risk-budget", accountId, currency, scope],
    queryFn: async () => {
      const qs = new URLSearchParams({ scope, base_currency: currency });
      if (accountId !== "all") qs.set("account_id", accountId);
      const r = await fetch(`/api/v2/portfolio/risk/budget?${qs}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

/** One decimal, rounded DOWN — so a filled-in set can never add up past 100. */
const floor1 = (v: number) => Math.floor(v * 10) / 10;

export function RiskBudgetPanel({
  accountId,
  currency,
  colors,
  scope,
  onScope,
}: {
  accountId: string;
  currency: "THB" | "USD";
  colors: Colors;
  scope: BudgetScope;
  onScope: (s: BudgetScope) => void;
}) {
  const qc = useQueryClient();
  const { data, isFetching, error, refetch } = useRiskBudget(accountId, currency, scope);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [cap, setCap] = useState("");
  const [band, setBand] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const sym = currency === "THB" ? "฿" : "$";

  const startEdit = (d: BudgetData) => {
    setDraft(
      Object.fromEntries(
        d.rows.filter((r) => r.budget_pct != null).map((r) => [r.key, String(r.budget_pct)])
      )
    );
    setCap(d.vol.cap_pct == null ? "" : String(d.vol.cap_pct));
    setBand(String(d.band_pp));
    setErr(null);
    setConfirmWipe(false);
    setEditing(true);
  };
  const changeScope = (s: BudgetScope) => {
    setEditing(false);
    setOpen({});
    onScope(s);
  };

  const shell = (body: React.ReactNode) => (
    <div
      className="rounded p-2 flex flex-col gap-2 font-mono"
      style={{ border: `1px solid ${colors.border}`, fontSize: 10 }}
    >
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="font-bold" style={{ color: colors.accent, letterSpacing: "0.08em" }}>
          RISK BUDGET · ความเสี่ยงที่ใช้ เทียบงบ
        </span>
        <div className="flex items-baseline gap-2" style={{ fontSize: 9 }}>
          <span style={{ color: colors.textSecondary }}>จัดกอง</span>
          {SCOPES.map((s) => (
            <button
              aria-pressed={scope === s.id}
              type="button"
              key={s.id}
              onClick={() => changeScope(s.id)}
              className="font-bold"
              style={{ color: scope === s.id ? colors.accent : colors.textSecondary }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex items-baseline gap-3 ml-auto" style={{ fontSize: 9 }}>
          <button
            aria-pressed={editing}
            type="button"
            disabled={!data}
            onClick={() => (editing ? setEditing(false) : data && startEdit(data))}
            style={{ color: colors.accent }}
          >
            {editing ? "▾ ตั้งงบ" : "▸ ตั้งงบ"}
          </button>
          <button type="button" onClick={() => refetch()} style={{ color: colors.textSecondary }}>
            {isFetching ? "กำลังโหลด…" : "REFRESH"}
          </button>
        </div>
      </div>
      {body}
    </div>
  );

  if (error)
    return shell(
      <span style={{ color: colors.negative }}>RISK BUDGET unavailable — {String(error)}</span>
    );
  if (!data)
    return shell(<span style={{ color: colors.textSecondary }}>กำลังคำนวณ risk budget…</span>);

  const held = data.rows.filter((r) => r.n > 0);
  const draftTotal = Object.values(draft).reduce((a, v) => a + (Number.parseFloat(v) || 0), 0);
  const fill = (weights: (r: BudgetRow) => number) => {
    const total = held.reduce((a, r) => a + Math.max(0, weights(r)), 0);
    if (total <= 0) return;
    setDraft(
      Object.fromEntries(
        held.map((r) => [r.key, String(floor1((Math.max(0, weights(r)) / total) * 100))])
      )
    );
  };

  const send = async (method: "PUT" | "DELETE") => {
    setBusy(true);
    setErr(null);
    try {
      const account = accountId !== "all" ? accountId : null;
      const budgets = Object.fromEntries(
        Object.entries(draft)
          .filter(([, v]) => v.trim() !== "" && Number.isFinite(Number.parseFloat(v)))
          .map(([k, v]) => [k, Number.parseFloat(v)])
      );
      const r = await fetch(
        `/api/v2/portfolio/risk/budget${method === "DELETE" && account ? `?account_id=${account}` : ""}`,
        {
          method,
          headers: method === "PUT" ? { "Content-Type": "application/json" } : undefined,
          body:
            method === "PUT"
              ? JSON.stringify({
                  account_id: account,
                  scope,
                  budgets,
                  vol_cap_pct: cap.trim() === "" ? null : Number.parseFloat(cap),
                  band_pp: band.trim() === "" ? undefined : Number.parseFloat(band),
                })
              : undefined,
        }
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail ?? d.error ?? `HTTP ${r.status}`);
      await qc.invalidateQueries({ queryKey: ["risk-budget"] });
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setConfirmWipe(false);
    }
  };

  const scale = Math.max(...data.rows.map((r) => Math.max(r.risk_pct, r.budget_pct ?? 0)), 1) * 1.1;
  const x = (v: number) => `${Math.min(100, Math.max(0, (v / scale) * 100))}%`;
  const toneOf = (s: BudgetStatus) =>
    s === "OVER" ? OVER : s === "UNDER" ? colors.positive : colors.textSecondary;
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
  const iStyle = { background: "transparent", color: colors.text, borderColor: colors.border };
  const noBudget = data.budget_total_pct === 0 && data.vol.cap_pct == null;

  return shell(
    <>
      <div style={{ color: colors.textSecondary, fontSize: 9.5, lineHeight: 1.5 }}>
        <b style={{ color: colors.text }}>ความเสี่ยงที่ใช้</b> = กองนั้นทำให้พอร์ตผันผวนกี่ % ของทั้งหมด (ขนาด ×
        ความผันผวนของมัน × การวิ่งตามตัวอื่น) · รวมทุกกอง = 100% · <b style={{ color: colors.text }}>งบ</b>{" "}
        = ส่วนที่คุณยอมให้กองนั้นใช้ · ห่างจากงบเกิน {data.band_pp} จุด จึงเตือน
        {noBudget && <b style={{ color: "#FFB300" }}> · ยังไม่ได้ตั้งงบ — กด "ตั้งงบ" เพื่อเริ่ม</b>}
      </div>

      {/* ── KPI strip ── */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 items-baseline">
        <Kpi
          label="ความผันผวนพอร์ต"
          value={`${data.vol.used_pct.toFixed(1)}%/ปี`}
          color={data.vol.status === "OVER" ? OVER : undefined}
          colors={colors}
        />
        <Kpi
          label="เพดาน"
          value={data.vol.cap_pct == null ? "ยังไม่ตั้ง" : `${data.vol.cap_pct.toFixed(1)}%/ปี`}
          colors={colors}
        />
        <Kpi
          label="เกินงบ"
          value={`${data.counts.OVER} กอง`}
          color={data.counts.OVER ? OVER : undefined}
          colors={colors}
        />
        <Kpi label="มีที่เหลือ" value={`${data.counts.UNDER} กอง`} colors={colors} />
        <Kpi
          label="ตั้งงบแล้ว"
          value={`${data.budget_total_pct.toFixed(1)}% · ว่าง ${data.unallocated_pct.toFixed(1)}%`}
          colors={colors}
        />
      </div>

      {data.vol.status === "OVER" && data.vol.derisk_pct != null && (
        <div style={{ color: OVER }}>
          ● พอร์ตผันผวนเกินเพดาน — ย้าย {data.vol.derisk_pct.toFixed(1)}% ของทุกตัวเป็นเงินสด (≈ {sym}
          {fmtAmt(data.vol.derisk_value ?? 0)}) จึงกลับมาที่เพดาน
        </div>
      )}

      {editing && (
        <div
          className="p-2 flex flex-col gap-1.5"
          style={{ background: colors.surfaceDeep, fontSize: 9.5 }}
        >
          <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap">
            <span style={{ color: colors.textSecondary }}>เติมงบให้</span>
            <button type="button" onClick={() => fill(() => 1)} style={{ color: colors.accent }}>
              เท่ากันทุกกอง
            </button>
            <button
              type="button"
              onClick={() => fill((r) => r.weight_pct)}
              style={{ color: colors.accent }}
            >
              ตามน้ำหนักเงิน
            </button>
            {scope === "thesis" && (
              <button
                type="button"
                onClick={() => fill((r) => r.conviction ?? 1)}
                style={{ color: colors.accent }}
                title="แบ่งตาม conviction ของ thesis · กองที่ไม่มี conviction นับเป็น 1"
              >
                ตาม conviction
              </button>
            )}
            <button
              type="button"
              onClick={() => setDraft({})}
              style={{ color: colors.textSecondary }}
            >
              ล้างช่อง
            </button>
            <span className="flex items-center gap-1 ml-auto" title="งบของทั้งพอร์ต · เว้นว่าง = ไม่ตั้ง">
              <span style={{ color: colors.textSecondary }}>เพดานความผันผวน</span>
              <NumInput
                value={cap}
                aria-label="เพดานความผันผวนพอร์ต (% ต่อปี)"
                min={0}
                className="w-12 text-right border px-1 outline-none"
                style={iStyle}
                onChange={(e) => setCap(e.target.value)}
              />
              <span style={{ color: colors.textSecondary }}>%/ปี</span>
            </span>
            <span className="flex items-center gap-1" title="ห่างจากงบเกินกี่จุด จึงนับว่าเกิน / เหลือ">
              <span style={{ color: colors.textSecondary }}>เตือนเมื่อห่าง</span>
              <NumInput
                value={band}
                aria-label="ระยะจากงบที่เริ่มเตือน (จุด)"
                min={0}
                className="w-10 text-right border px-1 outline-none"
                style={iStyle}
                onChange={(e) => setBand(e.target.value)}
              />
              <span style={{ color: colors.textSecondary }}>จุด</span>
            </span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span style={{ color: draftTotal > 100 ? OVER : colors.textSecondary }}>
              รวมงบ {draftTotal.toFixed(1)}%
              {draftTotal > 100
                ? " — เกิน 100% บันทึกไม่ได้"
                : ` · ว่าง ${(100 - draftTotal).toFixed(1)}%`}
            </span>
            {err && <span style={{ color: colors.negative }}>{err}</span>}
            <span className="ml-auto flex gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => (confirmWipe ? send("DELETE") : setConfirmWipe(true))}
                style={{ color: confirmWipe ? OVER : colors.textSecondary }}
                title="ลบงบทุกแบบ (รายหุ้น · sector · thesis) เพดาน และระยะเตือน ของมุมมองบัญชีนี้"
              >
                {confirmWipe ? "กดอีกครั้งเพื่อลบงบทั้งหมด" : "ลบงบทั้งหมด"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
                style={{ color: colors.textSecondary }}
              >
                ยกเลิก
              </button>
              <button
                type="button"
                disabled={busy || draftTotal > 100}
                onClick={() => send("PUT")}
                className="px-2 border font-bold"
                style={{
                  borderColor: draftTotal > 100 ? colors.border : colors.accent,
                  color: draftTotal > 100 ? colors.textSecondary : colors.accent,
                }}
              >
                {busy ? "…" : "บันทึก"}
              </button>
            </span>
          </div>
        </div>
      )}

      {/* ── Buckets ── */}
      {data.rows.length === 0 ? (
        <span style={{ color: colors.textSecondary }}>ยังไม่มีสถานะเปิดที่มีประวัติราคาพอให้คำนวณ</span>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full tabular-nums" style={{ fontSize: 9.5 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {th("กอง", false)}
                {th("เงิน", true, "น้ำหนักเทียบ NAV")}
                {th("ความเสี่ยงที่ใช้", true, "ส่วนของความผันผวนพอร์ตที่มาจากกองนี้ · ลบ = ช่วยลดความเสี่ยง")}
                {th("งบ", true, "% ของความเสี่ยงรวมที่ยอมให้ใช้")}
                {th("", false)}
                {th("ส่วนต่าง", true, "ที่ใช้ − งบ (จุด)")}
                {th("สถานะ", false)}
                {th(
                  "ต้องทำ",
                  false,
                  "คิดทีละกอง โดยกองอื่นอยู่เท่าเดิม · ลด = ขายเป็นเงินสด · ที่ว่าง = เพิ่มได้เท่านี้ก่อนชนงบ (ต้องมีเงินสดมาซื้อ)"
                )}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const tone = toneOf(r.status);
                const canOpen = scope !== "symbol" && r.members.length > 0;
                return (
                  <Fragment key={r.key}>
                    <tr style={{ borderBottom: `1px solid ${colors.border}33` }}>
                      <td className="px-1 py-0.5 whitespace-nowrap">
                        {canOpen ? (
                          <button
                            aria-pressed={!!open[r.key]}
                            type="button"
                            className="font-bold truncate align-bottom text-left"
                            style={{ color: colors.text, maxWidth: LABEL_MAX }}
                            title={r.label}
                            onClick={() => setOpen((o) => ({ ...o, [r.key]: !o[r.key] }))}
                          >
                            {open[r.key] ? "▾" : "▸"} {r.label}
                          </button>
                        ) : (
                          <span
                            className="font-bold truncate inline-block align-bottom"
                            style={{ color: colors.text, maxWidth: LABEL_MAX }}
                            title={r.label}
                          >
                            {r.label}
                          </span>
                        )}
                        {r.n > 1 && (
                          <span
                            className="ml-1"
                            style={{ color: colors.textSecondary, fontSize: 8.5 }}
                          >
                            {r.n} ตัว
                          </span>
                        )}
                        {r.conviction != null && (
                          <span
                            className="ml-1"
                            style={{ color: colors.textSecondary, fontSize: 8.5 }}
                            title="conviction ของ thesis"
                          >
                            C{r.conviction}
                          </span>
                        )}
                      </td>
                      <td className="px-1 text-right" style={{ color: colors.textSecondary }}>
                        {r.weight_pct.toFixed(1)}%
                      </td>
                      <td className="px-1 text-right font-bold" style={{ color: colors.text }}>
                        {r.risk_pct.toFixed(1)}%
                      </td>
                      <td className="px-1 text-right" style={{ color: colors.text }}>
                        {editing ? (
                          <NumInput
                            value={draft[r.key] ?? ""}
                            aria-label={`งบความเสี่ยงของ ${r.label} (%)`}
                            min={0}
                            className="w-12 text-right border px-1 outline-none"
                            style={iStyle}
                            onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}
                          />
                        ) : r.budget_pct == null ? (
                          "—"
                        ) : (
                          `${r.budget_pct.toFixed(1)}%`
                        )}
                      </td>
                      <td className="px-1">
                        <div
                          className="relative"
                          style={{ height: 8, width: 110, background: `${colors.border}55` }}
                        >
                          <div
                            className="absolute top-0 bottom-0 left-0"
                            style={{ width: x(r.risk_pct), background: tone, opacity: 0.75 }}
                          />
                          {r.budget_pct != null && (
                            <div
                              className="absolute"
                              style={{
                                left: x(r.budget_pct),
                                top: -2,
                                bottom: -2,
                                width: 1.5,
                                background: colors.accent,
                              }}
                              title={`งบ ${r.budget_pct.toFixed(1)}%`}
                            />
                          )}
                        </div>
                      </td>
                      <td className="px-1 text-right" style={{ color: tone }}>
                        {r.over_pp == null
                          ? "—"
                          : `${r.over_pp > 0 ? "+" : ""}${r.over_pp.toFixed(1)}`}
                      </td>
                      <td className="px-1 whitespace-nowrap font-bold" style={{ color: tone }}>
                        {STATUS_LABEL[r.status]}
                      </td>
                      <td className="px-1 whitespace-nowrap" style={{ color: colors.text }}>
                        {r.status === "OVER" &&
                          (r.trim_value != null
                            ? `ลด ${sym}${fmtAmt(r.trim_value)} (${(r.trim_pct ?? 0).toFixed(1)}% ของกอง)`
                            : "ทั้งพอร์ตอยู่ในกองนี้ — ลดด้วยกองเดียวไม่ได้")}
                        {r.status === "UNDER" &&
                          (r.add_value != null ? `ที่ว่าง ≈ ${sym}${fmtAmt(r.add_value)}` : "—")}
                        {r.status === "EMPTY" && `งบว่าง ${(r.budget_pct ?? 0).toFixed(1)}%`}
                      </td>
                    </tr>
                    {canOpen &&
                      open[r.key] &&
                      r.members.map((m) => (
                        <tr key={`${r.key}:${m.symbol}`} style={{ color: colors.textSecondary }}>
                          <td className="px-1 pl-5">{m.symbol}</td>
                          <td className="px-1 text-right">{m.weight_pct.toFixed(1)}%</td>
                          <td className="px-1 text-right">{m.risk_pct.toFixed(1)}%</td>
                          <td />
                          <td className="px-1">
                            <div className="relative" style={{ height: 4, width: 110 }}>
                              <div
                                className="absolute top-0 bottom-0 left-0"
                                style={{
                                  width: x(m.risk_pct),
                                  background: colors.textSecondary,
                                  opacity: 0.6,
                                }}
                              />
                            </div>
                          </td>
                          <td />
                          <td />
                          <td className="px-1">
                            {sym}
                            {fmtAmt(m.value)}
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ color: colors.textSecondary, opacity: 0.75, fontSize: 8.5, lineHeight: 1.5 }}>
        ความเสี่ยง = ส่วนแบ่งความผันผวน จากราคา {data.lookback_days} วันล่าสุด (น้ำหนักและ covariance ชุดเดียวกับ
        เชิงลึก ท้ายหน้า สรุป) · "ลด / เพิ่ม" แก้สมการจริง: ขายกองหนึ่ง ความผันผวนทั้งพอร์ตลดด้วย
        ส่วนแบ่งจึงลดช้ากว่าขนาด · งบเก็บในเครื่องนี้ แยกตามมุมมองบัญชี · ระบบไม่ส่งคำสั่งซื้อขาย · ณ {data.as_of}
        {data.excluded.length > 0 &&
          ` · ไม่รวม ${data.excluded.map((e) => e.symbol).join(", ")} (ประวัติราคาสั้น)`}
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
