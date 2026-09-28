"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { HEARTBEAT_KEY, type Heartbeat, useHeartbeat } from "./useHeartbeat";

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
  /** op-log engine only (OPLOG_ENABLED) */
  mode?: "oplog";
  open_conflicts?: number;
  pending?: number;
  diverged?: boolean;
  last_error?: string | null;
  peers?: { device: string; at: string; state: "in_sync" | "catching_up" | "DIVERGED" }[];
}

export interface SyncConflict {
  id: string;
  table_name: string;
  row_key: string;
  kept_device: string;
  kept_row: Record<string, unknown> | null;
  other_device: string;
  other_row: Record<string, unknown> | null;
  reason: string;
  detected_at: string;
}

const selectSync = (h: Heartbeat) => (h.sync ?? null) as SyncStatus | null;

function invalidateSynced(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({
    predicate: (q) => SYNCED_KEYS.includes(String(q.queryKey[0])),
  });
}

/**
 * Cloud-sync status + manual pull/push for the header chip.
 * Status rides the 15s heartbeat (`useHeartbeat`). A `last_pull` that moved on
 * its own means the backend worker merged a peer's push — the local rows
 * changed underneath React Query, so synced server state is invalidated
 * exactly as if the user had hit PULL.
 */
export function useSync() {
  const qc = useQueryClient();

  const query = useHeartbeat(selectSync);
  // A heartbeat whose sync part failed keeps the last good status on screen
  // (as the old per-endpoint query did on error) instead of hiding the chip.
  const lastGood = useRef<SyncStatus | undefined>(undefined);
  useEffect(() => {
    if (query.data) lastGood.current = query.data;
  }, [query.data]);
  const status = query.data ?? lastGood.current;

  const seenPull = useRef<string | null | undefined>(undefined);
  const lastPull = status?.last_pull;
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
      qc.invalidateQueries({ queryKey: HEARTBEAT_KEY });
      invalidateSynced(qc);
    },
  });

  const push = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/sync/push", { method: "POST" });
      if (!r.ok) throw new Error("push failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: HEARTBEAT_KEY }),
  });

  return {
    status,
    isLoading: query.isLoading,
    pull: pull.mutate,
    push: push.mutate,
    pulling: pull.isPending,
    pushing: push.isPending,
  };
}
