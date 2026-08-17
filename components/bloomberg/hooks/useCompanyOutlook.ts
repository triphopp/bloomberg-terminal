"use client";

/**
 * useCompanyOutlook — forward guidance, CEO commentary and as-reported XBRL
 * figures, straight from SEC EDGAR (`/api/company/*`).
 *
 * US listings only; the backend 404s anything EDGAR doesn't cover (`.BK`, `^VIX`,
 * crypto pairs), so callers should gate on `isUsListing` rather than firing and
 * showing an error.
 */

import { useQuery } from "@tanstack/react-query";

export interface GuidanceBlock {
  heading: string;
  metrics: Partial<
    Record<"revenue" | "gross_margin" | "operating_expenses" | "eps" | "operating_margin", string>
  >;
  excerpt: string;
}

export interface CeoQuote {
  speaker: string;
  title: string;
  quote: string;
}

export interface EarningsRelease {
  filed: string;
  period: string;
  url: string;
  index_url: string;
  guidance: GuidanceBlock | Record<string, never>;
  ceo_quotes: CeoQuote[];
}

export interface MdnaBlock {
  form: string;
  filed: string;
  period: string;
  url: string;
  statements: string[];
}

export interface CompanyOutlook {
  symbol: string;
  cik: string;
  release: EarningsRelease | Record<string, never>;
  mdna: MdnaBlock | Record<string, never>;
  has_guidance: boolean;
}

export interface XbrlPoint {
  start?: string;
  end: string;
  val: number;
  form?: string;
  fy?: number | null;
  fp?: string | null;
  filed?: string;
}

export interface CompanyXbrl {
  symbol: string;
  cik: string;
  period: "quarterly" | "annual";
  tags: Record<string, string>;
  series: Record<string, XbrlPoint[]>;
}

export interface CompanyFiling {
  form: string;
  filed: string;
  period: string;
  items: string;
  accession: string;
  url: string;
  index_url: string;
}

/** EDGAR only covers US listings — everything else is skipped client-side. */
export function isUsListing(symbol: string | null | undefined): boolean {
  return !!symbol && /^[A-Z][A-Z\-]{0,5}$/.test(symbol);
}

const HOUR = 3_600_000;

export function useCompanyOutlook(symbol: string | null, enabled = true) {
  return useQuery<CompanyOutlook>({
    queryKey: ["company-outlook", symbol],
    enabled: enabled && isUsListing(symbol),
    staleTime: 6 * HOUR,
    gcTime: 12 * HOUR,
    retry: 0,
    queryFn: async () => {
      const res = await fetch(`/api/company/outlook/${encodeURIComponent(symbol as string)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
}

export function useCompanyXbrl(
  symbol: string | null,
  period: "quarterly" | "annual" = "quarterly",
  enabled = true
) {
  return useQuery<CompanyXbrl>({
    queryKey: ["company-xbrl", symbol, period],
    enabled: enabled && isUsListing(symbol),
    staleTime: 24 * HOUR,
    gcTime: 24 * HOUR,
    retry: 0,
    queryFn: async () => {
      const res = await fetch(
        `/api/company/xbrl/${encodeURIComponent(symbol as string)}?period=${period}&limit=12`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
}

export function useCompanyFilings(symbol: string | null, enabled = true) {
  return useQuery<{ filings: CompanyFiling[] }>({
    queryKey: ["company-filings", symbol],
    enabled: enabled && isUsListing(symbol),
    staleTime: 6 * HOUR,
    retry: 0,
    queryFn: async () => {
      const res = await fetch(`/api/company/filings/${encodeURIComponent(symbol as string)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
}

/** "$50.0 billion ± $1.0 billion" → compact enough for a table cell. */
export function shortMetric(value: string): string {
  return value
    .replace(/\s*billion/gi, "B")
    .replace(/\s*million/gi, "M")
    .replace(/approximately\s*/gi, "~")
    .replace(/\s+/g, " ")
    .trim();
}
