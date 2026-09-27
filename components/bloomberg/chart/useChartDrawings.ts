"use client";

/**
 * useChartDrawings — trend lines + regression channels, stored in the backend
 * (`/api/v2/chart-drawings`, SQLite table `chart_drawings`) so they survive a
 * cleared browser and reach the other machine through the sync layer.
 *
 * One query for every chart: MKT, the chart windows and the stock view all read
 * the same cache, so a line drawn in one shows up in the others. Writes are
 * optimistic — the line appears on the click, not after the round trip — and a
 * failed write refetches, so what is on screen never outlives what was saved.
 *
 * Drawings made before this existed lived in localStorage ("chart:trend-lines",
 * "chart:regression"). They are imported once, the first time the backend
 * answers, and the keys are removed only after the import succeeds.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import type { StoredRegressionChannel } from "./indicators/regression-channel";
import type { StoredTrendLine } from "./indicators/trend-line";

export type ChartDrawingKind = "trend" | "regression";

export interface ChartDrawingRow {
  id: string;
  kind: ChartDrawingKind;
  symbol: string;
  barInterval: string;
  // biome-ignore lint/suspicious/noExplicitAny: shape depends on `kind` — see chart_drawings.py
  data: Record<string, any>;
  createdAt?: string;
}

const QUERY_KEY = ["chart-drawings"] as const;
const BASE = "/api/v2/chart-drawings";
const EMPTY: ChartDrawingRow[] = [];

const LS_TREND = "chart:trend-lines";
const LS_REGRESSION = "chart:regression";

async function fetchDrawings(): Promise<ChartDrawingRow[]> {
  const r = await fetch(BASE, { cache: "no-store" });
  if (!r.ok) throw new Error(`chart-drawings ${r.status}`);
  const d = (await r.json()) as { drawings?: ChartDrawingRow[] };
  return d.drawings ?? [];
}

// ── One-time localStorage import ─────────────────────────────────────────────

let importStarted = false;

function readLegacy(): (ChartDrawingRow & { id: string })[] {
  const out: (ChartDrawingRow & { id: string })[] = [];
  try {
    const trend = JSON.parse(localStorage.getItem(LS_TREND) ?? "[]") as StoredTrendLine[];
    if (Array.isArray(trend)) {
      for (const l of trend) {
        if (!l?.id || !l.symbol || !l.a || !l.b) continue;
        out.push({
          id: l.id,
          kind: "trend",
          symbol: l.symbol,
          barInterval: l.barInterval,
          data: { a: l.a, b: l.b, color: l.color },
        });
      }
    }
  } catch {
    /* unreadable — nothing to import */
  }
  try {
    // The pre-array single-selection shape carried no symbol, so it cannot be
    // placed on a chart and is dropped with the key.
    const reg = JSON.parse(localStorage.getItem(LS_REGRESSION) ?? "null") as
      | StoredRegressionChannel[]
      | null;
    if (Array.isArray(reg)) {
      for (const c of reg) {
        if (!c?.id || !c.symbol) continue;
        out.push({
          // "legacy" was a fixed id minted by the old single-channel migration —
          // every machine has one, and insert-if-absent would drop all but the
          // first to arrive. Give it a real one.
          id:
            c.id === "legacy"
              ? (globalThis.crypto?.randomUUID?.() ?? `reg-legacy-${Date.now()}`)
              : c.id,
          kind: "regression",
          symbol: c.symbol,
          barInterval: c.barInterval,
          data: {
            fromTime: c.fromTime,
            toTime: c.toTime,
            color: c.color,
            options: c.options,
          },
        });
      }
    }
  } catch {
    /* unreadable — nothing to import */
  }
  return out;
}

async function importLegacy(): Promise<boolean> {
  let legacy: ReturnType<typeof readLegacy>;
  try {
    if (localStorage.getItem(LS_TREND) == null && localStorage.getItem(LS_REGRESSION) == null) {
      return false;
    }
    legacy = readLegacy();
  } catch {
    return false; // storage blocked
  }
  if (legacy.length > 0) {
    const r = await fetch(`${BASE}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drawings: legacy }),
    });
    if (!r.ok) throw new Error(`chart-drawings import ${r.status}`);
  }
  try {
    localStorage.removeItem(LS_TREND);
    localStorage.removeItem(LS_REGRESSION);
  } catch {}
  return legacy.length > 0;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useChartDrawings() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchDrawings,
    staleTime: 30_000,
    // Picks up lines drawn on the other machine once the sync pull lands.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const loaded = query.isSuccess;
  useEffect(() => {
    if (!loaded || importStarted) return;
    importStarted = true;
    importLegacy()
      .then((imported) => {
        if (imported) queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      })
      .catch((err) => {
        importStarted = false; // keys untouched — try again next load
        console.error("[chart-drawings] localStorage import failed", err);
      });
  }, [loaded, queryClient]);

  const onWriteFailed = useCallback(
    (err: unknown) => {
      console.error("[chart-drawings] write failed", err);
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    [queryClient]
  );

  /** Create or replace one drawing. */
  const saveDrawing = useCallback(
    (row: ChartDrawingRow) => {
      // An in-flight refetch started before this write would land after it
      // and wipe the optimistic row.
      queryClient.cancelQueries({ queryKey: QUERY_KEY });
      queryClient.setQueryData<ChartDrawingRow[]>(QUERY_KEY, (prev = []) => {
        const i = prev.findIndex((d) => d.id === row.id);
        if (i < 0) return [...prev, row];
        const next = [...prev];
        next[i] = { ...prev[i], ...row };
        return next;
      });
      const { id, ...body } = row;
      fetch(`${BASE}/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((r) => {
          if (!r.ok) throw new Error(`PUT ${r.status}`);
        })
        .catch(onWriteFailed);
    },
    [queryClient, onWriteFailed]
  );

  /** Delete drawings by id. */
  const removeDrawings = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const drop = new Set(ids);
      queryClient.cancelQueries({ queryKey: QUERY_KEY });
      queryClient.setQueryData<ChartDrawingRow[]>(QUERY_KEY, (prev = []) =>
        prev.filter((d) => !drop.has(d.id))
      );
      Promise.all(
        ids.map((id) =>
          fetch(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => {
            if (!r.ok) throw new Error(`DELETE ${r.status}`);
          })
        )
      ).catch(onWriteFailed);
    },
    [queryClient, onWriteFailed]
  );

  return {
    drawings: query.data ?? EMPTY,
    saveDrawing,
    removeDrawings,
  };
}
