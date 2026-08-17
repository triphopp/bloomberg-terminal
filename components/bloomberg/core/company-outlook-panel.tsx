"use client";

/**
 * COMPANY OUTLOOK — what management told the SEC about the quarter ahead.
 *
 * Three blocks, all sourced from EDGAR: the guidance table filed as EX-99.1 to the
 * earnings 8-K, the CEO's quoted commentary from the same release, and the
 * forward-looking sentences in the latest 10-Q/10-K MD&A. `variant="compact"`
 * trims it to the guidance chips + one quote for the NEWS column.
 */

import { ExternalLink, Quote as QuoteIcon, RefreshCw } from "lucide-react";
import {
  type CompanyOutlook,
  type XbrlPoint,
  isUsListing,
  shortMetric,
  useCompanyOutlook,
  useCompanyXbrl,
} from "../hooks/useCompanyOutlook";
import type { bloombergColors } from "../lib/theme-config";

type ThemeColors = typeof bloombergColors.dark;

const METRIC_LABELS: Record<string, string> = {
  revenue: "REVENUE",
  gross_margin: "GROSS MGN",
  operating_expenses: "OPEX",
  operating_margin: "OP MGN",
  eps: "EPS",
};

function fmtDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function fmtBig(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

function GuidanceChips({
  outlook,
  colors,
}: {
  outlook: CompanyOutlook;
  colors: ThemeColors;
}) {
  const guidance = (outlook.release as { guidance?: { metrics?: Record<string, string> } })
    ?.guidance;
  const metrics = guidance?.metrics ?? {};
  const entries = Object.entries(metrics);
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([key, value]) => (
        <div
          key={key}
          className="px-1.5 py-0.5 border"
          style={{ borderColor: colors.border, backgroundColor: "#0a0a0a" }}
        >
          <div className="text-[8px] tracking-wider" style={{ color: colors.textSecondary }}>
            {METRIC_LABELS[key] ?? key.toUpperCase()}
          </div>
          <div className="text-[10px] font-bold" style={{ color: colors.accent }}>
            {shortMetric(value)}
          </div>
        </div>
      ))}
    </div>
  );
}

function XbrlTable({
  series,
  colors,
}: {
  series: Record<string, XbrlPoint[]>;
  colors: ThemeColors;
}) {
  const revenue = series.revenue ?? [];
  if (revenue.length === 0) return null;
  const periods = revenue.slice(0, 8);

  const rows: { key: string; label: string; pct?: boolean }[] = [
    { key: "revenue", label: "REVENUE" },
    { key: "gross_margin", label: "GROSS MGN %", pct: true },
    { key: "operating_income", label: "OP INCOME" },
    { key: "operating_margin", label: "OP MGN %", pct: true },
    { key: "net_income", label: "NET INCOME" },
    { key: "rnd", label: "R&D" },
    { key: "operating_cash_flow", label: "OP CASH FLOW" },
    { key: "capex", label: "CAPEX" },
  ];

  const valueAt = (key: string, end: string): number | null =>
    series[key]?.find((p) => p.end === end)?.val ?? null;

  return (
    <div className="overflow-x-auto">
      <table className="text-[10px] font-mono w-full" style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}>
            <th className="px-1 py-0.5 text-left" style={{ color: colors.textSecondary }}>
              AS REPORTED
            </th>
            {periods.map((p) => (
              <th
                key={p.end}
                className="px-1 py-0.5 text-right whitespace-nowrap"
                style={{ color: colors.accent }}
                title={`${p.form ?? ""} ${p.fy ?? ""} ${p.fp ?? ""}`.trim()}
              >
                {p.end.slice(2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cells = periods.map((p) => valueAt(row.key, p.end));
            if (cells.every((c) => c == null)) return null;
            return (
              <tr key={row.key} style={{ borderBottom: "1px solid #1a1a1a" }}>
                <td
                  className="px-1 py-0.5 whitespace-nowrap"
                  style={{ color: colors.textSecondary }}
                >
                  {row.label}
                </td>
                {cells.map((value, i) => (
                  <td
                    key={periods[i].end}
                    className="px-1 py-0.5 text-right"
                    style={{ color: value == null ? "#333" : colors.text }}
                  >
                    {value == null ? "—" : row.pct ? `${value.toFixed(1)}%` : fmtBig(value)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Props {
  symbol: string;
  colors: ThemeColors;
  variant?: "full" | "compact";
}

export function CompanyOutlookPanel({ symbol, colors, variant = "full" }: Props) {
  const compact = variant === "compact";
  const { data, isLoading, isError } = useCompanyOutlook(symbol);
  const { data: xbrl } = useCompanyXbrl(symbol, "quarterly", !compact);

  if (!isUsListing(symbol)) {
    return compact ? null : (
      <div className="p-3 text-[10px]" style={{ color: colors.textSecondary }}>
        {symbol} is not a US listing — SEC EDGAR has no filings for it. Thai issuers file with
        api.sec.or.th (needs a key in backend/.env).
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-3">
        <RefreshCw className="h-3 w-3 animate-spin" style={{ color: colors.accent }} />
        <span className="text-[10px]" style={{ color: colors.textSecondary }}>
          Reading EDGAR filings…
        </span>
      </div>
    );
  }

  if (isError || !data) {
    return compact ? null : (
      <div className="p-3 text-[10px]" style={{ color: colors.textSecondary }}>
        No EDGAR data for {symbol}.
      </div>
    );
  }

  const release = data.release as CompanyOutlook["release"] & {
    filed?: string;
    url?: string;
    ceo_quotes?: { speaker: string; title: string; quote: string }[];
  };
  const mdna = data.mdna as CompanyOutlook["mdna"] & {
    form?: string;
    filed?: string;
    url?: string;
    statements?: string[];
  };
  const quotes = release?.ceo_quotes ?? [];
  const statements = mdna?.statements ?? [];
  const nothing = !data.has_guidance && quotes.length === 0 && statements.length === 0;

  if (nothing) {
    return compact ? null : (
      <div className="p-3 text-[10px]" style={{ color: colors.textSecondary }}>
        {symbol} filed no guidance in its latest 8-K — some issuers (Costco, Berkshire) never do.
      </div>
    );
  }

  return (
    <div className={compact ? "flex flex-col gap-1.5 px-2 py-2" : "flex flex-col gap-3 p-3"}>
      {/* ── Guidance ── */}
      {data.has_guidance && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
              GUIDANCE
            </span>
            {release?.filed && (
              <span className="text-[8px]" style={{ color: colors.textSecondary }}>
                8-K filed {fmtDate(release.filed)}
              </span>
            )}
            {release?.url && (
              <a
                href={release.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto hover:opacity-70"
                title="Open the filed press release"
              >
                <ExternalLink className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
              </a>
            )}
          </div>
          <GuidanceChips outlook={data} colors={colors} />
        </div>
      )}

      {/* ── CEO commentary ── */}
      {quotes.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
            LOOKING FORWARD — {quotes[0].speaker.toUpperCase()}
          </span>
          {quotes.slice(0, compact ? 1 : 3).map((q) => (
            <div
              key={q.quote.slice(0, 40)}
              className="flex gap-1.5 border-l-2 pl-2"
              style={{ borderColor: colors.accent }}
            >
              <QuoteIcon className="h-2.5 w-2.5 shrink-0 mt-0.5" style={{ color: colors.accent }} />
              <div>
                <p className="text-[10px] leading-snug" style={{ color: colors.text }}>
                  {compact && q.quote.length > 260 ? `${q.quote.slice(0, 260)}…` : q.quote}
                </p>
                <p className="text-[8px] mt-0.5" style={{ color: colors.textSecondary }}>
                  {q.speaker} · {q.title}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── MD&A forward-looking ── */}
      {!compact && statements.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
              MD&A — FORWARD-LOOKING
            </span>
            <span className="text-[8px]" style={{ color: colors.textSecondary }}>
              {mdna?.form} {mdna?.filed ? `filed ${fmtDate(mdna.filed)}` : ""}
            </span>
            {mdna?.url && (
              <a
                href={mdna.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto hover:opacity-70"
              >
                <ExternalLink className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
              </a>
            )}
          </div>
          <ul className="flex flex-col gap-1">
            {statements.map((s) => (
              <li
                key={s.slice(0, 40)}
                className="text-[10px] leading-snug pl-2 border-l"
                style={{ color: colors.text, borderColor: colors.border }}
              >
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── As-reported financials ── */}
      {!compact && xbrl?.series && Object.keys(xbrl.series).length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
              AS-REPORTED (XBRL)
            </span>
            <span className="text-[8px]" style={{ color: colors.textSecondary }}>
              quarterly · straight from the filings, not normalised
            </span>
          </div>
          <XbrlTable series={xbrl.series} colors={colors} />
        </div>
      )}
    </div>
  );
}
