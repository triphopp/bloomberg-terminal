import type { QueryClient } from "@tanstack/react-query";
import type { OptionLot } from "./tabs/OptionsTab";
import type { Trade } from "./types";

/**
 * Query definitions for the PORT view.
 *
 * These used to be `useEffect` + `fetch` inside the tabs, which meant every
 * visit to PORT started from nothing: the positions call, then the slow
 * derived call (`premarket` ~4s cold) ran again
 * from scratch and the table sat empty until they landed. Going through React
 * Query gives three things the hand-rolled version could not: the second visit
 * paints from cache immediately, duplicate mounts share one request, and the
 * whole set can be warmed in the background from the terminal shell
 * (`usePortfolioPrewarm`) before the user ever presses P.
 *
 * `staleTime` per query mirrors the backend TTL for that endpoint, so a
 * background refetch never fires while the server would only replay its cache.
 */

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

const acctParam = (accountId: string) =>
  accountId !== "all" ? `?account_id=${encodeURIComponent(accountId)}` : "";

export type OpenPositionsPayload = {
  positions: Trade[];
  options?: OptionLot[];
  thb_per_usd: number;
};

export const portfolioQueries = {
  summary: (currency: string) => ({
    queryKey: ["portfolio", "summary", currency] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      getJson<unknown>(`/api/v2/portfolio/summary?base_currency=${currency}`, signal),
    staleTime: 60_000,
  }),

  accounts: () => ({
    queryKey: ["portfolio", "accounts"] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      getJson<unknown>("/api/v2/portfolio/accounts", signal),
    staleTime: 5 * 60_000,
  }),

  openPositions: (currency: string, accountId: string) => ({
    queryKey: ["portfolio", "open-positions", currency, accountId] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) => {
      const qs = new URLSearchParams({ base_currency: currency });
      if (accountId !== "all") qs.set("account_id", accountId);
      return getJson<OpenPositionsPayload>(`/api/v2/portfolio/open-positions?${qs}`, signal);
    },
    staleTime: 60_000,
  }),

  /** Heavy `.info` sweep; the backend only holds it for 30s. */
  premarket: (accountId: string) => ({
    queryKey: ["portfolio", "premarket", accountId] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      getJson<{ quotes?: Record<string, unknown> }>(
        `/api/v2/portfolio/premarket${acctParam(accountId)}`,
        signal
      ),
    staleTime: 30_000,
  }),

  costOverrides: (accountId: string) => ({
    queryKey: ["portfolio", "cost-overrides", accountId] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      getJson<{ symbol: string; avg_cost: number }[]>(
        `/api/v2/portfolio/cost-overrides${acctParam(accountId)}`,
        signal
      ),
    staleTime: 5 * 60_000,
  }),

  thesesSummary: () => ({
    queryKey: ["portfolio", "theses-summary"] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      getJson<{ by_symbol?: Record<string, { count: number; status: string }> }>(
        "/api/v2/theses/summary/by-symbol",
        signal
      ),
    staleTime: 5 * 60_000,
  }),
};

/**
 * Fill the PORT caches while the user is still looking at another view.
 *
 * Ordering matters: the slow `premarket` call needs the symbol list, so
 * positions has to land first. Failures are swallowed — this is opportunistic
 * warming, and the tab will fetch for itself if a warm-up did not make it.
 */
export async function prewarmPortfolio(
  qc: QueryClient,
  { currency = "THB", accountId = "all" }: { currency?: string; accountId?: string } = {}
) {
  try {
    await Promise.all([
      qc.prefetchQuery(portfolioQueries.accounts()),
      qc.prefetchQuery(portfolioQueries.summary(currency)),
      qc.prefetchQuery(portfolioQueries.openPositions(currency, accountId)),
      qc.prefetchQuery(portfolioQueries.costOverrides(accountId)),
      qc.prefetchQuery(portfolioQueries.thesesSummary()),
    ]);

    const positions = qc.getQueryData<OpenPositionsPayload>(
      portfolioQueries.openPositions(currency, accountId).queryKey
    )?.positions;
    if (!positions?.length) return;

    await qc.prefetchQuery(portfolioQueries.premarket(accountId));
  } catch {
    /* opportunistic — the tab still fetches on its own */
  }
}
