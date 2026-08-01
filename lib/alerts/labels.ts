/**
 * AlertLabel — a named predicate template attached to an indicator's chart
 * registry entry. Label ISN'T a separate system: `build()` expands straight
 * into a RuleNode, so a rule mixing labels and hand-built compares still
 * has exactly one AST, one evaluator, one storage format (plan §0).
 *
 * Intentionally has zero dependency on components/bloomberg/chart/* — the
 * chart registry imports FROM here, never the reverse, so the graph stays a
 * DAG (chart/types.ts -> lib/alerts/labels.ts -> lib/alerts/{ast,concepts,calibrate}.ts).
 *
 * See memory/plans/alert-rule-engine.md §2, §8.5.
 */

import type { RuleNode } from "./ast.ts";
import { type Calibration, DEFAULT_ADAPTIVE_WINDOW, type LabelBuildCtx } from "./calibrate.ts";
import type { LabelKey } from "./concepts.ts";

/** A numeric param a label exposes for tuning (almost always a threshold). */
export interface LabelParam {
  key: string;
  label: string;
  type: "number";
  default: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface AlertLabel {
  concept: LabelKey;
  /** Calibration modes this label supports — first is the default. */
  calibrations: Calibration["mode"][];
  params?: LabelParam[];
  build: (ctx: LabelBuildCtx) => RuleNode;
}

/** A value an indicator exposes that can be used as an alert Operand. */
export interface IndicatorOutput {
  /** Matches Operand.output for an IndicatorOperand referencing this indicator. */
  key: string;
  label: string;
  /** Natural value range — the rule builder uses this for slider min/max. */
  range?: [number, number];
  /** True = not comparable across symbols (price, volume) — the builder
   *  should nudge toward pctRank instead of an absolute threshold. */
  unbounded?: boolean;
}

/** Resolve a label's declared calibrations against a requested mode,
 * falling back to the label's own default (its first declared mode) if the
 * request isn't supported — e.g. asking a compression-only label for "static". */
export function resolveCalibration(label: AlertLabel, requested?: Calibration): Calibration {
  if (requested && label.calibrations.includes(requested.mode)) return requested;
  const fallbackMode = label.calibrations[0] ?? "static";
  if (fallbackMode === "adaptive") return { mode: "adaptive", window: DEFAULT_ADAPTIVE_WINDOW };
  return { mode: fallbackMode };
}

/** Default numeric value for each of a label's params, keyed by param key. */
export function defaultLabelParams(label: AlertLabel): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of label.params ?? []) out[p.key] = p.default;
  return out;
}
