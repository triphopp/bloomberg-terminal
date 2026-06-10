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

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useAtom } from "jotai";
import type { ChartIndicator, CanvasOverlay, ChartEventMarker, IndicatorRegistryEntry } from "./types";
import type { OhlcvBar } from "./types";
import {
  createEMA,
  createVolume,
  createSessionVPOverlay,
  createCompositeVPOverlay,
  INDICATOR_REGISTRY,
} from "./indicators";
import { createFootprintOverlay } from "./indicators/order-footprint";
import {
  chartIndicatorIdsAtom,
  chartShowVolumeProfileAtom,
  chartShowFootprintAtom,
  chartShowEventsAtom,
} from "../atoms";
import { useFootprintData } from "../hooks/useFootprintData";
import { useStockEvents } from "../hooks/useStockEvents";

// ── Default preset ───────────────────────────────────────────────────────────

const DEFAULT_IDS = ["ema-20", "ema-50", "volume"];

function buildIndicatorsFromIds(ids: string[]): ChartIndicator[] {
  const result: ChartIndicator[] = [];
  for (const id of ids) {
    if (id === "volume") { result.push(createVolume()); continue; }
    const emaMatch = id.match(/^ema-(\d+)$/);
    if (emaMatch) {
      const period = parseInt(emaMatch[1], 10);
      const colorMap: Record<number, string> = { 20: "#ffc107", 50: "#2196f3", 100: "#e91e63", 200: "#9c27b0" };
      result.push(createEMA({ period, color: colorMap[period] || "#ffc107" }));
      continue;
    }
    // Fallback: look up in registry by id prefix (handles fear-greed, rsi, macd, etc.)
    const entry = INDICATOR_REGISTRY.find(e => id === e.id || id.startsWith(e.id));
    if (entry) result.push(entry.factory());
  }
  return result;
}

// ── Crypto detection ─────────────────────────────────────────────────────────

const CRYPTO_BASES = [
  "BTC","ETH","BNB","SOL","XRP","ADA","DOGE","AVAX","DOT","LINK",
  "MATIC","UNI","ATOM","LTC","NEAR","SUI","APT","ARB","OP","PEPE",
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

  const [persistedIds, setPersistedIds] = useAtom(chartIndicatorIdsAtom);
  const [showVolumeProfile, setShowVolumeProfile] = useAtom(chartShowVolumeProfileAtom);
  const [showFootprint, setShowFootprint] = useAtom(chartShowFootprintAtom);
  const [showEvents, setShowEvents] = useAtom(chartShowEventsAtom);
  const [indicators, setIndicators] = useState<ChartIndicator[]>(() => buildIndicatorsFromIds(persistedIds));
  const [intradayData, setIntradayData] = useState<OhlcvBar[] | undefined>(undefined);

  const syncRef = useRef(false);
  useEffect(() => {
    if (syncRef.current) {
      setPersistedIds(indicators.map(i => i.id));
    }
    syncRef.current = true;
  }, [indicators, setPersistedIds]);

  // ── Symbol type detection ──
  const isCryptoSymbol = useMemo(() => detectCrypto(symbol), [symbol]);
  const isFxSymbol     = useMemo(() => detectFx(symbol), [symbol]);

  // Events are meaningful only for equities (not crypto/FX)
  const supportsEvents = !!symbol && !isCryptoSymbol && !isFxSymbol;

  // ── Footprint data fetching ──
  const fpEnabled = showFootprint && isCryptoSymbol && chartType === "candle";
  const footprintQuery = useFootprintData(
    fpEnabled ? symbol : null,
    barInterval,
    fpEnabled,
  );

  // ── Event markers: dividends, earnings, splits ──
  const { markers: rawEventMarkers } = useStockEvents(
    supportsEvents && showEvents && chartType === "candle" ? symbol : null,
    true,
  );

  const eventMarkers: ChartEventMarker[] = showEvents && supportsEvents && chartType === "candle"
    ? rawEventMarkers
    : [];

  // ── Indicator CRUD ───────────────────────────────────────────────────────

  const addIndicator = useCallback((entry: IndicatorRegistryEntry, configOverrides?: Record<string, number | boolean | string>) => {
    const newIndicator = entry.factory(configOverrides);
    setIndicators(prev => {
      if (entry.type === "pane" && entry.id !== "volume") {
        const existing = prev.find(i => i.id.startsWith(entry.id));
        if (existing) return prev;
      }
      const duplicate = prev.find(i => i.id === newIndicator.id);
      if (duplicate) return prev;
      return [...prev, newIndicator];
    });
  }, []);

  const removeIndicator = useCallback((indicatorId: string) => {
    setIndicators(prev => prev.filter(i => i.id !== indicatorId));
  }, []);

  const toggleIndicator = useCallback((entry: IndicatorRegistryEntry, configOverrides?: Record<string, number | boolean | string>) => {
    const testInstance = entry.factory(configOverrides);
    setIndicators(prev => {
      const existing = prev.find(i => i.id === testInstance.id);
      if (existing) return prev.filter(i => i.id !== testInstance.id);
      return [...prev, testInstance];
    });
  }, []);

  const resetIndicators = useCallback(() => {
    setIndicators(buildIndicatorsFromIds(DEFAULT_IDS));
    setShowVolumeProfile(false);
    setShowFootprint(false);
  }, [setShowVolumeProfile, setShowFootprint]);

  const updateIndicatorConfig = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (id: string, configPatch: Record<string, any>) => {
      setIndicators(prev =>
        prev.map(ind =>
          ind.id === id
            ? { ...ind, config: { ...ind.config, ...configPatch } }
            : ind,
        ) as ChartIndicator[],
      );
    },
    [],
  );

  // ── Canvas overlays: VP + Footprint ─────────────────────────────────────

  const overlays: CanvasOverlay[] = useMemo(() => {
    const result: CanvasOverlay[] = [];
    if (showVolumeProfile) {
      result.push(createSessionVPOverlay(intradayData));
      result.push(createCompositeVPOverlay());
    }
    if (showFootprint && footprintQuery.data) {
      result.push(createFootprintOverlay(footprintQuery.data));
    }
    return result;
  }, [showVolumeProfile, intradayData, showFootprint, footprintQuery.data]);

  // ── Toggles ──────────────────────────────────────────────────────────────

  const toggleVolumeProfile = useCallback(() => setShowVolumeProfile(v => !v), [setShowVolumeProfile]);
  const toggleFootprint      = useCallback(() => setShowFootprint(v => !v),      [setShowFootprint]);
  const toggleEvents         = useCallback(() => setShowEvents(v => !v),          [setShowEvents]);

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
