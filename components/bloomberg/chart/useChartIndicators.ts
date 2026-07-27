"use client";

/**
 * useChartIndicators — Unified hook for ALL chart overlays and event markers.
 *
 * Single source of truth for every view that renders a ModularChart.
 * Views call this hook, destructure what they need, and pass outputs straight
 * to <ModularChart>. No view should manage indicators/overlays/events itself.
 *
 *   const { indicators, overlays, eventMarkers, showEvents, toggleEvents } =
 *     useChartIndicators({ symbol, barInterval, chartType });
 */

import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";
import {
  DEFAULT_INDICATOR_SPECS,
  type IndicatorSpec,
  chartIndicatorSpecsAtom,
  chartShowEventsAtom,
  chartShowFootprintAtom,
  chartShowPEAtom,
  chartShowVolumeProfileAtom,
  chartVPConfigAtom,
} from "../atoms";
import { useFootprintData } from "../hooks/useFootprintData";
import type { PeStats } from "./PEPane";
import { INDICATOR_REGISTRY, createCompositeVPOverlay, createSessionVPOverlay } from "./indicators";
import { createFootprintOverlay } from "./indicators/order-footprint";
import type {
  CanvasOverlay,
  ChartEventMarker,
  ChartIndicator,
  IndicatorRegistryEntry,
} from "./types";
import type { OhlcvBar } from "./types";

export interface PeHistoryResponse {
  history: Array<{ time: string; pe: number | null; eps?: number; close?: number }>;
  stats: PeStats | null;
}
import { useStockEvents } from "../hooks/useStockEvents";

// ── Spec → instance ──────────────────────────────────────────────────────────

/** Instantiate one persisted spec. Returns null for specs whose entry is gone. */
function instantiate(spec: IndicatorSpec): ChartIndicator | null {
  const entry = INDICATOR_REGISTRY.find((e) => e.id === spec.id);
  if (!entry) return null;
  try {
    return entry.factory(spec.params);
  } catch {
    return null;
  }
}

/** The derived instance id ("rsi-30") a spec would produce — used for dedupe/removal. */
function specInstanceId(spec: IndicatorSpec): string | null {
  return instantiate(spec)?.id ?? null;
}

/** Stable empty array so memo consumers don't see a new identity each render. */
const EMPTY_MARKERS: ChartEventMarker[] = [];

// ── Crypto detection ─────────────────────────────────────────────────────────

const CRYPTO_BASES = [
  "BTC",
  "ETH",
  "BNB",
  "SOL",
  "XRP",
  "ADA",
  "DOGE",
  "AVAX",
  "DOT",
  "LINK",
  "MATIC",
  "UNI",
  "ATOM",
  "LTC",
  "NEAR",
  "SUI",
  "APT",
  "ARB",
  "OP",
  "PEPE",
];

function detectCrypto(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  const s = symbol.toUpperCase();
  if (s.endsWith("-USD")) {
    const base = s.replace(/-USD$/, "").replace(/\d+$/, "");
    return CRYPTO_BASES.includes(base);
  }
  return CRYPTO_BASES.includes(s);
}

// FX pairs end with "=X" (e.g. "EURUSD=X") — no earnings/dividends
function detectFx(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return symbol.toUpperCase().endsWith("=X");
}

// ── Hook options ─────────────────────────────────────────────────────────────

export interface ChartIndicatorOptions {
  symbol?: string | null;
  barInterval?: string;
  chartType?: "area" | "candle";
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useChartIndicators(options: ChartIndicatorOptions = {}) {
  const { symbol = null, barInterval = "1d", chartType = "candle" } = options;

  const [specs, setSpecs] = useAtom(chartIndicatorSpecsAtom);
  const [showVolumeProfile, setShowVolumeProfile] = useAtom(chartShowVolumeProfileAtom);
  const [showFootprint, setShowFootprint] = useAtom(chartShowFootprintAtom);
  const [showEvents, setShowEvents] = useAtom(chartShowEventsAtom);
  const [showPE, setShowPE] = useAtom(chartShowPEAtom);
  const [vpConfig, setVPConfig] = useAtom(chartVPConfigAtom);
  const [intradayData, setIntradayData] = useState<OhlcvBar[] | undefined>(undefined);

  // Transient per-instance config injected at runtime (e.g. fear-greed's
  // preloadedData). Deliberately NOT persisted — it holds fetched series, not
  // user choices, and would bloat localStorage.
  // biome-ignore lint/suspicious/noExplicitAny: config values are indicator-specific
  const [runtimeConfig, setRuntimeConfig] = useState<Record<string, Record<string, any>>>({});

  // Indicators are derived from the persisted specs, not a parallel useState.
  // The old copy-into-state approach lost the stored setup on every mount.
  const indicators: ChartIndicator[] = useMemo(() => {
    const built: ChartIndicator[] = [];
    for (const spec of specs) {
      const ind = instantiate(spec);
      if (!ind) continue;
      const patch = runtimeConfig[ind.id];
      built.push(patch ? ({ ...ind, config: { ...ind.config, ...patch } } as ChartIndicator) : ind);
    }
    return built;
  }, [specs, runtimeConfig]);

  // ── Symbol type detection ──
  const isCryptoSymbol = useMemo(() => detectCrypto(symbol), [symbol]);
  const isFxSymbol = useMemo(() => detectFx(symbol), [symbol]);

  // Events are meaningful only for equities (not crypto/FX)
  const supportsEvents = !!symbol && !isCryptoSymbol && !isFxSymbol;

  // ── Footprint data fetching ──
  const fpEnabled = showFootprint && isCryptoSymbol && chartType === "candle";
  const footprintQuery = useFootprintData(fpEnabled ? symbol : null, barInterval, fpEnabled);

  // ── Event markers: dividends, earnings, splits ──
  const { markers: rawEventMarkers } = useStockEvents(
    supportsEvents && showEvents && chartType === "candle" ? symbol : null,
    true
  );

  // Memoized: ModularChart rebuilds the whole chart when this array's identity
  // changes, so a fresh `[]` on every render would tear it down continuously.
  const eventMarkers: ChartEventMarker[] = useMemo(
    () =>
      showEvents && supportsEvents && chartType === "candle" ? rawEventMarkers : EMPTY_MARKERS,
    [showEvents, supportsEvents, chartType, rawEventMarkers]
  );

  // ── Trailing P/E history (equities only) ──
  const peEnabled = showPE && supportsEvents && chartType === "candle";
  const peQuery = useQuery<PeHistoryResponse>({
    queryKey: ["pe-history", symbol],
    queryFn: () =>
      fetch(`/api/stock?type=pe-history&symbol=${encodeURIComponent(symbol ?? "")}`).then((r) =>
        r.json()
      ),
    enabled: peEnabled && !!symbol,
    staleTime: 60 * 60 * 1000,
  });
  const togglePE = useCallback(() => setShowPE((v) => !v), [setShowPE]);

  // ── Indicator CRUD ───────────────────────────────────────────────────────

  const addIndicator = useCallback(
    (
      entry: IndicatorRegistryEntry,
      configOverrides?: Record<string, number | boolean | string>
    ) => {
      const newSpec: IndicatorSpec = { id: entry.id, params: configOverrides };
      const newId = specInstanceId(newSpec);
      if (!newId) return;
      setSpecs((prev) => {
        // One instance per pane indicator (volume excepted) — panes are expensive
        // and stacking two RSIs just eats vertical space. Re-adding one with
        // different params REPLACES it, which is how the picker's param editor
        // reads to a user ("RSI 14 → 30"); silently ignoring it looked broken.
        if (entry.type === "pane" && entry.id !== "volume") {
          const idx = prev.findIndex((s) => s.id === entry.id);
          if (idx >= 0) {
            if (specInstanceId(prev[idx]) === newId) return prev; // identical — nothing to do
            const next = [...prev];
            next[idx] = newSpec;
            return next;
          }
        }
        // Overlays stack: SMA 20 + SMA 50 on one chart is a normal setup.
        if (prev.some((s) => specInstanceId(s) === newId)) return prev;
        return [...prev, newSpec];
      });
    },
    [setSpecs]
  );

  const removeIndicator = useCallback(
    (indicatorId: string) => {
      setSpecs((prev) => prev.filter((s) => specInstanceId(s) !== indicatorId));
      setRuntimeConfig((prev) => {
        if (!(indicatorId in prev)) return prev;
        const next = { ...prev };
        delete next[indicatorId];
        return next;
      });
    },
    [setSpecs]
  );

  const toggleIndicator = useCallback(
    (
      entry: IndicatorRegistryEntry,
      configOverrides?: Record<string, number | boolean | string>
    ) => {
      const newSpec: IndicatorSpec = { id: entry.id, params: configOverrides };
      const newId = specInstanceId(newSpec);
      if (!newId) return;
      setSpecs((prev) =>
        prev.some((s) => specInstanceId(s) === newId)
          ? prev.filter((s) => specInstanceId(s) !== newId)
          : [...prev, newSpec]
      );
    },
    [setSpecs]
  );

  const resetIndicators = useCallback(() => {
    setSpecs(DEFAULT_INDICATOR_SPECS);
    setRuntimeConfig({});
    setShowVolumeProfile(false);
    setShowFootprint(false);
  }, [setSpecs, setShowVolumeProfile, setShowFootprint]);

  const updateIndicatorConfig = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: config values are indicator-specific, intentionally untyped
    (id: string, configPatch: Record<string, any>) => {
      setRuntimeConfig((prev) => {
        const current = prev[id];
        // Bail when nothing actually changes — callers patch from effects keyed on
        // fetched data, and a fresh object every time would re-render the chart.
        if (current && Object.entries(configPatch).every(([k, v]) => current[k] === v)) return prev;
        return { ...prev, [id]: { ...current, ...configPatch } };
      });
    },
    []
  );

  // ── Canvas overlays: VP + Footprint ─────────────────────────────────────

  const overlays: CanvasOverlay[] = useMemo(() => {
    const result: CanvasOverlay[] = [];
    if (showVolumeProfile) {
      result.push(createSessionVPOverlay(intradayData, vpConfig));
      result.push(createCompositeVPOverlay(vpConfig, intradayData));
    }
    if (showFootprint && footprintQuery.data) {
      result.push(createFootprintOverlay(footprintQuery.data));
    }
    return result;
  }, [showVolumeProfile, intradayData, vpConfig, showFootprint, footprintQuery.data]);

  // ── Toggles ──────────────────────────────────────────────────────────────

  const toggleVolumeProfile = useCallback(
    () => setShowVolumeProfile((v) => !v),
    [setShowVolumeProfile]
  );
  const toggleFootprint = useCallback(() => setShowFootprint((v) => !v), [setShowFootprint]);
  const toggleEvents = useCallback(() => setShowEvents((v) => !v), [setShowEvents]);

  return {
    indicators,
    overlays,
    // Event markers — pass directly to <ModularChart eventMarkers={...}>
    eventMarkers,
    showEvents,
    toggleEvents,
    supportsEvents,
    // VP
    showVolumeProfile,
    toggleVolumeProfile,
    setIntradayData,
    needsIntradayData: showVolumeProfile,
    vpConfig,
    setVPConfig,
    // Trailing P/E pane — equities only; peData self-hides when history empty
    showPE,
    togglePE,
    peData: peQuery.data ?? null,
    peLoading: peQuery.isLoading,
    // Footprint
    showFootprint,
    toggleFootprint,
    isCryptoSymbol,
    footprintLoading: footprintQuery.isLoading,
    // Indicator CRUD
    addIndicator,
    removeIndicator,
    toggleIndicator,
    resetIndicators,
    updateIndicatorConfig,
  };
}
