"use client";

/**
 * BUSINESS CYCLE — where the US economy stands, read off official indicators.
 *
 * Every row is a published series held against the line its publisher gives
 * (NBER, Sahm, Chicago Fed, NY Fed, OECD, CBO, FOMC); the row opens to the
 * rule as worded at the source, the track record counted from the same
 * history, and what the S&P 500 did after past signals. There is no composite
 * score and no phase of our own making — `backend/cycle.py` explains why.
 *
 * Context for the book, never in the risk level. The lines under WHAT FOLLOWS
 * are tied to a definition, a count from history, or a test in this repo; the
 * sector-by-phase table that used to be the obvious thing to put here was
 * tested and failed (research/sector_allocation/RESULTS.md).
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

type Tone = "good" | "watch" | "bad" | "neutral" | "unknown";

interface Track {
  from: string;
  window: number;
  signals: number;
  false: number;
  false_dates: string[];
  undecided: number;
  recessions: number;
  caught: number;
  missed: number;
  missed_dates: string[];
  median_lead: number | null;
}

interface MarketAfter {
  n: number;
  horizon: number;
  published_after: number;
  median_return: number;
  worst_return: number;
  best_return: number;
  up_share: number;
  median_low: number;
  worst_low: number;
  all_months_median_return: number | null;
  all_months_median_low: number | null;
}

interface Indicator {
  id: string;
  label: string;
  series: string;
  url: string | null;
  value: number | null;
  unit?: string;
  as_of?: string;
  state: string | null;
  tone: Tone;
  on?: boolean;
  since?: string;
  line?: string;
  detail?: string;
  rule: string;
  source: string;
  caveat?: string;
  revised?: boolean;
  published_after_months?: number;
  probability_12m?: number;
  verdict?: string;
  companion?: { label: string; value: number; line: string; on: boolean };
  track?: Track;
  market?: MarketAfter | null;
}

interface Group {
  id: string;
  label: string;
  question: string;
  indicators: Indicator[];
}

interface Implication {
  kind: "know" | "do" | "dont";
  text: string;
  basis: "definition" | "track record" | "backtest";
}

export interface CycleData {
  ok: boolean;
  detail?: string;
  ts: string;
  stale_hours: number | null;
  missing: string[];
  note: string;
  headline: {
    nber: string | null;
    months_in_expansion: number | null;
    recession_rules_on: number;
    recession_rules_known: number;
    recession_rules: { id: string; label: string; on: boolean }[];
    curve: string | null;
    probability_12m: number | null;
    cli_phase: string | null;
    output_gap: number | null;
    inflation_gap: number | null;
    policy: string | null;
    financial: string | null;
  };
  groups: Group[];
  implications: Implication[];
}

export function useCycle() {
  return useQuery<CycleData>({
    queryKey: ["cycle"],
    queryFn: () => fetch("/api/cycle").then((r) => r.json()),
    staleTime: 10 * 60_000,
    refetchInterval: 30 * 60_000,
  });
}

const TONE: Record<Tone, string> = {
  good: "#4CAF50",
  watch: "#FFCC44",
  bad: "#FF5252",
  neutral: "#9a9a9a",
  unknown: "#333",
};

const KIND: Record<Implication["kind"], { label: string; color: string }> = {
  know: { label: "ควรรู้", color: "#4FA3FF" },
  do: { label: "ควรทำ", color: "#4CAF50" },
  dont: { label: "ไม่ควรทำ", color: "#FF8800" },
};

const BASIS: Record<Implication["basis"], string> = {
  definition: "นิยาม",
  "track record": "สถิติย้อนหลัง",
  backtest: "ผลทดสอบ",
};

const head = { color: "#888", fontSize: 10, letterSpacing: "0.12em" } as const;
const box = "flex flex-col gap-1 p-2 border";

const signed = (v: number | null | undefined, dp = 2, suffix = "") =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}${suffix}`;
const pct = (v: number | null | undefined) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;

const SIGNED = new Set(["output_gap", "trend_10m"]);

function value(ind: Indicator) {
  if (ind.id === "nber") return "";
  if (ind.value == null) return "—";
  const unit = ind.unit ?? "";
  const dp = ind.id === "chauvet_piger" || ind.id === "hamilton" ? 1 : 2;
  return unit === "pp" || SIGNED.has(ind.id)
    ? signed(ind.value, dp, unit)
    : `${ind.value.toFixed(dp)}${unit}`;
}

function Chip({ label, text, color }: { label: string; text: string; color: string }) {
  return (
    <span style={{ fontSize: 9.5, color: "#6a6a6a" }}>
      {label} <span style={{ color, fontWeight: "bold" }}>{text}</span>
    </span>
  );
}

function Headline({ data }: { data: CycleData }) {
  const h = data.headline;
  const rulesOn = h.recession_rules_on;
  return (
    <div className={box} style={{ borderColor: rulesOn ? "#5a1f1f" : "#1e1e1e" }}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span
          style={{
            color: h.nber === "RECESSION" ? TONE.bad : "#CCC",
            fontSize: 11,
            fontWeight: "bold",
            letterSpacing: "0.1em",
          }}
          title="NBER ประกาศจุดเปลี่ยนช้า 4–21 เดือน — ค่านี้เป็นค่าย้อนหลัง"
        >
          NBER: {h.nber ?? "NO DATA"}
        </span>
        {h.months_in_expansion != null && (
          <span style={{ color: "#6a6a6a", fontSize: 9.5 }}>
            {h.months_in_expansion} เดือนนับจาก trough ล่าสุด
          </span>
        )}
        <span style={{ color: rulesOn ? TONE.bad : TONE.good, fontSize: 10.5, fontWeight: "bold" }}>
          กฎ RECESSION ติด {rulesOn}/{h.recession_rules_known}
        </span>
        <span className="flex gap-1.5">
          {h.recession_rules.map((r) => (
            <span key={r.id} style={{ color: r.on ? TONE.bad : "#4a4a4a", fontSize: 9 }}>
              {r.on ? "●" : "○"} {r.label}
            </span>
          ))}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        <Chip
          label="CURVE"
          text={`${h.curve ?? "—"}${h.probability_12m == null ? "" : ` · P(12M) ${h.probability_12m.toFixed(0)}%`}`}
          color={h.curve === "INVERTED" ? TONE.bad : "#9a9a9a"}
        />
        <Chip label="OECD CLI" text={h.cli_phase ?? "—"} color="#9a9a9a" />
        <Chip
          label="OUTPUT GAP"
          text={signed(h.output_gap, 2, "%")}
          color={(h.output_gap ?? 0) > 0 ? TONE.watch : "#9a9a9a"}
        />
        <Chip
          label="PCE vs 2%"
          text={signed(h.inflation_gap, 2, "pp")}
          color={(h.inflation_gap ?? 0) > 0 ? TONE.watch : TONE.good}
        />
        <Chip label="POLICY" text={h.policy ?? "—"} color="#9a9a9a" />
        <Chip
          label="NFCI"
          text={h.financial ?? "—"}
          color={h.financial?.startsWith("TIGHTER") ? TONE.bad : "#9a9a9a"}
        />
      </div>
    </div>
  );
}

function Evidence({ ind }: { ind: Indicator }) {
  const t = ind.track;
  const m = ind.market;
  const small = { color: "#777", fontSize: 9, lineHeight: 1.5 } as const;
  return (
    <div className="flex flex-col gap-1 px-1 pb-1" style={{ borderTop: "1px solid #141414" }}>
      <span style={{ color: "#9a9a9a", fontSize: 9.5, lineHeight: 1.5 }}>{ind.rule}</span>
      <span style={small}>
        ที่มา: {ind.source}
        {ind.url && (
          <>
            {" · "}
            <a href={ind.url} target="_blank" rel="noreferrer" style={{ color: "#4FA3FF" }}>
              {ind.series}
            </a>
          </>
        )}
        {ind.revised != null && (ind.revised ? " · ตัวเลขถูก revise ย้อนหลัง" : " · ไม่ถูก revise")}
        {ind.published_after_months ? ` · ออกช้า ${ind.published_after_months} เดือน` : ""}
      </span>
      {ind.companion && (
        <span style={small}>
          {ind.companion.label} {ind.companion.value.toFixed(2)} (เส้น {ind.companion.line}){" "}
          {ind.companion.on ? "— ติด" : "— ไม่ติด"}
        </span>
      )}
      {t && (
        <span style={small}>
          สถิติตั้งแต่ {t.from.slice(0, 4)}: recession {t.recessions} รอบ จับได้{" "}
          <b style={{ color: "#AAA" }}>{t.caught}</b> พลาด {t.missed}
          {t.missed_dates.length > 0 && ` (${t.missed_dates.join(", ")})`} · สัญญาณผิด{" "}
          <b style={{ color: t.false ? TONE.watch : "#AAA" }}>{t.false}</b>
          {t.false_dates.length > 0 && ` (${t.false_dates.join(", ")})`}
          {t.undecided > 0 && ` · ยังตัดสินไม่ได้ ${t.undecided}`}
          {t.median_lead != null &&
            ` · median ${t.median_lead > 0 ? "ก่อน" : "หลัง"} recession เริ่ม ${Math.abs(t.median_lead).toFixed(0)} เดือน`}
          {` · นับว่าจับได้เมื่อ recession เริ่มภายใน ${t.window} เดือนหลังสัญญาณ`}
        </span>
      )}
      {m && (
        <span style={small}>
          S&P 500 ใน {m.horizon} เดือนหลังรู้สัญญาณ (n={m.n}): median{" "}
          <b style={{ color: "#AAA" }}>{pct(m.median_return)}</b> · ช่วง {pct(m.worst_return)} ถึง{" "}
          {pct(m.best_return)} · บวก {(m.up_share * 100).toFixed(0)}% ของครั้ง · จุดต่ำสุดระหว่างทาง
          median {pct(m.median_low)} แย่สุด {pct(m.worst_low)} — ทุกเดือนในช่วงเดียวกัน: median{" "}
          {pct(m.all_months_median_return)}, จุดต่ำสุด {pct(m.all_months_median_low)}
        </span>
      )}
      {ind.caveat && <span style={{ ...small, color: "#8a6a3a" }}>{ind.caveat}</span>}
    </div>
  );
}

function IndicatorRow({
  ind,
  open,
  onToggle,
}: {
  ind: Indicator;
  open: boolean;
  onToggle: () => void;
}) {
  const color = TONE[ind.tone ?? "unknown"];
  return (
    <div style={{ border: `1px solid ${ind.on ? `${color}55` : "#141414"}` }}>
      <button
        type="button"
        aria-pressed={open}
        onClick={onToggle}
        className="w-full text-left px-1 py-0.5"
        title="กดเพื่อดูนิยาม ที่มา และสถิติย้อนหลัง"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span style={{ color: "#8a8a8a", fontSize: 9.5 }}>
            {ind.label}
            {ind.verdict && <span style={{ color: "#B06000" }}> {ind.verdict}</span>}
          </span>
          <span style={{ color, fontSize: 10, fontWeight: "bold" }}>{ind.state ?? "NO DATA"}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2" style={{ fontSize: 9 }}>
          <span className="tabular-nums" style={{ color: "#AAA" }}>
            {value(ind)}
            {ind.line && <span style={{ color: "#555" }}> · เส้น {ind.line}</span>}
            {ind.probability_12m != null && (
              <span style={{ color: "#888" }}> · P(12M) {ind.probability_12m.toFixed(0)}%</span>
            )}
          </span>
          <span style={{ color: "#555" }}>
            {ind.as_of}
            {ind.since ? ` · ตั้งแต่ ${ind.since}` : ""}
          </span>
        </div>
        {ind.detail && ind.state != null && (
          <div className="truncate" style={{ color: "#666", fontSize: 9 }}>
            {ind.detail}
          </div>
        )}
      </button>
      {open && <Evidence ind={ind} />}
    </div>
  );
}

export function CyclePanel() {
  const { data, isLoading } = useCycle();
  const [open, setOpen] = useState<string | null>(null);

  if (isLoading || !data) {
    return (
      <div className={box} style={{ borderColor: "#1e1e1e" }}>
        <span style={head}>BUSINESS CYCLE</span>
        <span style={{ color: "#555", fontSize: 9.5 }}>loading…</span>
      </div>
    );
  }
  if (!data.ok || !data.groups) {
    return (
      <div className={box} style={{ borderColor: "#1e1e1e" }}>
        <span style={head}>BUSINESS CYCLE</span>
        <span style={{ color: "#8a6a3a", fontSize: 9.5 }}>
          NO DATA — {data.detail ?? "backend error"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Headline data={data} />

      <div
        className="grid gap-2 content-start items-start"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}
      >
        {data.groups.map((g) => (
          <div key={g.id} className={box} style={{ borderColor: "#1e1e1e" }}>
            <div className="flex items-baseline justify-between gap-2">
              <span style={head}>{g.label}</span>
              <span className="truncate" style={{ color: "#5a5a5a", fontSize: 9 }}>
                {g.question}
              </span>
            </div>
            {g.indicators.map((ind) => (
              <IndicatorRow
                key={ind.id}
                ind={ind}
                open={open === ind.id}
                onToggle={() => setOpen(open === ind.id ? null : ind.id)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className={box} style={{ borderColor: "#1e1e1e" }}>
        <div className="flex items-baseline justify-between gap-2">
          <span style={head}>WHAT FOLLOWS</span>
          <span style={{ color: "#5a5a5a", fontSize: 9 }}>
            แต่ละบรรทัดอ้างนิยาม สถิติย้อนหลัง หรือผลทดสอบ — ไม่ใช่คำแนะนำซื้อขาย
          </span>
        </div>
        {data.implications.map((line) => {
          const kind = KIND[line.kind];
          return (
            <div key={line.text} className="flex gap-2" style={{ fontSize: 9.5, lineHeight: 1.55 }}>
              <span style={{ color: kind.color, fontWeight: "bold", minWidth: 52, flexShrink: 0 }}>
                {kind.label}
              </span>
              <span style={{ color: "#AAA" }}>
                {line.text} <span style={{ color: "#555" }}>[{BASIS[line.basis]}]</span>
              </span>
            </div>
          );
        })}
      </div>

      <span style={{ color: "#4a4a4a", fontSize: 8.5, lineHeight: 1.5 }}>
        {data.note} · กดแถวเพื่อดูนิยามตามต้นทาง
        {data.stale_hours != null && ` · ใช้ข้อมูลที่ดึงไว้ ${data.stale_hours} ชม.ก่อน (FRED ไม่ตอบ)`}
        {data.missing.length > 0 && ` · ขาด: ${data.missing.join(", ")}`}
      </span>
    </div>
  );
}
