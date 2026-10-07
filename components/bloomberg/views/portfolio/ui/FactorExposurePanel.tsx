"use client";

/**
 * PORT → RISK → BUDGET · FACTOR (lower panel): "what is the book betting on".
 *
 * The book's returns regressed on market-wide drivers (US / Thai equity, size,
 * value, momentum, rates, credit, USD/THB, oil, gold, Bitcoin — each a liquid
 * ETF or a spread of two). Per factor: beta, how sure it is (t), its share of
 * the book's risk, what a one-SD month of it does to the book, and which
 * holdings bring it. Whatever no factor explains is "เฉพาะตัว".
 *
 * Backend: GET /api/v2/portfolio/risk/factors (backend/factor_exposure.py —
 * 5-day overlapping returns, Newey-West t).
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { Colors } from "../helpers";
import { fmtAmt } from "../helpers";

export interface FactorRow {
  key: string;
  label: string;
  proxy: string;
  reads: string;
  beta: number | null;
  t_stat: number | null;
  significant: boolean;
  risk_share_pct: number | null;
  corr: number | null;
  vif: number | null;
  collinear: boolean;
  sd_1m_pct: number | null;
  impact_1sd_pct: number | null;
  impact_1sd_amount: number | null;
  top: { symbol: string; beta: number | null; contribution: number | null }[];
}

export interface FactorData {
  account_id: string;
  base_currency: string;
  as_of: string;
  lookback_days: number;
  nav: number;
  excluded: { symbol: string; reason: string; bars: number }[];
  missing_factors: string[];
  n_obs: number;
  horizon_days: number;
  r_squared: number | null;
  specific_pct: number | null;
  factors: FactorRow[];
  assets: {
    symbol: string;
    yf_symbol: string;
    weight_pct: number | null;
    r_squared: number | null;
    betas: Record<string, number | null>;
  }[];
  error?: string;
}

const LOOKBACKS: { days: number; label: string }[] = [
  { days: 126, label: "6M" },
  { days: 252, label: "1Y" },
  { days: 504, label: "2Y" },
];

const HEDGE = "#4FC3F7";
const signed = (v: number | null | undefined, d = 2) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}`;

export function FactorExposurePanel({
  accountId,
  currency,
  colors,
}: {
  accountId: string;
  currency: "THB" | "USD";
  colors: Colors;
}) {
  const [lookback, setLookback] = useState(252);
  const [fresh, setFresh] = useState(0);
  const [showAssets, setShowAssets] = useState(false);
  const sym = currency === "THB" ? "฿" : "$";

  const { data, isFetching, error } = useQuery<FactorData>({
    queryKey: ["risk-factors", accountId, currency, lookback, fresh],
    queryFn: async () => {
      const qs = new URLSearchParams({ lookback: String(lookback), base_currency: currency });
      if (accountId !== "all") qs.set("account_id", accountId);
      if (fresh) qs.set("fresh", "true");
      const r = await fetch(`/api/v2/portfolio/risk/factors?${qs}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  const shell = (body: React.ReactNode) => (
    <div
      className="rounded p-2 flex flex-col gap-2 font-mono"
      style={{ border: `1px solid ${colors.border}`, fontSize: 10 }}
    >
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="font-bold" style={{ color: colors.accent, letterSpacing: "0.08em" }}>
          FACTOR EXPOSURE · พอร์ตเดิมพันกับอะไร
        </span>
        <div className="flex items-baseline gap-2 ml-auto" style={{ fontSize: 9 }}>
          <span style={{ color: colors.textSecondary }}>ย้อนหลัง</span>
          {LOOKBACKS.map((l) => (
            <button
              aria-pressed={lookback === l.days}
              type="button"
              key={l.days}
              onClick={() => setLookback(l.days)}
              className="font-bold"
              style={{ color: lookback === l.days ? colors.accent : colors.textSecondary }}
            >
              {l.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setFresh((n) => n + 1)}
            style={{ color: colors.textSecondary }}
          >
            {isFetching ? "กำลังโหลด…" : "REFRESH"}
          </button>
        </div>
      </div>
      {body}
    </div>
  );

  if (error)
    return shell(
      <span style={{ color: colors.negative }}>FACTOR unavailable — {String(error)}</span>
    );
  if (!data)
    return shell(<span style={{ color: colors.textSecondary }}>กำลังคำนวณ factor exposure…</span>);
  if (data.error || !data.factors.length)
    return shell(
      <span style={{ color: colors.textSecondary }}>
        {data.error === "not enough history"
          ? `ประวัติราคาไม่พอ (${data.n_obs} ช่วง) — ลองช่วงย้อนหลังที่ยาวขึ้น`
          : "ยังไม่มีสถานะเปิดที่มีประวัติราคาพอให้คำนวณ"}
      </span>
    );

  const specific = data.specific_pct ?? 0;
  const maxShare = Math.max(
    specific,
    ...data.factors.map((f) => Math.abs(f.risk_share_pct ?? 0)),
    1
  );
  const biggest = data.factors[0];
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

  return shell(
    <>
      <div style={{ color: colors.textSecondary, fontSize: 9.5, lineHeight: 1.5 }}>
        ผลตอบแทนพอร์ตเทียบปัจจัยตลาด {data.factors.length} ตัว (ใช้ ETF แทน) ·{" "}
        <b style={{ color: colors.text }}>beta</b> = ปัจจัยขยับ 1% แล้วพอร์ตขยับกี่ % เมื่อปัจจัยอื่นอยู่นิ่ง ·{" "}
        <b style={{ color: colors.text }}>สัดส่วนความเสี่ยง</b> = ความผันผวนของพอร์ตมาจากปัจจัยนั้นกี่ % ·
        แถวสีจาง = ข้อมูลยังไม่พอจะบอกว่ามีจริง (|t| &lt; 2)
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 items-baseline">
        <Kpi
          label="ปัจจัยตลาดอธิบาย"
          value={`${((data.r_squared ?? 0) * 100).toFixed(0)}%`}
          colors={colors}
        />
        <Kpi
          label="เฉพาะตัวหุ้น"
          value={`${specific.toFixed(0)}%`}
          color={specific >= 60 ? "#FFB300" : undefined}
          colors={colors}
        />
        {biggest && (
          <Kpi
            label="ใหญ่สุด"
            value={`${biggest.label} ${(biggest.risk_share_pct ?? 0).toFixed(0)}%`}
            colors={colors}
          />
        )}
        <Kpi label="ข้อมูล" value={`${data.n_obs} ช่วง × ${data.horizon_days} วัน`} colors={colors} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full tabular-nums" style={{ fontSize: 9.5 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              {th("ปัจจัย", false)}
              {th("BETA", true, "พอร์ตขยับกี่ % เมื่อปัจจัยขยับ 1% (ปัจจัยอื่นนิ่ง)")}
              {th("t", true, "ความมั่นใจ: |t| ≥ 2 = มีจริง · Newey-West")}
              {th("สัดส่วนความเสี่ยง", true, "ส่วนของความผันผวนพอร์ตที่มาจากปัจจัยนี้ · ลบ = ช่วยลดความเสี่ยง")}
              {th("", false)}
              {th("ถ้าปัจจัยขยับ 1 SD ใน 1 เดือน", true, "ขนาดการขยับปกติใน 1 เดือนของปัจจัย → ผลต่อพอร์ต")}
              {th("มาจาก", false, "หุ้นที่พาปัจจัยนี้เข้าพอร์ตมากสุด: น้ำหนัก × beta ของหุ้น")}
            </tr>
          </thead>
          <tbody>
            {data.factors.map((f) => {
              const share = f.risk_share_pct ?? 0;
              const tone = share < 0 ? HEDGE : colors.accent;
              return (
                <tr
                  key={f.key}
                  style={{
                    borderBottom: `1px solid ${colors.border}33`,
                    opacity: f.significant ? 1 : 0.5,
                  }}
                >
                  <td className="px-1 py-0.5 whitespace-nowrap" title={f.reads}>
                    <span className="font-bold" style={{ color: colors.text }}>
                      {f.label}
                    </span>
                    <span className="ml-1" style={{ color: colors.textSecondary, fontSize: 8.5 }}>
                      {f.proxy}
                    </span>
                    {f.collinear && (
                      <span
                        className="ml-1"
                        style={{ color: "#FFB300", fontSize: 8.5 }}
                        title={`ปัจจัยนี้ขยับคล้ายปัจจัยอื่นในตาราง (VIF ${f.vif}) — beta แยกจากกันได้ไม่คม`}
                      >
                        ซ้อน
                      </span>
                    )}
                  </td>
                  <td
                    className="px-1 text-right font-bold"
                    style={{ color: (f.beta ?? 0) >= 0 ? colors.positive : colors.negative }}
                  >
                    {signed(f.beta)}
                  </td>
                  <td className="px-1 text-right" style={{ color: colors.textSecondary }}>
                    {signed(f.t_stat, 1)}
                  </td>
                  <td className="px-1 text-right" style={{ color: colors.text }}>
                    {share.toFixed(1)}%
                  </td>
                  <td className="px-1">
                    <Bar pct={(Math.abs(share) / maxShare) * 100} color={tone} colors={colors} />
                  </td>
                  <td className="px-1 text-right whitespace-nowrap" style={{ color: colors.text }}>
                    <span style={{ color: colors.textSecondary }}>
                      +{(f.sd_1m_pct ?? 0).toFixed(1)}% →{" "}
                    </span>
                    <span
                      style={{
                        color: (f.impact_1sd_pct ?? 0) >= 0 ? colors.positive : colors.negative,
                      }}
                    >
                      {signed(f.impact_1sd_pct)}% ({(f.impact_1sd_amount ?? 0) < 0 ? "−" : "+"}
                      {sym}
                      {fmtAmt(Math.abs(f.impact_1sd_amount ?? 0))})
                    </span>
                  </td>
                  <td className="px-1 whitespace-nowrap" style={{ color: colors.textSecondary }}>
                    {f.top.map((t) => `${t.symbol} ${signed(t.contribution)}`).join(" · ") || "—"}
                  </td>
                </tr>
              );
            })}
            <tr>
              <td className="px-1 py-0.5" style={{ color: colors.textSecondary }}>
                เฉพาะตัวหุ้น (ไม่มีปัจจัยอธิบาย)
              </td>
              <td />
              <td />
              <td className="px-1 text-right" style={{ color: colors.text }}>
                {specific.toFixed(1)}%
              </td>
              <td className="px-1">
                <Bar
                  pct={(specific / maxShare) * 100}
                  color={colors.textSecondary}
                  colors={colors}
                />
              </td>
              <td />
              <td className="px-1" style={{ color: colors.textSecondary }}>
                กระจายหุ้นเพิ่มช่วยลดส่วนนี้ · ปัจจัยตลาดลดไม่ได้ด้วยการกระจาย
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <button
          aria-pressed={showAssets}
          type="button"
          onClick={() => setShowAssets((v) => !v)}
          style={{ color: colors.accent, fontSize: 9 }}
        >
          {showAssets ? "▾" : "▸"} beta รายหุ้น ({data.assets.length})
        </button>
        {showAssets && <AssetBetas data={data} colors={colors} />}
      </div>

      <div style={{ color: colors.textSecondary, opacity: 0.75, fontSize: 8.5, lineHeight: 1.5 }}>
        ผลตอบแทนรวม {data.horizon_days} วันแบบซ้อนกัน (หุ้นไทยปิดก่อนสหรัฐเปิด — รายวันจะเห็น beta ต่ำเกินจริง) ·
        ผลตอบแทนหุ้นคิดเป็น {data.base_currency} ปัจจัยคิดในสกุลของมันเอง ค่าเงินจึงไปอยู่บรรทัดดอลลาร์เทียบบาท ·
        น้ำหนักเทียบ NAV (เงินสดไม่มี beta) · beta คือความสัมพันธ์ในอดีต ไม่ใช่คำพยากรณ์ · ณ {data.as_of}
        {data.excluded.length > 0 &&
          ` · ไม่รวม ${data.excluded.map((e) => e.symbol).join(", ")} (ประวัติราคาสั้น)`}
        {data.missing_factors.length > 0 && ` · ไม่มีข้อมูลปัจจัย ${data.missing_factors.join(", ")}`}
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

function Bar({ pct, color, colors }: { pct: number; color: string; colors: Colors }) {
  return (
    <div className="relative" style={{ height: 8, width: 110, background: `${colors.border}55` }}>
      <div
        className="absolute top-0 bottom-0 left-0"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color, opacity: 0.75 }}
      />
    </div>
  );
}

/** Holdings × factors. Colour = sign, strength = size (capped at |β| = 1.5).
 *  One stock against eleven factors is a noisy fit — the table says who brings
 *  a factor, not what a stock's beta "is". */
function AssetBetas({ data, colors }: { data: FactorData; colors: Colors }) {
  const keys = data.factors.map((f) => f.key);
  const label = Object.fromEntries(data.factors.map((f) => [f.key, f.label]));
  return (
    <div className="overflow-x-auto mt-1">
      <div style={{ color: colors.textSecondary, fontSize: 8.5 }}>
        beta ของหุ้นตัวเดียวแกว่งมาก — ใช้ดูว่าใครพาปัจจัยไหนเข้าพอร์ต ไม่ใช่ค่าที่แม่นของหุ้นตัวนั้น
      </div>
      <table className="tabular-nums" style={{ fontSize: 9 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
            <th className="text-left font-normal px-1" style={{ color: colors.textSecondary }}>
              หุ้น
            </th>
            <th className="text-right font-normal px-1" style={{ color: colors.textSecondary }}>
              น้ำหนัก
            </th>
            {keys.map((k) => (
              <th
                key={k}
                className="text-right font-normal px-1 whitespace-nowrap"
                style={{ color: colors.textSecondary }}
              >
                {label[k]}
              </th>
            ))}
            <th
              className="text-right font-normal px-1"
              style={{ color: colors.textSecondary }}
              title="ส่วนของการขยับของหุ้นตัวนี้ที่ปัจจัยตลาดอธิบายได้"
            >
              R²
            </th>
          </tr>
        </thead>
        <tbody>
          {data.assets.map((a) => (
            <tr key={a.yf_symbol} style={{ borderBottom: `1px solid ${colors.border}33` }}>
              <td className="px-1 font-bold" style={{ color: colors.text }}>
                {a.symbol}
              </td>
              <td className="px-1 text-right" style={{ color: colors.textSecondary }}>
                {(a.weight_pct ?? 0).toFixed(1)}%
              </td>
              {keys.map((k) => {
                const b = a.betas[k];
                const alpha = Math.round(Math.min(1, Math.abs(b ?? 0) / 1.5) * 60)
                  .toString(16)
                  .padStart(2, "0");
                return (
                  <td
                    key={k}
                    className="px-1 text-right"
                    style={{
                      color: colors.text,
                      background: `${(b ?? 0) >= 0 ? colors.positive : colors.negative}${alpha}`,
                    }}
                  >
                    {signed(b)}
                  </td>
                );
              })}
              <td className="px-1 text-right" style={{ color: colors.textSecondary }}>
                {a.r_squared == null ? "—" : `${(a.r_squared * 100).toFixed(0)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
