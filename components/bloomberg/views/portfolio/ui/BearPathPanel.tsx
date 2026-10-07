"use client";

/**
 * PORT → RISK: "what if the next days hold more losing days than winning ones?"
 *
 * The book as held, run through random paths in which losing days outnumber
 * winning days, at 3 / 5 / 7 / 21 / 42 trading days. Not every day falls and a
 * path can still end up — the tilt is on how often, not on every step. A
 * neutral run (no tilt) sits beside each horizon so the cost of the tilt reads
 * directly. A stress, not a forecast.
 *
 * Two faces of one query:
 *   <BearPathStrip/>  one line per horizon — lives on the RISK summary page
 *   <BearPathPanel/>  the table, the 2-month fan and who carries the loss
 *
 * Model: backend/bear_paths.py. Endpoint: GET /api/v2/portfolio/risk/bear-paths.
 * Palette: the MONTE CARLO pair — blue = neutral, amber = the down-tilted run.
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { LazyResponsiveContainer as ResponsiveContainer } from "../../../ui/LazyResponsiveContainer";
import type { Colors } from "../helpers";
import { fmtAmt } from "../helpers";
import { Shell } from "./WhatIfSimPanel";

interface BearHorizon {
  days: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  mean: number;
  p_loss: number;
  p_end_up: number;
  loss_prob: { worse_than_pct: number; prob_pct: number }[];
  max_dd_p50: number;
  max_dd_p95: number;
  amount_p50: number;
  amount_p5: number;
  base: { p5: number; p50: number; p95: number; p_loss: number; max_dd_p50: number };
  holdings: { symbol: string; contrib_pct: number; ret_p50: number }[];
}

export interface BearData {
  p_down: number;
  n_paths: number;
  down_days_in_window: number;
  up_days_in_window: number;
  avg_down_day_pct: number;
  avg_up_day_pct: number;
  horizons: BearHorizon[];
  fan?: {
    days: number[];
    p5: number[];
    p50: number[];
    p95: number[];
    base_p5: number[];
    base_p50: number[];
  };
  nav?: number;
  window_days?: number;
  window_from?: string;
  as_of?: string;
  excluded?: { symbol: string; weight_pct?: number }[];
  note?: string;
  error?: string;
}

const STORE_KEY = "bloomberg_port_bear";
/** Chance that a day is a losing day for the book. 50% still tilts: every path
 *  must hold more losing days than winning ones. */
const TILTS = [
  [0.55, "55%", "เอียงเบา"],
  [0.6, "60%", "ค่าเริ่มต้น — วันลง 6 ใน 10"],
  [0.7, "70%", "ขาลงชัด — วันลง 7 ใน 10"],
  [0.8, "80%", "ขาลงหนัก — วันลง 8 ใน 10"],
] as const;

const HORIZON_LABEL: Record<number, string> = {
  3: "3 วัน",
  5: "5 วัน",
  7: "7 วัน",
  21: "21 วัน · 1 เดือน",
  42: "42 วัน · 2 เดือน",
};

const pct = (v: number, d = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`;
const money = (v: number, sym: string) => `${v >= 0 ? "+" : "−"}${sym}${fmtAmt(Math.abs(v))}`;

function loadTilt(): number {
  if (typeof window === "undefined") return 0.6;
  try {
    const v = Number.parseFloat(localStorage.getItem(STORE_KEY) ?? "");
    if (TILTS.some(([t]) => t === v)) return v;
  } catch {
    /* ignore */
  }
  return 0.6;
}

/** The tilt is shared by the strip and the panel: one choice, one query. */
export function useBearTilt(): [number, (v: number) => void] {
  const [tilt, setTilt] = useState<number>(loadTilt);
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, String(tilt));
    } catch {
      /* ignore */
    }
  }, [tilt]);
  return [tilt, setTilt];
}

export function useBearPaths(accountId: string, currency: "THB" | "USD", tilt: number) {
  return useQuery<BearData>({
    queryKey: ["risk-bear-paths", accountId, currency, tilt],
    queryFn: async () => {
      const qs = new URLSearchParams({ p_down: String(tilt), base_currency: currency });
      if (accountId !== "all") qs.set("account_id", accountId);
      const r = await fetch(`/api/v2/portfolio/risk/bear-paths?${qs}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

function TiltPicker({
  tilt,
  onTilt,
  colors,
}: { tilt: number; onTilt: (v: number) => void; colors: Colors }) {
  return (
    <>
      <span
        style={{ color: colors.textSecondary }}
        title="โอกาสที่แต่ละวันเป็นวันที่พอร์ตติดลบ — ทุกเส้นทางถูกบังคับให้มีวันลงมากกว่าวันขึ้นเสมอ"
      >
        โอกาสวันลง
      </span>
      {TILTS.map(([v, label, title]) => (
        <button
          aria-pressed={tilt === v}
          type="button"
          key={v}
          title={title}
          onClick={() => onTilt(v)}
          style={{
            color: tilt === v ? colors.accent : colors.textSecondary,
            textDecoration: tilt === v ? "underline" : "none",
          }}
        >
          {label}
        </button>
      ))}
    </>
  );
}

// ── compact strip for the summary page ───────────────────────────────────────

export function BearPathStrip({
  accountId,
  currency,
  colors,
  tilt,
  onTilt,
  onOpen,
}: {
  accountId: string;
  currency: "THB" | "USD";
  colors: Colors;
  tilt: number;
  onTilt: (v: number) => void;
  onOpen?: () => void;
}) {
  const { data, error, isFetching } = useBearPaths(accountId, currency, tilt);
  const sym = currency === "THB" ? "฿" : "$";
  const TAIL = colors.bg === "#000000" ? "#c77700" : "#b86e00";

  return (
    <Shell
      colors={colors}
      title="ถ้าตลาดลงมากกว่าขึ้นติดต่อกัน"
      right={
        <>
          <TiltPicker tilt={tilt} onTilt={onTilt} colors={colors} />
          {onOpen && (
            <button type="button" onClick={onOpen} style={{ color: colors.accent }}>
              รายละเอียด →
            </button>
          )}
        </>
      }
    >
      {error ? (
        <span style={{ color: colors.negative }}>คำนวณไม่ได้ — {String(error)}</span>
      ) : !data ? (
        <span style={{ color: colors.textSecondary }}>กำลังจำลองเส้นทางขาลง…</span>
      ) : !data.horizons?.length ? (
        <span style={{ color: colors.textSecondary }}>
          {data.note ?? data.error ?? "ไม่มีสถานะให้จำลอง"}
        </span>
      ) : (
        <>
          <div
            className="grid gap-x-4 gap-y-2"
            style={{
              gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))",
              opacity: isFetching ? 0.6 : 1,
            }}
          >
            {data.horizons.map((h) => (
              <div
                key={h.days}
                className="min-w-0"
                title={`${HORIZON_LABEL[h.days] ?? `${h.days} วัน`}\nกลางๆ ${pct(h.p50)} · แย่ 5% ${pct(h.p5)} · ดี 5% ${pct(h.p95)}\nโอกาสจบติดลบ ${h.p_loss.toFixed(0)}% · ระหว่างทางลงลึกสุด (กลางๆ) ${pct(h.max_dd_p50)}\nถ้าไม่เอียง: กลางๆ ${pct(h.base.p50)}`}
              >
                <div style={{ color: colors.textSecondary, fontSize: 8.5 }}>
                  {HORIZON_LABEL[h.days] ?? `${h.days} วัน`}
                </div>
                <div
                  className="tabular-nums font-bold whitespace-nowrap"
                  style={{ color: h.p50 < 0 ? colors.negative : colors.text, fontSize: 13 }}
                >
                  {pct(h.p50)}
                </div>
                <div
                  className="tabular-nums whitespace-nowrap"
                  style={{ color: colors.text, fontSize: 9 }}
                >
                  {money(h.amount_p50, sym)}
                </div>
                <div
                  className="tabular-nums whitespace-nowrap"
                  style={{ color: TAIL, fontSize: 9 }}
                >
                  แย่ 5% {pct(h.p5)}
                </div>
              </div>
            ))}
          </div>
          <div style={{ color: colors.textSecondary, opacity: 0.8, fontSize: 8.5 }}>
            ตัวใหญ่ = ผลกลางๆ ของพอร์ตที่ถืออยู่ตอนนี้ ถ้าช่วงนั้นวันลงมากกว่าวันขึ้น (สุ่มจากวันจริงในอดีต{" "}
            {data.window_days} วัน) · ไม่ใช่การพยากรณ์ · ไม่รวม stop / การขาย
          </div>
        </>
      )}
    </Shell>
  );
}

// ── full panel ───────────────────────────────────────────────────────────────

export function BearPathPanel({
  accountId,
  currency,
  colors,
  tilt,
  onTilt,
}: {
  accountId: string;
  currency: "THB" | "USD";
  colors: Colors;
  tilt: number;
  onTilt: (v: number) => void;
}) {
  const { data, error, isFetching } = useBearPaths(accountId, currency, tilt);
  const [showModel, setShowModel] = useState(false);
  const sym = currency === "THB" ? "฿" : "$";
  const dark = colors.bg === "#000000";
  const C_BASE = dark ? "#3b8fd9" : "#2a7bc4";
  const C_TILT = dark ? "#c77700" : "#b86e00";

  const right = (
    <>
      <TiltPicker tilt={tilt} onTilt={onTilt} colors={colors} />
      <button
        aria-pressed={showModel}
        type="button"
        onClick={() => setShowModel((v) => !v)}
        style={{ color: colors.accent }}
      >
        {showModel ? "▾ วิธีคิด" : "▸ วิธีคิด"}
      </button>
    </>
  );
  const title = "เส้นทางขาลง · วันลงมากกว่าวันขึ้น 3 / 5 / 7 / 21 วัน / 2 เดือน";

  if (error)
    return (
      <Shell colors={colors} title={title} right={right}>
        <span style={{ color: colors.negative }}>คำนวณไม่ได้ — {String(error)}</span>
      </Shell>
    );
  if (!data)
    return (
      <Shell colors={colors} title={title} right={right}>
        <span style={{ color: colors.textSecondary }}>กำลังจำลองเส้นทางขาลง…</span>
      </Shell>
    );
  if (!data.horizons?.length)
    return (
      <Shell colors={colors} title={title} right={right}>
        <span style={{ color: colors.textSecondary }}>
          {data.note ?? data.error ?? "ไม่มีสถานะให้จำลอง"}
        </span>
      </Shell>
    );

  const fan = data.fan;
  const chart = fan
    ? fan.days.map((d, i) => ({
        d,
        band: [fan.p5[i], fan.p95[i]] as [number, number],
        p50: fan.p50[i],
        base: fan.base_p50[i],
        base5: fan.base_p5[i],
      }))
    : [];
  const lo = fan ? Math.min(...fan.p5, ...fan.base_p5) : 90;
  const hi = fan ? Math.max(...fan.p95) : 110;
  const pad = (hi - lo) * 0.06 || 1;
  const th = (h: string, title?: string, left = false) => (
    <th
      key={h}
      title={title}
      className={`${left ? "text-left" : "text-right"} font-normal px-1 py-0.5 whitespace-nowrap`}
      style={{ color: colors.textSecondary }}
    >
      {h}
    </th>
  );
  const last = data.horizons[data.horizons.length - 1];

  return (
    <Shell colors={colors} title={title} right={right}>
      <div style={{ color: colors.textSecondary, fontSize: 9.5, lineHeight: 1.5 }}>
        พอร์ตที่ถืออยู่ตอนนี้ (ไม่ซื้อ ไม่ขาย) ผ่านเส้นทางสุ่ม {data.n_paths.toLocaleString("en-US")} เส้นต่อช่วง ·
        แต่ละวันมีโอกาส <b style={{ color: colors.text }}>{(data.p_down * 100).toFixed(0)}%</b>{" "}
        เป็นวันที่พอร์ตติดลบ และทุกเส้น<b style={{ color: colors.text }}>ต้องมีวันลงมากกว่าวันขึ้น</b> — ไม่ได้ลงทุกวัน
        บางเส้นยังจบบวกได้ · วันลงเฉลี่ย {pct(data.avg_down_day_pct, 2)} · วันขึ้นเฉลี่ย{" "}
        {pct(data.avg_up_day_pct, 2)}
      </div>

      <div className="overflow-x-auto" style={{ opacity: isFetching ? 0.6 : 1 }}>
        <table className="w-full tabular-nums" style={{ fontSize: 9.5 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              {th("ช่วง", "วันทำการ", true)}
              {th("กลางๆ", "ครึ่งหนึ่งของเส้นทางจบแย่กว่านี้")}
              {th("เป็นเงิน", "ผลกลางๆ เป็นเงิน")}
              {th("แย่ 5%", "1 ใน 20 เส้นทางจบแย่กว่านี้")}
              {th("เป็นเงิน ", "ผลแย่ 5% เป็นเงิน")}
              {th("ดี 5%", "1 ใน 20 เส้นทางจบดีกว่านี้ — แม้วันลงจะมากกว่า")}
              {th("จบติดลบ", "ส่วนของเส้นทางที่จบต่ำกว่าวันนี้")}
              {th("< −10%", "โอกาสที่พอร์ตจบต่ำกว่าวันนี้เกิน 10%")}
              {th("ลงลึกสุดระหว่างทาง", "จากยอดสูงสุดในช่วงนั้น: กลางๆ / แย่ 5%")}
              {th("ถ้าไม่เอียง", "รันเดียวกันแต่สุ่มวันตามปกติ — กลางๆ / โอกาสจบติดลบ")}
              {th("ใครพาลง", "ผู้ถือที่ทำให้ผลเฉลี่ยติดลบมากสุด (จุด % ของพอร์ต)", true)}
            </tr>
          </thead>
          <tbody>
            {data.horizons.map((h) => {
              const over10 = h.loss_prob.find((x) => x.worse_than_pct === 10)?.prob_pct ?? 0;
              return (
                <tr key={h.days} style={{ borderBottom: `1px solid ${colors.border}33` }}>
                  <td
                    className="px-1 py-0.5 whitespace-nowrap font-bold"
                    style={{ color: colors.text }}
                  >
                    {HORIZON_LABEL[h.days] ?? `${h.days} วัน`}
                  </td>
                  <td
                    className="px-1 text-right font-bold"
                    style={{ color: h.p50 < 0 ? colors.negative : colors.positive }}
                  >
                    {pct(h.p50)}
                  </td>
                  <td className="px-1 text-right" style={{ color: colors.text }}>
                    {money(h.amount_p50, sym)}
                  </td>
                  <td className="px-1 text-right font-bold" style={{ color: C_TILT }}>
                    {pct(h.p5)}
                  </td>
                  <td className="px-1 text-right" style={{ color: colors.text }}>
                    {money(h.amount_p5, sym)}
                  </td>
                  <td
                    className="px-1 text-right"
                    style={{ color: h.p95 >= 0 ? colors.positive : colors.negative }}
                  >
                    {pct(h.p95)}
                  </td>
                  <td className="px-1 text-right" style={{ color: colors.text }}>
                    {h.p_loss.toFixed(0)}%
                  </td>
                  <td
                    className="px-1 text-right"
                    style={{ color: over10 >= 25 ? colors.negative : colors.text }}
                  >
                    {over10.toFixed(0)}%
                  </td>
                  <td className="px-1 text-right whitespace-nowrap" style={{ color: colors.text }}>
                    {pct(h.max_dd_p50)} / <span style={{ color: C_TILT }}>{pct(h.max_dd_p95)}</span>
                  </td>
                  <td className="px-1 text-right whitespace-nowrap" style={{ color: C_BASE }}>
                    {pct(h.base.p50)} / {h.base.p_loss.toFixed(0)}%
                  </td>
                  <td className="px-1 whitespace-nowrap" style={{ color: colors.textSecondary }}>
                    {h.holdings
                      .slice(0, 3)
                      .map((x) => `${x.symbol} ${pct(x.contrib_pct, 2)}`)
                      .join(" · ") || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {chart.length > 1 && (
        <div>
          <div className="flex items-baseline gap-3 flex-wrap" style={{ fontSize: 9 }}>
            <span style={{ color: colors.textSecondary }}>มูลค่าพอร์ต 2 เดือนข้างหน้า (วันนี้ = 100)</span>
            <span style={{ color: C_TILT }}>■ ขาลง: ช่วง 90% และเส้นกลาง</span>
            <span style={{ color: C_BASE }}>╌ ไม่เอียง: เส้นกลาง · แย่ 5%</span>
          </div>
          <div style={{ height: 190 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={colors.border} strokeOpacity={0.35} vertical={false} />
                <XAxis
                  dataKey="d"
                  type="number"
                  domain={[0, fan?.days[fan.days.length - 1] ?? 42]}
                  ticks={[0, 3, 5, 7, 21, 42]}
                  tick={{ fill: colors.textSecondary, fontSize: 9 }}
                  stroke={colors.border}
                  tickFormatter={(v: number) => `${v}ว`}
                />
                <YAxis
                  domain={[lo - pad, hi + pad]}
                  tick={{ fill: colors.textSecondary, fontSize: 9 }}
                  stroke={colors.border}
                  width={34}
                  tickFormatter={(v: number) => v.toFixed(0)}
                />
                <Tooltip
                  contentStyle={{
                    background: colors.surface,
                    border: `1px solid ${colors.border}`,
                    fontSize: 10,
                    fontFamily: "monospace",
                  }}
                  labelFormatter={(v) => `วันที่ ${v}`}
                  formatter={(value, name) => {
                    const label =
                      name === "band"
                        ? "ขาลง 5–95%"
                        : name === "p50"
                          ? "ขาลง กลางๆ"
                          : name === "base"
                            ? "ไม่เอียง กลางๆ"
                            : "ไม่เอียง แย่ 5%";
                    const text = Array.isArray(value)
                      ? `${Number(value[0]).toFixed(1)} – ${Number(value[1]).toFixed(1)}`
                      : Number(value).toFixed(1);
                    return [text, label];
                  }}
                />
                <ReferenceLine y={100} stroke={colors.textSecondary} strokeDasharray="2 3" />
                <Area
                  dataKey="band"
                  stroke="none"
                  fill={C_TILT}
                  fillOpacity={0.22}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="p50"
                  stroke={C_TILT}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="base"
                  stroke={C_BASE}
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="base5"
                  stroke={C_BASE}
                  strokeWidth={1}
                  strokeDasharray="2 3"
                  dot={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {last && (
        <div style={{ color: colors.text, fontSize: 9.5, lineHeight: 1.5 }}>
          อ่านว่า: ถ้า 2 เดือนข้างหน้าวันลงมากกว่าวันขึ้น พอร์ตกลางๆ จะอยู่ที่{" "}
          <b style={{ color: last.p50 < 0 ? colors.negative : colors.positive }}>
            {pct(last.p50)} ({money(last.amount_p50, sym)})
          </b>{" "}
          · 1 ใน 20 แย่กว่า <b style={{ color: C_TILT }}>{pct(last.p5)}</b> (
          {money(last.amount_p5, sym)}) · ระหว่างทางลงลึกสุดกลางๆ {pct(last.max_dd_p50)} · เทียบกับไม่เอียง{" "}
          {pct(last.base.p50)}
        </div>
      )}

      {showModel && (
        <div
          className="p-2 flex flex-col gap-1"
          style={{
            background: colors.surfaceDeep,
            color: colors.textSecondary,
            fontSize: 9,
            lineHeight: 1.5,
          }}
        >
          <span>
            <b style={{ color: colors.text }}>วันลง</b> = วันในอดีต ({data.window_from} → {data.as_of},{" "}
            {data.window_days} วัน) ที่พอร์ตน้ำหนักวันนี้ติดลบ — มี {data.down_days_in_window} วัน · วันขึ้น{" "}
            {data.up_days_in_window} วัน
          </span>
          <span>
            <b style={{ color: colors.text }}>เส้นทาง</b> = จำนวนวันลงสุ่มจาก Binomial(ช่วง, โอกาสวันลง)
            แล้วเก็บเฉพาะที่วันลงมากกว่าครึ่ง · ตำแหน่งวันลงในช่วงสุ่ม · แต่ละวันหยิบ "ทั้งวัน" จากอดีต
            ทุกตัวในพอร์ตใช้วันเดียวกัน จึงลงพร้อมกันเหมือนที่เคยเกิดจริง
          </span>
          <span>
            <b style={{ color: colors.text }}>ความผันผวน</b> เริ่มจากระดับวันนี้ และสูงขึ้นเมื่อเจอวันแรงติดกัน
            (GARCH เดียวกับ MONTE CARLO) · แต่ละช่วงรันแยกกัน เพราะเงื่อนไข "ลงมากกว่าขึ้น" นับในช่วงนั้น
          </span>
          <span>
            <b style={{ color: colors.text }}>ไม่ได้คิด</b>: stop loss และการขายระหว่างทาง (ดู WHAT-IF) ·
            gamma ของ option (ใช้ delta) · วันที่แย่กว่าที่เคยเกิดในหน้าต่างนี้ · โอกาสวันลงเป็นสมมติฐานที่คุณเลือก
            ไม่ใช่ค่าที่ประมาณจากตลาด
          </span>
          {!!data.excluded?.length && (
            <span>ไม่มีประวัติราคา (ไม่ได้จำลอง): {data.excluded.map((e) => e.symbol).join(", ")}</span>
          )}
        </div>
      )}
    </Shell>
  );
}
