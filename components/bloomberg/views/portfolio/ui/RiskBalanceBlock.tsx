"use client";

/**
 * PORT → RISK → สรุป → เชิงลึก: "what do I trade so that every part of the book
 * carries the share of risk I want it to?" — the answer the old ERC PARITY bars
 * gave without saying what the bars were.
 *
 * Three choices, each a labelled row of buttons:
 *   ตั้งเป้าที่     what a "part" is — a holding, an account (the book as its
 *                  sub-portfolios; all-accounts view only), a sector or a thesis
 *   เป้า           the same share for every part (100 ÷ n), or the user's own
 *                  numbers. Own numbers are typed in the target column and saved
 *                  as that view's risk budgets — the symbol / sector / thesis
 *                  sets are the ones the BUDGET page shows. A part left blank
 *                  takes an equal piece of what is left of 100%; a group's share
 *                  is split equally among its holdings.
 *   วิธี           sell + buy (money in the book unchanged, lands on the targets)
 *                  or buy only (says how much NEW money that takes; a smaller
 *                  budget buys the same things, scaled).
 *
 * Every column has a header and every mark a legend: the trade in shares and
 * money, the money weight now → after, the risk share now → after on an axis
 * drawn once above the rows, with each row's own target marked.
 *
 * Model: backend/risk_balance.py. Endpoint: GET /api/v2/portfolio/risk/balance,
 * PUT /api/v2/portfolio/risk/budget. Nothing is sent to a broker.
 */

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { Colors } from "../helpers";
import { fmtAmt, fmtQty } from "../helpers";
import { NumInput } from "./NumInput";
import { Shell } from "./WhatIfSimPanel";

type Level = "symbol" | "sector" | "thesis" | "account";
type Source = "budget" | "remainder" | "equal";

interface BalanceRow {
  key: string;
  symbol: string;
  yf_symbol: string;
  currency: string;
  account: string | null;
  /** The part this holding belongs to at the chosen level. */
  group: string;
  group_label: string;
  price: number;
  weight_now_pct: number;
  weight_after_pct: number;
  risk_now_pct: number;
  risk_after_pct: number;
  /** The share this holding SHOULD carry: its part's target ÷ holdings in the part. */
  target_risk_pct: number;
  target_source: Source;
  /** Money to move in the base currency: + buy, − sell. */
  trade_value: number;
  shares: number | null;
}

interface BalanceGroup {
  key: string;
  label: string;
  n: number;
  target_pct: number;
  source: Source;
  weight_now_pct: number;
  weight_after_pct: number;
  risk_now_pct: number;
  risk_after_pct: number;
  trade_value: number;
}

interface BalancePlan {
  rows: BalanceRow[];
  groups: BalanceGroup[];
  buy_value: number;
  sell_value: number;
  vol_now_pct: number;
  vol_after_pct: number;
  top2: string[];
  top2_risk_now_pct: number;
  top2_risk_after_pct: number;
  /** add-only plan */
  cash?: number;
  cash_to_balance?: number;
  fraction_pct?: number;
}

interface BalanceData {
  base_currency: string;
  level?: Level;
  invested_value?: number;
  equal_share_pct?: number;
  n_groups?: number;
  /** "budget" when any target of the user's is in force, else every part gets 1/n. */
  target_mode?: "budget" | "equal";
  /** Saved targets of the parts in this view, % of total risk. */
  budgets?: Record<string, number>;
  /** Every saved target at this level — a save replaces the whole set. */
  budgets_all?: Record<string, number>;
  lookback_days?: number;
  rebalance?: BalancePlan;
  add?: BalancePlan | null;
  note?: string;
  excluded?: { symbol: string }[];
}

type Mode = "rebalance" | "add";
const FRACTIONS = [0.25, 0.5, 1] as const;

const LEVELS: { id: Level; label: string; unit: string; title: string; allOnly?: boolean }[] = [
  { id: "symbol", label: "รายตัว", unit: "ตัว", title: "ตั้งเป้าให้หุ้นแต่ละตัว" },
  {
    id: "account",
    label: "บัญชี (พอร์ตย่อย)",
    unit: "บัญชี",
    title: "ตั้งเป้าให้แต่ละบัญชี — หุ้นในบัญชีเดียวกันแบ่งเป้าของบัญชีเท่ากัน",
    allOnly: true,
  },
  {
    id: "sector",
    label: "กลุ่มธุรกิจ",
    unit: "กลุ่ม",
    title: "ตั้งเป้าให้แต่ละ sector — หุ้นใน sector เดียวกันแบ่งเป้าของกลุ่มเท่ากัน",
  },
  {
    id: "thesis",
    label: "thesis",
    unit: "thesis",
    title: "ตั้งเป้าให้แต่ละ thesis — หุ้นที่ไม่มี thesis รวมเป็นกลุ่มเดียว",
  },
];

const p0 = (v: number) => {
  const t = v.toFixed(0);
  return `${Number(t) === 0 ? "0" : t}%`;
};
/** A small share keeps one decimal: 16 holdings in 3 accounts are 3.0% each, not "3%". */
const p1 = (v: number) => (Math.abs(v) < 10 ? `${v.toFixed(1)}%` : p0(v));

export function RiskBalanceBlock({
  accountId,
  currency,
  colors,
}: { accountId: string; currency: "THB" | "USD"; colors: Colors }) {
  const [mode, setMode] = useState<Mode>("rebalance");
  const [picked, setPicked] = useState<Level>("symbol");
  // Targets per account only exist where there are accounts to compare.
  const level: Level = picked === "account" && accountId !== "all" ? "symbol" : picked;
  // null = as much new money as the full plan takes.
  const [cash, setCash] = useState<number | null>(null);
  // Whose target: the user's own numbers, or the same share for every part.
  const [useOwn, setUseOwn] = useState(true);
  // Typed targets not saved yet: part key → text ("" = no target of its own).
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const qc = useQueryClient();
  const dark = colors.bg === "#000000";
  const C_RISK = dark ? "#c77700" : "#b86e00";
  const sym = currency === "THB" ? "฿" : "$";
  const lv = LEVELS.find((l) => l.id === level) ?? LEVELS[0];

  const { data, error, isFetching } = useQuery<BalanceData>({
    queryKey: ["risk-balance", accountId, currency, cash, level, useOwn],
    queryFn: async () => {
      const qs = new URLSearchParams({ base_currency: currency, level });
      if (accountId !== "all") qs.set("account_id", accountId);
      if (cash != null) qs.set("cash", String(cash));
      if (!useOwn) qs.set("target", "equal");
      const r = await fetch(`/api/v2/portfolio/risk/balance?${qs}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  const opt = (on: boolean) => ({
    color: on ? colors.accent : colors.textSecondary,
    textDecoration: on ? "underline" : "none",
  });
  const title = "ทำให้ความเสี่ยงเป็นไปตามเป้า · ต้องซื้อขายอะไร เท่าไร";

  /** Save the typed targets as this account view's risk budgets at `level`
   *  (PUT replaces the level's whole set, so parts not on screen are kept). */
  const saveTargets = async (next: Record<string, string>) => {
    setSaving(true);
    setSaveErr(null);
    try {
      const shown = new Set((data?.rebalance?.groups ?? []).map((g) => g.key));
      const budgets: Record<string, number> = {};
      for (const [k, v] of Object.entries(data?.budgets_all ?? {}))
        if (!shown.has(k)) budgets[k] = v;
      for (const [k, v] of Object.entries(next)) {
        const n = Number.parseFloat(v);
        if (Number.isFinite(n) && n >= 0) budgets[k] = n;
      }
      const r = await fetch("/api/v2/portfolio/risk/budget", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountId !== "all" ? accountId : null,
          scope: level,
          budgets,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail ?? d.error ?? `HTTP ${r.status}`);
      setDraft(null);
      setUseOwn(true);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["risk-balance"] }),
        qc.invalidateQueries({ queryKey: ["risk-budget"] }),
      ]);
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const levelRow = (
    <div className="flex items-center gap-3 flex-wrap" style={{ fontSize: 9.5 }}>
      <span style={{ color: colors.textSecondary }}>ตั้งเป้าที่</span>
      {LEVELS.filter((l) => !l.allOnly || accountId === "all").map((l) => (
        <button
          aria-pressed={level === l.id}
          type="button"
          key={l.id}
          title={l.title}
          onClick={() => {
            setPicked(l.id);
            setDraft(null);
            setSaveErr(null);
          }}
          style={opt(level === l.id)}
        >
          {l.label}
        </button>
      ))}
      <span className="ml-4" style={{ color: colors.textSecondary }}>
        วิธี
      </span>
      <button
        aria-pressed={mode === "rebalance"}
        type="button"
        onClick={() => setMode("rebalance")}
        style={opt(mode === "rebalance")}
        title="ขายส่วนที่แบกความเสี่ยงเกินเป้า ไปซื้อส่วนที่แบกน้อย — เงินในพอร์ตเท่าเดิม"
      >
        ขาย + ซื้อ (เงินเท่าเดิม)
      </button>
      <button
        aria-pressed={mode === "add"}
        type="button"
        onClick={() => setMode("add")}
        style={opt(mode === "add")}
        title="ไม่ขายอะไรเลย ใส่เงินใหม่เข้าไปซื้อเพิ่ม"
      >
        ซื้อเพิ่มอย่างเดียว (เงินใหม่)
      </button>
    </div>
  );

  if (error)
    return (
      <Shell colors={colors} title={title}>
        {levelRow}
        <span style={{ color: colors.negative }}>คำนวณไม่ได้ — {String(error)}</span>
      </Shell>
    );
  if (!data)
    return (
      <Shell colors={colors} title={title}>
        {levelRow}
        <span style={{ color: colors.textSecondary }}>กำลังคำนวณแผน…</span>
      </Shell>
    );
  const plan = mode === "rebalance" ? data.rebalance : data.add;
  if (!plan || !plan.rows.length)
    return (
      <Shell colors={colors} title={title}>
        {levelRow}
        <span style={{ color: colors.textSecondary }}>
          {data.note ?? "ต้องมีอย่างน้อย 2 ตัวที่มีประวัติราคา"}
        </span>
      </Shell>
    );

  const grouped = level !== "symbol";
  const nParts = data.n_groups ?? plan.groups.length;
  const equal = data.equal_share_pct ?? 100 / nParts;
  const own = data.target_mode === "budget";
  const saved = data.budgets ?? {};
  const edits = draft ?? Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, String(v)]));
  const typed = plan.groups.map((g) => Number.parseFloat(edits[g.key] ?? ""));
  const setTotal = typed.reduce((s0, v) => s0 + (Number.isFinite(v) ? v : 0), 0);
  const unsetCount = typed.filter((v) => !Number.isFinite(v)).length;
  const dirty = draft != null;
  const need = data.add?.cash_to_balance ?? 0;
  const partial = mode === "add" && (plan.fraction_pct ?? 100) < 99.95;
  const onTarget = need < 1 && Math.abs(plan.buy_value) < 1 && Math.abs(plan.sell_value) < 1;

  // One axis for the risk-share column, shared by every row and drawn once on top.
  const marks = plan.rows.flatMap((r) => [r.risk_now_pct, r.risk_after_pct, r.target_risk_pct]);
  const hi = Math.max(...marks) * 1.08 || 1;
  const lo = Math.min(0, ...marks);
  const x = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const ticks = [0, Math.max(10, Math.floor(hi / 10) * 10)].filter((t) => t <= hi);

  const biggestBuy = [...plan.rows].sort((a, b) => b.trade_value - a.trade_value)[0];
  const th = "font-normal px-1.5 py-1 whitespace-nowrap";
  const inputStyle = { background: "transparent", color: colors.text, borderColor: colors.border };

  const targetInput = (key: string, placeholder: number, name: string) => (
    <NumInput
      value={edits[key] ?? ""}
      aria-label={`Risk target for ${name} (% of book risk)`}
      min={0}
      placeholder={placeholder.toFixed(0)}
      className="w-12 text-right border px-1 outline-none"
      style={inputStyle}
      onChange={(e) => setDraft({ ...edits, [key]: e.target.value })}
    />
  );
  const sourceNote = (source: Source, value: number) => (
    <span
      style={{ color: colors.textSecondary, fontSize: 8.5 }}
      title={source === "budget" ? "เป้าที่คุณตั้ง" : "ไม่ได้ตั้ง — ได้ส่วนที่เหลือแบ่งเท่ากัน"}
    >
      {" "}
      {source === "budget" ? "ตั้งเอง" : `= ${p0(value)}`}
    </span>
  );
  const legendDot = (filled: boolean) => (
    <span
      style={{
        display: "inline-block",
        width: 9,
        height: 9,
        borderRadius: 5,
        background: filled ? C_RISK : "transparent",
        border: `2px solid ${C_RISK}`,
      }}
    />
  );
  /** now → after on the shared axis, with this row's own target marked. */
  const riskTrack = (now: number, after: number, target: number) => {
    const a = Math.min(now, after);
    const b = Math.max(now, after);
    const dot = (v: number, filled: boolean) => (
      <div
        className="absolute"
        style={{
          left: `calc(${x(v)} - 5px)`,
          top: 2,
          width: 10,
          height: 10,
          borderRadius: 5,
          background: filled ? C_RISK : colors.bg,
          border: `2px solid ${filled ? colors.bg : C_RISK}`,
        }}
      />
    );
    return (
      <div className="relative" style={{ height: 14 }}>
        <div
          className="absolute left-0 right-0"
          style={{ top: 6.5, height: 1, background: colors.border }}
        />
        <div
          className="absolute"
          style={{
            left: x(target),
            top: 0,
            bottom: 0,
            width: 2,
            marginLeft: -1,
            background: colors.text,
            opacity: 0.7,
          }}
        />
        <div
          className="absolute"
          style={{
            left: x(a),
            width: `calc(${x(b)} - ${x(a)})`,
            top: 5.5,
            height: 3,
            background: C_RISK,
            opacity: 0.5,
          }}
        />
        {dot(now, false)}
        {dot(after, true)}
      </div>
    );
  };
  const nowAfter = (now: number, after: number) => (
    <>
      <span style={{ color: colors.textSecondary }}>{p0(now)} → </span>
      <span className="font-bold" style={{ color: colors.text }}>
        {p0(after)}
      </span>
    </>
  );

  return (
    <Shell colors={colors} title={title}>
      {levelRow}

      {/* ── What this plan does, in one sentence ── */}
      <div style={{ color: colors.text, fontSize: 11, lineHeight: 1.55 }}>
        {onTarget ? (
          <b>พอร์ตนี้ตรงตามเป้าอยู่แล้ว — ไม่ต้องทำอะไร</b>
        ) : mode === "rebalance" ? (
          <>
            <b>
              ขาย {sym}
              {fmtAmt(plan.sell_value)} แล้วเอาเงินนั้นไปซื้อ
            </b>{" "}
            →{" "}
            {own
              ? `แต่ละ${lv.unit}แบกความเสี่ยงตามเป้าที่คุณตั้ง`
              : `ทุก${lv.unit}แบกความเสี่ยงเท่ากันที่ ${p0(equal)}`}
          </>
        ) : (
          <>
            <b>
              ถ้าไม่ขายอะไรเลย ต้องใส่เงินใหม่ {sym}
              {fmtAmt(need)} ถึงจะตรงเป้า
            </b>{" "}
            (≈ {data.invested_value ? ((need / data.invested_value) * 100).toFixed(0) : "—"}%
            ของเงินที่ลงทุนอยู่) — ส่วนใหญ่ซื้อ <b>{biggestBuy.symbol}</b>
            {partial && (
              <>
                {" "}
                · แผนด้านล่างใช้เงิน{" "}
                <b>
                  {sym}
                  {fmtAmt(plan.cash ?? 0)}
                </b>{" "}
                ({(plan.fraction_pct ?? 0).toFixed(0)}% ของที่ต้องใช้) จึงไปได้แค่บางส่วน
              </>
            )}
          </>
        )}
        {!onTarget && (
          <>
            {" "}
            · {plan.top2.join(" + ")} จาก <b>{p0(plan.top2_risk_now_pct)}</b> ของความเสี่ยง เหลือ{" "}
            <b>{p0(plan.top2_risk_after_pct)}</b> · ความผันผวนพอร์ต {plan.vol_now_pct.toFixed(0)}% →{" "}
            <b>{plan.vol_after_pct.toFixed(0)}%</b> ต่อปี
          </>
        )}
      </div>

      {/* ── Whose target ── */}
      <div className="flex items-center gap-3 flex-wrap" style={{ fontSize: 9.5 }}>
        <span style={{ color: colors.textSecondary }}>เป้าความเสี่ยงของแต่ละ{lv.unit}</span>
        <button
          aria-pressed={!useOwn}
          type="button"
          onClick={() => {
            setUseOwn(false);
            setDraft(null);
          }}
          style={opt(!useOwn)}
        >
          เท่ากัน ({p0(equal)} = 100 ÷ {nParts} {lv.unit})
        </button>
        <button
          aria-pressed={useOwn}
          type="button"
          onClick={() => setUseOwn(true)}
          style={opt(useOwn)}
          title={`พิมพ์ % ที่ยอมให้แต่ละ${lv.unit}แบกในช่อง เป้าความเสี่ยง แล้วกดบันทึก — ที่เว้นว่างแบ่งส่วนที่เหลือเท่ากัน`}
        >
          กำหนดเอง
        </button>
        {useOwn && (
          <>
            <span style={{ color: setTotal > 100 ? colors.negative : colors.textSecondary }}>
              ตั้งแล้ว {setTotal.toFixed(0)}%
              {setTotal > 100
                ? " — เกิน 100%"
                : unsetCount > 0
                  ? ` · ที่เหลือ ${(100 - setTotal).toFixed(0)}% แบ่งเท่ากันให้ ${unsetCount} ${lv.unit}ที่เว้นว่าง`
                  : setTotal < 100
                    ? " · รวมไม่ถึง 100 — ใช้ตามสัดส่วนที่พิมพ์"
                    : ""}
            </span>
            <button
              type="button"
              disabled={!dirty || saving || setTotal > 100}
              onClick={() => void saveTargets(edits)}
              className="px-2 border font-bold"
              style={{
                borderColor: dirty && setTotal <= 100 ? colors.accent : colors.border,
                color: dirty && setTotal <= 100 ? colors.accent : colors.textSecondary,
              }}
            >
              {saving ? "…" : "บันทึกเป้า"}
            </button>
            {(dirty || Object.keys(saved).length > 0) && (
              <button
                type="button"
                disabled={saving}
                onClick={() => (dirty ? setDraft(null) : void saveTargets({}))}
                style={{ color: colors.textSecondary }}
                title={dirty ? "ทิ้งที่พิมพ์ไว้" : `ลบเป้าของทุก${lv.unit}ในมุมมองนี้ กลับไปเท่ากัน`}
              >
                {dirty ? "ยกเลิก" : "ล้างเป้า"}
              </button>
            )}
          </>
        )}
        {saveErr && <span style={{ color: colors.negative }}>{saveErr}</span>}
      </div>

      {/* ── add-only: how much new money ── */}
      {mode === "add" && need >= 1 && (
        <div className="flex items-center gap-3 flex-wrap" style={{ fontSize: 9.5 }}>
          <span style={{ color: colors.textSecondary }}>เงินใหม่ที่จะใส่</span>
          {FRACTIONS.map((f) => {
            const on = f === 1 ? cash == null : cash != null && Math.abs(cash - need * f) < 1;
            return (
              <button
                aria-pressed={on}
                type="button"
                key={f}
                onClick={() => setCash(f === 1 ? null : Math.round(need * f * 100) / 100)}
                style={opt(on)}
                title={`${sym}${fmtAmt(need * f)}`}
              >
                {f === 1 ? "เท่าที่ต้องใช้ (ตรงเป้าเต็ม)" : `${f * 100}% ของที่ต้องใช้`}
              </button>
            );
          })}
          <span style={{ color: colors.textSecondary }}>หรือใส่เอง {sym}</span>
          <NumInput
            value={cash ?? ""}
            aria-label={`New money to add (${currency})`}
            min={0}
            placeholder={fmtAmt(need)}
            className="w-32 text-right border px-1 outline-none"
            style={inputStyle}
            onChange={(e) => {
              const v = Number.parseFloat(e.target.value);
              setCash(Number.isFinite(v) && v > 0 ? v : null);
            }}
          />
        </div>
      )}

      {/* ── Targets per group (account / sector / thesis): set here, summed here ── */}
      {grouped && (
        <div className="overflow-x-auto" style={{ opacity: isFetching ? 0.6 : 1 }}>
          <table className="w-full tabular-nums" style={{ fontSize: 10 }}>
            <thead>
              <tr
                style={{ borderBottom: `1px solid ${colors.border}`, color: colors.textSecondary }}
              >
                <th className={`${th} text-left`}>{lv.label}</th>
                <th className={`${th} text-right`}>จำนวนหุ้นในนั้น</th>
                <th className={`${th} text-right`} title={`ส่วนของความเสี่ยงทั้งพอร์ตที่${lv.unit}นี้ควรแบก`}>
                  เป้าความเสี่ยง
                  <br />% ของทั้งพอร์ต
                </th>
                <th className={`${th} text-right`}>
                  ซื้อ / ขายสุทธิ
                  <br />({data.base_currency})
                </th>
                <th className={`${th} text-right`}>
                  สัดส่วนเงิน
                  <br />
                  ตอนนี้ → หลังทำ
                </th>
                <th className={`${th} text-right`}>
                  ส่วนแบ่งความเสี่ยง
                  <br />
                  ตอนนี้ → หลังทำ
                </th>
              </tr>
            </thead>
            <tbody>
              {plan.groups.map((g) => (
                <tr
                  key={g.key}
                  className="hover:bg-white/5"
                  style={{ borderBottom: `1px solid ${colors.border}33` }}
                >
                  <td className="px-1.5 py-1 font-bold" style={{ color: colors.text }}>
                    {g.label}
                  </td>
                  <td className="px-1.5 text-right" style={{ color: colors.textSecondary }}>
                    {g.n}
                  </td>
                  <td className="px-1.5 text-right whitespace-nowrap">
                    {useOwn ? (
                      targetInput(g.key, g.target_pct, g.label)
                    ) : (
                      <span className="font-bold" style={{ color: colors.text }}>
                        {p0(g.target_pct)}
                      </span>
                    )}
                    {useOwn && sourceNote(g.source, g.target_pct)}
                  </td>
                  <td
                    className="px-1.5 text-right font-bold"
                    style={{
                      color:
                        g.trade_value > 0.5
                          ? colors.positive
                          : g.trade_value < -0.5
                            ? colors.negative
                            : colors.textSecondary,
                    }}
                  >
                    {Math.abs(g.trade_value) < 0.5
                      ? "—"
                      : `${g.trade_value > 0 ? "ซื้อ" : "ขาย"} ${sym}${fmtAmt(Math.abs(g.trade_value))}`}
                  </td>
                  <td className="px-1.5 text-right whitespace-nowrap">
                    {nowAfter(g.weight_now_pct, g.weight_after_pct)}
                  </td>
                  <td className="px-1.5 text-right whitespace-nowrap">
                    {nowAfter(g.risk_now_pct, g.risk_after_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── The trades, every column labelled ── */}
      {!onTarget && (
        <div className="overflow-x-auto" style={{ opacity: isFetching ? 0.6 : 1 }}>
          <table className="w-full tabular-nums" style={{ fontSize: 10 }}>
            <thead>
              <tr
                style={{ borderBottom: `1px solid ${colors.border}`, color: colors.textSecondary }}
              >
                <th className={`${th} text-left`}>หุ้น</th>
                {grouped && <th className={`${th} text-left`}>{lv.label}</th>}
                <th
                  className={`${th} text-right`}
                  title={
                    grouped
                      ? `เป้าของ${lv.unit} ÷ จำนวนหุ้นใน${lv.unit}นั้น`
                      : "ส่วนของความเสี่ยงทั้งพอร์ตที่ตัวนี้ควรแบก — พิมพ์เองได้เมื่อเลือก กำหนดเอง"
                  }
                >
                  เป้าความเสี่ยง
                  <br />% ของทั้งพอร์ต
                </th>
                <th className={`${th} text-left`}>ต้องทำ</th>
                <th className={`${th} text-right`}>จำนวนหุ้น</th>
                <th className={`${th} text-right`}>เป็นเงิน ({data.base_currency})</th>
                <th className={`${th} text-right`} title="ส่วนของเงินลงทุนที่อยู่ในตัวนี้">
                  สัดส่วนเงิน
                  <br />
                  ตอนนี้ → หลังทำ
                </th>
                <th
                  className={`${th} text-right`}
                  title="ส่วนของความผันผวนพอร์ตที่มาจากตัวนี้ (รวมผลของการขยับด้วยกัน)"
                >
                  ส่วนแบ่งความเสี่ยง
                  <br />
                  ตอนนี้ → หลังทำ
                </th>
                <th className={`${th} text-left`} style={{ width: "30%", minWidth: 200 }}>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span>ส่วนแบ่งความเสี่ยง (% ของทั้งพอร์ต)</span>
                    <span className="flex items-center gap-1">{legendDot(false)} ตอนนี้</span>
                    <span className="flex items-center gap-1">{legendDot(true)} หลังทำ</span>
                    <span className="flex items-center gap-1">
                      <span
                        style={{
                          display: "inline-block",
                          width: 2,
                          height: 11,
                          background: colors.text,
                        }}
                      />
                      เป้า
                    </span>
                  </div>
                  {/* the axis, once, above the rows */}
                  <div className="relative mt-1" style={{ height: 12 }}>
                    {ticks.map((t) => (
                      <span
                        key={t}
                        className="absolute"
                        style={{
                          left: x(t),
                          transform: "translateX(-50%)",
                          fontSize: 8.5,
                          color: colors.textSecondary,
                        }}
                      >
                        {p0(t)}
                      </span>
                    ))}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((r) => {
                const act = r.trade_value > 0.5 ? "ซื้อ" : r.trade_value < -0.5 ? "ขาย" : "ไม่ต้องทำ";
                const tone =
                  act === "ซื้อ"
                    ? colors.positive
                    : act === "ขาย"
                      ? colors.negative
                      : colors.textSecondary;
                return (
                  <tr
                    key={r.key}
                    className="hover:bg-white/5"
                    style={{ borderBottom: `1px solid ${colors.border}33` }}
                    title={`${r.symbol}${r.account ? ` · ${r.account}` : ""} · ราคา ${fmtAmt(r.price)} ${r.currency}\n${act}${r.shares ? ` ${fmtQty(Math.abs(r.shares))} หุ้น` : ""} = ${sym}${fmtAmt(Math.abs(r.trade_value))}\nสัดส่วนเงิน ${r.weight_now_pct.toFixed(1)}% → ${r.weight_after_pct.toFixed(1)}%\nส่วนแบ่งความเสี่ยง ${r.risk_now_pct.toFixed(1)}% → ${r.risk_after_pct.toFixed(1)}% (เป้า ${r.target_risk_pct.toFixed(1)}%)`}
                  >
                    <td className="px-1.5 py-1 font-bold" style={{ color: colors.text }}>
                      {r.symbol}
                    </td>
                    {grouped && (
                      <td
                        className="px-1.5 truncate"
                        style={{ color: colors.textSecondary, maxWidth: 160 }}
                      >
                        {r.group_label}
                      </td>
                    )}
                    <td className="px-1.5 text-right whitespace-nowrap">
                      {useOwn && !grouped ? (
                        targetInput(r.group, r.target_risk_pct, r.symbol)
                      ) : (
                        <span className="font-bold" style={{ color: colors.text }}>
                          {p1(r.target_risk_pct)}
                        </span>
                      )}
                      {useOwn && !grouped && sourceNote(r.target_source, r.target_risk_pct)}
                    </td>
                    <td className="px-1.5 font-bold" style={{ color: tone }}>
                      {act}
                    </td>
                    <td className="px-1.5 text-right" style={{ color: colors.text }}>
                      {act === "ไม่ต้องทำ" || r.shares == null ? "—" : fmtQty(Math.abs(r.shares))}
                    </td>
                    <td className="px-1.5 text-right" style={{ color: colors.text }}>
                      {act === "ไม่ต้องทำ" ? "—" : `${sym}${fmtAmt(Math.abs(r.trade_value))}`}
                    </td>
                    <td className="px-1.5 text-right whitespace-nowrap">
                      {nowAfter(r.weight_now_pct, r.weight_after_pct)}
                    </td>
                    <td className="px-1.5 text-right whitespace-nowrap">
                      {nowAfter(r.risk_now_pct, r.risk_after_pct)}
                    </td>
                    <td className="px-1.5">
                      {riskTrack(r.risk_now_pct, r.risk_after_pct, r.target_risk_pct)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ color: colors.textSecondary }}>
                <td className="px-1.5 py-1" colSpan={grouped ? 5 : 4}>
                  รวม
                </td>
                <td className="px-1.5 text-right" style={{ color: colors.text }}>
                  ซื้อ {sym}
                  {fmtAmt(plan.buy_value)}
                  {plan.sell_value > 0.5 && (
                    <>
                      {" "}
                      · ขาย {sym}
                      {fmtAmt(plan.sell_value)}
                    </>
                  )}
                </td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div style={{ color: colors.textSecondary, opacity: 0.85, fontSize: 8.5, lineHeight: 1.5 }}>
        เป้า = ส่วนของความเสี่ยงทั้งพอร์ตที่ยอมให้แต่ละส่วนแบก: "เท่ากัน" คือ 100 ÷ จำนวน · "กำหนดเอง"
        ใช้ตัวเลขที่คุณบันทึก (เป้ารายตัว / กลุ่มธุรกิจ / thesis เป็นชุดเดียวกับหน้า BUDGET · FACTOR)
        {grouped && ` · หุ้นใน${lv.unit}เดียวกันแบ่งเป้าของ${lv.unit}เท่ากัน`} ·
        ส่วนที่ขยับสวนทางกับพอร์ตต้องใช้เงินมากกว่าจะแบกได้ถึงเป้า · คำนวณจากการขยับของราคา{" "}
        {data.lookback_days ?? "—"} วันล่าสุด ซึ่งอาจไม่เหมือนเดิมในอนาคต · ราคาวันนี้ ยังไม่ปัดตาม lot
        และไม่รวมค่าธรรมเนียม/ภาษี/ค่าโอนเงินระหว่างบัญชี · ระบบไม่ส่งคำสั่งซื้อขาย
        {!!data.excluded?.length &&
          ` · ไม่ได้คิด (ประวัติราคาสั้นไป): ${data.excluded.map((e) => e.symbol).join(", ")}`}
      </div>
    </Shell>
  );
}
