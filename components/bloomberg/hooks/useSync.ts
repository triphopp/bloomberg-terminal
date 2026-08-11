"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/** Server-state keys whose rows come from SYNC_TABLES — refreshed after a pull. */
const SYNCED_KEYS = ["openPositions", "trades", "accounts", "pins", "paper"];

export interface SyncStatus {
  enabled: boolean;
  device: string;
  sync_dir: string | null;
  reachable: boolean;
  last_pull: string | null;
  last_push: string | null;
  last_conflicts: number;
}

async function fetchSyncStatus(): Promise<SyncStatus> {
  const r = await fetch("/api/sync/status");
  if (!r.ok) throw new Error("sync status fetch failed");
  return r.json();
}

function invalidateSynced(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({
    predicate: (q) => SYNCED_KEYS.includes(String(q.queryKey[0])),
  });
}

/**
 * Cloud-sync status + manual pull/push for the header chip.
 * Polls status every 15s. A `last_pull` that moved on its own means the backend
 * worker merged a peer's push — the local rows changed underneath React Query,
 * so synced server state is invalidated exactly as if the user had hit PULL.
 */
export function useSync() {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["sync-status"],
    queryFn: fetchSyncStatus,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const seenPull = useRef<string | null | undefined>(undefined);
  const lastPull = query.data?.last_pull;
  useEffect(() => {
    if (lastPull === undefined) return;
    if (seenPull.current === undefined) {
      seenPull.current = lastPull; // first observation — nothing to refresh
      return;
    }
    if (seenPull.current !== lastPull) {
      seenPull.current = lastPull;
      invalidateSynced(qc);
    }
  }, [lastPull, qc]);

  const pull = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/sync/pull", { method: "POST" });
      if (!r.ok) throw new Error("pull failed");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sync-status"] });
      invalidateSynced(qc);
    },
  });

  const push = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/sync/push", { method: "POST" });
      if (!r.ok) throw new Error("push failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sync-status"] }),
  });

  return {
    status: query.data,
    isLoading: query.isLoading,
    pull: pull.mutate,
    push: push.mutate,
    pulling: pull.isPending,
    pushing: push.isPending,
  };
}
