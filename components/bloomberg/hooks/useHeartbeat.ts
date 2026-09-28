"use client";

import { useQuery } from "@tanstack/react-query";

/** Shape of `/api/heartbeat` (app/api/heartbeat/route.ts). Parts are loose
 * here; `useSync` / `useProviders` / the dev banner type their own slice. */
export interface Heartbeat {
  dev: Record<string, unknown> | null;
  sync: unknown;
  providers: unknown;
  /** Per-table versions from the DB change feed (`/api/changes`). */
  changes: Record<string, number> | null;
  errors: { sync?: string; providers?: string; changes?: string };
}

export const HEARTBEAT_KEY = ["heartbeat"] as const;
const POLL_MS = 15_000;

async function fetchHeartbeat(): Promise<Heartbeat> {
  const r = await fetch("/api/heartbeat", { cache: "no-store" });
  if (!r.ok) throw new Error(`heartbeat ${r.status}`);
  return r.json();
}

/**
 * The header's background state — sync chip, provider switch, dev banner —
 * in ONE request every 15s (was three). Every caller shares the one query;
 * `pollMs` lets a caller poll faster for a while (the banner during a restart).
 */
export function useHeartbeat<T = Heartbeat>(
  select?: (h: Heartbeat) => T,
  pollMs: number = POLL_MS
) {
  return useQuery({
    queryKey: HEARTBEAT_KEY,
    queryFn: fetchHeartbeat,
    select,
    refetchInterval: pollMs,
    staleTime: 10_000,
    refetchOnWindowFocus: true, // back from another window → current state now
    retry: false, // the next poll is the retry; the banner counts failures itself
  });
}
