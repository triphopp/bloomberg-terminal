"use client";

/**
 * 10Y YIELD DECOMPOSITION — which piece of the yield is moving it.
 *
 *   10Y ≈ expected real short rate (Fed path, r*) + breakeven (inflation) + term premium
 *
 * The level alone says little; the same +30bp is benign when real rates lead
 * (growth + firm Fed), dangerous when term premium leads (fiscal / supply fear)
 * and worst when breakeven leads (inflation back, Fed doubted). This panel
 * names the driver, shows each piece against 20 years, and lists the three
 * numbers that would flip the read. Backend: `backend/bond_decomposition.py`.
 */

import { useState } from "react";
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
// Charts below the fold mount when scrolled near — see LazyResponsiveContainer.
import { LazyResponsiveContainer as ResponsiveContainer } from "../../ui/LazyResponsiveContainer";

import type { BondDecomposition, DecompContext, DecompPiece, DecompWire } from "./types";
import { C, Panel, bpColor, fmtBp, fmtDate } from "./ui";

const PIECE = {
  REAL: { label: "EXPECTED REAL", short: "REAL", color: "#60A5FA" },
  BE: { label: "BREAKEVEN", short: "BE", color: "#FBBF24" },
  TP: { label: "TERM PREMIUM", short: "TP", color: "#C084FC" },
} as const satisfies Record<DecompPiece, unknown>;

const SEVERITY_COLOR = ["#777", C.down, "#FF9800", C.up];
const STATUS_COLOR: Record<DecompWire["status"], string> = {
  OK: C.down,
  WATCH: "#FFC107",
  BREACH: C.up,
  NA: "#555",
};

const AXIS = { fontSize: 9, fontFamily: "monospace", fill: C.dim };
const TT = {
  backgroundColor: "#0a0a0a",
  border: "1px solid #2a2a2a",
  fontSize: 10,
  fontFamily: "monospace",
};

const pct = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${v.toFixed(d)}%`);

// ── Stack bar: the three pieces of today's yield ──────────────────────────────

function StackBar({ d }: { d: BondDecomposition }) {
  const p = d.snapshot.pieces;
  if (!p) return <span style={{ color: C.dim, fontSize: 10 }}>no model data</span>;
  const parts: { k: DecompPiece; v: number; share: number | null }[] = [
    { k: "REAL", v: p.expReal, share: p.share.expReal },
    { k: "BE", v: p.breakeven, share: p.share.breakeven },
    { k: "TP", v: p.termPremium, share: p.share.termPremium },
  ];
  const pos = parts.reduce((s, x) => s + Math.max(x.v, 0), 0) || 1;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-5 w-full overflow-hidden" style={{ background: "#0d0d0d" }}>
        {parts
          .filter((x) => x.v > 0)
          .map((x) => (
            <div
              key={x.k}
              title={`${PIECE[x.k].label} ${pct(x.v)}`}
              style={{
                width: `${(100 * x.v) / pos}%`,
                background: PIECE[x.k].color,
                opacity: 0.8,
              }}
            />
          ))}
      </div>
      <div className="grid grid-cols-3 gap-2" style={{ fontSize: 10 }}>
        {parts.map((x) => (
          <div key={x.k} className="flex flex-col">
            <span style={{ color: PIECE[x.k].color, fontSize: 9, letterSpacing: "0.06em" }}>
              {PIECE[x.k].label}
            </span>
            <span style={{ color: "#ddd", fontSize: 14 }}>
              {pct(x.v, x.k === "TP" ? 3 : 2)}
              <span style={{ color: C.dim, fontSize: 9 }}> {x.share ?? "—"}%</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Two lenses + the double-count trap ────────────────────────────────────────

function Lenses({ d }: { d: BondDecomposition }) {
  const { market, model, doubleCount } = d.snapshot;
  const row = (label: string, body: string, note: string) => (
    <div className="flex gap-2" style={{ fontSize: 10 }}>
      <span style={{ color: C.label, width: 52 }}>{label}</span>
      <span style={{ color: "#ccc" }}>{body}</span>
      <span className="ml-auto" style={{ color: C.dim, fontSize: 9 }}>
        {note}
      </span>
    </div>
  );
  return (
    <div className="flex flex-col gap-0.5">
      {market &&
        row(
          "MARKET",
          `${pct(market.nominal)} = ${pct(market.real)} real + ${pct(market.breakeven)} BE`,
          `TIPS · ${market.asOf}`
        )}
      {model &&
        row(
          "MODEL",
          `${pct(model.fitted)} = ${pct(model.expected)} expected + ${pct(model.termPremium, 3)} TP`,
          `${d.model} zero · ${model.asOf}`
        )}
      {doubleCount && (
        <div style={{ fontSize: 9, color: C.dim }}>
          ✕ real + BE + TP = {pct(doubleCount.stacked)} — เกิน yield จริง{" "}
          <span style={{ color: "#FF9800" }}>{fmtBp(doubleCount.overshoot_bp)}bp</span> เพราะนับ TP
          ซ้ำ (TIPS real มี real TP อยู่แล้ว, BE มี inflation risk premium ที่ {d.model} นับรวมใน TP) —
          ห้ามบวกสองมุมมองเข้าด้วยกัน
        </div>
      )}
    </div>
  );
}

// ── Attribution: which piece moved, per window ────────────────────────────────

function Attribution({ d }: { d: BondDecomposition }) {
  const cols = "38px repeat(5, minmax(0,1fr)) 44px 64px";
  return (
    <div className="flex flex-col gap-0.5">
      <div
        className="grid"
        style={{ gridTemplateColumns: cols, fontSize: 9, color: C.dim, columnGap: 4 }}
      >
        <span>Δ bp</span>
        <span className="text-right">10Y</span>
        <span className="text-right" title="TIPS real yield (market lens)">
          TIPS
        </span>
        <span className="text-right" style={{ color: PIECE.BE.color }}>
          BE
        </span>
        <span className="text-right" style={{ color: PIECE.REAL.color }} title="ACM expected − BE">
          EXP RL
        </span>
        <span className="text-right" style={{ color: PIECE.TP.color }}>
          TP
        </span>
        <span className="text-right" title="share of the TIPS-lens move that came from real yield">
          REAL%
        </span>
        <span className="text-right">DRIVER</span>
      </div>
      {d.attribution.map((a) => {
        const drv = a.driver ? PIECE[a.driver] : null;
        return (
          <div
            key={a.days}
            className="grid"
            style={{ gridTemplateColumns: cols, fontSize: 10, columnGap: 4 }}
            title={`market since ${a.since ?? "—"} · model since ${a.modelSince ?? "—"}`}
          >
            <span style={{ color: C.label }}>{a.days}D</span>
            <span className="text-right" style={{ color: bpColor(a.dNominal_bp) }}>
              {fmtBp(a.dNominal_bp)}
            </span>
            <span className="text-right" style={{ color: bpColor(a.dReal_bp) }}>
              {fmtBp(a.dReal_bp)}
            </span>
            <span className="text-right" style={{ color: bpColor(a.dBE_bp) }}>
              {fmtBp(a.dBE_bp)}
            </span>
            <span className="text-right" style={{ color: bpColor(a.dExpReal_bp) }}>
              {fmtBp(a.dExpReal_bp)}
            </span>
            <span className="text-right" style={{ color: bpColor(a.dTP_bp) }}>
              {fmtBp(a.dTP_bp)}
            </span>
            <span className="text-right" style={{ color: "#aaa" }}>
              {a.realShare == null ? "—" : `${a.realShare}%`}
            </span>
            <span className="text-right" style={{ color: drv?.color ?? "#555" }}>
              {drv?.short ?? "quiet"}
            </span>
          </div>
        );
      })}
      <span style={{ color: "#555", fontSize: 9 }}>
        TIPS/BE = มุมราคาตลาด (FRED) · EXP RL/TP = {d.model} · driver = ชิ้นที่ขยับมากสุดในทิศเดียวกับ yield
        (|Δ| ≥ 10bp)
      </span>
    </div>
  );
}

// ── Tripwires ─────────────────────────────────────────────────────────────────

function Tripwires({ d }: { d: BondDecomposition }) {
  const { wires, flip, flipNote } = d.tripwires;
  return (
    <div className="flex flex-col gap-1">
      {wires.map((w) => (
        <div key={w.id} className="flex flex-col" style={{ fontSize: 10 }}>
          <div className="flex items-baseline gap-2">
            <span style={{ color: STATUS_COLOR[w.status], width: 46 }}>{w.status}</span>
            <span style={{ color: "#ccc" }}>{w.label}</span>
            <span className="ml-auto" style={{ color: "#ddd" }}>
              {pct(w.value, w.piece === "TP" ? 3 : 2)}
              <span style={{ color: C.dim }}> / {pct(w.level, w.piece === "TP" ? 3 : 2)}</span>
            </span>
          </div>
          <div className="flex gap-2" style={{ fontSize: 9, color: C.dim, paddingLeft: 54 }}>
            <span>{w.levelNote}</span>
            <span className="ml-auto">
              {w.gap_bp == null ? "" : w.gap_bp > 0 ? `${w.gap_bp.toFixed(0)}bp to go` : "through"}
              {w.tpRoom_bp != null && ` · TP alone has ${w.tpRoom_bp.toFixed(0)}bp room`}
            </span>
          </div>
        </div>
      ))}
      <span style={{ color: flip ? C.up : "#555", fontSize: 9 }}>
        {flip ? flipNote : "ข้อ 1 + 2 ทะลุพร้อมกัน = เรื่องหนี้/เงินเฟ้อกลายเป็นตัวหลัก → เปลี่ยนมุมมอง"}
      </span>
    </div>
  );
}

// ── 20-year context ───────────────────────────────────────────────────────────

const CTX_ROWS: { key: keyof BondDecomposition["context"]; label: string; dp: number }[] = [
  { key: "nominal", label: "UST 10Y", dp: 2 },
  { key: "real", label: "TIPS REAL", dp: 2 },
  { key: "breakeven", label: "BREAKEVEN", dp: 2 },
  { key: "termPremium", label: "TERM PREM", dp: 3 },
];

const CELL_KEYS = ["avg", "low", "high", "pctile", "ago10"] as const;

function LongRun({ d, now }: { d: BondDecomposition; now: Record<string, number | undefined> }) {
  const cols = "72px repeat(6, minmax(0,1fr))";
  const cell = (c: DecompContext, dp: number) => {
    const y = c.y20 ?? c.y10;
    return [
      pct(y?.avg, dp),
      y ? `${pct(y.min, dp)} ${y.minDate.slice(2, 7)}` : "—",
      y ? `${pct(y.max, dp)} ${y.maxDate.slice(2, 7)}` : "—",
      y ? `P${y.pctile}` : "—",
      pct(c.ago10?.value, dp),
    ];
  };
  return (
    <div className="flex flex-col gap-0.5">
      <div
        className="grid"
        style={{ gridTemplateColumns: cols, fontSize: 9, color: C.dim, columnGap: 4 }}
      >
        <span />
        <span className="text-right">NOW</span>
        <span className="text-right">20Y AVG</span>
        <span className="text-right">20Y LOW</span>
        <span className="text-right">20Y HIGH</span>
        <span className="text-right">PCTILE</span>
        <span className="text-right">10Y AGO</span>
      </div>
      {CTX_ROWS.map((r) => {
        const c = d.context[r.key];
        if (!c) return null;
        return (
          <div
            key={r.key}
            className="grid"
            style={{ gridTemplateColumns: cols, fontSize: 10, columnGap: 4 }}
            title={c.y20 ? `since ${c.y20.since}` : "under 20y of history"}
          >
            <span style={{ color: C.label }}>{r.label}</span>
            <span className="text-right" style={{ color: C.amber }}>
              {pct(now[r.key], r.dp)}
            </span>
            {cell(c, r.dp).map((v, i) => (
              <span key={CELL_KEYS[i]} className="text-right" style={{ color: "#aaa" }}>
                {v}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── Stacked history ───────────────────────────────────────────────────────────

function StackChart({ d, days }: { d: BondDecomposition; days: number }) {
  const rows = d.history.slice(-days);
  return (
    <ResponsiveContainer width="100%" height={200}>
      <ComposedChart
        data={rows}
        stackOffset="sign"
        margin={{ top: 6, right: 8, left: 0, bottom: 0 }}
      >
        <CartesianGrid vertical={false} stroke="#141414" />
        <XAxis dataKey="date" tick={AXIS} tickFormatter={fmtDate} minTickGap={40} />
        <YAxis tick={AXIS} width={32} domain={["auto", "auto"]} />
        <ReferenceLine y={0} stroke="#333" />
        <Tooltip
          contentStyle={TT}
          labelStyle={{ color: "#aaa" }}
          formatter={(v: number, name: string) => [
            typeof v === "number" ? `${v.toFixed(name === "termPremium" ? 3 : 2)}%` : "—",
            {
              expReal: "EXP REAL",
              breakeven: "BREAKEVEN",
              termPremium: "TERM PREM",
              nominal: "UST 10Y",
            }[name] ?? name,
          ]}
        />
        <Area
          dataKey="expReal"
          stackId="y"
          stroke={PIECE.REAL.color}
          fill={PIECE.REAL.color}
          fillOpacity={0.35}
          isAnimationActive={false}
          connectNulls
        />
        <Area
          dataKey="breakeven"
          stackId="y"
          stroke={PIECE.BE.color}
          fill={PIECE.BE.color}
          fillOpacity={0.3}
          isAnimationActive={false}
          connectNulls
        />
        <Area
          dataKey="termPremium"
          stackId="y"
          stroke={PIECE.TP.color}
          fill={PIECE.TP.color}
          fillOpacity={0.35}
          isAnimationActive={false}
          connectNulls
        />
        <Line
          dataKey="nominal"
          stroke="#eee"
          strokeWidth={1.2}
          dot={false}
          connectNulls
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function DecompositionPanel({
  data,
  error,
  isLoading,
  days,
}: {
  data: BondDecomposition | undefined;
  error: unknown;
  isLoading: boolean;
  days: number;
}) {
  const [showRead, setShowRead] = useState(true);
  if (isLoading || !data || !data.ok) {
    return (
      <Panel title="10Y YIELD DECOMPOSITION">
        <span style={{ color: error || data?.ok === false ? "#FF4444" : "#666", fontSize: 10 }}>
          {isLoading
            ? "LOADING FRED + NY FED ACM…"
            : `FAILED — ${data?.detail ?? String(error ?? "no data")}`}
        </span>
      </Panel>
    );
  }
  const drv = data.driver;
  const m = data.snapshot.market;
  const now = {
    nominal: m?.nominal,
    real: m?.real,
    breakeven: m?.breakeven,
    termPremium: data.snapshot.model?.termPremium,
  };

  return (
    <Panel
      title="10Y YIELD DECOMPOSITION"
      note={`expected real + breakeven + term premium · ${data.modelNote}`}
      right={
        <button
          type="button"
          onClick={() => setShowRead((v) => !v)}
          style={{ color: showRead ? C.amber : "#555", fontSize: 9 }}
        >
          READ
        </button>
      }
    >
      {/* Driver verdict */}
      <div className="flex items-baseline gap-3 flex-wrap" style={{ fontSize: 11 }}>
        <span style={{ color: C.label, fontSize: 9 }}>20D DRIVER</span>
        <span
          style={{ color: SEVERITY_COLOR[drv.severity], fontSize: 14, letterSpacing: "0.06em" }}
        >
          {drv.label}
        </span>
        <span style={{ color: "#aaa" }}>{drv.case}</span>
        {showRead && (
          <span className="basis-full" style={{ color: "#8a8a8a", fontSize: 10 }}>
            {drv.read}
          </span>
        )}
      </div>

      <div className="grid gap-3 grid-cols-1 xl:grid-cols-3 mt-1">
        <div className="flex flex-col gap-2 min-w-0">
          <StackBar d={data} />
          <Lenses d={data} />
        </div>
        <div className="min-w-0">
          <Attribution d={data} />
        </div>
        <div className="min-w-0">
          <Tripwires d={data} />
        </div>
      </div>

      <div className="grid gap-3 grid-cols-1 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] mt-1">
        <div className="min-w-0">
          <div className="flex gap-3" style={{ fontSize: 9 }}>
            {(Object.keys(PIECE) as DecompPiece[]).map((k) => (
              <span key={k} style={{ color: PIECE[k].color }}>
                ■ {PIECE[k].label}
              </span>
            ))}
            <span style={{ color: "#eee" }}>— UST 10Y</span>
          </div>
          <StackChart d={data} days={days} />
        </div>
        <div className="min-w-0 flex flex-col gap-1">
          <LongRun d={data} now={now} />
          {showRead && (
            <span style={{ color: "#555", fontSize: 9 }}>
              ข่าวเข้าชิ้นไหน: Fed / r* / เศรษฐกิจโต → EXP REAL · ความน่าเชื่อถือ Fed → BE (และกด inflation
              risk ใน TP) · ขาดดุล / อุปทานบอนด์ / Big Tech ออกหุ้นกู้ / ต่างชาติซื้อน้อย → TP ·
              flight-to-safety กด TP, supply shock ดัน BE+TP. EXP REAL = {data.model} expected − BE
              เป็นค่าประมาณ (BE กับ TP ซ้อนกันที่ inflation risk premium)
            </span>
          )}
        </div>
      </div>
    </Panel>
  );
}
