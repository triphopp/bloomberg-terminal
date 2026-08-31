"use client";

import { type Colors, type StressResponse, fmtB, fmtBp, fmtM, fmtPct, fmtX } from "./types";

const LADDER_ROWS: { key: string; label: string }[] = [
  { key: "y1", label: "≤12M" },
  { key: "y2", label: "Y2" },
  { key: "y3", label: "Y3" },
  { key: "y4", label: "Y4" },
  { key: "y5", label: "Y5" },
  { key: "beyond", label: ">5Y" },
];

function Section({
  title,
  colors,
  children,
}: {
  title: string;
  colors: Colors;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <div
        className="text-[10px] font-mono font-bold tracking-widest mb-1 pb-1 border-b"
        style={{ color: colors.accent, borderColor: colors.border }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  note,
  colors,
  emphasis,
}: {
  label: string;
  value: string;
  note?: string;
  colors: Colors;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline text-xs font-mono py-0.5">
      <span className="flex-1" style={{ color: colors.text }}>
        {label}
      </span>
      <span
        className="w-32 text-right"
        style={{ color: emphasis ? colors.accent : colors.text, fontWeight: emphasis ? 700 : 400 }}
      >
        {value}
      </span>
      <span className="w-56 text-right text-[10px]" style={{ color: colors.textDimmed }}>
        {note ?? ""}
      </span>
    </div>
  );
}

export function ExposureSubTab({ data, colors }: { data: StressResponse; colors: Colors }) {
  const e = data.exposure;
  const gateFailed = !e.ladder_usable;

  return (
    <div>
      <div
        className="text-[11px] font-mono border px-2 py-1.5 mb-4"
        style={{ borderColor: colors.border, color: colors.textDimmed }}
      >
        <strong style={{ color: colors.text }}>NO SHOCK APPLIED</strong> — this is the position as
        it stands today
        {e.ladder_as_of ? `, filings as of ${e.ladder_as_of}` : ""}. The only basis-point figure
        below is the refinancing gap, which is the cost of rolling debt at
        <em> today&apos;s</em> market rate. Shocked scenarios live in the SCENARIO tab.
      </div>
      {gateFailed && (
        <div
          className="text-[11px] font-mono border px-2 py-1.5 mb-4"
          style={{ borderColor: colors.negative, color: colors.negative }}
        >
          MATURITY LADDER UNUSABLE —{" "}
          {e.ladder_completeness == null
            ? "no maturity tags filed"
            : `the filed buckets account for ${fmtPct(e.ladder_completeness, 0)} of total debt`}
          {e.ladder_stale && e.ladder_as_of ? ` · newest fact dated ${e.ladder_as_of}` : ""}.
          Refinancing terms are excluded; the bounded interest estimate still holds because it reads
          total debt, not the ladder.
        </div>
      )}

      <Section title="DEBT STRUCTURE" colors={colors}>
        <Row label="Total debt" value={fmtB(e.debt.total)} note={e.debt.source} colors={colors} />
        <Row label="  Current" value={fmtB(e.debt.current)} colors={colors} />
        <Row label="  Long-term" value={fmtB(e.debt.long_term)} colors={colors} />
        <Row label="  Capital leases" value={fmtB(e.debt.capital_leases)} colors={colors} />
        <Row label="Cash & equivalents" value={fmtB(e.debt.cash)} colors={colors} />
        <Row label="Net debt" value={fmtB(e.debt.net_debt)} colors={colors} />
      </Section>

      <Section title="MATURITY LADDER" colors={colors}>
        {LADDER_ROWS.map(({ key, label }) => {
          const row = e.ladder?.[key];
          return (
            <Row
              key={key}
              label={label}
              value={row?.value == null ? "—" : fmtB(row.value)}
              note={
                row?.tag
                  ? `${row.end ?? ""} · ${row.tag.replace(/^LongTermDebtMaturitiesRepaymentsOfPrincipal/, "…")}`
                  : "not filed"
              }
              colors={colors}
            />
          );
        })}
        <Row label="Ladder total" value={fmtB(e.ladder_total)} colors={colors} />
        <Row
          label="Ladder completeness (buckets / total debt)"
          value={fmtPct(e.ladder_completeness, 0)}
          note={
            e.ladder_usable
              ? "how much of the debt the filing accounts for · PASS (gate 70%)"
              : "how much of the debt the filing accounts for · FAIL — see banner"
          }
          colors={colors}
          emphasis
        />
      </Section>

      <Section title="COST OF DEBT" colors={colors}>
        <Row
          label="Interest expense (TTM)"
          value={fmtB(e.income.interest_expense, 2)}
          note={e.income.source}
          colors={colors}
        />
        <Row label="EBIT" value={fmtB(e.income.ebit, 2)} colors={colors} />
        <Row label="Interest coverage" value={fmtX(e.income.icr)} colors={colors} />
        <Row
          label="r_eff = interest / avg debt"
          value={fmtPct(e.cost.r_eff, 2)}
          note="what the existing stack actually costs"
          colors={colors}
        />
        <Row
          label="Market refinancing rate"
          value={fmtPct(e.cost.market_refi_rate, 2)}
          note="FRED 5Y + (Baa − 10Y)"
          colors={colors}
        />
        <Row
          label="Refinancing gap"
          value={fmtBp(e.cost.refi_gap_bp)}
          note="cost of rolling debt at today's rate, before any shock"
          colors={colors}
          emphasis
        />
        {e.cost.wall_12m_repricing_cost != null && (
          <Row
            label="Cost of the 12M wall at market"
            value={`${fmtM(e.cost.wall_12m_repricing_cost)}/yr`}
            colors={colors}
          />
        )}
      </Section>

      <Section title="FLOATING SHARE" colors={colors}>
        <Row label="XBRL variable-rate tag" value="NOT FOUND" colors={colors} />
        <Row label="Hedges / swaps" value="NOT DISCLOSED" colors={colors} />
        <div className="text-[10px] font-mono mt-1" style={{ color: colors.textDimmed }}>
          {e.floating_share.note}
        </div>
      </Section>
    </div>
  );
}
