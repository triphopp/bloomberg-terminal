"use client";

import { type Colors, type StressResponse, fmtPct } from "./types";

const LIMITS = [
  "Interest-rate swaps never appear in the XBRL concept API, so every earnings figure here is pre-hedge. A company that swapped its floating exposure away will look more exposed than it is.",
  "No issuer-level credit spread exists in either source. The refinancing rate uses Moody's Baa minus the 10Y, which is an index level: it moves with the market, not with this company's own credit.",
  "The maturity ladder is a year-end snapshot from a 10-K and can be up to twelve months stale even when it passes the completeness gate.",
  "The measured rate beta is correlation over one rate cycle, not a structural constant. Fitted on everything except 2022 it mispredicted 2022 by 18.6pp on average and flipped sign on several large caps.",
  "Scenarios shift the US Treasury curve only. Debt issued in other currencies is repriced off the wrong curve.",
  "The upper bound assumes the entire debt stack reprices within one year. For a company with long-dated fixed debt that is far more than will actually happen — the number to trust is 'no worse than this'.",
];

function StatusRow({
  label,
  ok,
  detail,
  colors,
}: {
  label: string;
  ok: boolean;
  detail: string;
  colors: Colors;
}) {
  return (
    <div className="flex items-baseline text-xs font-mono py-0.5">
      <span className="flex-1" style={{ color: colors.text }}>
        {label}
      </span>
      <span className="w-24 text-right" style={{ color: ok ? colors.positive : colors.negative }}>
        {ok ? "OK" : "MISSING"}
      </span>
      <span className="w-72 text-right text-[10px]" style={{ color: colors.textDimmed }}>
        {detail}
      </span>
    </div>
  );
}

export function DiagnosticsSubTab({ data, colors }: { data: StressResponse; colors: Colors }) {
  const e = data.exposure;
  const c = e.confidence;
  const beta = data.rate_beta;

  const levelColor =
    c.level === "high"
      ? colors.positive
      : c.level === "medium"
        ? colors.accentWarn
        : colors.negative;

  return (
    <div>
      <div className="mb-4 text-xs font-mono">
        <span style={{ color: colors.textDimmed }}>Overall confidence: </span>
        <strong style={{ color: levelColor }}>{c.level.toUpperCase()}</strong>
        <span style={{ color: colors.textDimmed }}>
          {" "}
          · bounded estimate {c.bounded_assessment_available ? "available" : "unavailable"} ·
          refinancing term {c.refi_term_available ? "included" : "excluded"}
        </span>
      </div>

      <div
        className="text-[10px] font-mono font-bold tracking-widest mb-1 pb-1 border-b"
        style={{ color: colors.accent, borderColor: colors.border }}
      >
        DATA AVAILABILITY
      </div>
      <StatusRow
        label="Interest expense"
        ok={e.income.interest_expense != null && e.income.interest_expense !== 0}
        detail={e.income.source}
        colors={colors}
      />
      <StatusRow label="EBIT" ok={e.income.ebit != null} detail={e.income.source} colors={colors} />
      <StatusRow
        label="Total debt / cash"
        ok={e.debt.total != null}
        detail={e.debt.source}
        colors={colors}
      />
      <StatusRow
        label="Maturity ladder"
        ok={e.ladder_usable}
        detail={
          e.ladder_completeness == null
            ? "no maturity tags filed"
            : `filed buckets = ${fmtPct(e.ladder_completeness, 0)} of total debt${e.ladder_as_of ? ` · as of ${e.ladder_as_of}` : ""}${e.ladder_stale ? " · STALE" : ""}`
        }
        colors={colors}
      />
      <StatusRow
        label="Rate beta"
        ok={beta.status === "ok" && Boolean(beta.significant)}
        detail={
          beta.status === "ok"
            ? `t = ${beta.kappa_10y_t?.toFixed(1) ?? "—"} · n = ${beta.n} · ${beta.window}`
            : beta.status
        }
        colors={colors}
      />
      {c.always_missing.map((k) => (
        <StatusRow
          key={k}
          label={k.replace(/_/g, " ")}
          ok={false}
          detail="not disclosed in any available source"
          colors={colors}
        />
      ))}

      <div
        className="text-[10px] font-mono font-bold tracking-widest mt-5 mb-1 pb-1 border-b"
        style={{ color: colors.accent, borderColor: colors.border }}
      >
        KNOWN LIMITS
      </div>
      <ul className="text-[11px] font-mono leading-relaxed" style={{ color: colors.textDimmed }}>
        {LIMITS.map((l) => (
          <li key={l.slice(0, 24)} className="py-0.5">
            · {l}
          </li>
        ))}
      </ul>
    </div>
  );
}
