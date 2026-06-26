"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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

/**
 * Cloud-sync status + manual pull/push for the header chip.
 * Polls status every 30s. After a manual pull, server data is invalidated so
 * portfolio views re-fetch the freshly merged rows.
 */
export function useSync() {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["sync-status"],
    queryFn: fetchSyncStatus,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const pull = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/sync/pull", { method: "POST" });
      if (!r.ok) throw new Error("pull failed");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sync-status"] });
      // merged rows landed in local DB — refresh portfolio server state
      qc.invalidateQueries({ queryKey: ["openPositions"] });
      qc.invalidateQueries({ queryKey: ["trades"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
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
