"use client";

import { useState } from "react";

import {
  type Colors,
  type ScenarioRow,
  type StressResponse,
  fmtBp,
  fmtM,
  fmtPct,
  fmtSignedPct,
  fmtX,
} from "./types";

/**
 * Scenarios run across the columns, one per shock, with the measures down the
 * side. Read the other way round, comparing two shocks means holding eight
 * column headings in mind; this way each measure is a single line to scan, and
 * the TODAY column gives every row the baseline it moves away from.
 */

type Tone = "bad" | "good" | "dim";
type Cell = { text: string; tone?: Tone };

interface Row {
  label: string;
  hint?: string;
  base: Cell;
  cell: (row: ScenarioRow) => Cell;
  group?: string;
  indent?: boolean;
}

const DASH: Cell = { text: "—", tone: "dim" };

/**
 * Fourteen shocks is too many columns to read at once, so they arrive in bands
 * and the reader picks which ones are on screen. A quarter-point move is what a
 * single meeting delivers and is already money for a leveraged issuer; a full
 * cycle is the question a year out. They are rarely the same question.
 */
const BANDS: { id: string; label: string; hint: string }[] = [
  { id: "meeting", label: "ONE MEETING", hint: "the size a single decision moves rates" },
  { id: "cycle", label: "FULL CYCLE", hint: "where rates get to over a year or more" },
  { id: "shape", label: "CURVE SHAPE", hint: "short and long ends moving apart" },
  { id: "history", label: "WHAT HAPPENED", hint: "replays of real episodes" },
];

export function ScenarioSubTab({ data, colors }: { data: StressResponse; colors: Colors }) {
  const [bands, setBands] = useState<string[]>(["meeting", "cycle"]);
  const all = data.scenarios;
  const scenarios = all.filter((r) => bands.includes(r.scenario.band ?? "cycle"));
  const v = data.valuation;
  const gap = data.channel_gap;
  const base = all[0];

  const theta = v.theta;
  const modelName =
    theta != null ? `Gordon growth model, pass-through ${theta.toFixed(2)}` : "Gordon growth model";

  const rows: Row[] = [
    {
      group: "THE SHOCK",
      label: "Ten-year Treasury moves by",
      base: { text: "no change", tone: "dim" },
      cell: (r) => ({ text: fmtBp(r.scenario.headline_bp) }),
    },
    {
      label: "What drove rates in this episode",
      base: DASH,
      cell: (r) => (r.scenario.driver ? { text: r.scenario.driver } : DASH),
    },
    {
      label: "A move this size has happened before",
      base: DASH,
      cell: (r) =>
        r.scenario.hypothetical
          ? { text: "no, invented", tone: "bad" }
          : { text: "yes", tone: "dim" },
    },

    {
      group: "WHAT IT COSTS IN INTEREST",
      label: "Extra interest per year, at least",
      hint: "nothing reprices; only the cash pile earns more",
      base: DASH,
      cell: (r) => ({ text: fmtM(r.delta_interest.lo) }),
    },
    {
      label: "Extra interest per year, at most",
      hint: "the entire debt stack reprices inside the year",
      base: DASH,
      cell: (r) => ({
        text: fmtM(r.delta_interest.hi),
        tone: r.delta_interest.hi > 0 ? "bad" : "good",
      }),
    },
    {
      label: "That upper figure as a share of operating profit",
      base: DASH,
      cell: (r) => ({ text: fmtSignedPct(r.vs_ebit.hi) }),
    },
    {
      label: "After tax, as a share of the company's market value",
      base: DASH,
      cell: (r) => (v.market_cap ? { text: fmtPct(r.after_tax.hi / v.market_cap, 2) } : DASH),
    },

    {
      group: "WHETHER IT CAN STILL PAY",
      label: "Operating profit covers the interest bill",
      hint: "operating profit divided by annual interest",
      base: { text: fmtX(base?.icr.base), tone: "dim" },
      cell: (r) => ({
        text: fmtX(r.icr.hi),
        tone: r.icr.hi != null && r.icr.hi < r.icr.covenant_level ? "bad" : undefined,
      }),
    },
    {
      label: "Below the two-times level lenders usually require",
      base: {
        text: base?.icr.already_below_covenant ? "yes" : "no",
        tone: base?.icr.already_below_covenant ? "bad" : "dim",
      },
      cell: (r) => {
        const below = r.icr.hi != null && r.icr.hi < r.icr.covenant_level;
        return { text: below ? "yes" : "no", tone: below ? "bad" : "dim" };
      },
    },

    {
      group: "WHAT IT DOES TO THE SHARE PRICE",
      label: `Estimated by the ${modelName}`,
      hint: "future cash flows discounted at a higher rate",
      base: DASH,
      cell: (r) =>
        r.price.model.status === "invalid_terminal_assumption"
          ? { text: "growth exceeds discount rate", tone: "bad" }
          : {
              text: fmtSignedPct(r.price.model.exact),
              tone: (r.price.model.exact ?? 0) < 0 ? "bad" : "good",
            },
    },
    {
      label: "Measured from five years of this share's own price",
      hint: "daily returns regressed on changes in the two- and ten-year yields",
      base: DASH,
      cell: (r) => {
        const e = r.price.empirical;
        if (e.status === "ok") {
          return { text: fmtSignedPct(e.value), tone: (e.value ?? 0) < 0 ? "bad" : "good" };
        }
        if (e.status === "not_extrapolable")
          return { text: "move too large to measure", tone: "dim" };
        if (e.status === "not_significant") return { text: "no reliable link", tone: "dim" };
        if (e.status === "pending") return { text: "loading", tone: "dim" };
        return DASH;
      },
    },
    {
      label: "Range that measurement is confident in",
      indent: true,
      base: DASH,
      cell: (r) => {
        const e = r.price.empirical;
        return e.ci95
          ? { text: `${fmtSignedPct(e.ci95[0])} to ${fmtSignedPct(e.ci95[1])}`, tone: "dim" }
          : DASH;
      },
    },
  ];

  const toneColor = (tone?: Tone) =>
    tone === "bad"
      ? colors.negative
      : tone === "good"
        ? colors.positive
        : tone === "dim"
          ? colors.textDimmed
          : colors.text;

  return (
    <div>
      <div
        className="text-[11px] font-mono border px-2 py-1.5 mb-3"
        style={{ borderColor: colors.border, color: colors.textDimmed }}
      >
        Each column is one shock applied to the whole Treasury curve. The basis-point heading names
        the move in the <strong>ten-year</strong>; shorter maturities move by more or less depending
        on the shape. The two replays use the real per-maturity curve change from that year rather
        than a round number.
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="text-[10px] font-mono" style={{ color: colors.textDimmed }}>
          SHOW
        </span>
        {BANDS.map((b) => {
          const on = bands.includes(b.id);
          const count = all.filter((r) => (r.scenario.band ?? "cycle") === b.id).length;
          if (count === 0) return null;
          return (
            <button
              key={b.id}
              type="button"
              title={b.hint}
              onClick={() =>
                setBands((prev) =>
                  prev.includes(b.id) ? prev.filter((x) => x !== b.id) : [...prev, b.id]
                )
              }
              className="px-2 py-0.5 text-[10px] font-mono border"
              style={{
                borderColor: on ? colors.accent : colors.border,
                backgroundColor: on ? colors.accent : "transparent",
                color: on ? "#000" : colors.text,
              }}
            >
              {b.label} ({count})
            </button>
          );
        })}
      </div>

      {scenarios.length === 0 && (
        <div className="text-xs font-mono py-8 text-center" style={{ color: colors.textDimmed }}>
          Pick at least one group of shocks above.
        </div>
      )}

      {scenarios.length > 0 && (
        <div className="overflow-x-auto">
          <table className="border-collapse" style={{ minWidth: "100%" }}>
            <thead>
              <tr>
                <th className="sticky left-0" style={{ backgroundColor: colors.surface }} />
                <th />
                {BANDS.map((b) => {
                  const span = scenarios.filter(
                    (r) => (r.scenario.band ?? "cycle") === b.id
                  ).length;
                  if (span === 0) return null;
                  return (
                    <th
                      key={b.id}
                      colSpan={span}
                      className="px-3 pt-1 pb-0.5 text-[9px] font-mono tracking-widest text-center"
                      style={{
                        color: colors.textDimmed,
                        borderBottom: `1px solid ${colors.border}`,
                      }}
                    >
                      {b.label}
                    </th>
                  );
                })}
              </tr>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                <th
                  className="px-2 py-1 text-[10px] font-mono font-bold tracking-wider text-left sticky left-0"
                  style={{ color: colors.accent, backgroundColor: colors.surface, minWidth: 300 }}
                >
                  MEASURE
                </th>
                <th
                  className="px-3 py-1 text-[10px] font-mono font-bold tracking-wider text-right"
                  style={{ color: colors.textDimmed }}
                >
                  TODAY
                </th>
                {scenarios.map((r) => (
                  <th
                    key={r.scenario.id}
                    className="px-3 py-1 text-[10px] font-mono font-bold tracking-wider text-right whitespace-nowrap"
                    style={{ color: colors.accent }}
                  >
                    {r.scenario.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <>
                  {row.group && (
                    <tr key={`${row.label}-group`}>
                      <td
                        colSpan={scenarios.length + 2}
                        className="px-2 pt-3 pb-1 text-[10px] font-mono font-bold tracking-widest"
                        style={{ color: colors.accent }}
                      >
                        {row.group}
                      </td>
                    </tr>
                  )}
                  <tr key={row.label} style={{ borderBottom: `1px solid ${colors.border}` }}>
                    <td
                      className="px-2 py-1 text-xs font-mono text-left sticky left-0"
                      style={{ backgroundColor: colors.surface }}
                    >
                      <span style={{ color: colors.text, paddingLeft: row.indent ? 12 : 0 }}>
                        {row.label}
                      </span>
                      {row.hint && (
                        <div
                          className="text-[10px] leading-tight"
                          style={{ color: colors.textDimmed, paddingLeft: row.indent ? 12 : 0 }}
                        >
                          {row.hint}
                        </div>
                      )}
                    </td>
                    <td
                      className="px-3 py-1 text-xs font-mono text-right whitespace-nowrap"
                      style={{ color: toneColor(row.base.tone) }}
                    >
                      {row.base.text}
                    </td>
                    {scenarios.map((r) => {
                      const c = row.cell(r);
                      return (
                        <td
                          key={r.scenario.id}
                          className="px-3 py-1 text-xs font-mono text-right whitespace-nowrap"
                          style={{ color: toneColor(c.tone) }}
                        >
                          {c.text}
                        </td>
                      );
                    })}
                  </tr>
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The headline of the whole tab: the two kinds of damage are not the same size. */}
      <div
        className="mt-4 border px-3 py-2 text-xs font-mono"
        style={{ borderColor: colors.border, color: colors.text }}
      >
        <div className="flex flex-wrap gap-x-8 gap-y-1">
          <span>
            Worst case the extra interest costs after tax, as a share of market value:{" "}
            <strong style={{ color: colors.accent }}>
              {fmtPct(gap.worst_after_tax_interest_over_mcap, 2)}
            </strong>
          </span>
          <span>
            Share price move for every hundred basis points:{" "}
            <strong style={{ color: colors.accent }}>
              {gap.price_impact_100bp == null
                ? "no reliable link"
                : fmtSignedPct(gap.price_impact_100bp)}
            </strong>
          </span>
        </div>
        <div className="mt-1 text-[10px]" style={{ color: colors.textDimmed }}>
          The cash cost and the share price move are different quantities and routinely differ by a
          factor of ten or more, because the price moves through the rate used to discount future
          cash flows rather than through the interest bill. They are never added together.
        </div>
      </div>

      <div
        className="mt-3 text-[10px] font-mono leading-relaxed"
        style={{ color: colors.textDimmed }}
      >
        Rates would have to rise{" "}
        <strong style={{ color: colors.text }}>
          {data.breaking_point.covenant_2x.bp == null
            ? (data.breaking_point.covenant_2x.note ?? "an unknown amount")
            : fmtBp(data.breaking_point.covenant_2x.bp)}
        </strong>{" "}
        before operating profit covers interest only two times over, and{" "}
        <strong style={{ color: colors.text }}>{fmtBp(data.breaking_point.breach_1x.bp)}</strong>{" "}
        before it stops covering it at all. Both are solved with every dollar of debt repricing
        inside a year, so they are the earliest the company could reach that point, not a forecast
        that it will.
      </div>
    </div>
  );
}
