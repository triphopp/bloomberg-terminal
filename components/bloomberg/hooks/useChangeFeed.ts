"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { type Heartbeat, useHeartbeat } from "./useHeartbeat";

/**
 * Table → the React Query keys that read it. Keep in step with
 * `change_feed.WATCHED` (backend/change_feed.py).
 */
const CHANGE_KEYS: Record<string, readonly (readonly unknown[])[]> = {
  chart_drawings: [["chart-drawings"]],
};

const selectChanges = (h: Heartbeat) => h.changes ?? null;

/**
 * Refetch a table's queries only when its version moves — replaces "poll just
 * in case" for data that changes when someone edits it (another tab, the other
 * machine's sync pull, the MCP server). The versions come from DB triggers
 * (backend/change_feed.py) and ride the 15 s heartbeat, so this costs no
 * request of its own. Mount once, at the app root.
 */
export function useChangeFeed() {
  const qc = useQueryClient();
  const { data } = useHeartbeat(selectChanges);
  const seen = useRef<Record<string, number> | null>(null);
  useEffect(() => {
    if (!data) return;
    const prev = seen.current;
    seen.current = data;
    if (!prev) return; // first answer: nothing to compare with — queries load on their own
    for (const [table, version] of Object.entries(data)) {
      if (prev[table] === undefined || prev[table] === version) continue;
      for (const key of CHANGE_KEYS[table] ?? []) qc.invalidateQueries({ queryKey: key });
    }
  }, [data, qc]);
}
