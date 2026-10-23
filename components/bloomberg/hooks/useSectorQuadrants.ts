"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type QuadrantRow, type SectorQuadrant, sectorQuadrants } from "../lib/rrg-quadrant";

interface RotationTablePayload {
  rows?: QuadrantRow[];
  bench?: string;
  as_of?: string | null;
  /** TH only: every SET symbol → its SET sector code. */
  symbol_sector?: Record<string, string>;
}

// Same key and URL as MKT → ROT's table (views/rotation-table.tsx), so the two
// share one cached answer and can never disagree about a sector's quadrant.
const tableQuery = (market: "US" | "TH", enabled: boolean) => ({
  queryKey: ["rotation-table", market],
  queryFn: async (): Promise<RotationTablePayload> => {
    const res = await fetch(`/api/rotation/table?market=${market}`);
    if (!res.ok) throw new Error("fetch failed");
    return res.json();
  },
  enabled,
  staleTime: 10 * 60 * 1000,
  retry: 1,
});

/** Sector label (GICS name or SET code) → its ROT quadrant, for both markets,
 *  plus the SET's own sector for every Thai symbol. */
export function useSectorQuadrants(enabled: boolean): {
  map: Map<string, SectorQuadrant>;
  setSectorOf: Record<string, string> | undefined;
  bench: { US?: string; TH?: string };
  asOf: string | null;
} {
  const us = useQuery(tableQuery("US", enabled));
  const th = useQuery(tableQuery("TH", enabled));
  const map = useMemo(() => sectorQuadrants(us.data?.rows, th.data?.rows), [us.data, th.data]);
  return {
    map,
    setSectorOf: th.data?.symbol_sector,
    bench: { US: us.data?.bench, TH: th.data?.bench },
    asOf: us.data?.as_of ?? th.data?.as_of ?? null,
  };
}
