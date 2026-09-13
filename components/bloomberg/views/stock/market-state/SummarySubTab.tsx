"use client";

/**
 * A — Market State Summary.
 *
 * The whole point of the project in one screen: the reader should not have to
 * open RSI, MACD, ADX, ATR and Bollinger Bands to answer "what is this market
 * doing". So this tab is four readings and one sentence, and nothing else.
 *
 * Two things it deliberately shows that a single label would hide:
 *   * the FULL posterior, not just the winner — a 41/39 split and a 94/2 split
 *     are different situations and must not print alike;
 *   * every score with its direction — "positive but weakening" is the reading
 *     that a number alone cannot give.
 */

import type { bloombergColors } from "../../../lib/theme-config";
import type { MarketStateResponse, ScoreBlock } from "./types";

type Colors = typeof bloombergColors.dark;

/** 100% is never true of a posterior — showing it invites more trust than the model has. */
export function fmtProb(p: number): string {
  const pct = p * 100;
  if (pct >= 99.5) return ">99%";
  if (pct < 0.5 && pct > 0) return "<1%";
  return `${pct.toFixed(0)}%`;
}

function scoreColor(v: number | null | undefined, colors: Colors): string {
  if (v == null) return colors.textDimmed;
  if (v > 0.15) return colors.positive;
  if (v < -0.15) return colors.negative;
  return colors.textSecondary;
}

function Tile({
  title,
  value,
  sub,
  color,
  colors,
  hint,
}: {
  title: string;
  value: string;
  sub?: string | null;
  color: string;
  colors: Colors;
  hint?: string;
}) {
  return (
    // `break-words` + `min-w-0` matter more than they look: without them each
    // tile's min-content width is its longest LINE, the flex row inherits that,
    // and the whole panel grows wider than the NEWS column it is mounted in —
    // clipping every block below it, not only the tiles.
    <div
      className="border p-2 flex-1 basis-[130px] min-w-0 break-words"
      style={{ borderColor: colors.border }}
      title={hint}
    >
      <div className="text-[9px] tracking-widest" style={{ color: colors.textDimmed }}>
        {title}
      </div>
      <div className="text-base font-bold font-mono leading-tight" style={{ color }}>
        {value}
      </div>
      {sub && (
        <div
          className="text-[10px] font-mono leading-tight"
          style={{ color: colors.textSecondary }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

export function SummarySubTab({ data, colors }: { data: MarketStateResponse; colors: Colors }) {
  const regime = data.regime;
  const s = data.scores ?? {};
  if (!regime) return null;

  // Spread into a typed local rather than `?? {}`: an untyped empty object
  // widens every field to `never` and the compiler stops checking them.
  const trend: NonNullable<ScoreBlock["trend"]> = s.trend ?? {
    score: null,
    change: null,
    word: null,
    direction: null,
  };
  const mom: NonNullable<ScoreBlock["momentum"]> = s.momentum ?? {
    score: null,
    change: null,
    sign: null,
    word: null,
  };
  const vol: NonNullable<ScoreBlock["volatility"]> = s.volatility ?? {
    sigma: null,
    change: null,
    level: null,
    direction: null,
  };

  return (
    <div className="space-y-3 min-w-0">
      {/* ── The four readings ── */}
      <div className="flex flex-wrap gap-2">
        <Tile
          title="REGIME"
          value={`${regime.label} ${fmtProb(regime.probability)}`}
          sub={`${regime.confidence} · in state ${regime.bars_in_state} bars${
            regime.expected_duration ? ` · typical ${regime.expected_duration}` : ""
          }`}
          color={regime.color}
          colors={colors}
          hint={regime.states.find((x) => x.key === regime.key)?.blurb}
        />
        <Tile
          title="TREND"
          value={
            trend.score == null ? "—" : `${trend.score > 0 ? "+" : ""}${trend.score.toFixed(2)}`
          }
          sub={[trend.word, trend.direction].filter(Boolean).join(" · ")}
          color={scoreColor(trend.score, colors)}
          colors={colors}
          hint="−1 strong bearish · 0 neutral · +1 strong bullish, scaled against this symbol's own year"
        />
        <Tile
          title="MOMENTUM"
          value={mom.score == null ? "—" : `${mom.score > 0 ? "+" : ""}${mom.score.toFixed(2)}`}
          sub={[mom.sign, mom.word].filter(Boolean).join(" · ")}
          color={scoreColor(mom.score, colors)}
          colors={colors}
          hint="Shorter horizon than TREND on purpose, so the two can disagree — that disagreement is the signal"
        />
        <Tile
          title="VOLATILITY"
          value={vol.sigma == null ? "—" : `${vol.sigma > 0 ? "+" : ""}${vol.sigma.toFixed(2)}σ`}
          sub={[vol.level, vol.direction].filter(Boolean).join(" · ")}
          color={
            vol.sigma == null
              ? colors.textDimmed
              : vol.sigma >= 0.75
                ? colors.negative
                : vol.sigma <= -0.75
                  ? colors.accentBlue
                  : colors.textSecondary
          }
          colors={colors}
          hint="Realized vol against its own 252-bar distribution, in σ"
        />
      </div>

      {/* ── The sentence ── */}
      <div
        className="border p-2"
        style={{ borderColor: regime.color, background: `${regime.color}0d` }}
      >
        <div className="text-[9px] tracking-widest mb-1" style={{ color: colors.textDimmed }}>
          SUMMARY
        </div>
        <div className="text-sm font-mono font-bold break-words" style={{ color: colors.text }}>
          {data.summary}
        </div>
        {regime.transition_note && (
          <div className="text-[10px] font-mono mt-1" style={{ color: colors.accentBlue }}>
            ↻ {regime.transition_note}
          </div>
        )}
      </div>

      {/* ── The whole posterior ── */}
      <div>
        <div className="text-[9px] tracking-widest mb-1" style={{ color: colors.textDimmed }}>
          REGIME PROBABILITY — every state, not just the winner
        </div>
        <div className="space-y-1">
          {regime.states.map((st) => (
            <div key={st.key} className="flex items-center gap-2" title={st.blurb}>
              <span
                className="text-[10px] font-mono w-24 shrink-0"
                style={{ color: st.key === regime.key ? st.color : colors.textSecondary }}
              >
                {st.label}
              </span>
              <div className="flex-1 h-3 border" style={{ borderColor: colors.borderFaint }}>
                <div
                  className="h-full"
                  style={{
                    width: `${Math.max(0, Math.min(100, st.probability * 100))}%`,
                    background: st.color,
                    opacity: st.key === regime.key ? 1 : 0.55,
                  }}
                />
              </div>
              <span
                className="text-[10px] font-mono w-10 text-right"
                style={{ color: colors.text }}
              >
                {fmtProb(st.probability)}
              </span>
              <span
                className="text-[9px] font-mono w-24 text-right shrink-0"
                style={{ color: colors.textDimmed }}
                title="Share of this symbol's history spent in the state, and the state's typical length"
              >
                {(st.share * 100).toFixed(0)}% of hist
                {st.expected_duration ? ` · ~${st.expected_duration}b` : ""}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── What this can and cannot claim ── */}
      {data.basis && (
        <div className="text-[9px] font-mono leading-relaxed" style={{ color: colors.textDimmed }}>
          Labels: {data.basis.labels}. Parameters: {data.basis.parameters}.{" "}
          <span style={{ color: colors.textSecondary }}>{data.basis.claim}</span>
        </div>
      )}
    </div>
  );
}
