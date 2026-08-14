"use client";

import { Check, ChevronDown, ChevronRight, Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { INDICATOR_REGISTRY } from "./indicators";
import type { ChartColors, ChartIndicator, IndicatorRegistryEntry } from "./types";

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
}

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
}: IndicatorPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, Record<string, number | string>>>(
    {}
  );
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setExpandedId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  // Reset the filters on open so the list never comes back pre-narrowed by a
  // search the user has since forgotten about.
  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setCategoryFilter(null);
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
    return saved ? { ...defaults, ...saved } : defaults;
  }

  function handleAdd(entry: IndicatorRegistryEntry) {
    if (entry.defaultParams.length === 0) {
      onAdd(entry);
      return;
    }
    if (expandedId === entry.id) {
      onAdd(entry, getParams(entry) as Record<string, number | boolean | string>);
      setExpandedId(null);
    } else {
      setExpandedId(entry.id);
    }
  }

  function setParam(entryId: string, key: string, value: number | string) {
    setParamValues((prev) => ({
      ...prev,
      [entryId]: { ...(prev[entryId] ?? {}), [key]: value },
    }));
  }

  return (
    <div className="flex items-center gap-1 flex-wrap" ref={dropdownRef}>
      {activeIndicators.map((ind) => (
        <button
          key={ind.id}
          type="button"
          className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono font-bold border cursor-pointer transition-colors hover:opacity-70"
          style={{
            borderColor: `${colors.accent ?? colors.positive}44`,
            backgroundColor: `${colors.accent ?? colors.positive}11`,
            color: colors.accent ?? colors.positive,
          }}
          onClick={() => onRemove(ind.id)}
          title={`Remove ${ind.name}`}
        >
          {ind.name}
          <X className="h-2.5 w-2.5" />
        </button>
      ))}

      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setIsOpen(!isOpen);
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

        {isOpen && (
          <div
            className="absolute top-full left-0 z-50 mt-1 border min-w-[240px] max-h-[400px] overflow-y-auto"
            style={{ backgroundColor: colors.surface, borderColor: colors.border }}
          >
            {/* Filter header — sticky so it stays reachable while the list scrolls */}
            <div
              className="sticky top-0 z-10 border-b px-2 py-1.5 flex flex-col gap-1"
              style={{ backgroundColor: colors.surface, borderColor: colors.border }}
            >
              <div className="flex items-center gap-1">
                <Search className="h-2.5 w-2.5 shrink-0" style={{ color: colors.textSecondary }} />
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
                  style={{ color: windowUnit === "days" ? colors.positive : colors.textSecondary }}
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
                  const isActive = activeIndicators.some((a) => a.id.startsWith(entry.id));
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
                                      setParam(entry.id, p.key, Number.parseFloat(e.target.value))
                                    }
                                    className="w-16 text-right text-[9px] font-mono px-1 py-0.5 border bg-transparent outline-none"
                                    style={{ borderColor: colors.border, color: colors.text }}
                                  />
                                )}
                              </label>
                            );
                          })}
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
          </div>
        )}
      </div>
    </div>
  );
}
