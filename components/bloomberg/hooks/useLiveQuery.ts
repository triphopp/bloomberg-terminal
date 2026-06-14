"use client";

import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { isRealTimeEnabledAtom } from "../atoms";

/**
 * Single source of truth for the live-data polling cadence.
 *
 * Every market/quote query should go through this wrapper instead of calling
 * useQuery with its own hardcoded refetchInterval. Centralizing the cadence
 * here means:
 *   - one place to tune polling speed for the whole app
 *   - one seam to swap polling → SSE/WebSocket later: when a push transport
 *     exists, this hook flips `refetchInterval` off and feeds the query cache
 *     from the socket instead — call sites never change.
 *
 * Cadence (aligned with backend CACHE_TTL=60s):
 *   - real-time ON  → poll 60s
 *   - real-time OFF → poll 5m (background freshness without hammering yfinance)
 */
const LIVE_INTERVAL = 60_000;
const IDLE_INTERVAL = 300_000;

export function useLiveQuery<TData>(
  options: Omit<UseQueryOptions<TData>, "refetchInterval" | "staleTime"> & {
    /** Override: pause polling when the owning view is not visible. */
    active?: boolean;
  },
) {
  const [isRealTime] = useAtom(isRealTimeEnabledAtom);
  const { active = true, ...queryOptions } = options;

  const interval = !active ? false : isRealTime ? LIVE_INTERVAL : IDLE_INTERVAL;

  return useQuery<TData>({
    ...queryOptions,
    refetchInterval: interval,
    staleTime: 55_000, // buffer 5s before backend cache expires at 60s
    refetchOnWindowFocus: true, // refresh instantly when the user returns to the tab
  });
}
