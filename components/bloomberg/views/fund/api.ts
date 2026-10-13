// The fund book (backend/routers/fund.py). Money and unit fields arrive as
// decimal strings: they are shown, never summed here — the server sends totals.

export interface Fund {
  id: string;
  name: string;
  base_currency: "THB" | "USD";
  unit_par: string;
  broker_note: string;
  agreement_ref: string;
}

export interface FundAccount {
  id: string;
  name: string;
  broker: string;
  currency: string;
  country: string;
}

export interface FundValue {
  base_currency: string;
  holdings: string;
  options: string;
  cash: string;
  nav: string | null;
  unpriced: string[];
  cash_is_estimate: boolean;
}

export interface FundDetail extends Fund {
  scope: string;
  accounts: FundAccount[];
  split_rule: { basis: string; effective_from: string; reason: string } | null;
  units: string;
  capital: string;
  value: FundValue;
}

export interface FundMember {
  id: string;
  name: string;
  contact: string;
  joined_on: string | null;
  note: string;
  capital: string;
  capital_share_pct: string | null;
  units: string;
  units_share_pct: string | null;
  value_by_capital: string | null;
  value_by_units: string | null;
}

export interface MembersView {
  base_currency: string;
  split_basis: string | null;
  capital_total: string;
  units_total: string;
  nav: string | null;
  unit_price: string | null;
  value: FundValue;
  members: FundMember[];
}

export interface Contribution {
  id: string;
  member_id: string;
  account_id: string;
  date: string;
  amount: string;
  currency: string;
  fx_rate: string;
  amount_base: string;
  nav_before: string | null;
  units_before: string;
  unit_price: string;
  units_issued: string;
  price_source: "par" | "live" | "snapshot" | "manual";
  price_reason: string;
  evidence_ref: string;
  entered_by: string;
  reverses_id: string | null;
  note: string;
  created_at: string;
  reversed: boolean;
  preview?: boolean;
}

export interface ContributionIn {
  member_id: string;
  account_id: string;
  date: string;
  amount: string;
  currency?: string;
  fx_rate?: string;
  unit_price?: string;
  price_reason?: string;
  evidence_ref?: string;
  note?: string;
}

const BASE = "/api/v2/fund";

/** The server's refusal as one sentence: `{detail: {code, detail}}` or a plain string. */
function refusal(body: unknown, status: number): string {
  const d = (body as { detail?: unknown; error?: unknown } | null)?.detail;
  if (d && typeof d === "object" && "detail" in d) return String((d as { detail: unknown }).detail);
  if (typeof d === "string") return d;
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === "string" ? e : `Request failed (${status})`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, init);
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(refusal(body, r.status));
  return body as T;
}

const post = <T>(path: string, body: unknown) =>
  call<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const fundApi = {
  list: () => call<{ funds: Fund[] }>(""),
  create: (body: { name: string; base_currency: string; unit_par: string }) => post<Fund>("", body),
  detail: (id: string) => call<FundDetail>(`/${id}`),
  members: (id: string) => call<MembersView>(`/${id}/members`),
  addMember: (id: string, body: { name: string; contact?: string; note?: string }) =>
    post<FundMember>(`/${id}/members`, body),
  addAccount: (id: string, body: { id: string; name: string; currency: string; broker?: string }) =>
    post<FundAccount>(`/${id}/accounts`, body),
  contributions: (id: string) => call<{ contributions: Contribution[] }>(`/${id}/contributions`),
  preview: (id: string, body: ContributionIn) =>
    post<Contribution>(`/${id}/contributions/preview`, body),
  contribute: (id: string, body: ContributionIn) =>
    post<Contribution>(`/${id}/contributions`, body),
  reverse: (id: string, contributionId: string, reason: string) =>
    post<Contribution>(`/${id}/contributions/${contributionId}/reverse`, { reason }),
};

/** A decimal string as a number for display only. */
export const num = (v: string | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
