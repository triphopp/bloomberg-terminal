"use client";

import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { QUAD_COLOR } from "../../lib/rrg-quadrant";
import type { ScreenFactor, ScreenRow, ThemeColors } from "./types";
import { useSectorScreen } from "./useNewsQueries";

// ROTATION → a group → SCREEN: the group's members ranked by four factors inside
// the group, with the market's state (F&G, VIX, MOVE) picking the weights. A
// ranking by stated rules, not advice — the panel says so at the foot.

const FACTORS: { id: ScreenFactor; short: string; title: string }[] = [
  { id: "momentum", short: "M", title: "Momentum: 12-1 month return" },
  { id: "quality", short: "Q", title: "Quality: ROE, ROA, gross margin, low debt/equity" },
  { id: "value", short: "V", title: "Value: earnings yield, EBITDA/EV, book/price" },
  { id: "low_vol", short: "L", title: "Low volatility: 1-year daily volatility" },
];

const STATE_COLOR = { normal: "#9ca3af", stress: "#ef4444", greed: "#22c55e" } as const;

function pctColor(p: number | null): string {
  if (p == null) return "#4b5563";
  return p >= 67 ? "#22c55e" : p <= 33 ? "#ef4444" : "#9ca3af";
}

const fmt = (v: number | null | undefined, d = 1) => (v == null ? "—" : v.toFixed(d));
const pctOf = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

function rowTitle(r: ScreenRow): string {
  const raw = r.raw;
  return [
    `${r.symbol} · ${r.name ?? ""} · weight ${fmt(r.weight, 2)}%`,
    `momentum 12-1 ${pctOf(raw.mom_12_1)} · vol 1y ${pctOf(raw.vol_1y)}`,
    `ROE ${pctOf(raw.roe)} · ROA ${pctOf(raw.roa)} · gross margin ${pctOf(raw.gross_margin)} · D/E ${fmt(raw.debt_to_equity)}`,
    `earnings yield ${pctOf(raw.earnings_yield)} · EBITDA/EV ${pctOf(raw.ebitda_to_ev)} · book/price ${fmt(raw.book_to_price, 3)}`,
    `beta to VIX ${fmt(r.beta_vix, 3)} · beta to MOVE ${fmt(r.beta_move, 3)} (daily return per 1.0 = 100% index move)`,
    ...r.flags.map((f) => `⚠ ${f}`),
  ].join("\n");
}

export function SectorScreen({
  market,
  group,
  colors,
}: {
  market: "US" | "TH";
  group: string;
  colors: ThemeColors;
}) {
  const q = useSectorScreen(market, group, true);
  const [showAll, setShowAll] = useState(false);
  const d = q.data;

  if (!d)
    return (
      <div
        className="flex items-center gap-2 px-2 py-2 text-[8px] font-mono"
        style={{ color: colors.textSecondary }}
      >
        {q.isError ? (
          "screen unavailable"
        ) : (
          <>
            <RefreshCw className="h-2.5 w-2.5 animate-spin" /> pricing members and reading their
            accounts…
          </>
        )}
      </div>
    );
  if (d.error && d.rows.length === 0)
    return (
      <div className="px-2 py-2 text-[8px] font-mono" style={{ color: colors.textSecondary }}>
        {d.error}
      </div>
    );

  const st = d.market_state;
  const rows = showAll ? d.rows : d.rows.slice(0, 8);
  return (
    <div className="font-mono">
      {st && (
        <div
          className="px-2 py-1 text-[8px] leading-snug"
          style={{ color: colors.textSecondary }}
          title={`${st.rule} (set ${st.rules_set})`}
        >
          <span className="font-bold" style={{ color: STATE_COLOR[st.state] }}>
            {st.state.toUpperCase()}
          </span>{" "}
          F&amp;G {fmt(st.fear_greed, 0)} · VIX {fmt(st.vix, 1)} (p{fmt(st.vix_pct_1y, 0)}) · MOVE{" "}
          {fmt(st.move, 0)} (p{fmt(st.move_pct_1y, 0)})
          <br />
          weights M {Math.round(st.weights.momentum * 100)} · Q{" "}
          {Math.round(st.weights.quality * 100)} · V {Math.round(st.weights.value * 100)} · L{" "}
          {Math.round(st.weights.low_vol * 100)}
        </div>
      )}

      <div
        className="grid items-center px-2 text-[7px]"
        style={{
          gridTemplateColumns: "10px 1fr 26px repeat(4, 16px) 10px",
          columnGap: 3,
          color: colors.textSecondary,
        }}
      >
        <span>#</span>
        <span>stock</span>
        <span className="text-right">score</span>
        {FACTORS.map((f) => (
          <span key={f.id} className="text-right" title={f.title}>
            {f.short}
          </span>
        ))}
        <span />
      </div>
      {rows.map((r, i) => {
        const top = d.top3?.includes(r.symbol);
        return (
          <div
            key={r.symbol}
            className="grid items-center px-2 py-px text-[8px]"
            style={{
              gridTemplateColumns: "10px 1fr 26px repeat(4, 16px) 10px",
              columnGap: 3,
              backgroundColor: top ? "#ffffff08" : undefined,
            }}
            title={rowTitle(r)}
          >
            <span style={{ color: colors.textSecondary }}>{i + 1}</span>
            <span className="truncate" style={{ color: top ? colors.accent : colors.text }}>
              <span
                className="text-[6px] mr-1"
                style={{ color: r.quadrant ? QUAD_COLOR[r.quadrant] : colors.textSecondary }}
              >
                ●
              </span>
              {r.symbol}
            </span>
            <span className="text-right font-bold" style={{ color: colors.text }}>
              {fmt(r.score, 0)}
            </span>
            {FACTORS.map((f) => (
              <span key={f.id} className="text-right" style={{ color: pctColor(r.factors[f.id]) }}>
                {r.factors[f.id] == null ? "—" : Math.round(r.factors[f.id] as number)}
              </span>
            ))}
            <span className="text-center" style={{ color: "#ff9800" }}>
              {r.flags.length ? "⚠" : ""}
            </span>
          </div>
        );
      })}
      {d.rows.length > 8 && (
        <button
          type="button"
          aria-pressed={showAll}
          onClick={() => setShowAll((v) => !v)}
          className="px-2 py-0.5 text-[7px] hover:opacity-80"
          style={{ color: colors.accent }}
        >
          {showAll ? "show top 8" : `show all ${d.rows.length}`}
        </button>
      )}
      <p className="px-2 py-1 text-[7px] leading-snug" style={{ color: colors.textSecondary }}>
        Percentiles inside the group (100 = best). Highlighted = first three with ≥3 of 4 factors. ●
        = the stock's own quadrant. ⚠ = falls most in the group when VIX / MOVE jumps, or data
        missing — hover a row for the numbers. {d.notes?.join(" · ")}
        {d.notes?.length ? " · " : ""}A ranking by stated rules, not a recommendation: factor
        evidence is for diversified portfolios, and choosing weights by market state is weaker
        evidence than the factors.
      </p>
    </div>
  );
}
