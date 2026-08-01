/**
 * Quick alert — one-click rule creation from a label, no modal (plan §9.5).
 *
 * Two sources feed the menu:
 *   1. Whatever indicators are active on the chart right now (chartIndicatorSpecsAtom)
 *      — guesses right most of the time, since the user is already looking at them.
 *   2. A fixed "commonly used" shortlist, independent of chart state.
 *
 * Both funnel through the same buildRuleFromLabel() -> the same AST the
 * (future) full rule builder modal will produce — no second code path.
 */

import type { RuleNode } from "@/lib/alerts/ast";
import type { Calibration } from "@/lib/alerts/calibrate";
import { CONCEPT_META } from "@/lib/alerts/concepts";
import { type AlertLabel, defaultLabelParams, resolveCalibration } from "@/lib/alerts/labels";
import type { IndicatorSpec } from "../atoms";
import { INDICATOR_REGISTRY, getIndicatorEntry } from "../chart/indicators";
import type { IndicatorRegistryEntry } from "../chart/types";
import type { AlertScope, CreateAlertRuleInput } from "../hooks/useAlertRules";
import type { WatchlistSignal } from "../hooks/useWatchlistSignals";

export interface QuickAlertItem {
  key: string;
  entry: IndicatorRegistryEntry;
  label: AlertLabel;
  indParams: Record<string, number>;
  /** Human label shown in the menu, e.g. "RSI(14) Oversold". */
  title: string;
  /** "ตอนนี้ 41.2" equivalent — omitted when no live reading is available for this indicator. */
  currentValue: string | null;
}

function conceptTitle(concept: AlertLabel["concept"]): string {
  if (concept.startsWith("x:")) return concept.slice(2);
  return CONCEPT_META[concept as keyof typeof CONCEPT_META]?.name ?? concept;
}

function paramSuffix(entry: IndicatorRegistryEntry, indParams: Record<string, number>): string {
  const parts = (entry.defaultParams ?? [])
    .filter((p) => p.type === "number" && p.key in indParams)
    .map((p) => indParams[p.key]);
  return parts.length ? `(${parts.join(",")})` : "";
}

function currentValueFor(entryId: string, sig: WatchlistSignal | undefined): string | null {
  if (!sig) return null;
  switch (entryId) {
    case "rsi":
      return sig.rsi.value != null ? sig.rsi.value.toFixed(1) : null;
    case "macd":
      return sig.macd.hist != null ? sig.macd.hist.toFixed(3) : null;
    case "rvol":
      return sig.rvol != null ? `${sig.rvol.toFixed(2)}x` : null;
    default:
      return null; // EMA/Bollinger have no single "current value" in the watchlist scan
  }
}

function toQuickAlertItem(
  entry: IndicatorRegistryEntry,
  label: AlertLabel,
  indParams: Record<string, number>,
  sig: WatchlistSignal | undefined
): QuickAlertItem {
  const value = currentValueFor(entry.id, sig);
  return {
    key: `${entry.id}:${JSON.stringify(indParams)}:${label.concept}`,
    entry,
    label,
    indParams,
    title: `${entry.name}${paramSuffix(entry, indParams)} ${conceptTitle(label.concept)}`,
    currentValue: value ? `now ${value}` : null,
  };
}

/** Cap per active indicator, not on the flattened total — otherwise one
 * indicator with many labels (EMA has 6) starves every other active
 * indicator's labels out of a length-capped list downstream (AlertBellCell). */
const LABELS_PER_INDICATOR = 3;

/** Labels of every currently-active chart indicator that has any — the most
 * useful few per indicator (each *_LABELS array is ordered most- to
 * least-common), not the exhaustive set. */
export function itemsFromActiveIndicators(
  specs: IndicatorSpec[],
  signal: WatchlistSignal | undefined
): QuickAlertItem[] {
  const items: QuickAlertItem[] = [];
  for (const spec of specs) {
    const entry = getIndicatorEntry(spec.id);
    if (!entry?.alertLabels?.length) continue;
    const indParams: Record<string, number> = {};
    for (const p of entry.defaultParams) {
      const v = spec.params?.[p.key] ?? p.default;
      if (typeof v === "number") indParams[p.key] = v;
    }
    for (const label of entry.alertLabels.slice(0, LABELS_PER_INDICATOR)) {
      items.push(toQuickAlertItem(entry, label, indParams, signal));
    }
  }
  return items;
}

/** A fixed, chart-independent shortlist (plan §9.5's "ใช้บ่อย" group). */
export function commonQuickAlertItems(signal: WatchlistSignal | undefined): QuickAlertItem[] {
  const rvol = INDICATOR_REGISTRY.find((e) => e.id === "rvol");
  const macd = INDICATOR_REGISTRY.find((e) => e.id === "macd");
  const ema = INDICATOR_REGISTRY.find((e) => e.id === "ema");
  const items: QuickAlertItem[] = [];
  if (rvol) {
    const spike = rvol.alertLabels?.find((l) => l.concept === "spike");
    if (spike) items.push(toQuickAlertItem(rvol, spike, { lookback: 20 }, signal));
  }
  if (macd) {
    const bullCross = macd.alertLabels?.find((l) => l.concept === "bullCross");
    if (bullCross)
      items.push(toQuickAlertItem(macd, bullCross, { fast: 12, slow: 26, signal: 9 }, signal));
  }
  if (ema) {
    const bullCross = ema.alertLabels?.find((l) => l.concept === "bullCross");
    if (bullCross) items.push(toQuickAlertItem(ema, bullCross, { period: 200 }, signal));
  }
  return items;
}

/**
 * Every label of every indicator that has any, at that indicator's registry
 * defaults — the full searchable catalog behind the filter box (AlertPickerDialog).
 * Unlike itemsFromActiveIndicators/commonQuickAlertItems this is NOT capped —
 * a search box makes scale a non-issue, so nothing needs curating out here.
 */
export function allQuickAlertItems(signal: WatchlistSignal | undefined): QuickAlertItem[] {
  const items: QuickAlertItem[] = [];
  for (const entry of INDICATOR_REGISTRY) {
    if (!entry.alertLabels?.length) continue;
    const indParams: Record<string, number> = {};
    for (const p of entry.defaultParams) {
      if (typeof p.default === "number") indParams[p.key] = p.default;
    }
    for (const label of entry.alertLabels) {
      items.push(toQuickAlertItem(entry, label, indParams, signal));
    }
  }
  return items;
}

/** Turns a chosen quick-alert item into the exact body /api/alerts/rules expects. */
export function buildRuleFromLabel(
  item: QuickAlertItem,
  symbols: string[],
  calibration?: Calibration
): CreateAlertRuleInput {
  const resolvedCalibration = resolveCalibration(item.label, calibration);
  const labelParams = defaultLabelParams(item.label);
  const node: RuleNode = item.label.build({
    indParams: item.indParams,
    labelParams,
    calibration: resolvedCalibration,
  });

  // Attach provenance so a future rule-list/modal can render this as a label
  // chip instead of the raw compare (plan §8.5.5). defVersion is a
  // placeholder until the label-prefs/versioning system (§8.5.3) exists.
  if (node.op === "cmp") {
    node.origin = {
      kind: "label",
      indicator: item.entry.id,
      concept: item.label.concept,
      calibration:
        resolvedCalibration.mode === "adaptive"
          ? { mode: "adaptive", window: resolvedCalibration.window }
          : { mode: resolvedCalibration.mode },
      labelParams,
      defVersion: 1,
    };
  }

  const scope: AlertScope = { type: "symbols", symbols };
  const name = `${symbols.length === 1 ? symbols[0] : `${symbols.length} symbols`} · ${item.title}`;

  return {
    name,
    scope,
    expr: node,
    timeframe: "1d",
    trigger: "edge",
    cooldown_bars: 1,
    notify: ["ticker"],
  };
}
