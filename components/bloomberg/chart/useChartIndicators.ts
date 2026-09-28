"use client";

/**
 * useChartIndicators — Unified hook for ALL chart overlays and event markers.
 *
 * Single source of truth for every view that renders a ModularChart.
 * Views call this hook, destructure what they need, and pass outputs straight
 * to <ModularChart>. No view should manage indicators/overlays/events itself.
 *
 *   const { indicators, overlays, eventMarkers } =
 *     useChartIndicators({ symbol, barInterval, chartType });
 */

import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_INDICATOR_SPECS,
  type IndicatorSpec,
  chartIndicatorSpecsAtom,
  chartRegressionOptsAtom,
  chartShowFootprintAtom,
  chartShowPEAtom,
  chartShowVolumeEventsAtom,
  chartShowVolumeProfileAtom,
  chartVPConfigAtom,
  chartWindowUnitAtom,
} from "../atoms";
import { useFootprintData } from "../hooks/useFootprintData";
import type { ChartClickContext } from "./ModularChart";
import type { PeStats } from "./PEPane";
import { createBbVolumeOverlay } from "./bb-volume-overlay";
import { INDICATOR_REGISTRY, createCompositeVPOverlay, createSessionVPOverlay } from "./indicators";
import { createFootprintOverlay } from "./indicators/order-footprint";
import {
  DEFAULT_REGRESSION_OPTIONS,
  REGRESSION_COLORS,
  type StoredRegressionChannel,
  createRegressionChannelOverlay,
} from "./indicators/regression-channel";
import {
  type StoredTrendLine,
  TREND_LINE_COLOR,
  type TrendPoint,
  createTrendHitMap,
  createTrendLineOverlay,
  hitTestTrendLines,
} from "./indicators/trend-line";
import type {
  BarInterval,
  CanvasOverlay,
  ChartEventMarker,
  ChartIndicator,
  IndicatorRegistryEntry,
} from "./types";
import type { OhlcvBar } from "./types";
import { useChartDrawings } from "./useChartDrawings";
import { createVolumeEventOverlay } from "./volume-event-overlay";
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
    const indicator = entry.factory(params);
    // Keep the user's original units for reopening BB/ATR settings (the factory
    // receives scaled bar counts in DAYS mode).
    if (spec.id === "bollinger" || spec.id === "bollinger-b" || spec.id === "atr-regime") {
      indicator.config.inputParams = spec.params ?? {};
    }
    return indicator;
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
  const [showPE, setShowPE] = useAtom(chartShowPEAtom);
  const [showVolumeEvents, setShowVolumeEvents] = useAtom(chartShowVolumeEventsAtom);
  const [vpConfig, setVPConfig] = useAtom(chartVPConfigAtom);
  const [intradayData, setIntradayData] = useState<OhlcvBar[] | undefined>(undefined);
  const [defaultRegressionOpts, setDefaultRegressionOpts] = useAtom(chartRegressionOptsAtom);
  const [activeRegressionId, setActiveRegressionId] = useState<string | null>(null);
  // Drawings live in the backend (synced across machines) — see useChartDrawings.
  const { drawings, saveDrawing, removeDrawings } = useChartDrawings();
  const regressionChannels: StoredRegressionChannel[] = useMemo(() => {
    if (!symbol) return [];
    return drawings
      .filter(
        (d) => d.kind === "regression" && d.symbol === symbol && d.barInterval === barInterval
      )
      .map((d) => ({
        id: d.id,
        symbol: d.symbol,
        barInterval: d.barInterval,
        fromTime: d.data.fromTime,
        toTime: d.data.toTime,
        color: d.data.color ?? REGRESSION_COLORS[0],
        options: { ...DEFAULT_REGRESSION_OPTIONS, ...d.data.options },
      }));
  }, [drawings, symbol, barInterval]);
  const activeRegression =
    regressionChannels.find((channel) => channel.id === activeRegressionId) ??
    regressionChannels.at(-1);
  const regressionSel = activeRegression ?? null;
  const regressionOpts = activeRegression?.options ?? defaultRegressionOpts;
  const saveRegression = useCallback(
    (c: StoredRegressionChannel) =>
      saveDrawing({
        id: c.id,
        kind: "regression",
        symbol: c.symbol,
        barInterval: c.barInterval,
        data: { fromTime: c.fromTime, toTime: c.toTime, color: c.color, options: c.options },
      }),
    [saveDrawing]
  );
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

  // ── Trend lines (point to point; Shift on the 2nd click = horizontal) ──
  // Same ref + state split as the REG anchor, for the same double-click race.
  const [trendArmed, setTrendArmed] = useState(false);
  const trendPendingRef = useRef<TrendPoint | null>(null);
  const [trendPending, setTrendPendingState] = useState<TrendPoint | null>(null);
  const setTrendPending = useCallback((p: TrendPoint | null) => {
    trendPendingRef.current = p;
    setTrendPendingState(p);
  }, []);
  // One line at a time can be selected; the overlay paints its × box and
  // records where every line landed on screen into `trendHitsRef`.
  const [selectedTrendId, setSelectedTrendId] = useState<string | null>(null);
  const trendHitsRef = useRef(createTrendHitMap());
  const trendLines: StoredTrendLine[] = useMemo(() => {
    if (!symbol) return [];
    return drawings
      .filter((d) => d.kind === "trend" && d.symbol === symbol && d.barInterval === barInterval)
      .map((d) => ({
        id: d.id,
        symbol: d.symbol,
        barInterval: d.barInterval,
        a: d.data.a,
        b: d.data.b,
        color: d.data.color ?? TREND_LINE_COLOR,
      }));
  }, [drawings, symbol, barInterval]);

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
  //
  // Not a toggle. Dividends, earnings and splits are part of what a price
  // series *is* — a gap the size of an ex-dividend reads as a sell-off with the
  // rail switched off — so the rail is always on wherever it applies, the way
  // the volume pane is. The events chip row costs one pinned row at the bottom
  // of the price pane and no vertical space in the candles themselves.
  const showEvents = supportsEvents && chartType === "candle";
  const { markers: rawEventMarkers } = useStockEvents(showEvents ? symbol : null, true);

  // Memoized so parent renders do not needlessly repaint the event rail.
  const eventMarkers: ChartEventMarker[] = useMemo(
    () => (showEvents ? rawEventMarkers : EMPTY_MARKERS),
    [showEvents, rawEventMarkers]
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

  // Volume inside the band: one BB carries it — the first with the overlay on.
  // Two stacked would paint over each other in the same space.
  const bbVolumeConfig = useMemo(
    () =>
      indicators.find(
        (ind) =>
          ind.id.startsWith("bb-") &&
          ind.config.volOverlay != null &&
          ind.config.volOverlay !== "off"
      )?.config ?? null,
    [indicators]
  );

  const overlays: CanvasOverlay[] = useMemo(() => {
    const result: CanvasOverlay[] = [];
    // First, so VP strips, channels and chips all paint over it.
    if (bbVolumeConfig && chartType === "candle") {
      result.push(createBbVolumeOverlay(bbVolumeConfig));
    }
    if (showVolumeProfile) {
      result.push(createSessionVPOverlay(intradayData, vpConfig));
      result.push(createCompositeVPOverlay(vpConfig, intradayData));
    }
    if (showFootprint && footprintQuery.data) {
      result.push(createFootprintOverlay(footprintQuery.data));
    }
    // Last, so the chips paint over the VP strip and the channel rather than
    // under them — a label hidden behind an overlay is worse than no label.
    if (showVolumeEvents) {
      result.push(createVolumeEventOverlay());
    }
    return result;
  }, [
    bbVolumeConfig,
    chartType,
    showVolumeProfile,
    intradayData,
    vpConfig,
    showFootprint,
    footprintQuery.data,
    showVolumeEvents,
  ]);

  // User drawings — REG channels + trend lines — go to <ModularChart
  // drawingOverlay>, which repaints in place. Kept out of `overlays` because a
  // change there rebuilds the chart, and that reset the price scale and pane
  // layout on every click of a drawing tool.
  const drawingOverlay: CanvasOverlay | null = useMemo(() => {
    const parts: CanvasOverlay[] = regressionChannels.map((channel, index) =>
      createRegressionChannelOverlay(channel, channel.options, {
        id: `regression-channel-${channel.id}`,
        color: channel.color,
        label: `REG ${index + 1}`,
        showLabel: channel.id === activeRegression?.id,
      })
    );
    if (trendLines.length > 0 || trendPending) {
      parts.push(
        createTrendLineOverlay(trendLines, trendPending, selectedTrendId, trendHitsRef.current)
      );
    } else {
      trendHitsRef.current.segments = [];
      trendHitsRef.current.deleteBox = null;
    }
    if (parts.length === 0) return null;
    return {
      id: "drawings",
      name: "Drawings",
      mode: "full",
      width: 0,
      draw(...args) {
        for (const part of parts) part.draw(...args);
      },
    };
  }, [regressionChannels, activeRegression?.id, trendLines, trendPending, selectedTrendId]);

  // ── Toggles ──────────────────────────────────────────────────────────────

  const toggleVolumeProfile = useCallback(
    () => setShowVolumeProfile((v) => !v),
    [setShowVolumeProfile]
  );
  const toggleFootprint = useCallback(() => setShowFootprint((v) => !v), [setShowFootprint]);
  const toggleVolumeEvents = useCallback(
    () => setShowVolumeEvents((v) => !v),
    [setShowVolumeEvents]
  );
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
      // Trend line: two clicks on the price pane. A click off the price pane
      // (indicator sub-panes) has no price and is ignored while armed.
      if (trendArmed) {
        if (ctx?.price == null) return;
        const first = trendPendingRef.current;
        if (!first) {
          setTrendPending({ time, price: ctx.price });
          return;
        }
        if (String(time) === String(first.time)) return; // same bar — ignore
        saveDrawing({
          id: globalThis.crypto?.randomUUID?.() ?? `tl-${Date.now()}`,
          kind: "trend",
          symbol: symbol ?? "",
          barInterval,
          data: {
            a: first,
            b: { time, price: ctx.shiftKey ? first.price : ctx.price },
            color: TREND_LINE_COLOR,
          },
        });
        setTrendPending(null);
        setTrendArmed(false);
        return;
      }
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
        const id = globalThis.crypto?.randomUUID?.() ?? `reg-${Date.now()}`;
        saveRegression({
          fromTime: anchor,
          toTime: time,
          id,
          symbol: symbol ?? "",
          barInterval,
          color: REGRESSION_COLORS[regressionChannels.length % REGRESSION_COLORS.length],
          options: { ...defaultRegressionOpts },
        });
        setActiveRegressionId(id);
        setAnchor(null);
        setRegressionArmed(false);
        return;
      }
      // A trend line under the click: its × deletes it, the line itself selects
      // it. Anything else deselects and falls through to the event rail.
      const hit = ctx?.panePoint ? hitTestTrendLines(trendHitsRef.current, ctx.panePoint) : null;
      if (hit) {
        if (hit.onDelete) {
          removeDrawings([hit.id]);
          setSelectedTrendId(null);
        } else {
          setSelectedTrendId(hit.id);
        }
        setSelectedEvent(null);
        return;
      }
      setSelectedTrendId(null);
      // Clicking a rail icon opens its detail card; clicking bare chart closes
      // whatever card is open.
      if (ctx?.events?.length && ctx.point) {
        setSelectedEvent({ markers: ctx.events, anchor: ctx.point });
      } else {
        setSelectedEvent(null);
      }
    },
    [
      trendArmed,
      setTrendPending,
      saveDrawing,
      removeDrawings,
      regressionArmed,
      setAnchor,
      saveRegression,
      regressionChannels.length,
      symbol,
      barInterval,
      defaultRegressionOpts,
    ]
  );

  const clearSelectedEvent = useCallback(() => setSelectedEvent(null), []);

  // A card left open across a symbol or interval change would describe an event
  // that is no longer on the chart, and its reaction numbers would be measured
  // against the wrong bars.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on identity change, not on the value it clears
  useEffect(() => {
    setSelectedEvent(null);
    setAnchor(null);
    setRegressionArmed(false);
    setTrendPending(null);
    setTrendArmed(false);
    setSelectedTrendId(null);
  }, [symbol, barInterval, chartType]);

  // Delete / Backspace removes the selected line, Escape lets go of it. Ignored
  // while typing in a field, so editing a symbol can't delete a drawing.
  useEffect(() => {
    if (!selectedTrendId) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeDrawings([selectedTrendId]);
        setSelectedTrendId(null);
      } else if (e.key === "Escape") {
        setSelectedTrendId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedTrendId, removeDrawings]);

  // A selected line deleted elsewhere (another chart, the other machine) drops
  // its selection rather than pointing at nothing.
  useEffect(() => {
    if (selectedTrendId && !trendLines.some((l) => l.id === selectedTrendId)) {
      setSelectedTrendId(null);
    }
  }, [selectedTrendId, trendLines]);

  /** Arm another range; existing channels stay visible. */
  const toggleRegression = useCallback(() => {
    setAnchor(null);
    setTrendPending(null);
    setTrendArmed(false);
    setRegressionArmed((v) => !v);
  }, [setAnchor, setTrendPending]);

  /** Arm one trend line (two clicks). Clicking again cancels. */
  const toggleTrendLine = useCallback(() => {
    setAnchor(null);
    setRegressionArmed(false);
    setTrendPending(null);
    setSelectedTrendId(null);
    setTrendArmed((v) => !v);
  }, [setAnchor, setTrendPending]);

  /** Undo: drop the newest line on this chart. */
  const removeLastTrendLine = useCallback(() => {
    const last = trendLines.at(-1);
    if (last) removeDrawings([last.id]);
  }, [trendLines, removeDrawings]);

  /** Remove every line on this chart (other symbols / intervals keep theirs). */
  const clearTrendLines = useCallback(
    () => removeDrawings(trendLines.map((l) => l.id)),
    [trendLines, removeDrawings]
  );

  const removeRegression = useCallback(
    (id: string) => {
      removeDrawings([id]);
      setActiveRegressionId((active) => (active === id ? null : active));
    },
    [removeDrawings]
  );

  const selectRegression = useCallback((id: string) => setActiveRegressionId(id), []);

  const setRegressionMode = useCallback(
    (mode: "stddev" | "quantile") => {
      if (!activeRegression) {
        setDefaultRegressionOpts((o) => ({ ...o, mode }));
        return;
      }
      saveRegression({
        ...activeRegression,
        options: { ...activeRegression.options, mode },
      });
    },
    [activeRegression, setDefaultRegressionOpts, saveRegression]
  );

  return {
    indicators,
    overlays,
    /** Pass to <ModularChart drawingOverlay> — repaints without a rebuild. */
    drawingOverlay,
    // ── Regression Channel (click two bars to define the range) ──
    regressionSel,
    regressionChannels,
    activeRegressionId: activeRegression?.id ?? null,
    regressionArmed,
    regressionPending: pendingAnchor != null,
    regressionOpts,
    toggleRegression,
    removeRegression,
    selectRegression,
    setRegressionMode,
    // ── Trend lines (click two points; Shift on the 2nd = horizontal) ──
    trendLines,
    trendArmed,
    trendPending: trendPending != null,
    toggleTrendLine,
    removeLastTrendLine,
    clearTrendLines,
    /** Any click-to-draw tool is waiting for a click — show the crosshair cursor. */
    drawingArmed: regressionArmed || trendArmed,
    handleChartClick,
    // Lookback window unit: "bars" (raw candles) vs "days" (session time)
    windowUnit,
    toggleWindowUnit,
    // Event markers — pass directly to <ModularChart eventMarkers={...}>. Always
    // populated for an equity on a candle chart; there is no switch.
    eventMarkers,
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
    // Volume events — chips on the price pane + <VolumeEventPanel data={bars}>
    showVolumeEvents,
    toggleVolumeEvents,
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
