"use client";

import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { useAllocation } from "../hooks/useAllocation";
import {
  useCrisisComposite,
  useListingGateScreen,
  useCircuitBreakerCheck,
  useCircuitBreakerMarket,
  useMarginRequirement,
} from "../hooks/useMarketQuality";
import { useCountryRotation, useCountryRotationRefresh } from "../hooks/useCountryRotation";
import { useSectorSelection, useSectorSelectionRefresh } from "../hooks/useSectorSelection";
import { RotationTab } from "./rotation-tab";
import { SectorTab } from "./sector-tab";

// ── Shared helpers ────────────────────────────────────────────────────────────

const TRAFFIC_COLORS = {
  GREEN:  { text: "#4caf50", bg: "rgba(76,175,80,0.08)"   },
  YELLOW: { text: "#ffc107", bg: "rgba(255,193,7,0.08)"   },
  RED:    { text: "#ef5350", bg: "rgba(239,83,80,0.08)"   },
  ORANGE: { text: "#ff9800", bg: "rgba(255,152,0,0.08)"   },
};

function MiniBar({ value, max = 100, color }: { value: number; max?: number; color: string }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="h-1 flex-1 overflow-hidden" style={{ backgroundColor: "#1e1e1e" }}>
      <div className="h-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

function ZBar({ score, max = 3 }: { score: number; max?: number }) {
  const pct = Math.min(100, ((score + max) / (max * 2)) * 100);
  const color = score > 0.15 ? "#00e676" : score < -0.15 ? "#ff1744" : "#424242";
  return (
    <div className="h-1 flex-1 overflow-hidden" style={{ backgroundColor: "#1e1e1e" }}>
      <div className="h-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

type Colors = {
  accent: string; text: string; textSecondary: string;
  border: string; surface: string; background: string;
};

// ── Risk Card (compact L3) ────────────────────────────────────────────────────

function RiskCardCompact({ colors }: { colors: Colors }) {
  const { data, isLoading } = useCrisisComposite();

  if (isLoading || !data) {
    return (
      <div className="border p-3" style={{ borderColor: colors.border, backgroundColor: colors.surface }}>
        <div className="text-[9px] font-mono font-bold tracking-widest mb-2" style={{ color: colors.accent }}>
          SYSTEMIC RISK
        </div>
        <div className="text-[9px] font-mono animate-pulse" style={{ color: colors.textSecondary }}>
          {isLoading ? "loading..." : "unavailable"}
        </div>
      </div>
    );
  }

  const { composite_score, traffic_light, indicators } = data;
  const trafficClr = TRAFFIC_COLORS[traffic_light]?.text ?? "#888";
  const trafficBg  = TRAFFIC_COLORS[traffic_light]?.bg   ?? "transparent";

  const IND_LABELS: Record<string, string> = {
    cape: "CAPE", vix: "VIX", hy_spread: "HY SPRD", yield_10y2y: "10Y-2Y", ted_spread: "TED",
  };
  const IND_FMT: Record<string, (v: number) => string> = {
    cape:        v => v.toFixed(1),
    vix:         v => v.toFixed(1),
    hy_spread:   v => v.toFixed(2) + "%",
    yield_10y2y: v => (v >= 0 ? "+" : "") + v.toFixed(2) + "%",
    ted_spread:  v => v.toFixed(2) + "%",
  };

  return (
    <div className="border p-3 space-y-2" style={{ borderColor: colors.border, backgroundColor: colors.surface }}>
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-mono font-bold tracking-widest" style={{ color: colors.accent }}>
          SYSTEMIC RISK
        </span>
        <div
          className="flex items-center gap-1.5 px-1.5 py-0.5 text-[9px] font-bold font-mono"
          style={{ color: trafficClr, backgroundColor: trafficBg, border: `1px solid ${trafficClr}40` }}
        >
          <span className="text-[8px]">●</span>
          <span>{composite_score.toFixed(0)}/100</span>
          <span>{traffic_light}</span>
        </div>
      </div>

      {/* Indicator rows */}
      <div className="space-y-1">
        {Object.entries(indicators).map(([key, ind]) => {
          const label = IND_LABELS[key];
          if (!label) return null;
          const val = ind.value;
          const scoreColor = ind.score <= 33 ? "#4caf50" : ind.score <= 66 ? "#ffc107" : "#ef5350";
          return (
            <div key={key} className="flex items-center gap-2 text-[9px] font-mono">
              <span className="w-14 shrink-0" style={{ color: colors.textSecondary }}>{label}</span>
              <span className="w-12 shrink-0 text-right font-bold" style={{ color: colors.text }}>
                {val != null ? IND_FMT[key]?.(val) ?? val.toFixed(2) : "—"}
              </span>
              <MiniBar value={ind.score} color={scoreColor} />
              <span className="w-6 text-right shrink-0" style={{ color: scoreColor }}>{ind.score.toFixed(0)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Allocation Card (compact) ─────────────────────────────────────────────────

function AllocationCardCompact({ colors }: { colors: Colors }) {
  const { data, isLoading } = useAllocation();

  if (isLoading || !data) {
    return (
      <div className="border p-3" style={{ borderColor: colors.border, backgroundColor: colors.surface }}>
        <div className="text-[9px] font-mono font-bold tracking-widest mb-2" style={{ color: colors.accent }}>
          ALLOCATION SIGNAL
        </div>
        <div className="text-[9px] font-mono animate-pulse" style={{ color: colors.textSecondary }}>
          {isLoading ? "loading..." : "unavailable"}
        </div>
      </div>
    );
  }

  const REGIME_COLORS: Record<string, string> = {
    STRONG_RISK_ON:  "#00e676",
    MILD_RISK_ON:    "#76ff03",
    NEUTRAL:         "#9e9e9e",
    MILD_RISK_OFF:   "#ff9800",
    STRONG_RISK_OFF: "#ff1744",
  };
  const LAYER_LABELS: Record<string, string> = { A: "Sentiment", B: "Flow", C: "Structural" };

  const regimeColor = REGIME_COLORS[data.regime] ?? "#9e9e9e";
  const wScore = data.weighted_score;

  return (
    <div className="border p-3 space-y-2" style={{ borderColor: colors.border, backgroundColor: colors.surface }}>
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-mono font-bold tracking-widest" style={{ color: colors.accent }}>
          ALLOCATION
        </span>
        <div
          className="px-1.5 py-0.5 text-[9px] font-bold font-mono"
          style={{ color: regimeColor, backgroundColor: `${regimeColor}12`, border: `1px solid ${regimeColor}40` }}
        >
          {data.conflict ? "⚠ CONFLICT" : data.regime.replace(/_/g, " ")}
        </div>
      </div>

      {/* Score row */}
      <div className="flex items-center gap-3 text-[9px] font-mono">
        <span style={{ color: colors.textSecondary }}>EQ</span>
        <span className="font-bold" style={{ color: data.equal_score > 0 ? "#00e676" : data.equal_score < 0 ? "#ff1744" : "#9e9e9e" }}>
          {data.equal_score > 0 ? "+" : ""}{data.equal_score}
        </span>
        <span style={{ color: colors.textSecondary }}>WTD</span>
        <span className="font-bold" style={{ color: wScore > 0 ? "#00e676" : wScore < 0 ? "#ff1744" : "#9e9e9e" }}>
          {wScore > 0 ? "+" : ""}{wScore.toFixed(2)}
        </span>
      </div>

      {/* Layer rows */}
      <div className="space-y-1">
        {(["A", "B", "C"] as const).map(id => {
          const layer = data.layers[id];
          const z = layer.z_score ?? 0;
          const zColor = z > 0.15 ? "#00e676" : z < -0.15 ? "#ff1744" : "#9e9e9e";
          return (
            <div key={id} className="flex items-center gap-2 text-[9px] font-mono">
              <span className="w-16 shrink-0" style={{ color: colors.textSecondary }}>
                {id} {LAYER_LABELS[id]}
              </span>
              <span className="w-10 text-right shrink-0 font-bold" style={{ color: zColor }}>
                {z > 0 ? "+" : ""}{z.toFixed(2)}
              </span>
              <ZBar score={z} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── L1 Listing Gate (drawer content) ─────────────────────────────────────────

function L1Content({ colors, isDark }: { colors: Colors; isDark: boolean }) {
  const { mutate, data, isPending, error } = useListingGateScreen();
  const [form, setForm] = useState({
    company_id: "", company_name: "",
    yr0: true, yr1: true, yr2: false,
    ocf0: "", ocf1: "", ocf2: "",
    free_float_pct: "", market_cap_usd: "",
    independent_directors_ratio: "",
    has_audit_committee: true, has_internal_controls: true,
    auditor_registered: true,
    going_concern_count: "0",
    related_party_revenue_pct: "",
  });
  function setF(key: string, val: unknown) { setForm(f => ({ ...f, [key]: val })); }
  function handleScreen() {
    mutate({
      company_id:   form.company_id || "UNKNOWN",
      company_name: form.company_name || "Unknown",
      years_profitable: [form.yr0, form.yr1, form.yr2],
      operating_cashflow: [parseFloat(form.ocf0)||0, parseFloat(form.ocf1)||0, parseFloat(form.ocf2)||0],
      free_float_pct:              parseFloat(form.free_float_pct) / 100 || 0.20,
      market_cap_usd:              parseFloat(form.market_cap_usd) * 1_000_000 || 50_000_000,
      independent_directors_ratio: parseFloat(form.independent_directors_ratio) / 100 || 0.33,
      has_audit_committee:         form.has_audit_committee,
      has_internal_controls:       form.has_internal_controls,
      auditor_registered:          form.auditor_registered,
      going_concern_count:         parseInt(form.going_concern_count) || 0,
      related_party_revenue_pct:   parseFloat(form.related_party_revenue_pct) / 100 || 0,
    });
  }
  const inp = { className: "border px-2 py-1 text-xs font-mono bg-transparent w-full", style: { borderColor: colors.border, color: colors.text } as React.CSSProperties };
  const decClr: Record<string, string> = { APPROVE: "#4caf50", CONDITIONAL: "#ffc107", REJECT: "#ef5350" };

  return (
    <div className="space-y-4 text-xs">
      <div className="text-[9px] font-bold tracking-widest font-mono" style={{ color: colors.accent }}>
        IPO LISTING QUALITY GATE
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[8px] mb-1" style={{ color: colors.textSecondary }}>COMPANY ID</div>
          <input {...inp} value={form.company_id} onChange={e => setF("company_id", e.target.value)} placeholder="COMP01" />
        </div>
        <div>
          <div className="text-[8px] mb-1" style={{ color: colors.textSecondary }}>NAME</div>
          <input {...inp} value={form.company_name} onChange={e => setF("company_name", e.target.value)} placeholder="Corp" />
        </div>
      </div>
      <div>
        <div className="text-[8px] mb-1" style={{ color: colors.textSecondary }}>PROFITABLE YEARS (Y-3, Y-2, Y-1)</div>
        <div className="flex gap-3">{(["yr0","yr1","yr2"] as const).map((k,i)=>(
          <label key={k} className="flex items-center gap-1 font-mono cursor-pointer">
            <input type="checkbox" checked={form[k]} onChange={e=>setF(k,e.target.checked)} />
            <span style={{color:colors.text}}>Y-{3-i}</span>
          </label>
        ))}</div>
      </div>
      <div>
        <div className="text-[8px] mb-1" style={{ color: colors.textSecondary }}>OPERATING CASHFLOW M$ (Y-3, Y-2, Y-1)</div>
        <div className="grid grid-cols-3 gap-1">
          <input {...inp} value={form.ocf0} onChange={e=>setF("ocf0",e.target.value)} placeholder="Y-3" type="number" />
          <input {...inp} value={form.ocf1} onChange={e=>setF("ocf1",e.target.value)} placeholder="Y-2" type="number" />
          <input {...inp} value={form.ocf2} onChange={e=>setF("ocf2",e.target.value)} placeholder="Y-1" type="number" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[8px] mb-1" style={{ color: colors.textSecondary }}>FREE FLOAT %</div>
          <input {...inp} value={form.free_float_pct} onChange={e=>setF("free_float_pct",e.target.value)} placeholder="25" type="number" />
        </div>
        <div>
          <div className="text-[8px] mb-1" style={{ color: colors.textSecondary }}>MARKET CAP M$</div>
          <input {...inp} value={form.market_cap_usd} onChange={e=>setF("market_cap_usd",e.target.value)} placeholder="100" type="number" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[8px] mb-1" style={{ color: colors.textSecondary }}>INDEP. DIRECTORS %</div>
          <input {...inp} value={form.independent_directors_ratio} onChange={e=>setF("independent_directors_ratio",e.target.value)} placeholder="40" type="number" />
        </div>
        <div>
          <div className="text-[8px] mb-1" style={{ color: colors.textSecondary }}>RELATED PARTY REV %</div>
          <input {...inp} value={form.related_party_revenue_pct} onChange={e=>setF("related_party_revenue_pct",e.target.value)} placeholder="10" type="number" />
        </div>
      </div>
      <div>
        <div className="text-[8px] mb-1" style={{ color: colors.textSecondary }}>GOING CONCERN YEARS</div>
        <input {...inp} value={form.going_concern_count} onChange={e=>setF("going_concern_count",e.target.value)} placeholder="0" type="number" />
      </div>
      <div className="flex flex-wrap gap-3">
        {[["has_audit_committee","Audit Committee"],["has_internal_controls","Internal Controls"],["auditor_registered","Auditor Registered"]].map(([k,label])=>(
          <label key={k} className="flex items-center gap-1 font-mono cursor-pointer">
            <input type="checkbox" checked={form[k as keyof typeof form] as boolean} onChange={e=>setF(k,e.target.checked)} />
            <span style={{color:colors.text}}>{label}</span>
          </label>
        ))}
      </div>
      {error && <div className="text-[9px] font-mono" style={{color:"#ef5350"}}><AlertTriangle className="h-3 w-3 inline mr-1" />{String(error)}</div>}
      <button type="button" onClick={handleScreen} disabled={isPending}
        className="w-full py-1.5 text-xs font-mono font-bold border"
        style={{ borderColor: colors.accent, color: colors.accent }}>
        {isPending ? "SCREENING..." : "SCREEN"}
      </button>
      {data && (
        <div className="space-y-3">
          <div className="border p-3" style={{ borderColor: decClr[data.decision], backgroundColor: isDark ? "#0a0a0a" : "#fff" }}>
            <div className="text-xl font-bold font-mono" style={{ color: decClr[data.decision] }}>{data.decision}</div>
            <div className="text-sm font-mono mt-1" style={{ color: colors.text }}>Score: <span className="font-bold" style={{ color: decClr[data.decision] }}>{data.score.toFixed(1)}</span>/100</div>
          </div>
          <div className="border p-3 space-y-1.5" style={{ borderColor: colors.border }}>
            <div className="text-[9px] tracking-widest font-mono mb-2" style={{ color: colors.textSecondary }}>BREAKDOWN</div>
            {Object.entries(data.score_breakdown).map(([k,v])=>{
              const c = v>=70?"#4caf50":v>=50?"#ffc107":"#ef5350";
              return (
                <div key={k} className="flex items-center gap-2 text-[9px] font-mono">
                  <span className="w-20 capitalize truncate" style={{color:colors.textSecondary}}>{k}</span>
                  <div className="flex-1 h-1.5" style={{backgroundColor:colors.border}}><div className="h-full" style={{width:`${v}%`,backgroundColor:c}} /></div>
                  <span className="w-8 text-right" style={{color:c}}>{v.toFixed(0)}%</span>
                </div>
              );
            })}
          </div>
          {data.recommendations.length > 0 && (
            <div className="border p-3" style={{ borderColor: "#ffc107" }}>
              <div className="text-[9px] tracking-widest font-mono mb-1" style={{color:"#ffc107"}}>RECOMMENDATIONS</div>
              {data.recommendations.map((r,i)=>(
                <div key={i} className="text-[9px] font-mono" style={{color:colors.text}}>• {r}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── L4 Circuit Breaker (drawer content) ──────────────────────────────────────

function L4Content({ colors, isDark }: { colors: Colors; isDark: boolean }) {
  const [stockSym,   setStockSym]   = useState("AAPL");
  const [stockPrice, setStockPrice] = useState("91");
  const [stockPrior, setStockPrior] = useState("100");
  const [idxVal,     setIdxVal]     = useState("4640");
  const [idxPrior,   setIdxPrior]   = useState("5000");
  const [idxTime,    setIdxTime]    = useState("14:30");

  const stockChk = useCircuitBreakerCheck();
  const mktChk   = useCircuitBreakerMarket();
  const { data: marginData, isLoading: marginLoading } = useMarginRequirement();

  const TIER_CLR: Record<number, string> = { 0:"#4caf50", 1:"#ffc107", 2:"#ff9800", 3:"#ef5350" };
  const LVL_CLR: Record<string, string>  = { NONE:"#4caf50", L1:"#ffc107", L2:"#ff9800", L3:"#ef5350", L3_BLOCKED:"#9e9e9e" };
  const inp = { className:"border px-2 py-1 text-xs font-mono bg-transparent w-full", style:{ borderColor:colors.border, color:colors.text } as React.CSSProperties };

  return (
    <div className="space-y-4 text-xs">
      <div className="text-[9px] font-bold tracking-widest font-mono" style={{ color: colors.accent }}>
        CIRCUIT BREAKER SIMULATOR
      </div>

      {/* Stock check */}
      <div className="border p-3 space-y-2" style={{ borderColor: colors.border, backgroundColor: colors.surface }}>
        <div className="text-[9px] font-bold font-mono" style={{ color: colors.accent }}>STOCK CIRCUIT BREAKER</div>
        <div className="grid grid-cols-3 gap-2">
          <div><div className="text-[8px] mb-1" style={{color:colors.textSecondary}}>SYMBOL</div><input {...inp} value={stockSym} onChange={e=>setStockSym(e.target.value.toUpperCase())} /></div>
          <div><div className="text-[8px] mb-1" style={{color:colors.textSecondary}}>PRICE</div><input {...inp} value={stockPrice} onChange={e=>setStockPrice(e.target.value)} type="number" /></div>
          <div><div className="text-[8px] mb-1" style={{color:colors.textSecondary}}>PRIOR CLOSE</div><input {...inp} value={stockPrior} onChange={e=>setStockPrior(e.target.value)} type="number" /></div>
        </div>
        <button type="button" onClick={()=>stockChk.mutate({symbol:stockSym,price:parseFloat(stockPrice),priorClose:parseFloat(stockPrior)})} disabled={stockChk.isPending}
          className="w-full py-1 text-xs font-mono font-bold border" style={{borderColor:colors.accent,color:colors.accent}}>
          {stockChk.isPending?"CHECKING...":"CHECK"}
        </button>
        {stockChk.data && (() => {
          const d = stockChk.data; const tc = TIER_CLR[d.tier??0]??"#888";
          return (
            <div className="space-y-1">
              <div className="font-mono font-bold text-sm" style={{color:(d.pct_change??0)<0?"#ef5350":"#4caf50"}}>
                Δ {(d.pct_change??0)>=0?"+":""}{(d.pct_change??0).toFixed(2)}%
              </div>
              <div className="border p-1.5 inline-block" style={{borderColor:tc}}><span className="font-bold font-mono" style={{color:tc}}>{d.halt_label}</span></div>
              <div className="text-[9px] font-mono" style={{color:colors.textSecondary}}>{d.trigger_reason}</div>
            </div>
          );
        })()}
      </div>

      {/* Market check */}
      <div className="border p-3 space-y-2" style={{ borderColor: colors.border, backgroundColor: colors.surface }}>
        <div className="text-[9px] font-bold font-mono" style={{ color: colors.accent }}>MARKET INDEX HALT</div>
        <div className="grid grid-cols-3 gap-2">
          <div><div className="text-[8px] mb-1" style={{color:colors.textSecondary}}>INDEX</div><input {...inp} value={idxVal} onChange={e=>setIdxVal(e.target.value)} type="number" /></div>
          <div><div className="text-[8px] mb-1" style={{color:colors.textSecondary}}>PRIOR</div><input {...inp} value={idxPrior} onChange={e=>setIdxPrior(e.target.value)} type="number" /></div>
          <div><div className="text-[8px] mb-1" style={{color:colors.textSecondary}}>TIME</div><input {...inp} value={idxTime} onChange={e=>setIdxTime(e.target.value)} placeholder="14:30" /></div>
        </div>
        <button type="button" onClick={()=>mktChk.mutate({indexValue:parseFloat(idxVal),priorClose:parseFloat(idxPrior),time:idxTime})} disabled={mktChk.isPending}
          className="w-full py-1 text-xs font-mono font-bold border" style={{borderColor:colors.accent,color:colors.accent}}>
          {mktChk.isPending?"CHECKING...":"CHECK"}
        </button>
        {mktChk.data && (() => {
          const d = mktChk.data; const lc = LVL_CLR[d.level??"NONE"]??"#888";
          return (
            <div className="space-y-1">
              <div className="font-mono font-bold text-sm" style={{color:"#ef5350"}}>Δ {(d.drop_pct??0).toFixed(2)}%</div>
              <div className="border p-1.5 inline-block" style={{borderColor:lc}}><span className="font-bold font-mono" style={{color:lc}}>{d.halt_label}</span></div>
              <div className="text-[9px] font-mono" style={{color:colors.textSecondary}}>{d.trigger_reason}</div>
            </div>
          );
        })()}
      </div>

      {/* Margin */}
      {marginLoading && <div className="text-[9px] font-mono flex items-center gap-1" style={{color:colors.textSecondary}}><RefreshCw className="h-3 w-3 animate-spin" />Loading margin...</div>}
      {marginData && (
        <div className="border p-3 space-y-2" style={{ borderColor: colors.border, backgroundColor: colors.surface }}>
          <div className="text-[9px] font-bold font-mono tracking-widest" style={{color:colors.accent}}>COUNTERCYCLICAL MARGIN</div>
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-bold font-mono" style={{color:marginData.required_margin_pct>25?"#ff9800":"#4caf50"}}>{marginData.required_margin_pct.toFixed(1)}%</span>
            <span className="border px-2 py-0.5 text-xs font-bold font-mono"
              style={{color:marginData.level==="NORMAL"?"#4caf50":marginData.level==="ELEVATED"?"#ffc107":"#ef5350",
                      borderColor:marginData.level==="NORMAL"?"#4caf50":marginData.level==="ELEVATED"?"#ffc107":"#ef5350"}}>
              {marginData.level}
            </span>
          </div>
          <div className="text-[9px] font-mono" style={{color:colors.textSecondary}}>{marginData.rationale}</div>
          <div className="grid grid-cols-2 gap-2">
            {[["CAPE", marginData.cape?.toFixed(1)??"N/A", marginData.cape_regime],
              ["VIX",  marginData.vix?.toFixed(1)??"N/A",  marginData.vix_regime]].map(([lbl,val,reg])=>(
              <div key={lbl} className="border p-2" style={{borderColor:colors.border}}>
                <div className="text-[8px]" style={{color:colors.textSecondary}}>{lbl}</div>
                <div className="text-base font-bold font-mono" style={{color:colors.text}}>{val}</div>
                <div className="text-[8px]" style={{color:colors.textSecondary}}>{reg}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Drawer ────────────────────────────────────────────────────────────────────

function Drawer({
  open, onClose, title, colors, isDark, children,
}: {
  open: boolean; onClose: () => void; title: string;
  colors: Colors; isDark: boolean; children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="absolute inset-0 z-40 flex" style={{ pointerEvents: "all" }}>
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" onClick={onClose} />
      {/* Panel */}
      <div
        className="w-[460px] shrink-0 h-full overflow-y-auto p-4 space-y-4 border-l"
        style={{ backgroundColor: isDark ? "#030303" : "#fafafa", borderColor: colors.border }}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[9px] font-bold tracking-widest font-mono" style={{ color: colors.accent }}>{title}</span>
          <button type="button" onClick={onClose} className="hover:opacity-70" style={{ color: colors.textSecondary }}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── SignalsTab (main) ─────────────────────────────────────────────────────────

export function SignalsTab({ colors, isDark }: { colors: Colors; isDark: boolean }) {
  const [rightPanel, setRightPanel] = useState<"sector" | "rotation">("sector");
  const [drawer, setDrawer]         = useState<"circuit" | "listing" | null>(null);

  const { data: rotData,    isLoading: rotLoading,    error: rotError    } = useCountryRotation();
  const { data: sectorData, isLoading: sectorLoading, error: sectorError } = useSectorSelection();
  const rotRefresh    = useCountryRotationRefresh();
  const sectorRefresh = useSectorSelectionRefresh();

  const btnBase = "px-2 py-1 text-[9px] font-bold font-mono border transition-colors";

  return (
    <div className="relative flex gap-3 h-full overflow-hidden">
      {/* ── Left panel (signals) ───────────────────────────────────── */}
      <div className="w-64 shrink-0 flex flex-col gap-2 overflow-y-auto">
        <RiskCardCompact colors={colors} />
        <AllocationCardCompact colors={colors} />

        {/* Utility tool buttons */}
        <div className="flex flex-col gap-1 pt-1 border-t" style={{ borderColor: colors.border }}>
          <div className="text-[8px] font-mono tracking-widest mb-0.5" style={{ color: colors.textSecondary }}>TOOLS</div>
          <button
            type="button" onClick={() => setDrawer("circuit")}
            className={btnBase}
            style={{
              borderColor: drawer === "circuit" ? colors.accent : colors.border,
              color: drawer === "circuit" ? colors.accent : colors.textSecondary,
              backgroundColor: drawer === "circuit" ? `${colors.accent}10` : "transparent",
            }}
          >
            CIRCUIT BREAKER
          </button>
          <button
            type="button" onClick={() => setDrawer("listing")}
            className={btnBase}
            style={{
              borderColor: drawer === "listing" ? colors.accent : colors.border,
              color: drawer === "listing" ? colors.accent : colors.textSecondary,
              backgroundColor: drawer === "listing" ? `${colors.accent}10` : "transparent",
            }}
          >
            IPO LISTING GATE
          </button>
        </div>
      </div>

      {/* ── Right panel (tables) ───────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col gap-2 overflow-hidden">
        {/* Toggle */}
        <div className="flex items-center gap-1 shrink-0">
          {(["sector", "rotation"] as const).map(p => (
            <button
              key={p} type="button" onClick={() => setRightPanel(p)}
              className={btnBase}
              style={{
                borderColor:     rightPanel === p ? colors.accent : colors.border,
                backgroundColor: rightPanel === p ? colors.accent : "transparent",
                color:           rightPanel === p ? "#000" : colors.text,
              }}
            >
              {p === "sector" ? "US SECTOR" : "COUNTRY ROTATION"}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="flex-1 overflow-hidden">
          {rightPanel === "sector" && (
            <SectorTab
              data={sectorData} isLoading={sectorLoading}
              error={sectorError instanceof Error ? sectorError : null}
              refresh={sectorRefresh} colors={colors}
            />
          )}
          {rightPanel === "rotation" && (
            <RotationTab
              data={rotData} isLoading={rotLoading}
              error={rotError} refresh={rotRefresh} colors={colors}
            />
          )}
        </div>
      </div>

      {/* ── Drawers ────────────────────────────────────────────────── */}
      <Drawer open={drawer === "circuit"} onClose={() => setDrawer(null)} title="CIRCUIT BREAKER SIMULATOR" colors={colors} isDark={isDark}>
        <L4Content colors={colors} isDark={isDark} />
      </Drawer>
      <Drawer open={drawer === "listing"} onClose={() => setDrawer(null)} title="IPO LISTING QUALITY GATE" colors={colors} isDark={isDark}>
        <L1Content colors={colors} isDark={isDark} />
      </Drawer>
    </div>
  );
}
