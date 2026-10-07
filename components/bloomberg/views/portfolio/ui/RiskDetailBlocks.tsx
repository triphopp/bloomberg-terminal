"use client";

/**
 * PORT → RISK → สรุป, "เชิงลึก": four blocks, each ONE sentence the screen
 * writes itself plus ONE picture that shows why (2026-10-07). They replace a
 * 7px table, an unlabelled bar chart and a folded matrix that showed model
 * output and left the conclusion to the reader.
 *
 *   WhoCarriesRiskBlock  money weight → share of risk, per holding
 *   LossLadderBlock      VaR → CVaR → stressed CVaR on one scale, per horizon
 *   ModelTrustBlock      each past day against the VaR line of the days before it
 *   CoMoveBlock          which holdings move together (pairs, or an ordered matrix)
 *
 * Every number comes from GET /api/v2/portfolio/risk/metrics — nothing is
 * computed here but the sentences. Colour: blue = money / neutral, amber = risk
 * / loss (the MONTE CARLO pair, validated for the dark and light surface); red
 * is kept for a crossed line. Text stays in ink colours; marks carry the hue.
 */

import { useState } from "react";

import type { Colors } from "../helpers";
import { fmtAmt } from "../helpers";
import { Shell } from "./WhatIfSimPanel";

const palette = (colors: Colors) => {
  const dark = colors.bg === "#000000";
  return {
    money: dark ? "#3b8fd9" : "#2a7bc4",
    risk: dark ? "#c77700" : "#b86e00",
    breach: "#FF4444",
    track: `${colors.border}`,
    surface: colors.bg,
  };
};

/** "-0%" reads as a bug: a value that rounds to zero is written as zero. */
const pct = (v: number, d = 1) => {
  const t = v.toFixed(d);
  return `${Number(t) === 0 ? t.replace("-", "") : t}%`;
};
const signed = (v: number, d = 1) => {
  const t = Math.abs(v).toFixed(d);
  return `${Number(t) === 0 ? "" : v >= 0 ? "+" : "−"}${t}`;
};

function Headline({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return <div style={{ color: colors.text, fontSize: 11, lineHeight: 1.5 }}>{children}</div>;
}

function Legend({
  colors,
  items,
}: {
  colors: Colors;
  items: { color: string; label: string; shape?: "dot" | "line" | "bar" }[];
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-0.5" style={{ fontSize: 9 }}>
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span
            style={{
              display: "inline-block",
              width: it.shape === "dot" ? 8 : 12,
              height: it.shape === "dot" ? 8 : it.shape === "line" ? 2 : 6,
              borderRadius: it.shape === "dot" ? 4 : 1,
              background: it.color,
            }}
          />
          <span style={{ color: colors.textSecondary }}>{it.label}</span>
        </span>
      ))}
    </div>
  );
}

// ── 1. Who carries the risk ──────────────────────────────────────────────────

export interface RiskAsset {
  symbol: string;
  weight_pct: number;
  risk_contribution_pct: number;
}

const CARRIER_ROWS = 10;

export function WhoCarriesRiskBlock({ assets, colors }: { assets: RiskAsset[]; colors: Colors }) {
  const [all, setAll] = useState(false);
  const P = palette(colors);
  if (!assets.length) return null;

  const rows = [...assets].sort((a, b) => b.risk_contribution_pct - a.risk_contribution_pct);
  const equal = 100 / rows.length;
  const hi =
    Math.max(equal, ...rows.flatMap((r) => [r.weight_pct, r.risk_contribution_pct])) * 1.06;
  const lo = Math.min(0, ...rows.map((r) => r.risk_contribution_pct));
  const x = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;

  const top = rows.slice(0, 2);
  const topRisk = top.reduce((s, r) => s + r.risk_contribution_pct, 0);
  const topWeight = top.reduce((s, r) => s + r.weight_pct, 0);
  // A holding that takes real money but adds little risk is what spreads the book.
  const spreaders = rows.filter(
    (r) => r.weight_pct >= 5 && r.risk_contribution_pct <= r.weight_pct * 0.5
  );
  const shown = all ? rows : rows.slice(0, CARRIER_ROWS);

  return (
    <Shell colors={colors} title="ใครแบกความเสี่ยง">
      <Headline colors={colors}>
        <b>
          {top.map((r) => r.symbol).join(" + ")} = {pct(topRisk, 0)} ของความเสี่ยง
        </b>{" "}
        ทั้งที่เป็นเงิน {pct(topWeight, 0)} ของพอร์ต
        {spreaders.length > 0 && (
          <>
            {" "}
            · <b>{spreaders.map((r) => r.symbol).join(", ")}</b> ช่วยกระจาย (เงิน{" "}
            {pct(
              spreaders.reduce((s, r) => s + r.weight_pct, 0),
              0
            )}{" "}
            แต่ความเสี่ยงแค่{" "}
            {pct(
              spreaders.reduce((s, r) => s + r.risk_contribution_pct, 0),
              0
            )}
            )
          </>
        )}
      </Headline>
      <Legend
        colors={colors}
        items={[
          { color: P.money, label: "สัดส่วนเงิน", shape: "dot" },
          { color: P.risk, label: "ส่วนแบ่งความเสี่ยง", shape: "dot" },
          {
            color: colors.textSecondary,
            label: `ถ้าทุกตัวเสี่ยงเท่ากัน (${pct(equal, 0)})`,
            shape: "line",
          },
        ]}
      />
      <div className="flex flex-col">
        {shown.map((r) => {
          const gap = r.risk_contribution_pct - r.weight_pct;
          const from = Math.min(r.weight_pct, r.risk_contribution_pct);
          const to = Math.max(r.weight_pct, r.risk_contribution_pct);
          return (
            <div
              key={r.symbol}
              className="grid items-center gap-2 hover:bg-white/5"
              style={{ gridTemplateColumns: "64px minmax(0,1fr) 168px", height: 20 }}
              title={`${r.symbol}\nสัดส่วนเงิน ${pct(r.weight_pct)}\nส่วนแบ่งความเสี่ยง ${pct(r.risk_contribution_pct)}\nต่างกัน ${signed(gap)} จุด`}
            >
              <span className="font-bold truncate" style={{ color: colors.text, fontSize: 10 }}>
                {r.symbol}
              </span>
              <div className="relative" style={{ height: 12 }}>
                <div
                  className="absolute left-0 right-0"
                  style={{ top: 5.5, height: 1, background: P.track }}
                />
                <div
                  className="absolute"
                  style={{
                    left: x(equal),
                    top: 0,
                    bottom: 0,
                    width: 1,
                    background: colors.textSecondary,
                    opacity: 0.6,
                  }}
                />
                <div
                  className="absolute"
                  style={{
                    left: x(from),
                    width: `calc(${x(to)} - ${x(from)})`,
                    top: 4.5,
                    height: 3,
                    background: gap > 0 ? P.risk : P.money,
                    opacity: 0.55,
                  }}
                />
                <div
                  className="absolute"
                  style={{
                    left: `calc(${x(r.weight_pct)} - 5px)`,
                    top: 1,
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    background: P.money,
                    border: `2px solid ${P.surface}`,
                  }}
                />
                <div
                  className="absolute"
                  style={{
                    left: `calc(${x(r.risk_contribution_pct)} - 5px)`,
                    top: 1,
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    background: P.risk,
                    border: `2px solid ${P.surface}`,
                  }}
                />
              </div>
              <span className="tabular-nums text-right whitespace-nowrap" style={{ fontSize: 9.5 }}>
                <span style={{ color: colors.textSecondary }}>{pct(r.weight_pct, 0)} → </span>
                <span className="font-bold" style={{ color: colors.text }}>
                  {pct(r.risk_contribution_pct, 0)}
                </span>
                <span style={{ color: colors.textSecondary }}> ({signed(gap, 0)})</span>
              </span>
            </div>
          );
        })}
      </div>
      {rows.length > CARRIER_ROWS && (
        <button
          aria-pressed={all}
          type="button"
          className="self-start"
          onClick={() => setAll((v) => !v)}
          style={{ color: colors.accent, fontSize: 9 }}
        >
          {all ? "▾ ย่อ" : `▸ อีก ${rows.length - CARRIER_ROWS} ตัว`}
        </button>
      )}
      <div style={{ color: colors.textSecondary, opacity: 0.8, fontSize: 8.5 }}>
        จุดส้มอยู่ขวาของจุดฟ้า = ตัวนั้นเสี่ยงเกินขนาดเงิน · อยู่ซ้าย = ช่วยลดความเสี่ยงของพอร์ต · ส่วนแบ่ง =
        ส่วนของความผันผวนพอร์ตที่มาจากตัวนั้น (รวมผลของการขยับด้วยกัน)
      </div>
    </Shell>
  );
}

// ── 2. How much can be lost ──────────────────────────────────────────────────

export interface LossMetrics {
  confidence: number;
  var_historical_pct: number;
  var_historical_amount: number;
  cvar_pct: number;
  cvar_amount: number;
  cvar_ci_lo: number;
  cvar_ci_hi: number;
  var_cf_pct: number;
  var_cf_amount: number;
  cvar_mc_pct: number;
  cvar_mc_amount: number;
  cvar_stressed_pct: number;
  cvar_stressed_amount: number;
  ensemble_signal: "STABLE" | "FAT_TAIL_RISK" | "CORRELATION_RISK";
}

const HORIZONS = [
  { label: "1 วัน", days: 1 },
  { label: "1 สัปดาห์", days: 5 },
  { label: "1 เดือน", days: 21 },
  { label: "3 เดือน", days: 63 },
] as const;

export function LossLadderBlock({
  metrics: m,
  colors,
  sym,
}: { metrics: LossMetrics; colors: Colors; sym: string }) {
  const [h, setH] = useState<(typeof HORIZONS)[number]>(HORIZONS[0]);
  const P = palette(colors);
  const k = Math.sqrt(h.days);
  const conf = (m.confidence * 100).toFixed(0);
  const tail = (100 - m.confidence * 100).toFixed(0);

  const main = [
    {
      key: "var",
      label: `VaR ${conf}%`,
      note: `${tail} ใน 100 ช่วง เสียเกินเส้นนี้`,
      p: m.var_historical_pct * k,
      amt: m.var_historical_amount * k,
    },
    {
      key: "cvar",
      label: `CVaR ${conf}%`,
      note: "เมื่อเกินเส้นแล้ว เสียเฉลี่ยเท่านี้",
      p: m.cvar_pct * k,
      amt: m.cvar_amount * k,
      ci: m.cvar_ci_lo > 0 ? ([m.cvar_ci_lo * k, m.cvar_ci_hi * k] as [number, number]) : undefined,
    },
    {
      key: "stress",
      label: "CVaR ตึงเครียด",
      note: "ถ้าความผันผวนและการขยับด้วยกันเป็นแบบช่วงวิกฤต",
      p: m.cvar_stressed_pct * k,
      amt: m.cvar_stressed_amount * k,
    },
  ];
  const others = [
    {
      key: "cf",
      label: "VaR ปรับหางอ้วน",
      note: "Cornish-Fisher",
      p: m.var_cf_pct * k,
      amt: m.var_cf_amount * k,
    },
    {
      key: "mc",
      label: "CVaR จำลอง",
      note: "Monte Carlo",
      p: m.cvar_mc_pct * k,
      amt: m.cvar_mc_amount * k,
    },
  ];
  const hi = Math.max(...main.map((r) => r.ci?.[1] ?? r.p), ...others.map((r) => r.p)) * 1.05 || 1;
  const w = (v: number) => `${Math.min(100, (v / hi) * 100)}%`;

  const methods = [m.cvar_pct, m.var_cf_pct, m.cvar_mc_pct].map((v) => v * k);
  const spread = Math.max(...methods) - Math.min(...methods);
  const verdict =
    m.ensemble_signal === "FAT_TAIL_RISK"
      ? "วันลงแรงเกิดบ่อยกว่าที่การกระจายปกติบอก (หางอ้วน) — ให้น้ำหนักตัวเลขที่สูงกว่า"
      : m.ensemble_signal === "CORRELATION_RISK"
        ? "แบบจำลองให้ผลแย่กว่าประวัติจริง — หุ้นกำลังขยับไปทางเดียวกันมากขึ้น"
        : `สามวิธีให้ผลใกล้กัน (ห่างกัน ${spread.toFixed(1)} จุด) — ไม่มีสัญญาณผิดปกติ`;

  const row = (r: (typeof main)[number], strong: boolean) => (
    <div
      key={r.key}
      className="grid items-center gap-2 hover:bg-white/5"
      style={{ gridTemplateColumns: "108px minmax(0,1fr) 150px", height: strong ? 22 : 17 }}
      title={`${r.label} — ${r.note}\n−${r.p.toFixed(2)}% · −${sym}${fmtAmt(r.amt)}${r.ci ? `\nช่วงความเชื่อมั่น 90%: ${r.ci[0].toFixed(2)}–${r.ci[1].toFixed(2)}%` : ""}`}
    >
      <span
        className={strong ? "font-bold" : ""}
        style={{ color: strong ? colors.text : colors.textSecondary, fontSize: strong ? 10 : 9 }}
      >
        {r.label}
      </span>
      <div className="relative" style={{ height: strong ? 10 : 5 }}>
        <div
          className="absolute left-0 top-0 bottom-0"
          style={{
            width: w(r.p),
            background: P.risk,
            opacity: strong ? 1 : 0.45,
            borderRadius: "0 3px 3px 0",
          }}
        />
        {r.ci && (
          <div
            className="absolute"
            style={{
              left: w(r.ci[0]),
              width: `calc(${w(r.ci[1])} - ${w(r.ci[0])})`,
              top: "50%",
              height: 2,
              marginTop: -1,
              background: colors.text,
            }}
          />
        )}
      </div>
      <span
        className="tabular-nums text-right whitespace-nowrap"
        style={{ fontSize: strong ? 10 : 9 }}
      >
        <span className={strong ? "font-bold" : ""} style={{ color: colors.text }}>
          −{r.p.toFixed(2)}%
        </span>
        <span style={{ color: colors.textSecondary }}>
          {" "}
          −{sym}
          {fmtAmt(r.amt)}
        </span>
      </span>
    </div>
  );

  return (
    <Shell
      colors={colors}
      title="เสียได้เท่าไร"
      right={
        <>
          <span style={{ color: colors.textSecondary }}>ช่วง</span>
          {HORIZONS.map((x) => (
            <button
              aria-pressed={h === x}
              type="button"
              key={x.days}
              onClick={() => setH(x)}
              style={{
                color: h === x ? colors.accent : colors.textSecondary,
                textDecoration: h === x ? "underline" : "none",
              }}
            >
              {x.label}
            </button>
          ))}
        </>
      }
    >
      <Headline colors={colors}>
        ใน {h.label} ที่แย่ ({tail} ใน 100):{" "}
        <b>
          เสียเฉลี่ย −{main[1].p.toFixed(1)}% (−{sym}
          {fmtAmt(main[1].amt)})
        </b>{" "}
        · ถ้าตลาดตึงเครียด −{main[2].p.toFixed(1)}% (−{sym}
        {fmtAmt(main[2].amt)})
      </Headline>
      <div className="flex flex-col">
        {main.map((r) => row(r, true))}
        <div className="mt-1" style={{ color: colors.textSecondary, fontSize: 8.5 }}>
          วิธีอื่น ไว้เทียบ
        </div>
        {others.map((r) => row(r, false))}
      </div>
      <div style={{ color: colors.text, fontSize: 9.5 }}>{verdict}</div>
      <div style={{ color: colors.textSecondary, opacity: 0.8, fontSize: 8.5 }}>
        % ของพอร์ต · ขีดบนแท่ง CVaR = ช่วงความเชื่อมั่น 90% ของตัวเลขนั้น
        {h.days > 1 && ` · ${h.label} = ค่า 1 วัน × √${h.days} (สมมติว่าแต่ละวันไม่ขึ้นต่อกัน)`}
      </div>
    </Shell>
  );
}

// ── 3. Can the model be trusted ──────────────────────────────────────────────

export interface BacktestDay {
  d: string;
  /** that day's return, % */
  r: number;
  /** the VaR line that day, % (negative) */
  v: number;
  /** crossed */
  x: boolean;
}

export function ModelTrustBlock({
  series,
  rolling,
  confidence,
  colors,
  children,
}: {
  series: BacktestDay[] | undefined;
  rolling: {
    exceptions: number;
    obs: number | undefined;
    rate: number;
    signal: string;
    kupiec: number;
  };
  confidence: number;
  colors: Colors;
  /** The live forecast log (VarValidationCard) — the test of the real book. */
  children?: React.ReactNode;
}) {
  const P = palette(colors);
  const obs = rolling.obs ?? series?.length ?? 0;
  const expected = obs * (1 - confidence);
  const insufficient = rolling.signal === "INSUFFICIENT_DATA" || !series?.length;
  const recent = series ? series.slice(-20).filter((d) => d.x).length : 0;

  const verdict =
    rolling.signal === "GREEN"
      ? "ตรงกับที่เกิดจริง — ใช้ตัวเลขขาดทุนได้ตามที่เขียน"
      : rolling.signal === "YELLOW"
        ? "ประเมินต่ำเล็กน้อย — อ่านตัวเลขขาดทุนเป็นค่าขั้นต่ำ"
        : "ประเมินต่ำชัดเจน — ขาดทุนจริงเกินเส้นบ่อยกว่าที่โมเดลบอกมาก";
  const tone =
    rolling.signal === "GREEN"
      ? colors.positive
      : rolling.signal === "YELLOW"
        ? "#FFB300"
        : P.breach;

  let chart: React.ReactNode = null;
  if (series?.length) {
    const W = 600;
    const H = 120;
    const top = Math.max(...series.map((d) => d.r), 0) * 1.08 || 1;
    const bot = Math.min(...series.map((d) => Math.min(d.r, d.v)), 0) * 1.08 || -1;
    const y = (v: number) => ((top - v) / (top - bot)) * H;
    const step = W / series.length;
    const bar = Math.max(1, step - (step > 4 ? 2 : 0.5));
    const line = series
      .map(
        (d, i) =>
          `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(d.v).toFixed(1)} H${((i + 1) * step).toFixed(1)}`
      )
      .join(" ");
    chart = (
      <div>
        <div className="flex items-stretch gap-1">
          <div
            className="flex flex-col justify-between tabular-nums text-right"
            style={{ color: colors.textSecondary, fontSize: 8.5, width: 34 }}
          >
            <span>+{top.toFixed(1)}%</span>
            <span>{bot.toFixed(1)}%</span>
          </div>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="flex-1"
            style={{ height: H, display: "block" }}
            role="img"
            aria-label={`ผลตอบแทนรายวัน ${series.length} วันเทียบเส้น VaR; เกินเส้น ${rolling.exceptions} วัน`}
          >
            <line
              x1={0}
              x2={W}
              y1={y(0)}
              y2={y(0)}
              stroke={colors.textSecondary}
              strokeWidth={1}
              opacity={0.5}
              vectorEffect="non-scaling-stroke"
            />
            {series.map((d, i) => (
              <rect
                key={d.d}
                x={i * step + (step - bar) / 2}
                width={bar}
                y={Math.min(y(d.r), y(0))}
                height={Math.max(0.6, Math.abs(y(d.r) - y(0)))}
                fill={d.x ? P.breach : P.money}
                opacity={d.x ? 1 : 0.5}
              >
                <title>{`${d.d}\nพอร์ต ${signed(d.r, 2)}%\nเส้น VaR ${d.v.toFixed(2)}%${d.x ? "\nเกินเส้น" : ""}`}</title>
              </rect>
            ))}
            <path
              d={line}
              fill="none"
              stroke={P.risk}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
        <div
          className="flex justify-between tabular-nums"
          style={{ color: colors.textSecondary, fontSize: 8.5, marginLeft: 38 }}
        >
          <span>{series[0].d}</span>
          <span>{series[series.length - 1].d}</span>
        </div>
      </div>
    );
  }

  return (
    <Shell colors={colors} title="โมเดลเชื่อได้แค่ไหน">
      {insufficient ? (
        <Headline colors={colors}>ประวัติราคายังสั้นเกินไปที่จะทดสอบเส้น VaR ย้อนหลัง</Headline>
      ) : (
        <>
          <Headline colors={colors}>
            <b>
              เกินเส้น VaR {rolling.exceptions} วัน ใน {obs} วัน
            </b>{" "}
            (ควรเป็นราว {expected.toFixed(0)}) → <b style={{ color: tone }}>{verdict}</b>
          </Headline>
          <Legend
            colors={colors}
            items={[
              { color: P.money, label: "ผลตอบแทนรายวันของพอร์ต", shape: "bar" },
              { color: P.breach, label: "วันที่เกินเส้น", shape: "bar" },
              {
                color: P.risk,
                label: `เส้น VaR ${(confidence * 100).toFixed(0)}% ของวันนั้น`,
                shape: "line",
              },
            ]}
          />
          {chart}
          <div style={{ color: colors.text, fontSize: 9.5 }}>
            {recent > 0
              ? `${recent} ครั้งเกิดใน 20 วันล่าสุด${recent >= 3 ? " — กระจุกตัว: ตลาดเปลี่ยนเร็วกว่าที่หน้าต่างย้อนหลังตามทัน" : ""}`
              : "20 วันล่าสุดไม่เกินเส้นเลย"}
            {" · "}
            {rolling.kupiec >= 0.05
              ? `ทางสถิติยังไม่ถึงขั้นบอกว่าโมเดลผิด (Kupiec p ${rolling.kupiec.toFixed(2)})`
              : `ทางสถิติถือว่าโมเดลผิด (Kupiec p ${rolling.kupiec.toFixed(3)})`}
          </div>
          <div style={{ color: colors.textSecondary, opacity: 0.8, fontSize: 8.5 }}>
            แต่ละวันเทียบกับเส้นที่คำนวณจากวันก่อนหน้าเท่านั้น (out-of-sample) · เป็นพอร์ตที่ถือวันนี้ย้อนหลัง
            ไม่ใช่พอร์ตที่ถือจริงในวันนั้น — ตัวทดสอบของจริงคือบันทึกด้านล่าง
          </div>
        </>
      )}
      {children}
    </Shell>
  );
}

// ── 4. Which holdings move together ──────────────────────────────────────────

const PAIRS_ONLY_MAX = 6;

/** Order symbols so that neighbours are the ones that move together. */
function clusterOrder(matrix: number[][]): number[] {
  const n = matrix.length;
  if (n <= 2) return matrix.map((_, i) => i);
  const avg = matrix.map((row, i) => row.reduce((s, v, j) => (i === j ? s : s + v), 0) / (n - 1));
  let cur = avg.indexOf(Math.max(...avg));
  const order = [cur];
  const left = new Set(matrix.map((_, i) => i).filter((i) => i !== cur));
  while (left.size) {
    let best = -1;
    for (const j of left) if (best < 0 || matrix[cur][j] > matrix[cur][best]) best = j;
    order.push(best);
    left.delete(best);
    cur = best;
  }
  return order;
}

export function CoMoveBlock({
  symbols,
  matrix,
  colors,
}: { symbols: string[]; matrix: number[][]; colors: Colors }) {
  const P = palette(colors);
  const n = symbols.length;
  if (n < 2) return null;

  const pairs: { a: string; b: string; v: number }[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) pairs.push({ a: symbols[i], b: symbols[j], v: matrix[i][j] });
  pairs.sort((p, q) => q.v - p.v);
  const avg = pairs.reduce((s, p) => s + p.v, 0) / pairs.length;
  const topPair = pairs[0];
  const low = pairs[pairs.length - 1];
  const verdict =
    avg >= 0.6
      ? "ทั้งพอร์ตขยับเกือบเป็นตัวเดียว — การกระจายช่วยได้น้อย"
      : avg >= 0.35
        ? "ขยับไปทางเดียวกันพอสมควร"
        : "โดยรวมค่อนข้างเป็นอิสระต่อกัน";

  // Diverging: amber = together (adds risk), blue = opposite (offsets), no hue near zero.
  const cell = (v: number) => {
    const a = Math.min(1, Math.abs(v));
    if (a < 0.15) return "transparent";
    const hex = Math.round((0.15 + a * 0.75) * 255)
      .toString(16)
      .padStart(2, "0");
    return `${v >= 0 ? P.risk : P.money}${hex}`;
  };

  const pairRow = (p: { a: string; b: string; v: number }) => (
    <div
      key={`${p.a}|${p.b}`}
      className="grid items-center gap-2 hover:bg-white/5"
      style={{ gridTemplateColumns: "120px minmax(0,1fr) 40px", height: 18 }}
      title={`${p.a} กับ ${p.b}: สหสัมพันธ์ ${p.v.toFixed(2)}\n1 = ขยับด้วยกันทุกวัน · 0 = ไม่เกี่ยวกัน · ติดลบ = สวนทาง`}
    >
      <span className="truncate" style={{ color: colors.text, fontSize: 9.5 }}>
        <b>{p.a}</b> – <b>{p.b}</b>
      </span>
      <div className="relative" style={{ height: 8 }}>
        <div
          className="absolute"
          style={{
            left: "50%",
            top: -2,
            bottom: -2,
            width: 1,
            background: colors.textSecondary,
            opacity: 0.6,
          }}
        />
        <div
          className="absolute top-0 bottom-0"
          style={{
            left: p.v >= 0 ? "50%" : `${50 + p.v * 50}%`,
            width: `${Math.abs(p.v) * 50}%`,
            background: p.v >= 0 ? P.risk : P.money,
            borderRadius: p.v >= 0 ? "0 3px 3px 0" : "3px 0 0 3px",
          }}
        />
      </div>
      <span
        className="tabular-nums text-right font-bold"
        style={{ color: colors.text, fontSize: 9.5 }}
      >
        {p.v.toFixed(2)}
      </span>
    </div>
  );

  const order = clusterOrder(matrix);
  const short = (s: string) => (s.length > 6 ? s.slice(0, 6) : s);

  return (
    <Shell colors={colors} title="ตัวไหนขยับด้วยกัน">
      <Headline colors={colors}>
        <b>
          ขยับด้วยกันมากสุด: {topPair.a} – {topPair.b} ({topPair.v.toFixed(2)})
        </b>{" "}
        · เฉลี่ยทั้งพอร์ต {avg.toFixed(2)} — {verdict}
        {low.v < 0.15 && pairs.length > 1 && (
          <>
            {" "}
            · แทบไม่เกี่ยวกัน: {low.a} – {low.b} ({low.v.toFixed(2)})
          </>
        )}
      </Headline>
      <Legend
        colors={colors}
        items={[
          { color: P.risk, label: "ขยับด้วยกัน (เพิ่มความเสี่ยง)", shape: "bar" },
          { color: P.money, label: "สวนทาง (หักล้างกัน)", shape: "bar" },
        ]}
      />
      {n <= PAIRS_ONLY_MAX ? (
        <div className="flex flex-col">{pairs.map(pairRow)}</div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <div className="overflow-x-auto max-w-full">
            <table style={{ borderCollapse: "separate", borderSpacing: 2 }}>
              <thead>
                <tr>
                  <th />
                  {order.map((j) => (
                    <th
                      key={symbols[j]}
                      className="font-normal"
                      style={{ color: colors.textSecondary, fontSize: 8, minWidth: 30 }}
                    >
                      {short(symbols[j])}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {order.map((i) => (
                  <tr key={symbols[i]}>
                    <td
                      className="text-right pr-1 font-bold"
                      style={{ color: colors.text, fontSize: 8.5 }}
                    >
                      {short(symbols[i])}
                    </td>
                    {order.map((j) => (
                      <td
                        key={symbols[j]}
                        className="text-center tabular-nums"
                        title={
                          i === j
                            ? symbols[i]
                            : `${symbols[i]} – ${symbols[j]}: ${matrix[i][j].toFixed(2)}`
                        }
                        style={{
                          width: 30,
                          height: 20,
                          fontSize: 8,
                          borderRadius: 2,
                          background: i === j ? `${colors.border}66` : cell(matrix[i][j]),
                          color: i === j ? colors.textSecondary : colors.text,
                        }}
                      >
                        {/* a number only where there is a relation to read */}
                        {i === j || Math.abs(matrix[i][j]) < 0.15 ? "" : matrix[i][j].toFixed(1)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col min-w-0 flex-1" style={{ minWidth: 240 }}>
            <span style={{ color: colors.textSecondary, fontSize: 8.5 }}>ขยับด้วยกันมากสุด</span>
            {pairs.slice(0, 5).map(pairRow)}
            <span className="mt-1" style={{ color: colors.textSecondary, fontSize: 8.5 }}>
              เป็นอิสระต่อกันมากสุด
            </span>
            {pairs.slice(-3).reverse().map(pairRow)}
          </div>
        </div>
      )}
      <div style={{ color: colors.textSecondary, opacity: 0.8, fontSize: 8.5 }}>
        สหสัมพันธ์ของผลตอบแทนรายวัน (Ledoit-Wolf) · 1 = ขยับด้วยกันทุกวัน · 0 = ไม่เกี่ยวกัน · ติดลบ = สวนทาง
        {n > PAIRS_ONLY_MAX && " · ตารางเรียงให้ตัวที่ขยับด้วยกันอยู่ติดกัน"}
      </div>
    </Shell>
  );
}
