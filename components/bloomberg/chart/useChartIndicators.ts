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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_INDICATOR_SPECS,
  type IndicatorSpec,
  chartIndicatorSpecsAtom,
  chartRegressionAtom,
  chartRegressionOptsAtom,
  chartShowEventsAtom,
  chartShowFootprintAtom,
  chartShowPEAtom,
  chartShowVolumeProfileAtom,
  chartVPConfigAtom,
  chartWindowUnitAtom,
} from "../atoms";
import { useFootprintData } from "../hooks/useFootprintData";
import type { ChartClickContext } from "./ModularChart";
import type { PeStats } from "./PEPane";
import { INDICATOR_REGISTRY, createCompositeVPOverlay, createSessionVPOverlay } from "./indicators";
import { createFootprintOverlay } from "./indicators/order-footprint";
import { createRegressionChannelOverlay } from "./indicators/regression-channel";
import type {
  BarInterval,
  CanvasOverlay,
  ChartEventMarker,
  ChartIndicator,
  IndicatorRegistryEntry,
} from "./types";
import type { OhlcvBar } from "./types";
import { type WindowUnit, scaleParamsToBars, specParamsKey } from "./windowUnits";

export interface PeHistoryResponse {
  history: Array<{ time: string; pe: number | null; eps?: number; close?: number }>;
  stats: PeStats | null;
}
import { useStockEvents } from "../hooks/useStockEvents";

// ── Spec → instance ──────────────────────────────────────────────────────────

/** Everything needed to turn a stored window number into a bar count. */
interface WindowCtx {
  unit: WindowUnit;
  interval: BarInterval;
  isCrypto: boolean;
}

/**
 * Instantiate one persisted spec. Returns null for specs whose entry is gone.
 *
 * In "days" mode the entry's declared duration params are converted to bar
 * counts for the interval on screen, so one edit point covers every indicator
 * — no factory needs to know about units.
 */
function instantiate(spec: IndicatorSpec, ctx: WindowCtx): ChartIndicator | null {
  const entry = INDICATOR_REGISTRY.find((e) => e.id === spec.id);
  if (!entry) return null;
  try {
    const params = scaleParamsToBars(
      spec.params,
      entry.timeScalableParams,
      entry.defaultParams,
      ctx.unit,
      ctx.interval,
      ctx.isCrypto
    );
    return entry.factory(params);
  } catch {
    return null;
  }
}

/**
 * The derived instance id ("rsi-30") a spec would produce — used for dedupe and
 * removal. Resolved through the same ctx as the live instances so both sides of
 * a comparison agree; ids therefore change when the interval does, which is
 * fine because every id in play is recomputed on the same render.
 */
function specInstanceId(spec: IndicatorSpec, ctx: WindowCtx): string | null {
  return instantiate(spec, ctx)?.id ?? null;
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

/** Event markers the user clicked, ready to be handed to the detail card. */
export interface SelectedChartEvent {
  /** Nearest first. More than one means a cluster was clicked. */
  markers: ChartEventMarker[];
  /** Click position in viewport coordinates. */
  anchor: { x: number; y: number };
}

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
  const [regressionSel, setRegressionSel] = useAtom(chartRegressionAtom);
  const [regressionOpts, setRegressionOpts] = useAtom(chartRegressionOptsAtom);
  // Arming is deliberately NOT persisted: reloading into "waiting for your
  // first click" with no visual cue would be baffling.
  const [regressionArmed, setRegressionArmed] = useState(false);
  // Event marker whose detail card is open, plus where to anchor it. Transient
  // by design — a card restored on reload with no click behind it is confusing.
  const [selectedEvent, setSelectedEvent] = useState<SelectedChartEvent | null>(null);
  // The anchor lives in a ref as well as state: the click handler reaches the
  // chart through a ref, so two clicks landing before React re-renders would
  // both read a stale `null` and the second would just re-anchor instead of
  // closing the range. The state copy exists only to drive the button label.
  const pendingRef = useRef<string | number | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<string | number | null>(null);
  const setAnchor = useCallback((t: string | number | null) => {
    pendingRef.current = t;
    setPendingAnchor(t);
  }, []);

  // Transient per-instance config injected at runtime (e.g. fear-greed's
  // preloadedData). Deliberately NOT persisted — it holds fetched series, not
  // user choices, and would bloat localStorage.
  // biome-ignore lint/suspicious/noExplicitAny: config values are indicator-specific
  const [runtimeConfig, setRuntimeConfig] = useState<Record<string, Record<string, any>>>({});

  // ── Symbol type detection ──
  // Declared before the indicator memo: crypto trades 24h, which changes how
  // many bars a "day" of window is worth.
  const isCryptoSymbol = useMemo(() => detectCrypto(symbol), [symbol]);
  const isFxSymbol = useMemo(() => detectFx(symbol), [symbol]);

  // ── Window unit resolution ──
  const [windowUnit, setWindowUnit] = useAtom(chartWindowUnitAtom);
  const windowCtx: WindowCtx = useMemo(
    () => ({
      unit: windowUnit,
      interval: barInterval as BarInterval,
      isCrypto: isCryptoSymbol,
    }),
    [windowUnit, barInterval, isCryptoSymbol]
  );

  // Indicators are derived from the persisted specs, not a parallel useState.
  // The old copy-into-state approach lost the stored setup on every mount.
  const indicators: ChartIndicator[] = useMemo(() => {
    const built: ChartIndicator[] = [];
    for (const spec of specs) {
      const ind = instantiate(spec, windowCtx);
      if (!ind) continue;
      const patch = runtimeConfig[ind.id];
      built.push(patch ? ({ ...ind, config: { ...ind.config, ...patch } } as ChartIndicator) : ind);
    }
    return built;
  }, [specs, runtimeConfig, windowCtx]);

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
      const newId = specInstanceId(newSpec, windowCtx);
      if (!newId) return;
      setSpecs((prev) => {
        // One instance per pane indicator (volume excepted) — panes are expensive
        // and stacking two RSIs just eats vertical space. Re-adding one with
        // different params REPLACES it, which is how the picker's param editor
        // reads to a user ("RSI 14 → 30"); silently ignoring it looked broken.
        if (entry.type === "pane" && entry.id !== "volume") {
          const idx = prev.findIndex((s) => s.id === entry.id);
          if (idx >= 0) {
            // Compared on SETTINGS, not on the derived id — see specParamsKey.
            if (
              specParamsKey(prev[idx], entry, windowCtx) ===
              specParamsKey(newSpec, entry, windowCtx)
            ) {
              return prev; // identical — nothing to do
            }
            const next = [...prev];
            next[idx] = newSpec;
            return next;
          }
        }
        // Overlays stack: SMA 20 + SMA 50 on one chart is a normal setup — those
        // are two different derived ids, so they append.
        //
        // One that lands on the SAME derived id is a re-edit of what is already
        // there, not a second copy: VWAP's id carries no params at all, so
        // changing its bands was swallowed exactly the way the pane indicators'
        // settings were. Same id + different settings REPLACES.
        const sameId = prev.findIndex((s) => specInstanceId(s, windowCtx) === newId);
        if (sameId >= 0) {
          if (
            specParamsKey(prev[sameId], entry, windowCtx) ===
            specParamsKey(newSpec, entry, windowCtx)
          ) {
            return prev;
          }
          const next = [...prev];
          next[sameId] = newSpec;
          return next;
        }
        return [...prev, newSpec];
      });
    },
    [setSpecs, windowCtx]
  );

  const removeIndicator = useCallback(
    (indicatorId: string) => {
      setSpecs((prev) => prev.filter((s) => specInstanceId(s, windowCtx) !== indicatorId));
      setRuntimeConfig((prev) => {
        if (!(indicatorId in prev)) return prev;
        const next = { ...prev };
        delete next[indicatorId];
        return next;
      });
    },
    [setSpecs, windowCtx]
  );

  const toggleIndicator = useCallback(
    (
      entry: IndicatorRegistryEntry,
      configOverrides?: Record<string, number | boolean | string>
    ) => {
      const newSpec: IndicatorSpec = { id: entry.id, params: configOverrides };
      const newId = specInstanceId(newSpec, windowCtx);
      if (!newId) return;
      setSpecs((prev) =>
        prev.some((s) => specInstanceId(s, windowCtx) === newId)
          ? prev.filter((s) => specInstanceId(s, windowCtx) !== newId)
          : [...prev, newSpec]
      );
    },
    [setSpecs, windowCtx]
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
    if (regressionSel) {
      result.push(createRegressionChannelOverlay(regressionSel, regressionOpts));
    }
    return result;
  }, [
    showVolumeProfile,
    intradayData,
    vpConfig,
    showFootprint,
    footprintQuery.data,
    regressionSel,
    regressionOpts,
  ]);

  // ── Toggles ──────────────────────────────────────────────────────────────

  const toggleVolumeProfile = useCallback(
    () => setShowVolumeProfile((v) => !v),
    [setShowVolumeProfile]
  );
  const toggleFootprint = useCallback(() => setShowFootprint((v) => !v), [setShowFootprint]);
  const toggleEvents = useCallback(() => setShowEvents((v) => !v), [setShowEvents]);
  const toggleWindowUnit = useCallback(
    () => setWindowUnit((u) => (u === "bars" ? "days" : "bars")),
    [setWindowUnit]
  );

  /**
   * Two clicks define the channel: the first drops an anchor, the second closes
   * the range and disarms. Clicking the toolbar button again cancels.
   */
  const handleChartClick = useCallback(
    (time: string | number, ctx?: ChartClickContext) => {
      // Regression selection owns the click while armed — otherwise picking an
      // endpoint that happens to sit near an earnings date would pop the detail
      // card instead of closing the range.
      if (regressionArmed) {
        const anchor = pendingRef.current;
        if (anchor == null) {
          setAnchor(time);
          return;
        }
        if (String(time) === String(anchor)) return; // same bar — ignore
        setRegressionSel({ fromTime: anchor, toTime: time });
        setAnchor(null);
        setRegressionArmed(false);
        return;
      }
      // Clicking near a marker opens its detail card; clicking bare chart closes
      // whatever card is open.
      if (ctx?.events?.length && ctx.point) {
        setSelectedEvent({ markers: ctx.events, anchor: ctx.point });
      } else {
        setSelectedEvent(null);
      }
    },
    [regressionArmed, setAnchor, setRegressionSel]
  );

  const clearSelectedEvent = useCallback(() => setSelectedEvent(null), []);

  // A card left open across a symbol or interval change would describe an event
  // that is no longer on the chart, and its reaction numbers would be measured
  // against the wrong bars.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on identity change, not on the value it clears
  useEffect(() => {
    setSelectedEvent(null);
  }, [symbol, barInterval, chartType]);

  /** Arm selection; if a channel already exists, clear it instead. */
  const toggleRegression = useCallback(() => {
    if (regressionSel) {
      setRegressionSel(null);
      setAnchor(null);
      setRegressionArmed(false);
      return;
    }
    setAnchor(null);
    setRegressionArmed((v) => !v);
  }, [regressionSel, setAnchor, setRegressionSel]);

  const setRegressionMode = useCallback(
    (mode: "stddev" | "quantile") => setRegressionOpts((o) => ({ ...o, mode })),
    [setRegressionOpts]
  );

  return {
    indicators,
    overlays,
    // ── Regression Channel (click two bars to define the range) ──
    regressionSel,
    regressionArmed,
    regressionPending: pendingAnchor != null,
    regressionOpts,
    toggleRegression,
    setRegressionMode,
    handleChartClick,
    // Lookback window unit: "bars" (raw candles) vs "days" (session time)
    windowUnit,
    toggleWindowUnit,
    // Event markers — pass directly to <ModularChart eventMarkers={...}>
    eventMarkers,
    showEvents,
    toggleEvents,
    supportsEvents,
    // Marker clicked on the chart — feed into <EventDetailPopover>
    selectedEvent,
    clearSelectedEvent,
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
