"use client";

import { Check, ChevronDown, ChevronRight, Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BollingerFitSummary } from "./BollingerFitSummary";
import { resolveBollingerParameters } from "./bollinger-fit";
import { INDICATOR_REGISTRY } from "./indicators";
import { ATR_REGIME_COLORS, calcAtrRegime, validAtrInputs } from "./indicators/atr";
import type { ChartColors, ChartIndicator, IndicatorRegistryEntry, OhlcvBar } from "./types";

interface IndicatorPickerProps {
  colors: ChartColors;
  activeIndicators: ChartIndicator[];
  onAdd: (
    entry: IndicatorRegistryEntry,
    config?: Record<string, number | boolean | string>
  ) => void;
  onRemove: (indicatorId: string) => void;
  /** Unit lookback windows are entered in. Omit to hide the unit switch. */
  windowUnit?: "bars" | "days";
  onToggleWindowUnit?: () => void;
  /** Same immutable bars as ModularChart, used for Bollinger/ATR diagnostics. */
  data?: OhlcvBar[];
  /** Keep active chips on one scrollable line when embedded in a chart toolbar. */
  compact?: boolean;
}

const EMPTY_BARS: OhlcvBar[] = [];
const isBollingerEntry = (id: string) => id === "bollinger" || id === "bollinger-b";
function bollingerEntryId(ind: ChartIndicator): string | null {
  if (/^bb-b-\d/.test(ind.id)) return "bollinger-b";
  if (/^bb-\d/.test(ind.id)) return "bollinger";
  return null;
}
const hasSettings = (id: string) => isBollingerEntry(id) || id === "atr-regime";
const settingsEntryId = (ind: ChartIndicator) =>
  ind.id === "atr-regime" ? ind.id : bollingerEntryId(ind);
const ATR_STATE_LABEL = { accumulate: "ACCUMULATE", avoid: "AVOID", unknown: "NO SIGNAL" };

const CATEGORY_LABELS: Record<string, string> = {
  trend: "Trend",
  momentum: "Momentum",
  volatility: "Volatility",
  volume: "Volume",
  custom: "Custom",
};

const CATEGORY_ORDER = ["trend", "momentum", "volatility", "volume", "custom"];

export function IndicatorPicker({
  colors,
  activeIndicators,
  onAdd,
  onRemove,
  windowUnit = "bars",
  onToggleWindowUnit,
  data = EMPTY_BARS,
  compact = false,
}: IndicatorPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, Record<string, number | string>>>(
    {}
  );
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (!isOpen) return;
    const ownerDocument = dropdownRef.current?.ownerDocument ?? document;
    const handler = (e: MouseEvent) => {
      if (
        !dropdownRef.current?.contains(e.target as Node) &&
        !menuRef.current?.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setExpandedId(null);
      }
    };
    ownerDocument.addEventListener("mousedown", handler);
    return () => ownerDocument.removeEventListener("mousedown", handler);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const ownerWindow = dropdownRef.current?.ownerDocument.defaultView ?? window;
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect)
        setMenuPos({
          left: Math.max(4, Math.min(rect.left, ownerWindow.innerWidth - 248)),
          top: rect.bottom + 4,
        });
    };
    position();
    ownerWindow.addEventListener("resize", position);
    ownerWindow.addEventListener("scroll", position, true);
    return () => {
      ownerWindow.removeEventListener("resize", position);
      ownerWindow.removeEventListener("scroll", position, true);
    };
  }, [isOpen]);

  // Focus after opening. The add button resets filters; a BB settings shortcut
  // deliberately filters to the indicator being edited.
  useEffect(() => {
    if (!isOpen) return;
    searchRef.current?.focus();
  }, [isOpen]);

  const q = query.trim().toLowerCase();
  const matches = INDICATOR_REGISTRY.filter(
    (e) =>
      (!categoryFilter || e.category === categoryFilter) &&
      (!q || e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q))
  );
  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat] ?? cat,
    items: matches.filter((e) => e.category === cat),
  })).filter((g) => g.items.length > 0);

  // Categories that exist at all — the chips stay stable while typing so the row
  // doesn't reflow underneath the pointer.
  const categories = CATEGORY_ORDER.filter((cat) =>
    INDICATOR_REGISTRY.some((e) => e.category === cat)
  );

  function getParams(entry: IndicatorRegistryEntry): Record<string, number | string> {
    const saved = paramValues[entry.id];
    const defaults: Record<string, number | string> = {};
    for (const p of entry.defaultParams) {
      const v = p.default;
      defaults[p.key] = typeof v === "boolean" ? (v ? 1 : 0) : v;
    }
    const active = hasSettings(entry.id)
      ? activeIndicators.find((ind) => settingsEntryId(ind) === entry.id)
      : undefined;
    return { ...defaults, ...(active?.config.inputParams ?? {}), ...saved };
  }

  function handleAdd(entry: IndicatorRegistryEntry) {
    if (entry.defaultParams.length === 0) {
      onAdd(entry);
      return;
    }
    if (expandedId === entry.id) {
      if (isBollingerEntry(entry.id) && !validBollingerParams(getParams(entry))) return;
      if (entry.id === "atr-regime" && !validAtrInputs(getParams(entry))) return;
      onAdd(entry, getParams(entry) as Record<string, number | boolean | string>);
      setExpandedId(null);
    } else {
      setExpandedId(entry.id);
    }
  }

  function validBollingerParams(params: Record<string, number | string>) {
    const n = Number(params.period);
    const k = Number(params.stdDev);
    const cost = Number(params.fitCostBps);
    return (
      params.fitCostBps !== "" &&
      Number.isInteger(n) &&
      n >= 5 &&
      n <= 200 &&
      Number.isFinite(k) &&
      k >= 0.5 &&
      k <= 4 &&
      Number.isFinite(cost) &&
      cost >= 0 &&
      cost <= 100
    );
  }

  function openIndicatorSettings(ind: ChartIndicator) {
    const entryId = settingsEntryId(ind);
    if (!entryId) return;
    setParamValues((prev) => ({ ...prev, [entryId]: ind.config.inputParams ?? ind.config }));
    setIsOpen(true);
    setQuery(
      entryId === "atr-regime"
        ? "ATR Accumulation"
        : entryId === "bollinger-b"
          ? "Bollinger %B"
          : "Bollinger Bands"
    );
    setCategoryFilter("volatility");
    setExpandedId(entryId);
  }

  function setParam(entryId: string, key: string, value: number | string) {
    setParamValues((prev) => ({
      ...prev,
      [entryId]: { ...(prev[entryId] ?? {}), [key]: value },
    }));
  }

  return (
    <div
      className={`flex items-center gap-1 ${compact ? "min-w-0 flex-1" : "flex-wrap"}`}
      ref={dropdownRef}
    >
      <div
        className={
          compact
            ? "flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            : "contents"
        }
      >
        {activeIndicators.map((ind) => {
          const isBB = bollingerEntryId(ind) != null;
          const isATR = ind.id === "atr-regime";
          const atr = isATR ? calcAtrRegime(data, ind.config).at(-1) : null;
          const accent = isATR
            ? ATR_REGIME_COLORS[atr?.state ?? "unknown"]
            : (colors.accent ?? colors.positive);
          const resolved = isBB ? resolveBollingerParameters(data, ind.config) : null;
          const label = resolved?.fit
            ? `${ind.id.startsWith("bb-b-") ? "%B" : "BB"} (${resolved.period}, ${resolved.stdDev}σ) · ${resolved.fit.best ? "FIT" : "FIT N/A · MANUAL"}`
            : isATR
              ? `${ind.name} · ${ATR_STATE_LABEL[atr?.state ?? "unknown"]}`
              : ind.name;
          return (
            <div key={ind.id} className="flex items-center">
              <button
                key={ind.id}
                type="button"
                className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono font-bold border cursor-pointer transition-colors hover:opacity-70"
                style={{
                  borderColor: `${accent}44`,
                  backgroundColor: `${accent}11`,
                  color: accent,
                }}
                onClick={() => onRemove(ind.id)}
                title={`Remove ${ind.name}`}
              >
                {label}
                <X className="h-2.5 w-2.5" />
              </button>
              {(isBB || isATR) && (
                <button
                  type="button"
                  onClick={() => openIndicatorSettings(ind)}
                  className="text-[9px] font-mono px-1 py-0.5 border hover:opacity-70"
                  style={{ borderColor: colors.border, color: colors.textSecondary }}
                  aria-label={`Settings for ${ind.name}`}
                  title={
                    isATR ? "ATR settings · color definition" : "Bollinger settings · Manual / Fit"
                  }
                >
                  ⚙
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="relative shrink-0">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            setIsOpen(!isOpen);
            setQuery("");
            setCategoryFilter(null);
            setExpandedId(null);
          }}
          className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-mono border transition-colors hover:opacity-70"
          style={{
            borderColor: colors.border,
            color: colors.textSecondary,
            backgroundColor: isOpen ? `${colors.accent ?? colors.positive}11` : "transparent",
          }}
          title="Add indicator"
        >
          <Plus className="h-3 w-3" />
          <span>INDICATOR</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </button>

        {isOpen &&
          createPortal(
            <div
              ref={menuRef}
              className="fixed z-50 border min-w-[240px] max-h-[400px] overflow-y-auto"
              style={{
                left: menuPos.left,
                top: menuPos.top,
                backgroundColor: colors.surface,
                borderColor: colors.border,
              }}
            >
              {/* Filter header — sticky so it stays reachable while the list scrolls */}
              <div
                className="sticky top-0 z-10 border-b px-2 py-1.5 flex flex-col gap-1"
                style={{ backgroundColor: colors.surface, borderColor: colors.border }}
              >
                <div className="flex items-center gap-1">
                  <Search
                    className="h-2.5 w-2.5 shrink-0"
                    style={{ color: colors.textSecondary }}
                  />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        if (query) setQuery("");
                        else setIsOpen(false);
                      }
                      // Enter adds the only remaining match — the fast path for
                      // "type three letters, hit enter".
                      if (e.key === "Enter" && matches.length === 1) {
                        handleAdd(matches[0]);
                      }
                    }}
                    placeholder="FILTER"
                    className="flex-1 min-w-0 bg-transparent outline-none text-[9px] font-mono uppercase"
                    style={{ color: colors.text }}
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      className="shrink-0 hover:opacity-70"
                      title="Clear filter"
                    >
                      <X className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {categories.map((cat) => {
                    const on = categoryFilter === cat;
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setCategoryFilter(on ? null : cat)}
                        className="px-1 py-0 text-[8px] font-mono border transition-colors hover:opacity-70"
                        style={{
                          borderColor: on ? (colors.accent ?? colors.positive) : colors.border,
                          color: on ? (colors.accent ?? colors.positive) : colors.textSecondary,
                          backgroundColor: on
                            ? `${colors.accent ?? colors.positive}15`
                            : "transparent",
                        }}
                      >
                        {CATEGORY_LABELS[cat] ?? cat}
                      </button>
                    );
                  })}
                </div>
              </div>

              {grouped.length === 0 && (
                <div
                  className="px-3 py-2 text-[9px] font-mono"
                  style={{ color: colors.textSecondary }}
                >
                  NO MATCH
                </div>
              )}

              {onToggleWindowUnit && (
                <button
                  type="button"
                  onClick={onToggleWindowUnit}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-[9px] font-mono border-b transition-colors hover:opacity-70"
                  style={{
                    borderColor: colors.border,
                    color: colors.textSecondary,
                    backgroundColor: `${colors.surface}cc`,
                  }}
                  title={
                    windowUnit === "days"
                      ? "Windows are entered in days and converted to bars for the current interval — comparable across timeframes"
                      : "Windows are entered in raw bars — the span they cover changes with the timeframe"
                  }
                >
                  <span className="opacity-60">WINDOW UNIT</span>
                  <span
                    className="font-bold"
                    style={{
                      color: windowUnit === "days" ? colors.positive : colors.textSecondary,
                    }}
                  >
                    {windowUnit === "days" ? "DAYS" : "BARS"}
                  </span>
                </button>
              )}
              {grouped.map(({ category, label, items }) => (
                <div key={category}>
                  <div
                    className="px-3 py-1.5 text-[9px] font-bold tracking-widest uppercase border-b"
                    style={{
                      color: colors.textSecondary,
                      borderColor: colors.border,
                      backgroundColor: `${colors.border}44`,
                    }}
                  >
                    {label}
                  </div>
                  {items.map((entry) => {
                    const isActive = activeIndicators.some((a) =>
                      isBollingerEntry(entry.id)
                        ? bollingerEntryId(a) === entry.id
                        : a.id.startsWith(entry.id)
                    );
                    const isExpanded = expandedId === entry.id;
                    const hasParams = entry.defaultParams.length > 0;
                    const params = getParams(entry);

                    return (
                      <div key={entry.id}>
                        <button
                          type="button"
                          onClick={() => handleAdd(entry)}
                          className="w-full text-left px-3 py-1.5 text-[10px] font-mono flex items-center justify-between border-b transition-colors hover:opacity-70"
                          style={{
                            borderColor: `${colors.border}44`,
                            color: isActive ? (colors.accent ?? colors.positive) : colors.text,
                            backgroundColor: isExpanded
                              ? `${colors.accent ?? colors.positive}14`
                              : isActive
                                ? `${colors.accent ?? colors.positive}08`
                                : "transparent",
                          }}
                        >
                          <div className="flex items-center gap-1">
                            {hasParams ? (
                              isExpanded ? (
                                <ChevronDown className="h-2.5 w-2.5 opacity-60" />
                              ) : (
                                <ChevronRight className="h-2.5 w-2.5 opacity-40" />
                              )
                            ) : (
                              <span className="w-2.5" />
                            )}
                            <span className="font-bold">{entry.name}</span>
                            <span className="opacity-40 text-[8px]">
                              {entry.type === "overlay" ? "overlay" : "pane"}
                            </span>
                          </div>
                          {isActive && !isExpanded && (
                            <span className="text-[8px] opacity-50">ACTIVE</span>
                          )}
                          {isExpanded && <Check className="h-3 w-3 opacity-70" />}
                        </button>

                        {/* Inline param editor */}
                        {isExpanded && (
                          <div
                            className="px-3 py-2 border-b flex flex-col gap-1.5"
                            style={{
                              borderColor: `${colors.border}44`,
                              backgroundColor: `${colors.surface}cc`,
                            }}
                          >
                            {entry.defaultParams.map((p) => {
                              // Only duration params follow the unit switch; std devs,
                              // thresholds and ratios stay unitless.
                              const scaled =
                                windowUnit === "days" &&
                                (entry.timeScalableParams?.includes(p.key) ?? false);
                              const controlId = `ind-param-${entry.id}-${p.key}`;
                              return (
                                <label
                                  key={p.key}
                                  htmlFor={controlId}
                                  className="flex items-center justify-between gap-2"
                                >
                                  <span className="text-[9px] font-mono opacity-60 min-w-[60px]">
                                    {p.label}
                                    {isBollingerEntry(entry.id) &&
                                      ["period", "stdDev"].includes(p.key) &&
                                      params.fitMode === "sharpe" &&
                                      " (manual)"}
                                    {scaled && <span style={{ color: colors.positive }}> (d)</span>}
                                  </span>
                                  {p.type === "select" ? (
                                    <select
                                      id={controlId}
                                      value={params[p.key] as string}
                                      onChange={(e) => setParam(entry.id, p.key, e.target.value)}
                                      className="text-right text-[9px] font-mono px-1 py-0.5 border outline-none"
                                      style={{
                                        borderColor: colors.border,
                                        color: colors.text,
                                        backgroundColor: colors.surface,
                                      }}
                                    >
                                      {(p.options ?? []).map((o) => (
                                        <option key={o.value} value={o.value}>
                                          {o.label}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <input
                                      id={controlId}
                                      type="number"
                                      value={params[p.key] as number}
                                      min={p.min}
                                      max={p.max}
                                      step={p.step ?? 1}
                                      onChange={(e) =>
                                        setParam(
                                          entry.id,
                                          p.key,
                                          hasSettings(entry.id) && e.target.value === ""
                                            ? ""
                                            : Number.parseFloat(e.target.value)
                                        )
                                      }
                                      className="w-16 text-right text-[9px] font-mono px-1 py-0.5 border bg-transparent outline-none"
                                      style={{ borderColor: colors.border, color: colors.text }}
                                    />
                                  )}
                                </label>
                              );
                            })}
                            {isBollingerEntry(entry.id) && !validBollingerParams(params) && (
                              <p
                                role="alert"
                                className="text-[9px] font-mono"
                                style={{ color: colors.negative }}
                              >
                                Use a whole period 5–200, deviation 0.5–4 and cost 0–100 bps.
                              </p>
                            )}
                            {isBollingerEntry(entry.id) &&
                              params.fitMode === "sharpe" &&
                              validBollingerParams(params) && (
                                <BollingerFitSummary
                                  data={data}
                                  costBps={Number(params.fitCostBps)}
                                  colors={colors}
                                />
                              )}
                            {isBollingerEntry(entry.id) && (
                              <button
                                type="button"
                                disabled={!validBollingerParams(params)}
                                onClick={() => handleAdd(entry)}
                                className="text-[9px] font-mono border px-2 py-1 disabled:opacity-40"
                                style={{
                                  color: colors.accent ?? colors.positive,
                                  borderColor: colors.border,
                                }}
                              >
                                {params.fitMode === "sharpe" ? "APPLY FIT" : "APPLY MANUAL"}
                              </button>
                            )}
                            {entry.id === "atr-regime" && (
                              <div className="text-[9px] font-mono flex flex-col gap-1.5 max-w-[300px]">
                                <div style={{ color: ATR_REGIME_COLORS.accumulate }}>
                                  GREEN · ATR% ≤ prior baseline × limit AND close &gt; EMA AND EMA
                                  above its value one slope span ago.
                                </div>
                                <div style={{ color: ATR_REGIME_COLORS.avoid }}>
                                  RED · Accumulation filter not met.
                                </div>
                                <div style={{ color: ATR_REGIME_COLORS.unknown }}>
                                  GRAY · History incomplete or baseline has no range.
                                </div>
                                <div style={{ color: colors.textSecondary }}>
                                  Wilder ATR; ATR% = 100 × ATR / close. Baseline = SMA of prior ATR%
                                  values, excluding the current bar. Thin gray line = low-volatility
                                  threshold.
                                </div>
                                {(() => {
                                  const active = activeIndicators.find(
                                    (ind) => ind.id === "atr-regime"
                                  );
                                  const latest = active
                                    ? calcAtrRegime(data, active.config).at(-1)
                                    : null;
                                  if (!latest) return null;
                                  return (
                                    <div style={{ color: colors.text }}>
                                      APPLIED · {ATR_STATE_LABEL[latest.state]}
                                      <br />
                                      ATR% {latest.atrPercent?.toFixed(3) ?? "—"} · LIMIT{" "}
                                      {latest.thresholdPercent?.toFixed(3) ?? "—"}%<br />
                                      TREND{" "}
                                      {latest.uptrend == null
                                        ? "—"
                                        : latest.uptrend
                                          ? "UP"
                                          : "NOT UP"}
                                    </div>
                                  );
                                })()}
                                <div style={{ color: colors.textSecondary }}>
                                  A configurable volatility/trend filter; low ATR alone does not
                                  prove accumulation. Current-bar color may change until close.
                                </div>
                                {!validAtrInputs(params) && (
                                  <p role="alert" style={{ color: colors.negative }}>
                                    Enter valid periods and an ATR/base limit from 0.1 to 3.
                                  </p>
                                )}
                                <button
                                  type="button"
                                  disabled={!validAtrInputs(params)}
                                  onClick={() => handleAdd(entry)}
                                  className="border px-2 py-1 disabled:opacity-40"
                                  style={{
                                    borderColor: colors.border,
                                    color: colors.accent ?? colors.positive,
                                  }}
                                >
                                  APPLY ATR
                                </button>
                              </div>
                            )}
                            <p className="text-[8px] opacity-40 font-mono mt-0.5">
                              click name again to confirm
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>,
            dropdownRef.current?.ownerDocument.body ?? document.body
          )}
      </div>
    </div>
  );
}
