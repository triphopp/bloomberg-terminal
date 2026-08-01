"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type React from "react";
import { useState } from "react";
import type { SectorSignal } from "../hooks/useSectorSelection";

// ── Tooltip helper ───────────────────────────────────────────────────────────

function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default">{children}</span>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[10px] bg-black border border-white/20 text-white/80 max-w-[220px] text-center leading-relaxed">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

// ── Constants ────────────────────────────────────────────────────────────────

const TIER_COLORS: Record<string, string> = {
  STRONG_OVERWEIGHT: "text-green-300 bg-green-900/30 border-green-600",
  OVERWEIGHT: "text-green-400 bg-green-900/20 border-green-700",
  NEUTRAL: "text-yellow-400 bg-yellow-900/20 border-yellow-700",
  UNDERWEIGHT: "text-red-400 bg-red-900/20 border-red-700",
  STRONG_UNDERWEIGHT: "text-red-300 bg-red-900/30 border-red-600",
};

// ALL CAPS with space — Bloomberg terminal style
const PHASE_LABELS: Record<string, string> = {
  EARLY_RECOVERY: "EARLY RECOVERY",
  MID_EXPANSION: "MID EXPANSION",
  LATE_CYCLE: "LATE CYCLE",
  RECESSION: "RECESSION",
};

const PHASE_COLORS: Record<string, string> = {
  EARLY_RECOVERY: "text-green-400",
  MID_EXPANSION: "text-[#00bfff]",
  LATE_CYCLE: "text-[#ffb300]",
  RECESSION: "text-red-500",
};

// border accent per phase (Bloomberg terminal left-border style)
const PHASE_BORDER: Record<string, string> = {
  EARLY_RECOVERY: "#22c55e",
  MID_EXPANSION: "#00bfff",
  LATE_CYCLE: "#ffb300",
  RECESSION: "#ef4444",
};

// Static sector positioning per phase (Stovall 1996 + Stangl 2009)
const PHASE_SECTORS: Record<string, { ow: string[]; uw: string[] }> = {
  EARLY_RECOVERY: { ow: ["XLF", "XLY", "XLI", "XLK"], uw: ["XLU", "XLP"] },
  MID_EXPANSION: { ow: ["XLK", "XLI", "XLC"], uw: ["XLU", "XLP", "XLRE"] },
  LATE_CYCLE: { ow: ["XLE", "XLB", "XLV"], uw: ["XLY", "XLF"] },
  RECESSION: { ow: ["XLV", "XLP", "XLU", "XLRE"], uw: ["XLY", "XLI", "XLB"] },
};

const PHASE_TAGLINES: Record<string, string> = {
  EARLY_RECOVERY: "Economy troughing — cycle turning up",
  MID_EXPANSION: "Above-trend expansion — watch for peak signals",
  LATE_CYCLE: "Slowdown underway — begin defensive rotation",
  RECESSION: "Contraction confirmed — full defensive posture",
};

/** Dynamic description — reflects actual cycle_score magnitude, not generic ideal */
function getPhaseDesc(phase: string, score: number): string {
  const abs = Math.abs(score);
  const weak = abs < 0.35;
  const strong = abs >= 0.7;

  switch (phase) {
    case "EARLY_RECOVERY":
      return weak
        ? "สัญญาณฟื้นตัวเพิ่งเริ่มปรากฏ ยังอ่อน — ยืนยันด้วย Fed policy และ yield curve steepening"
        : strong
          ? "เศรษฐกิจฟื้นตัวชัดเจน — yield curve ชันแรง Fed ลดดอกเบี้ย credit spreads แคบลงเร็ว"
          : "เศรษฐกิจกำลังฟื้นตัว — yield curve เปิด Fed เริ่มผ่อนคลาย credit spreads ปรับตัวดีขึ้น";
    case "MID_EXPANSION":
      return weak
        ? "เศรษฐกิจขยายตัวเล็กน้อยเหนือค่าเฉลี่ย สัญญาณปนกัน — cycle_score ใกล้ขอบ LATE CYCLE"
        : strong
          ? "เศรษฐกิจขยายตัวแข็งแกร่งเหนือค่าเฉลี่ย ใกล้จุดสูงสุดของวัฏจักร — เฝ้าระวัง Late Cycle signals"
          : "เศรษฐกิจขยายตัวพอสมควรเหนือค่าเฉลี่ย — yield curve spread บวก CFNAI ในแดนบวก";
    case "LATE_CYCLE":
      return weak
        ? "เศรษฐกิจเพิ่งเริ่มชะลอ ต่ำกว่าค่าเฉลี่ยเล็กน้อย — ยังไม่วิกฤต แต่ควรเริ่ม rotate"
        : strong
          ? "การขยายตัวชะลอชัดเจน — yield curve แบน/กลับด้าน credit spreads กว้างขึ้นมาก"
          : "การขยายตัวชะลอลง — yield curve แบน CFNAI ต่ำกว่าศักยภาพ เริ่มหมุน defensives";
    case "RECESSION":
      return weak
        ? "สัญญาณหดตัวเพิ่งเริ่มชัด — ยังไม่ full recession แต่ defensive posture แนะนำ"
        : strong
          ? "เศรษฐกิจหดตัวชัดเจน — yield curve กลับด้านลึก CFNAI < -0.7 ต่อเนื่อง full defensive"
          : "เศรษฐกิจหดตัว — yield curve กลับด้าน CFNAI ติดลบ Fed กำลังลดดอกเบี้ยเพื่อกระตุ้น";
    default:
      return "ไม่สามารถระบุสถานะได้ — ข้อมูล FRED ไม่เพียงพอ";
  }
}

const LAYER_LABELS: Record<string, string> = {
  BC: "Cycle Fit", // renamed: this is sector's FIT score within the phase, NOT the overall cycle score
  MOM: "Momentum",
  VAL: "Valuation",
  F: "Macro",
};

// ── Phase info static data ─────────────────────────────────────────────────────

interface PhaseInfo {
  tagline: string;
  indicators: { label: string; value: string }[];
  overweight: string[];
  underweight: string[];
}

const PHASE_INFO: Record<string, PhaseInfo> = {
  EARLY_RECOVERY: {
    tagline: PHASE_TAGLINES.EARLY_RECOVERY,
    indicators: [
      { label: "Yield Curve", value: "Steepening" },
      { label: "CFNAI", value: "Turning positive" },
      { label: "HY Spread", value: "Narrowing" },
      { label: "Fed Policy", value: "Easing / on hold" },
      { label: "Employment", value: "Bottoming" },
    ],
    overweight: PHASE_SECTORS.EARLY_RECOVERY.ow,
    underweight: PHASE_SECTORS.EARLY_RECOVERY.uw,
  },
  MID_EXPANSION: {
    tagline: PHASE_TAGLINES.MID_EXPANSION,
    indicators: [
      { label: "Yield Curve", value: "Positive slope" },
      { label: "CFNAI", value: "Above 0" },
      { label: "HY Spread", value: "Tight" },
      { label: "Fed Policy", value: "Neutral / tightening" },
      { label: "Employment", value: "Near full" },
    ],
    overweight: PHASE_SECTORS.MID_EXPANSION.ow,
    underweight: PHASE_SECTORS.MID_EXPANSION.uw,
  },
  LATE_CYCLE: {
    tagline: PHASE_TAGLINES.LATE_CYCLE,
    indicators: [
      { label: "Yield Curve", value: "Flattening" },
      { label: "CFNAI", value: "Below trend" },
      { label: "HY Spread", value: "Widening" },
      { label: "Fed Policy", value: "Restrictive" },
      { label: "Employment", value: "Peaking" },
    ],
    overweight: PHASE_SECTORS.LATE_CYCLE.ow,
    underweight: PHASE_SECTORS.LATE_CYCLE.uw,
  },
  RECESSION: {
    tagline: PHASE_TAGLINES.RECESSION,
    indicators: [
      { label: "Yield Curve", value: "Inverted / flat" },
      { label: "CFNAI", value: "< −0.7 sustained" },
      { label: "HY Spread", value: "Very wide" },
      { label: "Fed Policy", value: "Cutting rates" },
      { label: "Employment", value: "Deteriorating" },
    ],
    overweight: PHASE_SECTORS.RECESSION.ow,
    underweight: PHASE_SECTORS.RECESSION.uw,
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Zone label for the cycle score magnitude */
function getCycleZone(score: number): { label: string; color: string } {
  const abs = Math.abs(score);
  if (abs < 0.35) return { label: "BORDERLINE", color: "#ffb300" };
  if (abs < 0.7) return { label: "MODERATE", color: "#00bfff" };
  return { label: "STRONG", color: "#22c55e" };
}

function ScoreBar({ value, max = 2.5 }: { value: number; max?: number }) {
  const pct = Math.min(100, Math.max(0, (Math.abs(value) / max) * 100));
  const isPositive = value >= 0;
  return (
    <div className="flex items-center gap-1 w-14">
      <div className="h-1.5 flex-1 rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pct}%`,
            backgroundColor: isPositive ? "#22c55e" : "#ef4444",
          }}
        />
      </div>
      <span className="text-[10px] font-mono w-9 text-right text-white/60">
        {value >= 0 ? "+" : ""}
        {value.toFixed(1)}
      </span>
    </div>
  );
}

// ── Cycle snapshot ────────────────────────────────────────────────────────────

const DRIVER_LABELS: {
  key: keyof NonNullable<SectorSignal["indicators"]>;
  label: string;
  weight: string;
  desc: string;
}[] = [
  {
    key: "z_slope",
    label: "Yield Curve",
    weight: "30%",
    desc: "T10Y2Y Spread (10-Year − 2-Year Treasury Yield)\nค่า z-score เทียบช่วง 252 วันทำการที่ผ่านมา (น้ำหนัก 30%)\nบวก: yield curve ชันขึ้น (ภาวะปกติ) | ลบ: แบนตัวหรือกลับด้าน",
  },
  {
    key: "z_pmi",
    label: "Activity",
    weight: "30%",
    desc: "Chicago Fed National Activity Index (CFNAI)\nค่า z-score เทียบช่วง 36 เดือนที่ผ่านมา (น้ำหนัก 30%)\nบวก: กิจกรรมเศรษฐกิจสูงกว่าศักยภาพ | ลบ: ต่ำกว่าศักยภาพ",
  },
  {
    key: "z_spread",
    label: "Credit",
    weight: "25%",
    desc: "ICE BofA US High Yield OAS (BAMLH0A0HYM2) — ค่า inverted\nค่า z-score เทียบช่วง 252 วันทำการที่ผ่านมา (น้ำหนัก 25%)\nบวก: credit spread ตึงตัว (ภาวะ risk-on) | ลบ: spread ขยายตัว (ภาวะ risk-off)",
  },
  {
    key: "z_dpmi",
    label: "Momentum",
    weight: "15%",
    desc: "CFNAI 3-Month Change — อัตราเร่งของกิจกรรมเศรษฐกิจ (น้ำหนัก 15%)\nบวก: เศรษฐกิจมีแนวโน้มเร่งตัวขึ้น | ลบ: เศรษฐกิจมีแนวโน้มชะลอตัวลง",
  },
];

function CycleSnapshot({
  score,
  indicators,
}: {
  score: number;
  indicators?: SectorSignal["indicators"];
}) {
  const zone = getCycleZone(score);
  const distToEdge = score >= 0 ? score : Math.abs(score + 1.0); // distance to next phase boundary
  const nearEdge = Math.abs(score) < 0.35;

  return (
    <div className="space-y-1 pl-2 border-l-2 border-white/5 font-mono">
      {/* Row 1 — cycle Z + zone badge + edge warning */}
      <div className="flex items-center gap-2 text-[9px] flex-wrap">
        <span className="text-white/30 uppercase tracking-widest">CYCLE Z</span>
        <span
          className="font-bold text-[11px]"
          style={{ color: score >= 0 ? "#00bfff" : "#ffb300" }}
        >
          {score >= 0 ? "+" : ""}
          {score.toFixed(2)}
        </span>
        <Tip
          label={
            zone.label === "BORDERLINE"
              ? "Composite z-score < 0.35σ — สัญญาณอ่อน\nอยู่ใกล้ขอบเขต phase ระดับความน่าเชื่อถือต่ำ อาจเปลี่ยน phase ได้จากข้อมูลเพียงรายการเดียว"
              : zone.label === "MODERATE"
                ? "Composite z-score 0.35–0.70σ — สัญญาณปานกลาง\nระดับความน่าเชื่อถือพอสมควร ควรติดตาม indicators อย่างใกล้ชิด"
                : "Composite z-score > 0.70σ — สัญญาณชัดเจน\nระดับความน่าเชื่อถือสูง indicators ส่วนใหญ่สอดคล้องกัน"
          }
        >
          <span
            className="px-1 py-0.5 rounded text-[8px] uppercase tracking-wider font-bold"
            style={{
              color: zone.color,
              borderColor: zone.color,
              border: `1px solid ${zone.color}40`,
            }}
          >
            {zone.label}
          </span>
        </Tip>
        {nearEdge && (
          <span className="text-amber-400/70 text-[9px]">
            ⚠ ห่างจาก phase ถัดไป {distToEdge.toFixed(2)}σ
          </span>
        )}
        <span className="text-white/20 text-[8px] ml-auto">scale −3 ··· 0 ··· +3σ</span>
      </div>

      {/* Row 2 — 4 drivers (only if indicators data available) */}
      {indicators && (
        <div className="flex items-center gap-4 flex-wrap text-[9px]">
          <span className="text-white/20 uppercase tracking-widest">DRIVERS</span>
          {DRIVER_LABELS.map(({ key, label, weight, desc }) => {
            const v = indicators[key] ?? 0;
            const clr = v > 0.1 ? "#22c55e" : v < -0.1 ? "#ef4444" : "#888";
            const dir = v > 0.1 ? "↑" : v < -0.1 ? "↓" : "→";
            return (
              <Tip key={key} label={`${desc}\n\nweight ${weight} ใน cycle score`}>
                <span className="flex items-center gap-0.5">
                  <span className="text-white/35">{label}</span>
                  <span className="font-bold" style={{ color: clr }}>
                    {dir}
                    {v >= 0 ? "+" : ""}
                    {v.toFixed(2)}σ
                  </span>
                </span>
              </Tip>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PhaseInfoPanel({ phase, cycleScore }: { phase: string; cycleScore: number }) {
  const [open, setOpen] = useState(false);
  const info = PHASE_INFO[phase];
  const color = PHASE_COLORS[phase] || "text-white/50";
  const accent = PHASE_BORDER[phase] || "#555";
  const label = PHASE_LABELS[phase] || phase;
  if (!info) return null;

  return (
    <div className="font-mono">
      {/* ── Collapsed trigger ─────────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2 py-1 text-[10px] hover:bg-white/[0.03] transition-colors border-l-2"
        style={{ borderLeftColor: accent }}
      >
        <span className="text-white/25 text-[9px]">{open ? "▾" : "▸"}</span>
        <span className={`font-bold tracking-[0.12em] ${color}`}>{label}</span>
        <span className="text-white/30 mx-1">|</span>
        <span className="text-white/40">{info.tagline}</span>
        <span className="ml-auto text-white/20 text-[9px] uppercase tracking-widest">
          {open ? "HIDE" : "INFO"}
        </span>
      </button>

      {/* ── Expanded panel ────────────────────────────────────────────── */}
      {open && (
        <div
          className="border-l-2 ml-0 px-3 py-2 space-y-2 text-[10px] bg-white/[0.02]"
          style={{ borderLeftColor: accent }}
        >
          {/* Description — dynamic: reflects actual cycle_score magnitude */}
          <p className="text-white/45 leading-relaxed">{getPhaseDesc(phase, cycleScore)}</p>

          {/* Indicators table */}
          <div>
            <div className="text-[9px] text-white/25 uppercase tracking-widest mb-1">
              CYCLE INDICATORS
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-0.5">
              {info.indicators.map((ind: { label: string; value: string }) => (
                <div key={ind.label} className="flex gap-2">
                  <span className="text-white/30 w-16 shrink-0">{ind.label}</span>
                  <span className="text-white/55">{ind.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Sector positioning */}
          <div className="flex gap-6 pt-0.5 border-t border-white/5">
            <div>
              <div className="text-[9px] text-white/25 uppercase tracking-widest mb-1">
                OVERWEIGHT
              </div>
              <div className="flex gap-2 flex-wrap">
                {info.overweight.map((s: string) => (
                  <span key={s} className="text-green-400/70 font-mono">
                    {s}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[9px] text-white/25 uppercase tracking-widest mb-1">
                UNDERWEIGHT
              </div>
              <div className="flex gap-2 flex-wrap">
                {info.underweight.map((s: string) => (
                  <span key={s} className="text-red-400/70 font-mono">
                    {s}
                  </span>
                ))}
              </div>
            </div>
            <div className="ml-auto text-right">
              <div className="text-[9px] text-white/25 uppercase tracking-widest mb-1">
                MKT CYCLE Z
              </div>
              <span
                className="font-bold text-xs"
                style={{ color: cycleScore >= 0 ? "#00bfff" : "#ffb300" }}
              >
                {cycleScore >= 0 ? "+" : ""}
                {cycleScore.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConflictBanner({ conflicts }: { conflicts: SectorSignal["conflicts"] }) {
  if (!conflicts.mom_val_divergence && conflicts.bc_mom_conflicts.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1 mb-2">
      {conflicts.mom_val_divergence && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 text-[11px] border rounded
                        bg-amber-900/20 border-amber-700 text-amber-300"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span>
            Momentum vs Valuation divergence — top MOM: {conflicts.top_momentum_sector}, top VAL:{" "}
            {conflicts.top_valuation_sector}. Reduce position sizing.
          </span>
        </div>
      )}
      {conflicts.bc_mom_conflicts.length > 0 && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 text-[11px] border rounded
                        bg-blue-900/20 border-blue-700 text-blue-300"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span>
            BC–MOM conflict: {conflicts.bc_mom_conflicts.join(", ")} — cycle disagrees with
            momentum. Verify thesis before trading.
          </span>
        </div>
      )}
    </div>
  );
}

function SectorRow({
  entry,
  isExpanded,
  onToggle,
  colors,
  cycleScore,
}: {
  entry: SectorSignal["sectors"][0];
  isExpanded: boolean;
  onToggle: () => void;
  colors: { text: string; textSecondary: string; border: string };
  cycleScore: number; // overall market cycle composite — determines phase
}) {
  const tierColor = TIER_COLORS[entry.classification] || TIER_COLORS.NEUTRAL;

  return (
    <>
      <tr
        tabIndex={0}
        className="cursor-pointer hover:bg-white/5 border-b transition-colors"
        style={{ borderColor: colors.border }}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <td className="py-1.5 pl-3 text-[11px] font-mono text-white/40 w-8">{entry.rank}</td>
        <td className="py-1.5 text-[11px] font-mono text-white/80 w-14">{entry.ticker}</td>
        <td className="py-1.5 text-[11px] text-white/60 hidden md:table-cell">{entry.name}</td>
        <td
          className="py-1.5 text-[11px] font-mono w-16 text-right pr-2"
          style={{ color: entry.sector_score >= 0 ? "#22c55e" : "#ef4444" }}
        >
          {entry.sector_score >= 0 ? "+" : ""}
          {entry.sector_score.toFixed(2)}
        </td>
        <td className="py-1.5 w-28">
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${tierColor}`}>
            {entry.classification.replace("_", " ")}
          </span>
        </td>
        <td className="py-1.5 hidden lg:table-cell">
          <ScoreBar value={entry.layers.BC?.z_score ?? 0} />
        </td>
        <td className="py-1.5 hidden lg:table-cell">
          <ScoreBar value={entry.layers.MOM?.z_score ?? 0} />
        </td>
        <td className="py-1.5 hidden lg:table-cell">
          <ScoreBar value={entry.layers.VAL?.z_score ?? 0} />
        </td>
        <td className="py-1.5 hidden lg:table-cell">
          <ScoreBar value={entry.layers.F?.z_score ?? 0} />
        </td>
        <td className="py-1.5 pr-3 w-6">
          {isExpanded ? (
            <ChevronDown className="h-3 w-3 text-white/30" />
          ) : (
            <ChevronRight className="h-3 w-3 text-white/30" />
          )}
        </td>
      </tr>

      {/* Expanded detail row */}
      {isExpanded && (
        <tr className="bg-white/[0.02]">
          <td colSpan={10} className="p-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[10px]">
              {(["BC", "MOM", "VAL", "F"] as const).map((layer) => {
                const d = entry.layers[layer] as Record<string, unknown>;
                return (
                  <div key={layer} className="space-y-0.5">
                    <div className="font-bold text-white/50 uppercase tracking-wider">
                      {LAYER_LABELS[layer]} (
                      {d?.z_score != null
                        ? `${Number(d.z_score) >= 0 ? "+" : ""}${Number(d.z_score).toFixed(2)}`
                        : "N/A"}
                      )
                    </div>
                    {layer === "BC" && (
                      <>
                        {/* phase_label = overall market phase (from cycle_score composite) */}
                        <div className="text-white/60">
                          Phase:{" "}
                          <span className="text-white/80 font-medium">
                            {String(d?.phase_label ?? "—")}
                          </span>
                        </div>
                        {/* cycleScore = composite z-score that DETERMINES the phase */}
                        <div className="text-white/40 text-[9px]">
                          Mkt Cycle: {cycleScore >= 0 ? "+" : ""}
                          {cycleScore.toFixed(2)} (score ≥0 → MID_EXP, ≥1 → EARLY_REC, &lt;0 → LATE,
                          &lt;-1 → REC)
                        </div>
                        {/* z_score = how THIS SECTOR performs in current phase */}
                        <div className="text-white/40 text-[9px]">
                          Fit score = FAV[{entry.ticker}] × phase probabilities
                        </div>
                      </>
                    )}
                    {layer === "MOM" && (
                      <>
                        <div className="text-white/60">
                          12M-1M:{" "}
                          {d?.mom_12_1 != null ? `${(Number(d.mom_12_1) * 100).toFixed(1)}%` : "—"}
                        </div>
                        <div className="text-white/60">
                          6M: {d?.mom_6m != null ? `${(Number(d.mom_6m) * 100).toFixed(1)}%` : "—"}
                        </div>
                        <div className="text-white/60">
                          3M: {d?.mom_3m != null ? `${(Number(d.mom_3m) * 100).toFixed(1)}%` : "—"}
                        </div>
                      </>
                    )}
                    {layer === "VAL" && (
                      <>
                        <div className="text-white/60">
                          P/E: {d?.pe_current != null ? Number(d.pe_current).toFixed(1) : "N/A"}
                        </div>
                        <div className="text-white/60">
                          z_PE: {d?.z_PE != null ? Number(d.z_PE).toFixed(2) : "—"}
                        </div>
                      </>
                    )}
                    {layer === "F" && (
                      <div className="text-white/60">
                        raw: {d?.raw_factor != null ? Number(d.raw_factor).toFixed(2) : "—"}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function FactorDashboard({ factors }: { factors: Record<string, number> }) {
  const items: { key: string; label: string }[] = [
    { key: "f_yield", label: "Yield Curve" },
    { key: "f_cpi", label: "CPI" },
    { key: "f_cs", label: "Credit Spread" },
    { key: "f_dxy", label: "DXY (USD)" },
    { key: "f_oil", label: "Oil" },
  ];

  return (
    <div className="flex items-center gap-4 flex-wrap text-[10px]">
      {items.map(({ key, label }) => {
        const v = factors[key] ?? 0;
        const clr = v >= 0 ? "#22c55e" : "#ef4444";
        const dir = v > 0.1 ? "↑" : v < -0.1 ? "↓" : "→";
        return (
          <div key={key} className="flex items-center gap-1">
            <span className="text-white/40">{label}</span>
            <span className="font-mono" style={{ color: clr }}>
              {dir} {v >= 0 ? "+" : ""}
              {v.toFixed(2)}σ
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function SectorTab({
  data,
  isLoading,
  error,
  refresh,
  colors,
}: {
  data: SectorSignal | undefined;
  isLoading: boolean;
  error: Error | null;
  refresh?: () => void;
  colors: { text: string; textSecondary: string; border: string; surface: string; accent: string };
}) {
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);

  // Loading skeleton
  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="text-xs font-mono text-white/30 animate-pulse">
          Loading sector signal...
        </div>
      </div>
    );
  }

  // Error state
  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-2">
        <AlertTriangle className="h-5 w-5 text-red-400" />
        <div className="text-xs font-mono text-red-400">Failed to load sector data</div>
        <div className="text-[10px] text-white/30">{error.message}</div>
      </div>
    );
  }

  if (!data) return null;

  const phaseColor = PHASE_COLORS[data.cycle_phase] || "text-white/60";

  return (
    <TooltipProvider delayDuration={300}>
      <div className="h-full overflow-y-auto p-3 space-y-3 text-xs">
        {/* ── Header bar ─────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <span className={`font-bold font-mono tracking-[0.12em] text-xs ${phaseColor}`}>
              {PHASE_LABELS[data.cycle_phase] || data.cycle_phase}
            </span>
            {data.vix != null && (
              <span className="text-[10px] font-mono text-white/40">
                VIX {data.vix}
                {data.volatility_brake_active && (
                  <span className="text-amber-400 ml-1">⚡ MOM weight reduced</span>
                )}
              </span>
            )}
            <span className="text-[10px] font-mono text-white/30">
              {new Date(data.timestamp).toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
          {refresh && (
            <button
              type="button"
              onClick={refresh}
              className="flex items-center gap-1 text-[10px] font-mono hover:opacity-70"
              style={{ color: colors.accent }}
            >
              <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
              REFRESH
            </button>
          )}
        </div>

        {/* ── Conflict alerts ────────────────────────────────────────────── */}
        <ConflictBanner conflicts={data.conflicts} />

        {/* ── Cycle Z snapshot ──────────────────────────────────────────── */}
        <CycleSnapshot score={data.cycle_score} indicators={data.indicators} />

        {/* ── Phase info + cycle probabilities ──────────────────────────── */}
        <PhaseInfoPanel phase={data.cycle_phase} cycleScore={data.cycle_score} />

        {/* PROB row — soft phase probabilities (sum = 100%)
          RCVRY = Early Recovery (≠ Recession), RCSSN = Recession/Contraction */}
        <div className="flex items-center gap-3 text-[9px] font-mono text-white/25 flex-wrap pl-2 border-l-2 border-white/5">
          <Tip label="Soft Phase Probabilities — ความน่าจะเป็นในแต่ละ phase ของวัฏจักรเศรษฐกิจ (รวม = 100%)\nคำนวณโดย sigmoid function จาก composite z-score ไม่ใช่การตัดสินแบบ hard threshold">
            <span className="uppercase tracking-widest text-white/20 underline decoration-dotted decoration-white/20">
              PHASE PROB
            </span>
          </Tip>
          {Object.entries(data.cycle_probabilities).map(([k, v]) => {
            const short: Record<string, { label: string; tip: string }> = {
              p_recovery: {
                label: "RCVRY",
                tip: "Early Recovery — ช่วงฟื้นตัวของวัฏจักรเศรษฐกิจ\nลักษณะ: yield curve ชันขึ้น นโยบายการเงินผ่อนคลาย credit spreads แคบลง\nภาคที่ได้ประโยชน์: การเงิน อุตสาหกรรม ผู้บริโภคดุลยพินิจ\nหมายเหตุ: RCVRY หมายถึง Recovery ไม่ใช่ Recession",
              },
              p_expansion: {
                label: "EXPAN",
                tip: "Mid Expansion — การขยายตัวเหนือศักยภาพ\nลักษณะ: CFNAI เป็นบวก ตลาดแรงงานแข็งแกร่ง credit spreads คงที่\nภาคที่ได้ประโยชน์: เทคโนโลยี อุตสาหกรรม สื่อสาร",
              },
              p_slowdown: {
                label: "SLOW",
                tip: "Late Cycle / Slowdown — การขยายตัวชะลอตัว\nลักษณะ: yield curve แบนตัว CFNAI ต่ำกว่าศักยภาพ อัตราเงินเฟ้อสูงสุด\nภาคที่ได้ประโยชน์: พลังงาน วัสดุ สาธารณสุข",
              },
              p_contraction: {
                label: "RCSSN",
                tip: "Recession / Contraction — ภาวะเศรษฐกิจหดตัว\nลักษณะ: CFNAI ติดลบต่อเนื่อง yield curve กลับด้าน นโยบายการเงินกระตุ้น\nภาคที่ได้ประโยชน์: สาธารณสุข สินค้าจำเป็น สาธารณูปโภค",
              },
            };
            const meta = short[k] ?? { label: k, tip: k };
            const pct = Number(v) * 100;
            return (
              <Tip key={k} label={meta.tip}>
                <span>
                  {meta.label} <span className="text-white/50">{pct.toFixed(0)}%</span>
                </span>
              </Tip>
            );
          })}
        </div>

        {/* ── Ranking table ──────────────────────────────────────────────── */}
        <div className="overflow-x-auto" style={{ borderColor: colors.border }}>
          <table className="w-full border-collapse">
            <thead>
              <tr
                className="border-b text-[10px] text-white/30 uppercase tracking-wider"
                style={{ borderColor: colors.border }}
              >
                <th className="py-1 pl-3 text-left w-8">#</th>
                <th className="py-1 text-left w-14">Ticker</th>
                <th className="py-1 text-left hidden md:table-cell">Name</th>
                <th className="py-1 text-right pr-2 w-16">Score</th>
                <th className="py-1 text-left w-28">Signal</th>
                <th className="py-1 hidden lg:table-cell w-14">BC</th>
                <th className="py-1 hidden lg:table-cell w-14">MOM</th>
                <th className="py-1 hidden lg:table-cell w-14">VAL</th>
                <th className="py-1 hidden lg:table-cell w-14">F</th>
                <th className="py-1 pr-3 w-6" />
              </tr>
            </thead>
            <tbody>
              {data.sectors.map((entry) => (
                <SectorRow
                  key={entry.ticker}
                  entry={entry}
                  isExpanded={expandedTicker === entry.ticker}
                  onToggle={() =>
                    setExpandedTicker(expandedTicker === entry.ticker ? null : entry.ticker)
                  }
                  colors={colors}
                  cycleScore={data.cycle_score}
                />
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Macro factor dashboard ─────────────────────────────────────── */}
        {data.macro_factors && Object.keys(data.macro_factors).length > 0 && (
          <div className="border-t pt-2" style={{ borderColor: colors.border }}>
            <div className="text-[10px] text-white/30 uppercase tracking-wider mb-1">
              Macro Factors
            </div>
            <FactorDashboard factors={data.macro_factors} />
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
