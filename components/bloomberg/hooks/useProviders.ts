"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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

async function fetchProviders(): Promise<ProvidersResponse> {
  const r = await fetch("/api/providers");
  if (!r.ok) throw new Error("providers fetch failed");
  return r.json();
}

/**
 * Quote-provider status + controls for the header switch.
 * Polls health every 30s (matches backend health-cache TTL).
 */
export function useProviders() {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["providers"],
    queryFn: fetchProviders,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

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
      qc.invalidateQueries({ queryKey: ["providers"] });
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["providers"] }),
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
