"use client";

/**
 * PORT → RISK → OVERVIEW → WHAT-IF SIM: the real book, two ways.
 *
 *   ทำ (DO)      — the ticked trades filled today at today's price (no fees),
 *                  then, if "ทำตาม stop ต่อ" is on, every stop obeyed.
 *   ไม่ทำ (DON'T) — the book exactly as it is, held.
 *
 * Both run over the same random paths for +1 / 0 / −1 / −2 SD home markets
 * ("±SD": market pinned, the band is stock-specific noise only) or for an
 * unpinned market ("สุ่ม": the band includes market risk, so P(loss) reads as
 * a chance), so the gap between the two lines is the decision and nothing else.
 * REBALANCE sends its take-profit trims here (`rebalance` + `focus`).
 * Suggested trades come from TRADE GUARD (stop hit → sell, over the 10% cap →
 * trim to the cap) and from the ERC risk-contribution signals.
 *
 * Model + caveats: backend/stop_sim.py. Endpoint: POST /api/v2/portfolio/risk/what-if-sim.
 * Palette (validated): DO blue, DON'T amber — dark #3b8fd9 / #c77700, light #2a7bc4 / #b86e00.
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from "recharts";

import { LazyResponsiveContainer as ResponsiveContainer } from "../../../ui/LazyResponsiveContainer";
import type { Colors } from "../helpers";
import { fmtAmt, fmtPx, fmtQty } from "../helpers";
import type { RebalTrade } from "./RebalancePanel";

// ── types ────────────────────────────────────────────────────────────────────

interface ModeStats {
  p10: number[];
  p50: number[];
  p90: number[];
  dd_p50: number[];
  final_p10: number;
  final_p50: number;
  final_p90: number;
  maxdd_p50: number;
  maxdd_p90: number;
  p_loss?: number;
  p_loss_gt_5?: number;
  p_loss_gt_10: number;
}

interface Scenario {
  /** null = the unpinned ("สุ่ม") run. */
  k: number | null;
  random?: boolean;
  market_move_pct: Record<string, number>;
  market_move_range?: Record<string, [number, number, number]>;
  disciplined: ModeStats; // DO
  hold: ModeStats; // DON'T
  /** Per-path DO − DON'T at the horizon, base currency (same draws both sides). */
  diff_value?: { p10: number; p50: number; p90: number };
  /** % of paths where DO ends above DON'T. */
  p_do_better?: number;
  stop_prob: Record<string, number>;
  avg_stops: number;
}

interface SimPosition {
  key: string;
  account_id: string;
  symbol: string;
  volume: number;
  price: number;
  stop: number;
  to_stop_pct: number | null;
  market_value: number;
  weight_pct: number;
  return_pct: number | null;
  flags: string[];
  override: boolean;
}

interface Suggestion {
  key: string;
  code: string;
  target_volume: number;
  text: string;
  overridden: boolean;
}

interface SimData {
  scenarios: Scenario[];
  start_value: number;
  cash: number;
  horizon: number;
  n_paths: number;
  follow_stops: boolean;
  market?: "sd" | "random";
  do_cash: number;
  do_turnover: number;
  positions: SimPosition[];
  suggestions: Suggestion[];
  holdings: {
    key: string;
    symbol: string;
    weight_pct: number;
    price: number;
    stop: number | null;
    factor: string;
    beta: number;
    resid_vol_pct: number;
  }[];
  factors: {
    key: string;
    label: string;
    daily_vol_pct: number;
    sd_horizon_pct: number;
    estimated: boolean;
  }[];
  thin_history: string[];
  note?: string;
}

/** ERC signal from /risk/metrics `trim_signals` — aggregated per symbol. */
export interface ErcSignal {
  symbol: string;
  action: "TRIM" | "BUY";
  shares_to_trim: number | null;
  shares_to_buy: number | null;
  suggested_trim_pct: number;
}

interface Pick {
  id: string;
  key: string;
  code: string;
  label: string;
  title: string;
  target: number;
  defaultOn: boolean;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const HORIZONS = [5, 20, 60] as const;
const kLabel = (k: number | null) =>
  k === null ? "สุ่ม" : k === 0 ? "0 SD" : `${k > 0 ? "+" : "−"}${Math.abs(k)} SD`;
const pct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
const money = (v: number, sym: string) => `${v >= 0 ? "+" : "-"}${sym}${fmtAmt(Math.abs(v))}`;
const CODE_LABEL: Record<string, string> = {
  STOP_HIT: "ขาย·หลุด stop",
  OVERWEIGHT: "ลด→10%",
  ERC_TRIM: "ERC ลด",
  ERC_BUY: "ERC ซื้อ",
  REBAL: "ขายทำกำไร",
};

/** Median per-path DO − DON'T; older backends only sent the two medians. */
const gapOf = (data: SimData, s: Scenario) =>
  s.diff_value?.p50 ?? (data.start_value * (s.disciplined.final_p50 - s.hold.final_p50)) / 100;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Guard suggestions + ERC signals + REBALANCE trims, spread over the accounts
 *  that hold the symbol (pro rata to shares held). */
function buildPicks(data: SimData | undefined, erc: ErcSignal[], rebal: RebalTrade[]): Pick[] {
  if (!data?.positions) return [];
  const out: Pick[] = data.suggestions.map((s) => ({
    id: `${s.key}:${s.code}`,
    key: s.key,
    code: s.code,
    label: CODE_LABEL[s.code] ?? s.code,
    title: s.overridden ? `${s.text} · คุณกด HOLD ไว้แล้ว` : s.text,
    target: s.target_volume,
    // A recorded HOLD is the user's own decision — start it unticked.
    defaultOn: !s.overridden,
  }));
  for (const e of erc) {
    const rows = data.positions.filter((p) => p.symbol === e.symbol);
    const total = rows.reduce((a, p) => a + p.volume, 0);
    const delta = e.action === "TRIM" ? -(e.shares_to_trim ?? 0) : (e.shares_to_buy ?? 0);
    if (!rows.length || total <= 0 || !delta) continue;
    for (const p of rows) {
      const code = e.action === "TRIM" ? "ERC_TRIM" : "ERC_BUY";
      out.push({
        id: `${p.key}:${code}`,
        key: p.key,
        code,
        label:
          e.action === "TRIM" ? `ERC −${e.suggested_trim_pct}%` : `ERC +${fmtQty(Math.abs(delta))}`,
        title: "ERC: ให้ทุกตัวแบกความเสี่ยงเท่ากัน (risk contribution) — ไม่ใช่กติกาของ TRADE GUARD",
        target: Math.max(0, p.volume + (delta * p.volume) / total),
        defaultOn: false,
      });
    }
  }
  for (const t of rebal) {
    const rows = data.positions.filter((p) => p.symbol.toUpperCase() === t.symbol.toUpperCase());
    const total = rows.reduce((a, p) => a + p.volume, 0);
    if (!rows.length || total <= 0 || !t.delta_shares) continue;
    for (const p of rows) {
      out.push({
        id: `${p.key}:REBAL`,
        key: p.key,
        code: "REBAL",
        label: `ขายทำกำไร −${fmtQty(Math.abs((t.delta_shares * p.volume) / total))}`,
        title: "REBALANCE: กำไรโตจนน้ำหนักเกินเป้า — ขายบางส่วนกลับเข้าสัดส่วน",
        target: Math.max(0, p.volume + (t.delta_shares * p.volume) / total),
        defaultOn: false,
      });
    }
  }
  return out;
}

// ── component ────────────────────────────────────────────────────────────────

export function WhatIfSimPanel({
  accountId,
  colors,
  erc = [],
  rebalance = [],
  focus = 0,
}: {
  accountId: string;
  colors: Colors;
  erc?: ErcSignal[];
  rebalance?: RebalTrade[];
  /** Bumped by REBALANCE "จำลองแผนนี้": tick only the REBAL picks, stops off. */
  focus?: number;
}) {
  const [horizon, setHorizon] = useState<number>(20);
  const [followStops, setFollowStops] = useState(true);
  const [market, setMarket] = useState<"sd" | "random">("sd");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [manual, setManual] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [selK, setSelK] = useState<number | null>(-2);
  const [lastData, setLastData] = useState<SimData | undefined>(undefined);
  const dark = colors.bg === "#000000";
  const C_DO = dark ? "#3b8fd9" : "#2a7bc4";
  const C_DONT = dark ? "#c77700" : "#b86e00";
  const sym = "฿";

  const picks = useMemo(() => buildPicks(lastData, erc, rebalance), [lastData, erc, rebalance]);
  const isOn = (p: Pick) => picked[p.id] ?? p.defaultOn;

  // "จำลองแผนนี้" from REBALANCE: compare the trims alone against holding —
  // every other suggestion off and stops off, so the gap is the rebalance only.
  const hasPicks = picks.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per focus bump, after picks exist
  useEffect(() => {
    if (!focus || !hasPicks) return;
    setPicked(Object.fromEntries(picks.map((p) => [p.id, p.code === "REBAL"])));
    setManual({});
    setFollowStops(false);
  }, [focus, hasPicks]);

  // key → shares after the trade. Typed qty beats ticked suggestions; among
  // ticked ones the deepest cut wins (a sell and a trim on one name = sell).
  // biome-ignore lint/correctness/useExhaustiveDependencies: isOn reads `picked`
  const target = useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of picks) {
      if (!isOn(p)) continue;
      const cur = out[p.key];
      out[p.key] = cur === undefined ? p.target : Math.min(cur, p.target);
    }
    for (const [k, v] of Object.entries(manual)) {
      const n = Number.parseFloat(v);
      if (v !== "" && Number.isFinite(n) && n >= 0) out[k] = n;
    }
    return out;
  }, [picks, picked, manual]);

  const req = useDebounced(
    JSON.stringify({
      account_id: accountId !== "all" ? accountId : null,
      horizon,
      n_paths: 1000,
      follow_stops: followStops,
      market,
      target_volume: target,
    }),
    350
  );

  const { data, isFetching, error, refetch } = useQuery<SimData>({
    queryKey: ["what-if-sim", req],
    queryFn: async () => {
      const r = await fetch("/api/v2/portfolio/risk/what-if-sim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: req,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (data?.positions) setLastData(data);
  }, [data]);

  const domains = useMemo(() => {
    if (!data?.scenarios.length) return null;
    let lo = 100;
    let hi = 100;
    let ddLo = 0;
    for (const s of data.scenarios) {
      for (const m of [s.disciplined, s.hold]) {
        for (const v of m.p10) lo = Math.min(lo, v);
        for (const v of m.p90) hi = Math.max(hi, v);
        for (const v of m.dd_p50) ddLo = Math.min(ddLo, v);
      }
    }
    const pad = (hi - lo) * 0.05 || 1;
    return {
      eq: [Math.floor(lo - pad), Math.ceil(hi + pad)] as [number, number],
      dd: [Math.floor(ddLo - 0.5), 0] as [number, number],
    };
  }, [data]);

  if (error) {
    return (
      <Shell colors={colors} title="WHAT-IF SIM">
        <span style={{ color: colors.negative }}>unavailable — {String(error)}</span>
      </Shell>
    );
  }
  if (!data || !domains) {
    return (
      <Shell colors={colors} title="WHAT-IF SIM">
        <span style={{ color: colors.textSecondary }}>
          {data?.note ??
            (market === "random" ? "running 1,000 paths…" : "running 1,000 paths × 4 scenarios…")}
        </span>
      </Shell>
    );
  }

  const random = data.market === "random";
  const sel = data.scenarios.find((s) => s.k === selK) ?? data.scenarios[0];
  const factorLabel = (key: string) => data.factors.find((f) => f.key === key)?.label ?? key;
  const posByKey = new Map(data.positions.map((p) => [p.key, p]));
  const picksByKey = new Map<string, Pick[]>();
  for (const p of picks) picksByKey.set(p.key, [...(picksByKey.get(p.key) ?? []), p]);

  // Trades implied by `target`, in base currency at today's price.
  let sold = 0;
  let bought = 0;
  for (const [k, v] of Object.entries(target)) {
    const p = posByKey.get(k);
    if (!p || p.volume <= 0) continue;
    const dv = (v / p.volume - 1) * p.market_value;
    if (dv < 0) sold -= dv;
    else bought += dv;
  }
  const changed = sold > 0 || bought > 0;

  const rows = data.positions
    .filter((p) => showAll || picksByKey.has(p.key) || p.key in manual || p.key in target)
    .sort((a, b) => (picksByKey.has(b.key) ? 1 : 0) - (picksByKey.has(a.key) ? 1 : 0));
  const hidden = data.positions.length - rows.length;

  const set = (id: string, on: boolean) => setPicked((s) => ({ ...s, [id]: on }));
  const allOff = () => setPicked(Object.fromEntries(picks.map((p) => [p.id, false])));
  const reset = () => {
    setPicked({});
    setManual({});
  };

  const iStyle = { background: "transparent", color: colors.text, borderColor: colors.border };
  const hd = (h: string, right = true, title?: string) => (
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
    <Shell
      colors={colors}
      title="WHAT-IF SIM · ทำ vs ไม่ทำ"
      right={
        <>
          <span style={{ color: colors.textSecondary }}>ตลาด</span>
          {(
            [
              [
                "sd",
                "±SD",
                "บังคับให้ตลาดจบที่ +1 / 0 / −1 / −2 SD — ตอบว่า 'ถ้าตลาดเป็นแบบนี้ พอร์ตจะเป็นยังไง'",
              ],
              ["random", "สุ่ม", "ตลาดสุ่มเองตามความผันผวนจริง ไม่บังคับปลายทาง — ตอบว่า 'มีโอกาสขาดทุนแค่ไหน'"],
            ] as const
          ).map(([m, label, title]) => (
            <button
              aria-pressed={market === m}
              type="button"
              key={m}
              title={title}
              onClick={() => setMarket(m)}
              style={{
                color: market === m ? colors.accent : colors.textSecondary,
                textDecoration: market === m ? "underline" : "none",
              }}
            >
              {label}
            </button>
          ))}
          <span style={{ color: colors.textSecondary }}>horizon</span>
          {HORIZONS.map((h) => (
            <button
              aria-pressed={horizon === h}
              type="button"
              key={h}
              onClick={() => setHorizon(h)}
              style={{
                color: horizon === h ? colors.accent : colors.textSecondary,
                textDecoration: horizon === h ? "underline" : "none",
              }}
            >
              {h}D
            </button>
          ))}
          <label className="flex items-center gap-1 cursor-pointer" style={{ color: colors.text }}>
            <input
              type="checkbox"
              checked={followStops}
              onChange={(e) => setFollowStops(e.target.checked)}
            />
            ทำตาม stop ต่อ
          </label>
          <span className="flex items-center gap-1">
            <span style={{ width: 12, height: 2, background: C_DO, display: "inline-block" }} />
            <span style={{ color: colors.text }}>ทำ</span>
          </span>
          <span className="flex items-center gap-1">
            <span style={{ width: 12, height: 2, background: C_DONT, display: "inline-block" }} />
            <span style={{ color: colors.text }}>ไม่ทำ (ถือเหมือนเดิม)</span>
          </span>
          <button type="button" onClick={() => refetch()} style={{ color: colors.textSecondary }}>
            {isFetching ? "running…" : "RERUN"}
          </button>
        </>
      }
    >
      {/* Headline: the selected scenario, both ways */}
      <div className="flex gap-x-5 gap-y-1 flex-wrap items-baseline">
        <span style={{ color: colors.textSecondary }}>
          {random ? "ตลาดสุ่ม" : `ตลาด ${kLabel(sel.k)}`} ใน {data.horizon} วันทำการ · พอร์ต {sym}
          {fmtAmt(data.start_value)}
        </span>
        <span>
          <span style={{ color: colors.textSecondary }}>ทำ </span>
          <span className="tabular-nums font-bold" style={{ color: C_DO, fontSize: 13 }}>
            {pct(sel.disciplined.final_p50)}
          </span>
          <span className="tabular-nums" style={{ color: colors.textSecondary }}>
            {" "}
            ({money((data.start_value * sel.disciplined.final_p50) / 100, sym)}) · DD{" "}
            {pct(sel.disciplined.maxdd_p50)}
            {random &&
              sel.disciplined.p_loss != null &&
              ` · P(ขาดทุน) ${sel.disciplined.p_loss.toFixed(0)}%`}
          </span>
        </span>
        <span>
          <span style={{ color: colors.textSecondary }}>ไม่ทำ </span>
          <span className="tabular-nums font-bold" style={{ color: C_DONT, fontSize: 13 }}>
            {pct(sel.hold.final_p50)}
          </span>
          <span className="tabular-nums" style={{ color: colors.textSecondary }}>
            {" "}
            ({money((data.start_value * sel.hold.final_p50) / 100, sym)}) · DD{" "}
            {pct(sel.hold.maxdd_p50)}
            {random && sel.hold.p_loss != null && ` · P(ขาดทุน) ${sel.hold.p_loss.toFixed(0)}%`}
          </span>
        </span>
        <span className="font-bold" style={{ color: colors.text }}>
          ทำ − ไม่ทำ ≈ {money(gapOf(data, sel), sym)}
          {sel.diff_value && (
            <span className="font-normal" style={{ color: colors.textSecondary }}>
              {" "}
              (p10 {money(sel.diff_value.p10, sym)} · p90 {money(sel.diff_value.p90, sym)}
              {sel.p_do_better != null && ` · ทำดีกว่า ${sel.p_do_better.toFixed(0)}% ของเส้นทาง`})
            </span>
          )}
        </span>
        <span style={{ color: colors.textSecondary }}>
          {changed ? (
            <>
              เทรดวันนี้: ขาย {sym}
              {fmtAmt(sold)} · ซื้อ {sym}
              {fmtAmt(bought)} · เงินสดหลังทำ{" "}
              <span style={{ color: data.do_cash < 0 ? colors.negative : colors.text }}>
                {sym}
                {fmtAmt(data.do_cash)}
              </span>
              {data.do_cash < 0 && " (ติดลบ — ต้องหาเงินเพิ่ม)"}
            </>
          ) : followStops ? (
            "ไม่มีเทรดวันนี้ — ต่างกันที่การทำตาม stop อย่างเดียว"
          ) : (
            "ยังไม่ได้เลือก action — สองเส้นเท่ากัน"
          )}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        {/* ── Actions ── */}
        <div className="min-w-0">
          <div className="flex items-baseline gap-3 mb-0.5" style={{ fontSize: 9 }}>
            <span style={{ color: colors.textSecondary }}>
              ACTION บนหุ้นที่ถือ — ติ๊กคำแนะนำ หรือพิมพ์จำนวนหุ้นหลังทำเอง
            </span>
            <button type="button" onClick={allOff} style={{ color: colors.textSecondary }}>
              ไม่ติ๊กเลย
            </button>
            <button type="button" onClick={reset} style={{ color: colors.textSecondary }}>
              ค่าเริ่มต้น
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full tabular-nums" style={{ fontSize: 9.5 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {hd("SYMBOL", false)}
                  {hd("W%")}
                  {hd("TO STOP", true, "ราคาห่างจาก stop — ติดลบ = หลุดแล้ว")}
                  {hd("คำแนะนำ", false)}
                  {hd("ถืออยู่")}
                  {hd("หลังทำ")}
                  {hd("Δ มูลค่า")}
                  {followStops && hd(`P(stop) ${kLabel(sel.k)}`, true, "โอกาสโดน stop ในฝั่ง 'ทำ'")}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const ps = picksByKey.get(p.key) ?? [];
                  const tgt = target[p.key];
                  const after = tgt ?? p.volume;
                  const dv = p.volume > 0 ? (after / p.volume - 1) * p.market_value : 0;
                  const prob = sel.stop_prob[p.key];
                  return (
                    <tr key={p.key} style={{ borderBottom: `1px solid ${colors.border}33` }}>
                      <td className="px-1 py-0.5 whitespace-nowrap">
                        <span
                          className="font-bold"
                          style={{
                            color: p.flags.includes("STOP_HIT") ? colors.negative : colors.text,
                          }}
                        >
                          {p.symbol}
                        </span>
                        <span className="ml-1" style={{ color: colors.textSecondary, fontSize: 8 }}>
                          {p.account_id}
                        </span>
                      </td>
                      <td
                        className="px-1 text-right"
                        style={{ color: p.weight_pct > 10 ? "#FFB300" : colors.text }}
                      >
                        {p.weight_pct.toFixed(1)}
                      </td>
                      <td
                        className="px-1 text-right"
                        style={{
                          color:
                            p.to_stop_pct == null
                              ? colors.textSecondary
                              : p.to_stop_pct <= 0
                                ? colors.negative
                                : p.to_stop_pct < 3
                                  ? "#FFB300"
                                  : colors.textSecondary,
                        }}
                      >
                        {p.to_stop_pct == null ? "—" : pct(p.to_stop_pct)}
                      </td>
                      <td className="px-1">
                        <div className="flex flex-wrap gap-x-2">
                          {ps.map((x) => (
                            <label
                              key={x.id}
                              className="flex items-center gap-0.5 cursor-pointer whitespace-nowrap"
                              title={x.title}
                              style={{ color: isOn(x) ? colors.text : colors.textSecondary }}
                            >
                              <input
                                type="checkbox"
                                checked={isOn(x)}
                                disabled={p.key in manual}
                                onChange={(e) => set(x.id, e.target.checked)}
                              />
                              {x.label}
                            </label>
                          ))}
                        </div>
                      </td>
                      <td className="px-1 text-right" style={{ color: colors.textSecondary }}>
                        {fmtQty(p.volume)}
                      </td>
                      <td className="px-1 text-right">
                        <input
                          type="number"
                          min={0}
                          step="any"
                          className="w-20 text-right border px-1 outline-none"
                          style={{
                            ...iStyle,
                            color:
                              tgt !== undefined && Math.abs(tgt - p.volume) > 1e-9
                                ? C_DO
                                : colors.text,
                          }}
                          placeholder={fmtQty(Number(after.toFixed(7)))}
                          value={manual[p.key] ?? ""}
                          title="พิมพ์จำนวนหุ้นหลังทำ (0 = ขายหมด) — ว่าง = ใช้คำแนะนำที่ติ๊ก"
                          onChange={(e) => setManual((m) => ({ ...m, [p.key]: e.target.value }))}
                          onBlur={(e) => {
                            if (e.target.value === "")
                              setManual((m) => {
                                const { [p.key]: _, ...rest } = m;
                                return rest;
                              });
                          }}
                        />
                      </td>
                      <td
                        className="px-1 text-right"
                        style={{
                          color:
                            Math.abs(dv) < 0.005 ? colors.textSecondary : dv < 0 ? C_DONT : C_DO,
                        }}
                      >
                        {Math.abs(dv) < 0.005 ? "—" : money(dv, sym)}
                      </td>
                      {followStops && (
                        <td
                          className="px-1 text-right"
                          style={{
                            color:
                              prob == null
                                ? colors.textSecondary
                                : prob >= 50
                                  ? colors.negative
                                  : prob >= 20
                                    ? "#FFB300"
                                    : colors.textSecondary,
                          }}
                        >
                          {prob == null ? "—" : `${prob.toFixed(0)}%`}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button
            aria-pressed={showAll}
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="mt-0.5"
            style={{ color: colors.accent, fontSize: 9 }}
          >
            {showAll ? "▾ แสดงเฉพาะตัวที่มีคำแนะนำ" : `▸ แสดงทุกตัว (+${hidden}) เพื่อแก้จำนวนเอง`}
          </button>
        </div>

        {/* ── Results ── */}
        <div className="min-w-0 flex flex-col gap-1">
          {random ? (
            <div style={{ color: colors.textSecondary, fontSize: 9 }}>
              ตลาดใน {data.horizon} วัน (p10 / กลาง / p90):{" "}
              {Object.entries(sel.market_move_range ?? {})
                .map(
                  ([k, [lo, mid, hi]]) => `${factorLabel(k)} ${pct(lo)} / ${pct(mid)} / ${pct(hi)}`
                )
                .join(" · ")}
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-1">
              {data.scenarios.map((s) => (
                <button
                  aria-pressed={selK === s.k}
                  type="button"
                  key={String(s.k)}
                  onClick={() => setSelK(s.k)}
                  className="text-left px-1 py-0.5"
                  style={{
                    borderBottom: `2px solid ${s.k === sel.k ? colors.accent : "transparent"}`,
                  }}
                  title={Object.entries(s.market_move_pct)
                    .map(([k, v]) => `${factorLabel(k)} ${pct(v)}`)
                    .join(" · ")}
                >
                  <div
                    style={{
                      color:
                        (s.k ?? 0) < 0
                          ? colors.negative
                          : (s.k ?? 0) > 0
                            ? colors.positive
                            : colors.text,
                      fontWeight: 700,
                      fontSize: 9,
                    }}
                  >
                    ตลาด {kLabel(s.k)}
                  </div>
                  <div className="tabular-nums" style={{ fontSize: 9 }}>
                    <span style={{ color: C_DO }}>{pct(s.disciplined.final_p50)}</span>
                    <span style={{ color: colors.textSecondary }}> / </span>
                    <span style={{ color: C_DONT }}>{pct(s.hold.final_p50)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
          <ScenarioChart s={sel} domains={domains} colors={colors} cDo={C_DO} cDont={C_DONT} />
          <SummaryTable data={data} colors={colors} cDo={C_DO} cDont={C_DONT} sym={sym} />
        </div>
      </div>

      <div className="flex gap-3 items-baseline flex-wrap" style={{ fontSize: 9 }}>
        <button
          aria-pressed={showModel}
          type="button"
          onClick={() => setShowModel((v) => !v)}
          style={{ color: colors.accent }}
        >
          {showModel ? "▾ HIDE MODEL" : "▸ MODEL INPUTS"}
        </button>
        {data.thin_history.length > 0 && (
          <span style={{ color: "#B06000" }}>
            ประวัติไม่พอ (ใช้ β 1, vol 2%): {data.thin_history.join(", ")}
          </span>
        )}
        <span style={{ color: colors.textSecondary, opacity: 0.75 }}>
          จำลองจากพอร์ตจริง (จำนวนหุ้น ราคา stop และเงินสดวันนี้) แบบ Monte Carlo · หุ้น = β × ตลาดบ้าน
          (S&amp;P 500 / SET50 / BTC / ทอง) + ส่วนเฉพาะตัวหางอ้วน (t df 4) ·{" "}
          {random
            ? "ตลาดสุ่มเอง (ไม่มี drift) — แถบรวมความเสี่ยงตลาดแล้ว"
            : "ตลาดถูกบังคับจบที่ k SD — แถบคือความผันผวนเฉพาะตัวหุ้นเท่านั้น ไม่ใช่โอกาสขาดทุน"}{" "}
          · หุ้นตลาดเดียวกันขยับร่วมกันผ่านดัชนีเท่านั้น (กลุ่มเดียวกันอาจเสี่ยงกว่าที่เห็น) · เทรด "ทำ" ที่ราคาวันนี้
          ไม่รวมค่าธรรมเนียม · เงินสด 0% · ค่าเงินคงที่ · {data.n_paths.toLocaleString()} เส้นทาง · β/vol
          ย้อนหลัง ~1 ปี · ภาพประกอบการตัดสินใจ ไม่ใช่การพยากรณ์
        </span>
      </div>
      {showModel && <ModelTable data={data} colors={colors} factorLabel={factorLabel} />}
    </Shell>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────

export function Shell({
  colors,
  title,
  right,
  children,
}: {
  colors: Colors;
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded p-2 flex flex-col gap-1.5 font-mono"
      style={{ border: `1px solid ${colors.border}`, fontSize: 10 }}
    >
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="font-bold" style={{ color: colors.accent, letterSpacing: "0.08em" }}>
          {title}
        </span>
        <div className="flex items-baseline gap-3 flex-wrap ml-auto" style={{ fontSize: 9 }}>
          {right}
        </div>
      </div>
      {children}
    </div>
  );
}

// memo: typing a quantity re-renders the panel; the charts only change with the sim result.
const ScenarioChart = memo(function ScenarioChart({
  s,
  domains,
  colors,
  cDo,
  cDont,
}: {
  s: Scenario;
  domains: { eq: [number, number]; dd: [number, number] };
  colors: Colors;
  cDo: string;
  cDont: string;
}) {
  const rows = useMemo(
    () =>
      s.disciplined.p50.map((_, d) => ({
        d,
        doV: s.disciplined.p50[d],
        dontV: s.hold.p50[d],
        doBand: [s.disciplined.p10[d], s.disciplined.p90[d]],
        dontBand: [s.hold.p10[d], s.hold.p90[d]],
        doDd: s.disciplined.dd_p50[d],
        dontDd: s.hold.dd_p50[d],
      })),
    [s]
  );
  const grid = colors.border;
  const axis = { fill: colors.textSecondary, fontSize: 8.5 };
  const tip = ({ active, payload, label }: TooltipProps<number, string>) => {
    if (!active || !payload?.length) return null;
    const r = payload[0].payload as (typeof rows)[number];
    return (
      <div
        className="font-mono px-2 py-1"
        style={{ background: colors.surface, border: `1px solid ${colors.border}`, fontSize: 9 }}
      >
        <div style={{ color: colors.textSecondary }}>วันที่ {label}</div>
        <div style={{ color: colors.text }}>
          <span style={{ color: cDo }}>●</span> ทำ {pct(r.doV - 100, 2)} · DD {pct(r.doDd, 2)}
        </div>
        <div style={{ color: colors.text }}>
          <span style={{ color: cDont }}>●</span> ไม่ทำ {pct(r.dontV - 100, 2)} · DD{" "}
          {pct(r.dontDd, 2)}
        </div>
      </div>
    );
  };
  return (
    <div>
      <div style={{ height: 140 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={grid} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="d" hide />
            <YAxis
              domain={domains.eq}
              tick={axis}
              tickLine={false}
              axisLine={false}
              width={34}
              tickFormatter={(v: number) => `${(v - 100).toFixed(0)}%`}
            />
            <ReferenceLine y={100} stroke={colors.textDimmed} strokeDasharray="3 3" />
            <Area
              dataKey="dontBand"
              stroke="none"
              fill={cDont}
              fillOpacity={0.14}
              isAnimationActive={false}
            />
            <Area
              dataKey="doBand"
              stroke="none"
              fill={cDo}
              fillOpacity={0.18}
              isAnimationActive={false}
            />
            <Line
              dataKey="dontV"
              stroke={cDont}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="doV"
              stroke={cDo}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Tooltip content={tip} cursor={{ stroke: colors.textSecondary, strokeWidth: 1 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div style={{ height: 56 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 2, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={grid} strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="d"
              tick={axis}
              tickLine={false}
              axisLine={{ stroke: grid }}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={domains.dd}
              tick={axis}
              tickLine={false}
              axisLine={false}
              width={34}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
            />
            <Line
              dataKey="dontDd"
              stroke={cDont}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="doDd"
              stroke={cDo}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Tooltip content={tip} cursor={{ stroke: colors.textSecondary, strokeWidth: 1 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div style={{ color: colors.textSecondary, fontSize: 8 }}>
        บน = มูลค่าพอร์ต (เส้น median · แถบ p10–p90) · ล่าง = drawdown median · แกน x = วันทำการ
      </div>
    </div>
  );
});

const SummaryTable = memo(function SummaryTable({
  data,
  colors,
  cDo,
  cDont,
  sym,
}: {
  data: SimData;
  colors: Colors;
  cDo: string;
  cDont: string;
  sym: string;
}) {
  const th = (key: string, h: string, color?: string) => (
    <th
      key={key}
      className="text-right font-normal px-1"
      style={{ color: color ?? colors.textSecondary }}
    >
      {h}
    </th>
  );
  const td = (v: string, color?: string) => (
    <td className="text-right px-1" style={{ color: color ?? colors.text }}>
      {v}
    </td>
  );
  return (
    <table className="w-full tabular-nums" style={{ fontSize: 9 }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
          <th className="text-left font-normal px-1" style={{ color: colors.textSecondary }}>
            ตลาด
          </th>
          {th("do-med", "ทำ med", cDo)}
          {th("do-p10", "p10", cDo)}
          {th("do-dd", "DD p90", cDo)}
          {th("dont-med", "ไม่ทำ med", cDont)}
          {th("dont-p10", "p10", cDont)}
          {th("dont-dd", "DD p90", cDont)}
          {th("diff", "ต่าง (med)")}
          {data.market === "random" && th("ploss", "P(ขาดทุน) ทำ / ไม่ทำ")}
        </tr>
      </thead>
      <tbody>
        {data.scenarios.map((s) => {
          const diff = gapOf(data, s);
          return (
            <tr key={String(s.k)}>
              <td className="px-1" style={{ color: colors.text }}>
                {kLabel(s.k)}
              </td>
              {td(pct(s.disciplined.final_p50))}
              {td(pct(s.disciplined.final_p10), colors.textSecondary)}
              {td(pct(s.disciplined.maxdd_p90), colors.textSecondary)}
              {td(pct(s.hold.final_p50))}
              {td(pct(s.hold.final_p10), colors.textSecondary)}
              {td(pct(s.hold.maxdd_p90), colors.textSecondary)}
              {td(money(diff, sym), diff >= 0 ? colors.positive : colors.negative)}
              {data.market === "random" &&
                td(
                  `${s.disciplined.p_loss?.toFixed(0) ?? "—"}% / ${s.hold.p_loss?.toFixed(0) ?? "—"}%`
                )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
});

function ModelTable({
  data,
  colors,
  factorLabel,
}: {
  data: SimData;
  colors: Colors;
  factorLabel: (k: string) => string;
}) {
  return (
    <div className="flex gap-6 flex-wrap items-start" style={{ fontSize: 9 }}>
      <div className="grid gap-x-3" style={{ gridTemplateColumns: "repeat(4, auto)" }}>
        {["FACTOR", "σ/วัน", `1 SD ${data.horizon}D`, ""].map((h) => (
          <span key={h} style={{ color: colors.textSecondary, fontSize: 8.5 }}>
            {h}
          </span>
        ))}
        {data.factors.map((f) => (
          <div key={f.key} className="contents">
            <span style={{ color: colors.text }}>{f.label}</span>
            <span className="tabular-nums">{f.daily_vol_pct.toFixed(2)}%</span>
            <span className="tabular-nums">±{f.sd_horizon_pct.toFixed(1)}%</span>
            <span style={{ color: "#B06000" }}>{f.estimated ? "" : "สมมติ 1.5%"}</span>
          </div>
        ))}
      </div>
      <div className="grid gap-x-3" style={{ gridTemplateColumns: "repeat(6, auto)" }}>
        {["SYMBOL", "WEIGHT", "FACTOR", "β", "σ เฉพาะตัว/วัน", "STOP"].map((h) => (
          <span key={h} style={{ color: colors.textSecondary, fontSize: 8.5 }}>
            {h}
          </span>
        ))}
        {data.holdings.map((h) => (
          <div key={h.key} className="contents">
            <span style={{ color: colors.text }}>{h.symbol}</span>
            <span className="tabular-nums">{h.weight_pct.toFixed(1)}%</span>
            <span>{factorLabel(h.factor)}</span>
            <span className="tabular-nums">{h.beta.toFixed(2)}</span>
            <span className="tabular-nums">{h.resid_vol_pct.toFixed(2)}%</span>
            <span className="tabular-nums">
              {h.stop == null
                ? "—"
                : `${fmtPx(h.stop)} (${((h.stop / h.price - 1) * 100).toFixed(1)}%)`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
