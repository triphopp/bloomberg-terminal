"use client";
import type { CSSProperties } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LazyResponsiveContainer as ResponsiveContainer } from "../../../ui/LazyResponsiveContainer";
import { type Colors, fmtAmt, fmtAxis, fmtPx, fmtQty, pnlColor } from "../helpers";
import type { AssetChange, ChangeKind, DividendGrowth, TtmPoint } from "./dividend-growth";

// The body of PORT → ANALYTICS → DIVIDEND GROWTH. All figures come from
// `dividend-growth.ts`; this file only lays them out.

const PAID_COLOR = "#4ade80";
const TTM_COLOR = "#60a5fa";
const PARTIAL_COLOR = "#71717a";
const UP = "#22c55e";
const DOWN = "#ef4444";
const TOTAL_COLOR = "#a1a1aa";

const KIND_LABEL: Record<ChangeKind, { text: string; color: string; hint: string }> = {
  NEW: { text: "NEW", color: UP, hint: "ไม่ได้ปันผลในช่วงก่อน — ซื้อเข้ามาใหม่ หรือเพิ่งจ่ายครั้งแรก" },
  STOPPED: {
    text: "STOPPED",
    color: DOWN,
    hint: "ได้ปันผลในช่วงก่อน แต่ช่วงนี้ไม่ได้ — ขายไปแล้ว หรือบริษัทงดจ่าย",
  },
  DPS_UP: { text: "DPS ↑", color: UP, hint: "บริษัทจ่ายปันผลต่อหุ้นมากขึ้น" },
  DPS_DOWN: { text: "DPS ↓", color: DOWN, hint: "บริษัทจ่ายปันผลต่อหุ้นน้อยลง" },
  UNITS_UP: {
    text: "MORE UNITS",
    color: TTM_COLOR,
    hint: "ถือหุ้นมากขึ้น — เงินที่เราใส่เพิ่ม ไม่ใช่บริษัทจ่ายเพิ่ม",
  },
  UNITS_DOWN: { text: "FEWER UNITS", color: "#f59e0b", hint: "ถือหุ้นน้อยลง" },
  FX: { text: "FX", color: "#a78bfa", hint: "ปันผลเท่าเดิมในสกุลหุ้น — ต่างเพราะค่าเงิน" },
  SAME: { text: "SAME", color: PARTIAL_COLOR, hint: "เท่าเดิม" },
};

const signed = (sym: string, v: number) => `${v >= 0 ? "+" : "−"}${sym}${fmtAmt(Math.abs(v))}`;

function Swatch({
  color,
  dashed = false,
  bar = false,
}: { color: string; dashed?: boolean; bar?: boolean }) {
  return (
    <svg
      width={bar ? 8 : 16}
      height={8}
      className="inline-block align-middle mr-1"
      aria-hidden="true"
    >
      {bar ? (
        <rect x={0} y={0} width={8} height={8} fill={color} fillOpacity={0.5} />
      ) : (
        <line
          x1={0}
          y1={4}
          x2={16}
          y2={4}
          stroke={color}
          strokeWidth={2}
          strokeDasharray={dashed ? "4 3" : undefined}
        />
      )}
    </svg>
  );
}

function Kpi({
  label,
  value,
  color,
  sub,
  title,
  colors,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
  title?: string;
  colors: Colors;
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[8px] tracking-wider" style={{ color: colors.textSecondary }}>
        {label}
      </div>
      <div className="text-[12px] font-bold" style={{ color: color ?? colors.text }}>
        {value}
      </div>
      {sub && (
        <div className="text-[8px] truncate" style={{ color: "#666" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export function DividendGrowthPanel({
  growth,
  ttm,
  colors,
  sym,
  tooltipContentStyle,
}: {
  growth: DividendGrowth;
  ttm: TtmPoint[];
  colors: Colors;
  sym: string;
  tooltipContentStyle: Record<string, unknown>;
}) {
  const g = growth;
  const span = (w: { start: string; end: string }) => `${w.start} → ${w.end}`;

  // The TTM line is drawn grey and dashed while it still holds fewer than 12
  // months; the two parts share the first full point so the line is unbroken.
  const firstFull = ttm.findIndex((p) => !p.partial);
  const ttmChart = ttm.map((p, i) => ({
    month: p.month,
    paid: p.paid,
    full: p.partial ? null : p.ttm,
    partial: p.partial || i === firstFull ? p.ttm : null,
  }));

  const b = g.bridge;
  const steps: [string, number, string][] = [
    ["NEW", b.newPayers, "หุ้นที่ช่วงก่อนไม่ได้ปันผล"],
    ["STOPPED", b.stopped, "หุ้นที่ช่วงนี้ไม่ได้ปันผลแล้ว"],
    ["FX", b.fx, "ผลจากค่าเงิน (หุ้นต่างประเทศ)"],
    ["UNITS", b.units, "ถือหุ้นมากขึ้น/น้อยลง ในหุ้นที่ได้ปันผลทั้งสองช่วง"],
    ["DPS", b.dps, "บริษัทจ่ายปันผลต่อหุ้นมากขึ้น/น้อยลง — การเติบโตของปันผลจริงๆ"],
  ];
  let level = b.prior;
  const bridgeChart = [
    { name: "PRIOR", range: [0, b.prior], value: b.prior, color: TOTAL_COLOR, hint: span(g.prior) },
    ...steps.map(([name, v, hint]) => {
      const from = level;
      level += v;
      return {
        name,
        range: [Math.min(from, level), Math.max(from, level)],
        value: v,
        color: v >= 0 ? UP : DOWN,
        hint,
      };
    }),
    {
      name: "NOW",
      range: [0, b.current],
      value: b.current,
      color: TOTAL_COLOR,
      hint: span(g.current),
    },
  ];

  const growthColor = g.growthPct == null ? colors.text : pnlColor(g.growthPct);
  const organicPct = b.prior > 0 ? (b.dps / b.prior) * 100 : null;

  return (
    <div className="flex flex-col gap-2 font-mono">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-x-4 gap-y-2">
        <Kpi
          colors={colors}
          label={g.mode === "TTM" ? "LAST 12 MONTHS" : "THIS YEAR TO DATE"}
          value={`${sym}${fmtAmt(g.totalCurrent)}`}
          sub={span(g.current)}
        />
        <Kpi
          colors={colors}
          label="SAME PERIOD BEFORE"
          value={`${sym}${fmtAmt(g.totalPrior)}`}
          sub={span(g.prior)}
        />
        <Kpi
          colors={colors}
          label="GROWTH"
          value={
            g.growthPct == null ? "—" : `${g.growthPct >= 0 ? "+" : ""}${g.growthPct.toFixed(2)}%`
          }
          color={growthColor}
          sub={
            g.growthPct == null ? "no payout before" : signed(sym, g.totalCurrent - g.totalPrior)
          }
        />
        <Kpi
          colors={colors}
          label="FROM DPS RAISES"
          value={
            organicPct == null ? "—" : `${organicPct >= 0 ? "+" : ""}${organicPct.toFixed(2)}%`
          }
          color={organicPct == null ? colors.text : pnlColor(organicPct)}
          sub={signed(sym, b.dps)}
          title="ส่วนที่บริษัทจ่ายปันผลต่อหุ้นเพิ่มขึ้น เทียบกับช่วงก่อน — ไม่นับการซื้อหุ้นเพิ่ม หุ้นใหม่ หรือค่าเงิน"
        />
        <Kpi
          colors={colors}
          label="PAYERS"
          value={`${g.payersCurrent}`}
          sub={`before ${g.payersPrior}`}
          title="จำนวนหุ้นที่จ่ายปันผลให้ในแต่ละช่วง"
        />
        <Kpi
          colors={colors}
          label="DPS RAISED · CUT · HELD"
          value={`${g.dpsRaised} · ${g.dpsCut} · ${g.dpsHeld}`}
          color={g.dpsCut > g.dpsRaised ? DOWN : g.dpsRaised > 0 ? UP : colors.text}
          sub="stocks paid in both periods"
          title="หุ้นที่ได้ปันผลทั้งสองช่วง: ปันผลต่อหุ้นเพิ่ม · ลด · เท่าเดิม (±0.5%)"
        />
      </div>

      {g.priorIncomplete && (
        <div className="text-[8px]" style={{ color: "#f59e0b" }}>
          ⚠ ช่วงก่อนหน้าเริ่ม {g.prior.start} แต่ปันผลแรกที่บันทึกไว้คือ {g.firstPayout} —
          ถ้าก่อนหน้านั้นมีปันผลที่ไม่ได้บันทึก GROWTH จะสูงเกินจริง
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div className="min-w-0">
          <div
            className="flex flex-wrap items-center gap-x-3 text-[8px] mb-1"
            style={{ color: colors.textSecondary }}
          >
            <span className="font-bold" style={{ color: colors.accent }}>
              TREND
            </span>
            <span style={{ color: TTM_COLOR }}>
              <Swatch color={TTM_COLOR} />
              ROLLING 12 MONTHS
            </span>
            <span
              style={{ color: PARTIAL_COLOR }}
              title="ยังมีข้อมูลไม่ครบ 12 เดือน — เส้นขึ้นเพราะข้อมูลสะสม ไม่ใช่ปันผลโต"
            >
              <Swatch color={PARTIAL_COLOR} dashed />
              &lt; 12 MONTHS OF DATA
            </span>
            <span style={{ color: PAID_COLOR }}>
              <Swatch color={PAID_COLOR} bar />
              PAID IN MONTH
            </span>
          </div>
          <ResponsiveContainer width="100%" height={190}>
            <ComposedChart data={ttmChart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: "#666", fontSize: 7 }} tickLine={false} />
              <YAxis
                tick={{ fill: "#666", fontSize: 7 }}
                tickLine={false}
                axisLine={false}
                domain={[0, "auto"]}
                tickFormatter={(v: number) => fmtAxis(v)}
              />
              <Tooltip
                // biome-ignore lint/suspicious/noExplicitAny: recharts tooltip props
                content={({ active, payload, label }: any) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0].payload as (typeof ttmChart)[number];
                  const t = row.full ?? row.partial;
                  return (
                    <div style={{ ...tooltipContentStyle, padding: "4px 6px" } as CSSProperties}>
                      <div>{label}</div>
                      <div style={{ color: PAID_COLOR }}>
                        PAID {sym}
                        {fmtAmt(row.paid)}
                      </div>
                      <div style={{ color: row.full == null ? PARTIAL_COLOR : TTM_COLOR }}>
                        12 MONTHS {t == null ? "—" : `${sym}${fmtAmt(t)}`}
                        {row.full == null ? " (data < 12 months)" : ""}
                      </div>
                    </div>
                  );
                }}
              />
              <Bar
                dataKey="paid"
                fill={PAID_COLOR}
                fillOpacity={0.45}
                maxBarSize={14}
                isAnimationActive={false}
              />
              <Line
                dataKey="partial"
                stroke={PARTIAL_COLOR}
                strokeWidth={1.4}
                strokeDasharray="4 3"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="full"
                stroke={TTM_COLOR}
                strokeWidth={2.2}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="min-w-0">
          <div
            className="flex flex-wrap items-center gap-x-3 text-[8px] mb-1"
            style={{ color: colors.textSecondary }}
          >
            <span className="font-bold" style={{ color: colors.accent }}>
              WHY IT CHANGED
            </span>
            <span>
              <Swatch color={UP} bar /> ADDED <Swatch color={DOWN} bar /> TOOK AWAY
            </span>
          </div>
          <ResponsiveContainer width="100%" height={130}>
            <BarChart data={bridgeChart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
              <XAxis dataKey="name" tick={{ fill: "#888", fontSize: 7 }} tickLine={false} />
              <YAxis
                tick={{ fill: "#666", fontSize: 7 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => fmtAxis(v)}
              />
              <ReferenceLine y={0} stroke="#444" />
              <Tooltip
                cursor={{ fill: "#ffffff08" }}
                // biome-ignore lint/suspicious/noExplicitAny: recharts tooltip props
                content={({ active, payload }: any) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0].payload as (typeof bridgeChart)[number];
                  const total = row.name === "PRIOR" || row.name === "NOW";
                  return (
                    <div style={{ ...tooltipContentStyle, padding: "4px 6px" } as CSSProperties}>
                      <div style={{ color: row.color }}>
                        {row.name} {total ? `${sym}${fmtAmt(row.value)}` : signed(sym, row.value)}
                      </div>
                      <div style={{ color: "#888" }}>{row.hint}</div>
                    </div>
                  );
                }}
              />
              <Bar dataKey="range" isAnimationActive={false} maxBarSize={36}>
                {bridgeChart.map((r) => (
                  <Cell
                    key={r.name}
                    fill={r.color}
                    fillOpacity={r.name === "PRIOR" || r.name === "NOW" ? 0.55 : 0.8}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <table className="w-full text-[8px] mt-1">
            <tbody>
              {bridgeChart.map((r) => {
                const total = r.name === "PRIOR" || r.name === "NOW";
                return (
                  <tr key={r.name} title={r.hint} style={{ borderBottom: "1px solid #151515" }}>
                    <td
                      className="py-px"
                      style={{ color: total ? colors.text : colors.textSecondary }}
                    >
                      {r.name}
                    </td>
                    <td
                      className="py-px text-right font-bold"
                      style={{ color: total ? colors.text : pnlColor(r.value) }}
                    >
                      {total ? `${sym}${fmtAmt(r.value)}` : signed(sym, r.value)}
                    </td>
                    <td className="py-px pl-2 truncate max-w-[220px]" style={{ color: "#666" }}>
                      {r.hint}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {g.assets.length > 0 && <AssetTable assets={g.assets} colors={colors} sym={sym} />}
    </div>
  );
}

function AssetTable({
  assets,
  colors,
  sym,
}: { assets: AssetChange[]; colors: Colors; sym: string }) {
  const th = (label: string, align: "left" | "right" = "right", title?: string) => (
    <th
      className={`py-1 px-1.5 font-normal sticky top-0 text-${align}`}
      style={{ color: colors.textSecondary, background: "#050505" }}
      title={title}
    >
      {label}
    </th>
  );
  const arrow = (a: number | null, b: number | null, fmt: (n: number) => string) =>
    a == null && b == null ? "—" : `${a == null ? "—" : fmt(a)} → ${b == null ? "—" : fmt(b)}`;
  return (
    <div className="overflow-auto" style={{ maxHeight: 240 }}>
      <table className="w-full text-[9px]">
        <thead>
          <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
            {th("ASSET", "left")}
            {th("BEFORE")}
            {th("NOW")}
            {th("CHANGE")}
            {th("DPS BEFORE → NOW", "right", "ปันผลต่อหุ้นรวมทั้งช่วง ในสกุลเงินของหุ้น")}
            {th("UNITS BEFORE → NOW", "right", "จำนวนหุ้นที่ได้ปันผล (ปันผลรวม ÷ ปันผลต่อหุ้น)")}
            {th("PAYMENTS", "right", "จำนวนครั้งที่จ่าย (ex-date) ในแต่ละช่วง")}
            {th("WHY", "left", "ส่วนที่อธิบายการเปลี่ยนแปลงมากที่สุด")}
          </tr>
        </thead>
        <tbody>
          {assets.map((a) => {
            const kind = KIND_LABEL[a.kind];
            const timing =
              a.paymentsPrior > 0 && a.paymentsCurrent > 0 && a.paymentsPrior !== a.paymentsCurrent;
            return (
              <tr key={a.asset} style={{ borderBottom: "1px solid #151515" }}>
                <td className="py-0.5 px-1.5 font-bold" style={{ color: colors.accent }}>
                  {a.asset}
                  <span className="font-normal ml-1" style={{ color: "#555" }}>
                    {a.currency}
                  </span>
                </td>
                <td className="py-0.5 px-1.5 text-right" style={{ color: colors.textSecondary }}>
                  {a.prior ? `${sym}${fmtAmt(a.prior)}` : "—"}
                </td>
                <td className="py-0.5 px-1.5 text-right" style={{ color: colors.text }}>
                  {a.current ? `${sym}${fmtAmt(a.current)}` : "—"}
                </td>
                <td
                  className="py-0.5 px-1.5 text-right font-bold"
                  style={{ color: pnlColor(a.delta) }}
                >
                  {signed(sym, a.delta)}
                </td>
                <td className="py-0.5 px-1.5 text-right" style={{ color: colors.text }}>
                  {arrow(a.dpsPrior, a.dpsCurrent, fmtPx)}
                </td>
                <td className="py-0.5 px-1.5 text-right" style={{ color: colors.textSecondary }}>
                  {arrow(a.unitsPrior, a.unitsCurrent, fmtQty)}
                </td>
                <td
                  className="py-0.5 px-1.5 text-right"
                  style={{ color: timing ? "#f59e0b" : colors.textSecondary }}
                  title={
                    timing
                      ? "จำนวนครั้งที่จ่ายไม่เท่ากัน — ส่วนหนึ่งอาจเป็นแค่วันจ่ายเลื่อนข้ามช่วง ไม่ใช่ปันผลเพิ่ม/ลดจริง"
                      : undefined
                  }
                >
                  {a.paymentsPrior} → {a.paymentsCurrent}
                  {timing ? " ⚠" : ""}
                </td>
                <td
                  className="py-0.5 px-1.5 font-bold"
                  style={{ color: kind.color }}
                  title={kind.hint}
                >
                  {kind.text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
