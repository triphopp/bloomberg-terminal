"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HEARTBEAT_KEY, type Heartbeat, useHeartbeat } from "./useHeartbeat";

export interface ProviderStatus {
  name: string;
  label: string;
  healthy: boolean;
  active: boolean;
  auto_failover: boolean;
  last_served: boolean;
}

interface ProvidersResponse {
  active: string;
  providers: ProviderStatus[];
}

const selectProviders = (h: Heartbeat) => (h.providers ?? null) as ProvidersResponse | null;

/**
 * Quote-provider status + controls for the header switch.
 * Status rides the 15s heartbeat; the backend caches provider health for 30s,
 * so the faster poll costs no extra vendor probes.
 */
export function useProviders() {
  const qc = useQueryClient();

  const query = useHeartbeat(selectProviders);

  const setActive = useMutation({
    mutationFn: async (name: string) => {
      const r = await fetch("/api/providers/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error("switch failed");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: HEARTBEAT_KEY });
      // Refresh market data so the new provider's numbers show immediately.
      qc.invalidateQueries({ queryKey: ["marketData"] });
    },
  });

  const setAutoFailover = useMutation({
    mutationFn: async (enabled: boolean) => {
      const r = await fetch("/api/providers/auto-failover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!r.ok) throw new Error("toggle failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: HEARTBEAT_KEY }),
  });

  return {
    providers: query.data?.providers ?? [],
    active: query.data?.active,
    isLoading: query.isLoading,
    setActive: setActive.mutate,
    setAutoFailover: setAutoFailover.mutate,
    switching: setActive.isPending,
  };
}
