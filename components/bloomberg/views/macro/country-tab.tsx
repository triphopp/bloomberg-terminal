"use client";

import {
  AlertTriangle,
  ChevronDown,
  Database,
  Globe,
  RefreshCw,
  Search,
} from "lucide-react";
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  useSovereignCompare,
  useSovereignDetail,
  useSovereignRefresh,
} from "../../hooks/useSovereignData";
import type { WbValue, WbSeriesPoint } from "../../hooks/useSovereignData";
import { SectionHeader } from "./shared";

// ── Country list ─────────────────────────────────────────────────────────────

const POPULAR_COUNTRIES = [
  { code: "US", name: "United States", flag: "🇺🇸" },
  { code: "CN", name: "China",         flag: "🇨🇳" },
  { code: "JP", name: "Japan",         flag: "🇯🇵" },
  { code: "GB", name: "United Kingdom",flag: "🇬🇧" },
  { code: "DE", name: "Germany",       flag: "🇩🇪" },
  { code: "FR", name: "France",        flag: "🇫🇷" },
  { code: "IN", name: "India",         flag: "🇮🇳" },
  { code: "BR", name: "Brazil",        flag: "🇧🇷" },
  { code: "KR", name: "South Korea",   flag: "🇰🇷" },
  { code: "AU", name: "Australia",     flag: "🇦🇺" },
  { code: "CA", name: "Canada",        flag: "🇨🇦" },
  { code: "MX", name: "Mexico",        flag: "🇲🇽" },
  { code: "ID", name: "Indonesia",     flag: "🇮🇩" },
  { code: "TH", name: "Thailand",      flag: "🇹🇭" },
  { code: "SG", name: "Singapore",     flag: "🇸🇬" },
  { code: "CH", name: "Switzerland",   flag: "🇨🇭" },
  { code: "SA", name: "Saudi Arabia",  flag: "🇸🇦" },
  { code: "ZA", name: "South Africa",  flag: "🇿🇦" },
  { code: "RU", name: "Russia",        flag: "🇷🇺" },
  { code: "TR", name: "Turkey",        flag: "🇹🇷" },
  { code: "PL", name: "Poland",        flag: "🇵🇱" },
  { code: "VN", name: "Vietnam",       flag: "🇻🇳" },
  { code: "TW", name: "Taiwan",        flag: "🇹🇼" },
  { code: "PH", name: "Philippines",   flag: "🇵🇭" },
  { code: "MY", name: "Malaysia",      flag: "🇲🇾" },
  { code: "IL", name: "Israel",        flag: "🇮🇱" },
  { code: "AE", name: "UAE",           flag: "🇦🇪" },
  { code: "NG", name: "Nigeria",       flag: "🇳🇬" },
  { code: "EG", name: "Egypt",         flag: "🇪🇬" },
  { code: "AR", name: "Argentina",     flag: "🇦🇷" },
  { code: "CL", name: "Chile",         flag: "🇨🇱" },
  { code: "SE", name: "Sweden",        flag: "🇸🇪" },
  { code: "NO", name: "Norway",        flag: "🇳🇴" },
  { code: "DK", name: "Denmark",       flag: "🇩🇰" },
  { code: "NZ", name: "New Zealand",   flag: "🇳🇿" },
];

const COMPARE_CODES_DEFAULT =
  "US,CN,JP,GB,IN,DE,FR,BR,KR,AU,CA,SG,TH,ID,MY,VN,PH,MX,TR,SA";

// ── Category config for World Bank indicators ────────────────────────────────

type CategoryDef = {
  title: string;
  icon: string;
  indicators: { key: string; label: string; unit: string; description: string; goodDirection?: "up" | "down" | "neutral" }[];
};

const WB_CATEGORIES: CategoryDef[] = [
  {
    title: "MACROECONOMICS",
    icon: "📊",
    indicators: [
      { key: "gdp_usd",     label: "GDP",              unit: "USD",   description: "Gross Domestic Product (nominal)",             goodDirection: "up" },
      { key: "gdp_growth",   label: "GDP Growth",       unit: "% YoY", description: "Real GDP year-over-year growth rate",          goodDirection: "up" },
      { key: "gdp_per_cap",  label: "GDP per Capita",   unit: "USD",   description: "GDP per capita (nominal)",                     goodDirection: "up" },
      { key: "hdi_proxy_gni",label: "GNI per Capita PPP",unit: "USD",  description: "Gross National Income per capita (PPP)",       goodDirection: "up" },
      { key: "cpi",          label: "Inflation (CPI)",  unit: "% YoY", description: "Consumer Price Index year-over-year",          goodDirection: "down" },
      { key: "unemployment", label: "Unemployment",     unit: "%",     description: "Unemployment rate (% of labor force)",         goodDirection: "down" },
      { key: "current_acct", label: "Current Account",  unit: "% GDP", description: "Current account balance as % of GDP",          goodDirection: "up" },
      { key: "trade_balance",label: "Trade Balance",     unit: "% GDP", description: "Net trade in goods and services (% of GDP)",   goodDirection: "up" },
      { key: "debt_gdp",     label: "Govt Debt / GDP",  unit: "%",     description: "Central government debt as % of GDP",          goodDirection: "down" },
      { key: "fiscal_bal",   label: "Fiscal Balance",   unit: "% GDP", description: "Net lending(+)/borrowing(-) (% of GDP)",       goodDirection: "up" },
    ],
  },
  {
    title: "FINANCIAL MARKETS",
    icon: "💹",
    indicators: [
      { key: "broad_money",     label: "Broad Money / GDP",  unit: "%",  description: "Broad money (M2+) as % of GDP",              goodDirection: "neutral" },
      { key: "domestic_credit", label: "Domestic Credit/GDP", unit: "%",  description: "Domestic credit to private sector (% GDP)",   goodDirection: "neutral" },
      { key: "reserves_mo",     label: "FX Reserves",         unit: "mo", description: "Total reserves in months of imports",         goodDirection: "up" },
      { key: "ext_debt",        label: "Ext. Debt / GNI",     unit: "%",  description: "External debt stocks (% of GNI)",            goodDirection: "down" },
    ],
  },
  {
    title: "MONETARY POLICY",
    icon: "🏦",
    indicators: [
      { key: "broad_money",     label: "Money Supply (M2+)",  unit: "% GDP", description: "Broad money as % of GDP — proxy for monetary base",    goodDirection: "neutral" },
      { key: "domestic_credit", label: "Credit Growth",        unit: "% GDP", description: "Domestic credit to private sector — credit expansion", goodDirection: "neutral" },
      { key: "cpi",             label: "Inflation Target",     unit: "% YoY", description: "CPI — key driver of central bank policy",              goodDirection: "down" },
    ],
  },
  {
    title: "REAL ECONOMY",
    icon: "🏭",
    indicators: [
      { key: "industry_va",    label: "Industry",          unit: "% GDP",  description: "Industry value added (% of GDP)",       goodDirection: "neutral" },
      { key: "services_va",    label: "Services",          unit: "% GDP",  description: "Services value added (% of GDP)",       goodDirection: "neutral" },
      { key: "agriculture_va", label: "Agriculture",       unit: "% GDP",  description: "Agriculture value added (% of GDP)",    goodDirection: "neutral" },
      { key: "gfcf",           label: "Capital Formation", unit: "% GDP",  description: "Gross fixed capital formation (% GDP)", goodDirection: "up" },
      { key: "exports_gdp",    label: "Exports",           unit: "% GDP",  description: "Exports of goods & services (% GDP)",   goodDirection: "up" },
      { key: "imports_gdp",    label: "Imports",           unit: "% GDP",  description: "Imports of goods & services (% GDP)",   goodDirection: "neutral" },
      { key: "fdi_net",        label: "FDI Net Inflows",   unit: "% GDP",  description: "Net FDI inflows (% of GDP)",            goodDirection: "up" },
      { key: "tax_rev",           label: "Tax Revenue",       unit: "% GDP",  description: "Tax revenue (% of GDP)",                goodDirection: "neutral" },
      { key: "listed_companies", label: "Listed Companies",  unit: "",       description: "Listed domestic companies, total (World Bank)", goodDirection: "up" },
    ],
  },
  {
    title: "SOCIAL INDICATORS",
    icon: "👥",
    indicators: [
      { key: "population",      label: "Population",      unit: "",      description: "Total population",                       goodDirection: "neutral" },
      { key: "pop_growth",      label: "Pop. Growth",     unit: "% YoY", description: "Population growth rate",                 goodDirection: "neutral" },
      { key: "life_expectancy", label: "Life Expectancy", unit: "years", description: "Life expectancy at birth",               goodDirection: "up" },
      { key: "literacy",        label: "Literacy Rate",   unit: "%",     description: "Adult literacy rate (% ages 15+)",       goodDirection: "up" },
      { key: "gini",            label: "Gini Index",      unit: "",      description: "Income inequality (0=equal, 100=unequal)",goodDirection: "down" },
      { key: "hdi_proxy_gni",   label: "GNI per Cap PPP", unit: "USD",  description: "GNI per capita PPP — HDI proxy",         goodDirection: "up" },
    ],
  },
  {
    title: "COMPETITIVENESS",
    icon: "🌍",
    indicators: [
      { key: "ease_business",    label: "Ease of Business",  unit: "rank",  description: "Ease of Doing Business rank (World Bank)",     goodDirection: "down" },
      { key: "political_stab",   label: "Political Stability",unit: "score", description: "Political Stability Index (-2.5 to +2.5)",     goodDirection: "up" },
      { key: "rule_of_law",      label: "Rule of Law",        unit: "score", description: "Rule of Law Index (-2.5 to +2.5)",             goodDirection: "up" },
      { key: "gov_effectiveness",label: "Govt Effectiveness", unit: "score", description: "Government Effectiveness (-2.5 to +2.5)",      goodDirection: "up" },
      { key: "control_corrupt",  label: "Corruption Control", unit: "score", description: "Control of Corruption Index (-2.5 to +2.5)",   goodDirection: "up" },
    ],
  },
];

function fmtWbVal(v: number | null | undefined, unit: string): string {
  if (v == null) return "—";
  if (unit === "USD" && v > 1_000_000_000_000) return `$${(v / 1_000_000_000_000).toFixed(2)}T`;
  if (unit === "USD" && v > 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (unit === "USD" && v > 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (unit === "USD") return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (unit === "" && v > 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (unit === "" && v > 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (unit === "rank") return `#${v.toFixed(0)}`;
  if (unit === "score") return v.toFixed(2);
  if (unit === "mo") return `${v.toFixed(1)} mo`;
  if (unit === "years") return `${v.toFixed(1)}`;
  return v.toFixed(1) + (unit.includes("%") || unit === "%" || unit === "% YoY" || unit === "% GDP" || unit === "% MoM" ? "%" : unit ? ` ${unit}` : "");
}

function CountrySelector({ selected, onSelect, colors, isDark }: {
  selected: string; onSelect: (code: string) => void; colors: any; isDark: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = search
    ? POPULAR_COUNTRIES.filter(c =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.code.toLowerCase().includes(search.toLowerCase())
      )
    : POPULAR_COUNTRIES;

  const current = POPULAR_COUNTRIES.find(c => c.code === selected);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 border text-xs font-mono font-bold transition-colors hover:opacity-80"
        style={{ borderColor: colors.accent, color: colors.accent, backgroundColor: isDark ? "#0a0a0a" : "#fff" }}
      >
        <Globe className="h-3 w-3" />
        {current ? `${current.flag} ${current.code}` : selected}
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-1 z-50 border w-64 max-h-80 overflow-hidden flex flex-col"
          style={{ backgroundColor: isDark ? "#0a0a0a" : "#fff", borderColor: colors.border }}
        >
          <div className="p-2 border-b" style={{ borderColor: colors.border }}>
            <div className="flex items-center gap-2 px-2 py-1 border" style={{ borderColor: colors.border, backgroundColor: colors.surface }}>
              <Search className="h-3 w-3" style={{ color: colors.textSecondary }} />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search country..."
                className="bg-transparent text-xs font-mono outline-none flex-1"
                style={{ color: colors.text }}
                autoFocus
              />
            </div>
          </div>
          <div className="overflow-y-auto flex-1">
            {filtered.map(c => (
              <button
                key={c.code}
                type="button"
                onClick={() => { onSelect(c.code); setOpen(false); setSearch(""); }}
                className="w-full text-left px-3 py-1.5 text-xs font-mono hover:opacity-80 flex items-center gap-2"
                style={{
                  backgroundColor: c.code === selected ? (isDark ? "#1a1a0a" : "#fffff0") : "transparent",
                  color: c.code === selected ? colors.accent : colors.text,
                }}
              >
                <span>{c.flag}</span>
                <span className="font-bold" style={{ color: colors.textSecondary }}>{c.code}</span>
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── WB Indicator value card ──────────────────────────────────────────────────

function WbCard({ label, wb, unit, description, goodDirection, colors, isDark }: {
  label: string; wb: WbValue; unit: string; description: string;
  goodDirection?: "up" | "down" | "neutral"; colors: any; isDark: boolean;
}) {
  if (!wb) {
    return (
      <div className="border p-2.5 flex flex-col gap-0.5 opacity-40" style={{ borderColor: colors.border, backgroundColor: colors.surface }}>
        <div className="text-[8px] tracking-widest font-bold truncate" style={{ color: colors.textSecondary }}>{label}</div>
        <div className="text-sm font-mono font-bold" style={{ color: colors.text }}>—</div>
      </div>
    );
  }

  return (
    <div className="border p-2.5 flex flex-col gap-0.5" style={{ borderColor: colors.border, backgroundColor: colors.surface }}>
      <div className="text-[8px] tracking-widest font-bold truncate" style={{ color: colors.textSecondary }}>{label}</div>
      <div className="text-sm font-mono font-bold" style={{ color: colors.text }}>
        {fmtWbVal(wb.value, unit)}
      </div>
      <div className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
        {wb.year}
      </div>
    </div>
  );
}

// ── Tornado Chart (horizontal bar, bilateral) ────────────────────────────────

function TornadoChart({ data, colors, isDark, title, subtitle }: {
  data: { label: string; value: number; color?: string }[];
  colors: any; isDark: boolean; title: string; subtitle?: string;
}) {
  if (!data.length) return null;

  const maxAbs = Math.max(...data.map(d => Math.abs(d.value)), 1);

  return (
    <div>
      <SectionHeader title={title} sub={subtitle} colors={colors} />
      <div className="space-y-1">
        {data.map((item, i) => {
          const pct = (Math.abs(item.value) / maxAbs) * 100;
          const isPositive = item.value >= 0;
          const barColor = item.color ?? (isPositive ? "#4caf50" : "#ef5350");

          return (
            <div key={i} className="flex items-center gap-2 h-6">
              <div className="w-28 text-right text-[9px] font-mono truncate shrink-0" style={{ color: colors.textSecondary }}>
                {item.label}
              </div>
              <div className="flex-1 h-4 relative" style={{ backgroundColor: isDark ? "#1a1a1a" : "#f0f0f0" }}>
                {isPositive ? (
                  <div
                    className="absolute left-1/2 top-0 h-full"
                    style={{ width: `${pct / 2}%`, backgroundColor: barColor, opacity: 0.8 }}
                  />
                ) : (
                  <div
                    className="absolute top-0 h-full"
                    style={{ right: "50%", width: `${pct / 2}%`, backgroundColor: barColor, opacity: 0.8 }}
                  />
                )}
                <div className="absolute left-1/2 top-0 bottom-0 w-px" style={{ backgroundColor: colors.textSecondary, opacity: 0.3 }} />
              </div>
              <div className="w-20 text-[9px] font-mono font-bold shrink-0" style={{ color: barColor }}>
                {item.value > 0 ? "+" : ""}{item.value.toFixed(3)}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── WB Time Series chart ─────────────────────────────────────────────────────

function WbSeriesChart({ series, label, unit, colors, isDark }: {
  series: WbSeriesPoint[]; label: string; unit: string; colors: any; isDark: boolean;
}) {
  if (!series || series.length < 2) return null;

  const data = [...series].reverse();
  const gridColor    = isDark ? "#2a2a2a" : "#e5e5e5";
  const tooltipStyle = { backgroundColor: isDark ? "#1a1a1a" : "#fff", border: `1px solid ${colors.border}`, fontSize: 11, fontFamily: "monospace" };
  const hasNegative  = data.some(d => d.value < 0);

  return (
    <div>
      <SectionHeader title={label} sub={`${data.length} year history`} colors={colors} />
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid vertical={false} stroke={gridColor} />
          <XAxis dataKey="year" tick={{ fontSize: 9, fontFamily: "monospace", fill: colors.textSecondary }} />
          <YAxis
            tickFormatter={(v: number) => fmtWbVal(v, unit)}
            tick={{ fontSize: 9, fontFamily: "monospace", fill: colors.textSecondary }}
            domain={hasNegative ? ["auto", "auto"] : [0, "auto"]}
          />
          <Tooltip
            formatter={(v: number) => [fmtWbVal(v, unit), label]}
            contentStyle={tooltipStyle} labelStyle={{ color: colors.text }}
          />
          <Bar dataKey="value" radius={[2, 2, 0, 0]}>
            {data.map((entry, i) => {
              const prev = i > 0 ? data[i - 1].value : entry.value;
              return <Cell key={i} fill={entry.value >= prev ? "#4caf50" : "#ef5350"} />;
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Economic Structure Donut (as horizontal stacked bar) ─────────────────────

function EconomicStructureBar({ indicators, colors, isDark }: {
  indicators: Record<string, WbValue>; colors: any; isDark: boolean;
}) {
  // Use raw (un-rounded) values for all computations to keep bar widths accurate
  const agr = indicators.agriculture_va;
  const ind = indicators.industry_va;
  const svc = indicators.services_va;

  const agriculture = agr?.value ?? 0;
  const industry    = ind?.value ?? 0;
  const services    = svc?.value ?? 0;
  const sum3 = agriculture + industry + services;
  if (sum3 === 0) return null;

  // Year of sector data (all three should match — WB releases them together)
  const dataYear = agr?.year ?? ind?.year ?? svc?.year ?? "";

  const exceedsHundred = sum3 > 100.5;
  // Residual = net taxes on products (taxes − subsidies on products)
  // Bridges value-added at basic prices → GDP at market prices (SNA identity)
  const netTaxes = Math.max(0, 100 - sum3);
  const showNetTaxes = !exceedsHundred && netTaxes > 0.3;

  const segments = [
    { label: "Agriculture", value: agriculture, color: "#4caf50" },
    { label: "Industry",    value: industry,    color: "#ff9800" },
    { label: "Services",    value: services,    color: "#42a5f5" },
    ...(showNetTaxes ? [{ label: "Net Taxes on Products", value: netTaxes, color: "#757575" }] : []),
  ];

  const barTotal = exceedsHundred ? sum3 : 100;

  return (
    <div>
      <SectionHeader
        title="ECONOMIC STRUCTURE"
        sub={`value added at basic prices${dataYear ? ` (${dataYear})` : ""} — GDP = VA + net product taxes`}
        colors={colors}
      />
      {exceedsHundred && (
        <div className="text-[9px] font-mono mb-1.5 px-2 py-1 border" style={{ borderColor: "#ff9800", color: "#ff9800", backgroundColor: isDark ? "#1a0e00" : "#fff8f0" }}>
          ⚠ Sum ({sum3.toFixed(2)}%) exceeds 100% — World Bank data may include overlapping sub-categories
        </div>
      )}
      <div className="flex h-6 w-full overflow-hidden border" style={{ borderColor: colors.border }}>
        {segments.map(s => (
          <div
            key={s.label}
            className="flex items-center justify-center text-[8px] font-mono font-bold text-black"
            style={{ width: `${(s.value / barTotal) * 100}%`, backgroundColor: s.color, minWidth: s.value > 0.5 ? "20px" : "0" }}
          >
            {s.value >= 5 ? `${s.value.toFixed(1)}%` : ""}
          </div>
        ))}
      </div>
      <div className="flex gap-3 mt-1.5 flex-wrap items-center">
        {segments.map(s => (
          <div key={s.label} className="flex items-center gap-1.5 text-[9px] font-mono" style={{ color: colors.textSecondary }}>
            <span className="w-2 h-2 shrink-0" style={{ backgroundColor: s.color }} />
            {s.label}: <span className="font-bold" style={{ color: colors.text }}>{s.value.toFixed(2)}%</span>
          </div>
        ))}
        <div className="ml-auto text-[9px] font-mono" style={{ color: colors.textSecondary }}>
          VA sum: <span className="font-bold" style={{ color: exceedsHundred ? "#ff9800" : colors.text }}>{sum3.toFixed(2)}%</span>
          {showNetTaxes && <span style={{ color: "#757575" }}> + {netTaxes.toFixed(2)}% taxes = 100%</span>}
        </div>
      </div>
    </div>
  );
}

// ── Governance Radar Chart ───────────────────────────────────────────────────

function GovernanceRadar({ indicators, colors, isDark }: {
  indicators: Record<string, WbValue>; colors: any; isDark: boolean;
}) {
  const metrics = [
    { key: "political_stab",    label: "Political Stability" },
    { key: "rule_of_law",       label: "Rule of Law" },
    { key: "gov_effectiveness", label: "Govt Effectiveness" },
    { key: "control_corrupt",   label: "Corruption Control" },
  ];

  const data = metrics.map(m => {
    const v = indicators[m.key]?.value ?? 0;
    // WGI scores range from -2.5 to +2.5, normalize to 0-100
    return { subject: m.label, value: Math.round(((v + 2.5) / 5) * 100), raw: v };
  });

  if (data.every(d => d.raw === 0)) return null;

  return (
    <div>
      <SectionHeader title="GOVERNANCE INDICATORS" sub="World Governance Indicators (-2.5 to +2.5)" colors={colors} />
      <ResponsiveContainer width="100%" height={280}>
        <RadarChart data={data}>
          <PolarGrid stroke={isDark ? "#333" : "#ddd"} />
          <PolarAngleAxis
            dataKey="subject"
            tick={{ fontSize: 9, fontFamily: "monospace", fill: colors.textSecondary }}
          />
          <PolarRadiusAxis
            angle={30} domain={[0, 100]}
            tick={{ fontSize: 8, fill: colors.textSecondary }}
          />
          <Radar
            name="Score"
            dataKey="value"
            stroke={colors.accent}
            fill={colors.accent}
            fillOpacity={0.2}
            strokeWidth={2}
          />
          <Tooltip
            formatter={(v: number, name: string, props: any) => {
              const raw = props.payload?.raw;
              return [`${raw?.toFixed(2) ?? v} (normalized: ${v})`, name];
            }}
            contentStyle={{ backgroundColor: isDark ? "#1a1a1a" : "#fff", border: `1px solid ${colors.border}`, fontSize: 11, fontFamily: "monospace" }}
          />
        </RadarChart>
      </ResponsiveContainer>
      {/* Raw scores table */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 mt-2">
        {data.map(d => (
          <div key={d.subject} className="border p-2 text-center font-mono" style={{ borderColor: colors.border, backgroundColor: colors.surface }}>
            <div className="text-[8px] truncate" style={{ color: colors.textSecondary }}>{d.subject}</div>
            <div className="text-sm font-bold" style={{ color: d.raw >= 0 ? "#4caf50" : "#ef5350" }}>
              {d.raw >= 0 ? "+" : ""}{d.raw.toFixed(2)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Population Tornado Chart ─────────────────────────────────────────────────

function PopulationTornado({ indicators, colors, isDark }: {
  indicators: Record<string, WbValue>; colors: any; isDark: boolean;
}) {
  const popGrowth = indicators.pop_growth;
  if (!popGrowth?.series || popGrowth.series.length < 2) return null;

  const data = [...popGrowth.series].reverse().map(s => ({
    label: s.year,
    value: s.value,
    // Blue = still growing (positive); Red = population shrinking (negative)
    color: s.value >= 0 ? "#42a5f5" : "#ef5350",
  }));

  return (
    <TornadoChart
      data={data}
      colors={colors}
      isDark={isDark}
      title="POPULATION GROWTH (% YoY)"
      subtitle="blue = growing, red = shrinking; bar length = rate magnitude"
    />
  );
}

// ── Listed Companies horizontal bar chart ───────────────────────────────────

function ListedCompaniesChart({ colors, isDark, selectedCountry }: { colors: any; isDark: boolean; selectedCountry: string }) {
  const { data, isLoading, isError, error } = useSovereignCompare("listed_companies", COMPARE_CODES_DEFAULT);

  if (isLoading) return (
    <div className="flex items-center gap-2 py-4 text-xs font-mono" style={{ color: colors.textSecondary }}>
      <RefreshCw className="h-3 w-3 animate-spin" style={{ color: colors.accent }} />
      Loading listed companies data...
    </div>
  );

  if (isError) return (
    <div className="flex items-center gap-2 p-3 border text-xs font-mono" style={{ borderColor: "#ef5350", color: "#ef5350" }}>
      <AlertTriangle className="h-3 w-3 shrink-0" />
      Listed companies unavailable: {error?.message ?? "Unknown error"}
    </div>
  );

  if (!data?.data?.length) return null;

  const chartData = data.data.slice(0, 20).map(d => ({
    name: d.code,
    fullName: d.name,
    value: d.value ?? 0,
    year: d.year,
  }));

  const tooltipStyle = {
    backgroundColor: isDark ? "#1a1a1a" : "#fff",
    border: `1px solid ${colors.border}`,
    fontSize: 11, fontFamily: "monospace",
  };

  return (
    <div>
      <SectionHeader
        title="LISTED DOMESTIC COMPANIES"
        sub={`World Bank (CM.MKT.LDOM.NO) — top ${chartData.length} markets`}
        colors={colors}
      />
      <ResponsiveContainer width="100%" height={320}>
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 5, right: 60, left: 40, bottom: 5 }}
        >
          <CartesianGrid horizontal={false} stroke={isDark ? "#2a2a2a" : "#e5e5e5"} />
          <XAxis
            type="number"
            tickFormatter={(v: number) =>
              v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)
            }
            tick={{ fontSize: 9, fontFamily: "monospace", fill: colors.textSecondary }}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={36}
            tick={{ fontSize: 9, fontFamily: "monospace", fill: colors.textSecondary }}
          />
          <Tooltip
            formatter={(v: number, _n: string, p: any) => [
              v.toLocaleString(),
              `${p.payload.fullName} (${p.payload.year})`,
            ]}
            contentStyle={tooltipStyle}
            labelStyle={{ color: colors.text }}
          />
          <Bar dataKey="value" radius={[0, 2, 2, 0]}>
            {chartData.map((entry, i) => {
              const isSelected = entry.name === selectedCountry;
              const baseFill = i === 0 ? colors.accent : i < 5 ? "#42a5f5" : isDark ? "#2a4a6a" : "#90caf9";
              return (
                <Cell
                  key={i}
                  fill={isSelected ? colors.accent : baseFill}
                  stroke={isSelected ? (isDark ? "#fff" : "#000") : undefined}
                  strokeWidth={isSelected ? 1.5 : 0}
                />
              );
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── GINI cross-country comparison ────────────────────────────────────────────

function GiniComparisonChart({ colors, isDark, selectedCountry }: { colors: any; isDark: boolean; selectedCountry: string }) {
  const { data, isLoading, isError, error } = useSovereignCompare("gini", COMPARE_CODES_DEFAULT);

  if (isLoading) return (
    <div className="flex items-center gap-2 py-4 text-xs font-mono" style={{ color: colors.textSecondary }}>
      <RefreshCw className="h-3 w-3 animate-spin" style={{ color: colors.accent }} />
      Loading GINI data...
    </div>
  );

  if (isError) return (
    <div className="flex items-center gap-2 p-3 border text-xs font-mono" style={{ borderColor: "#ef5350", color: "#ef5350" }}>
      <AlertTriangle className="h-3 w-3 shrink-0" />
      GINI comparison unavailable: {error?.message ?? "Unknown error"}
    </div>
  );

  if (!data?.data?.length) return null;

  const chartData = [...data.data]
    .filter(d => d.value !== null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .map(d => ({ name: d.code, fullName: d.name, value: d.value ?? 0, year: d.year }));

  const tooltipStyle = {
    backgroundColor: isDark ? "#1a1a1a" : "#fff",
    border: `1px solid ${colors.border}`,
    fontSize: 11, fontFamily: "monospace",
  };

  const giniColor = (v: number) =>
    v > 45 ? "#ef5350" : v > 35 ? "#ff9800" : "#4caf50";

  return (
    <div>
      <SectionHeader
        title="GINI INDEX — CROSS-COUNTRY"
        sub="World Bank (SI.POV.GINI) — higher = more unequal; sorted descending"
        colors={colors}
      />
      <ResponsiveContainer width="100%" height={320}>
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 5, right: 50, left: 40, bottom: 5 }}
        >
          <CartesianGrid horizontal={false} stroke={isDark ? "#2a2a2a" : "#e5e5e5"} />
          <XAxis
            type="number"
            domain={[20, 70]}
            tickFormatter={(v: number) => String(v)}
            tick={{ fontSize: 9, fontFamily: "monospace", fill: colors.textSecondary }}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={36}
            tick={{ fontSize: 9, fontFamily: "monospace", fill: colors.textSecondary }}
          />
          <Tooltip
            formatter={(v: number, _n: string, p: any) => [
              `${v.toFixed(1)}`,
              `${p.payload.fullName} (${p.payload.year})`,
            ]}
            contentStyle={tooltipStyle}
            labelStyle={{ color: colors.text }}
          />
          <ReferenceLine x={35} stroke="#4caf50" strokeDasharray="4 2"
            label={{ value: "Low", position: "insideTopRight", fontSize: 8, fill: "#4caf50" }} />
          <ReferenceLine x={45} stroke="#ef5350" strokeDasharray="4 2"
            label={{ value: "High", position: "insideTopRight", fontSize: 8, fill: "#ef5350" }} />
          <Bar dataKey="value" radius={[0, 2, 2, 0]}>
            {chartData.map((entry, i) => {
              const isSelected = entry.name === selectedCountry;
              return (
                <Cell
                  key={i}
                  fill={isSelected ? colors.accent : giniColor(entry.value)}
                  stroke={isSelected ? (isDark ? "#fff" : "#000") : undefined}
                  strokeWidth={isSelected ? 1.5 : 0}
                />
              );
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Country Macro Tab content ────────────────────────────────────────────────

export function CountryMacroTab({ colors, isDark }: { colors: any; isDark: boolean }) {
  const [country, setCountry] = useState("US");
  const [activeCategory, setActiveCategory] = useState(0);
  const { data: countryData, isLoading, error } = useSovereignDetail(country);
  const refreshSovereign = useSovereignRefresh();

  const cat = WB_CATEGORIES[activeCategory];

  return (
    <div className="space-y-4">
      {/* Country selector + Risk Score */}
      <div className="flex items-center gap-4 flex-wrap">
        <CountrySelector selected={country} onSelect={setCountry} colors={colors} isDark={isDark} />

        {countryData && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>SOVEREIGN RISK:</span>
              <span
                className="px-2 py-0.5 text-xs font-mono font-bold border"
                style={{
                  borderColor: countryData.risk_label === "LOW" ? "#4caf50" : countryData.risk_label === "HIGH" ? "#ef5350" : "#ff9800",
                  color:       countryData.risk_label === "LOW" ? "#4caf50" : countryData.risk_label === "HIGH" ? "#ef5350" : "#ff9800",
                  backgroundColor: isDark ? "#0a0a0a" : "#fff",
                }}
              >
                {countryData.risk_label} ({countryData.risk_score}/100)
              </span>
            </div>

            <div
              className="flex items-center gap-2 text-[10px] font-mono"
              style={{ color: colors.textSecondary }}
            >
              <Database className="h-3 w-3" style={{ color: "#42a5f5" }} />
              Data: <span style={{ color: "#42a5f5" }}>World Bank</span>
            </div>

            <button
              type="button" onClick={refreshSovereign}
              className="flex items-center gap-1 text-[10px] font-mono hover:opacity-70 ml-auto"
              style={{ color: colors.accent }}
            >
              <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
              REFRESH
            </button>
          </>
        )}
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 flex-wrap">
        {WB_CATEGORIES.map((c, i) => (
          <button
            key={c.title}
            type="button"
            onClick={() => setActiveCategory(i)}
            className="px-2.5 py-1 text-[10px] font-mono font-bold border tracking-wider transition-colors"
            style={{
              borderColor:     activeCategory === i ? colors.accent : colors.border,
              backgroundColor: activeCategory === i ? colors.accent : "transparent",
              color:           activeCategory === i ? "#000" : colors.text,
            }}
          >
            {c.icon} {c.title}
          </button>
        ))}
      </div>

      {/* Loading / Error */}
      {isLoading && !countryData && (
        <div className="flex items-center justify-center py-12" style={{ color: colors.textSecondary }}>
          <RefreshCw className="h-5 w-5 animate-spin mr-3" style={{ color: colors.accent }} />
          <span className="text-sm font-mono">Fetching World Bank data for {country}...</span>
        </div>
      )}

      {error && !countryData && (
        <div className="flex items-center gap-2 p-3 border text-sm font-mono" style={{ borderColor: "#ef5350", color: "#ef5350" }}>
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Error: {String(error)}</span>
        </div>
      )}

      {/* Country data */}
      {countryData && (
        <div className="space-y-6">
          {/* Indicator cards grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {cat.indicators.map(ind => (
              <WbCard
                key={ind.key}
                label={ind.label}
                wb={countryData.indicators[ind.key]}
                unit={ind.unit}
                description={ind.description}
                goodDirection={ind.goodDirection}
                colors={colors}
                isDark={isDark}
              />
            ))}
          </div>

          {/* Category-specific charts */}
          {activeCategory === 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* GDP Growth time series */}
              {countryData.indicators.gdp_growth?.series && (
                <WbSeriesChart
                  series={countryData.indicators.gdp_growth.series}
                  label="GDP GROWTH"
                  unit="% YoY"
                  colors={colors}
                  isDark={isDark}
                />
              )}
              {/* CPI time series */}
              {countryData.indicators.cpi?.series && (
                <WbSeriesChart
                  series={countryData.indicators.cpi.series}
                  label="INFLATION (CPI)"
                  unit="% YoY"
                  colors={colors}
                  isDark={isDark}
                />
              )}
              {/* Unemployment time series */}
              {countryData.indicators.unemployment?.series && (
                <WbSeriesChart
                  series={countryData.indicators.unemployment.series}
                  label="UNEMPLOYMENT"
                  unit="%"
                  colors={colors}
                  isDark={isDark}
                />
              )}
              {/* Debt/GDP time series */}
              {countryData.indicators.debt_gdp?.series && (
                <WbSeriesChart
                  series={countryData.indicators.debt_gdp.series}
                  label="GOVT DEBT / GDP"
                  unit="%"
                  colors={colors}
                  isDark={isDark}
                />
              )}
            </div>
          )}

          {activeCategory === 1 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {countryData.indicators.broad_money?.series && (
                <WbSeriesChart series={countryData.indicators.broad_money.series} label="BROAD MONEY / GDP" unit="%" colors={colors} isDark={isDark} />
              )}
              {countryData.indicators.domestic_credit?.series && (
                <WbSeriesChart series={countryData.indicators.domestic_credit.series} label="DOMESTIC CREDIT / GDP" unit="%" colors={colors} isDark={isDark} />
              )}
            </div>
          )}

          {activeCategory === 2 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {countryData.indicators.broad_money?.series && (
                <WbSeriesChart series={countryData.indicators.broad_money.series} label="MONEY SUPPLY (M2+) / GDP" unit="%" colors={colors} isDark={isDark} />
              )}
              {countryData.indicators.domestic_credit?.series && (
                <WbSeriesChart series={countryData.indicators.domestic_credit.series} label="DOMESTIC CREDIT EXPANSION / GDP" unit="%" colors={colors} isDark={isDark} />
              )}
              {countryData.indicators.cpi?.series && (
                <WbSeriesChart series={countryData.indicators.cpi.series} label="INFLATION (CPI) — POLICY DRIVER" unit="% YoY" colors={colors} isDark={isDark} />
              )}
            </div>
          )}

          {activeCategory === 3 && (
            <div className="space-y-6">
              <EconomicStructureBar indicators={countryData.indicators} colors={colors} isDark={isDark} />
              <ListedCompaniesChart colors={colors} isDark={isDark} selectedCountry={country} />
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {countryData.indicators.exports_gdp?.series && (
                  <WbSeriesChart series={countryData.indicators.exports_gdp.series} label="EXPORTS / GDP" unit="%" colors={colors} isDark={isDark} />
                )}
                {countryData.indicators.fdi_net?.series && (
                  <WbSeriesChart series={countryData.indicators.fdi_net.series} label="FDI NET / GDP" unit="%" colors={colors} isDark={isDark} />
                )}
              </div>
            </div>
          )}

          {activeCategory === 4 && (
            <div className="space-y-6">
              <PopulationTornado indicators={countryData.indicators} colors={colors} isDark={isDark} />
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {countryData.indicators.population?.series && (
                  <WbSeriesChart series={countryData.indicators.population.series} label="TOTAL POPULATION" unit="" colors={colors} isDark={isDark} />
                )}
                {countryData.indicators.life_expectancy?.series && (
                  <WbSeriesChart series={countryData.indicators.life_expectancy.series} label="LIFE EXPECTANCY" unit="years" colors={colors} isDark={isDark} />
                )}
                {countryData.indicators.gdp_per_cap?.series && (
                  <WbSeriesChart series={countryData.indicators.gdp_per_cap.series} label="GDP PER CAPITA" unit="USD" colors={colors} isDark={isDark} />
                )}
                {countryData.indicators.gini?.series && countryData.indicators.gini.series.length >= 2 && (
                  <WbSeriesChart
                    series={countryData.indicators.gini.series}
                    label={`GINI INDEX — ${countryData.name.toUpperCase()}`}
                    unit=""
                    colors={colors}
                    isDark={isDark}
                  />
                )}
              </div>
              <GiniComparisonChart colors={colors} isDark={isDark} selectedCountry={country} />
            </div>
          )}

          {activeCategory === 5 && (
            <GovernanceRadar indicators={countryData.indicators} colors={colors} isDark={isDark} />
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
