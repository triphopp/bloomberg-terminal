/**
 * Custom condition builder — the fallback path the label registry was
 * designed to hand off to (plan §2: "indicator ที่ยังไม่ประกาศ alertLabels
 * จะยังใช้ได้เต็มที่ใน custom compare mode ผ่าน outputs"). Any indicator
 * that declares `outputs` can be compared here even with zero curated
 * labels — so adding backend support for a new indicator is enough to make
 * it usable, labels are a nicety on top, not a prerequisite.
 */

import type { Comparator, Operand, RuleNode } from "@/lib/alerts/ast";
import { INDICATOR_REGISTRY } from "../chart/indicators";
import type { IndicatorRegistryEntry } from "../chart/types";
import type { AlertScope, CreateAlertRuleInput, NotifyChannel } from "../hooks/useAlertRules";

export type OperandKind = "indicator" | "price" | "const";
export type PriceField = "open" | "high" | "low" | "close" | "volume";

export interface CustomOperandDraft {
  kind: OperandKind;
  indicatorId?: string;
  outputKey?: string;
  params?: Record<string, number>;
  priceField?: PriceField;
  constValue?: number;
}

export const COMPARATOR_OPTIONS: { value: Comparator; label: string }[] = [
  { value: "gt", label: "greater than" },
  { value: "gte", label: "greater than or equal" },
  { value: "lt", label: "less than" },
  { value: "lte", label: "less than or equal" },
  { value: "eq", label: "equals" },
  { value: "neq", label: "not equals" },
  { value: "crossesAbove", label: "crosses above" },
  { value: "crossesBelow", label: "crosses below" },
  { value: "between", label: "between" },
  { value: "outside", label: "outside" },
];

export const PRICE_FIELDS: PriceField[] = ["close", "open", "high", "low", "volume"];

export const NEEDS_SECOND_VALUE = new Set<Comparator>(["between", "outside"]);

export function indicatorsWithOutputs(): IndicatorRegistryEntry[] {
  return INDICATOR_REGISTRY.filter((e) => (e.outputs?.length ?? 0) > 0);
}

export function defaultParamsFor(entry: IndicatorRegistryEntry): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of entry.defaultParams) {
    if (typeof p.default === "number") out[p.key] = p.default;
  }
  return out;
}

export function emptyOperandDraft(kind: OperandKind = "const"): CustomOperandDraft {
  if (kind === "indicator") {
    const first = indicatorsWithOutputs()[0];
    return first
      ? {
          kind,
          indicatorId: first.id,
          outputKey: first.outputs?.[0]?.key,
          params: defaultParamsFor(first),
        }
      : { kind: "const", constValue: 0 };
  }
  if (kind === "price") return { kind, priceField: "close" };
  return { kind: "const", constValue: 0 };
}

export function draftToOperand(draft: CustomOperandDraft): Operand | null {
  if (draft.kind === "const") {
    if (draft.constValue == null || Number.isNaN(draft.constValue)) return null;
    return { src: "const", value: draft.constValue };
  }
  if (draft.kind === "price") {
    if (!draft.priceField) return null;
    return { src: "price", field: draft.priceField };
  }
  if (draft.kind === "indicator") {
    if (!draft.indicatorId || !draft.outputKey) return null;
    return {
      src: "indicator",
      id: draft.indicatorId,
      output: draft.outputKey,
      params: draft.params ?? {},
    };
  }
  return null;
}

function describeOperand(draft: CustomOperandDraft): string {
  if (draft.kind === "const") return draft.constValue != null ? String(draft.constValue) : "?";
  if (draft.kind === "price") return draft.priceField ?? "price";
  const entry = INDICATOR_REGISTRY.find((e) => e.id === draft.indicatorId);
  const params = Object.values(draft.params ?? {});
  return `${entry?.name ?? draft.indicatorId}${params.length ? `(${params.join(",")})` : ""}`;
}

export interface BuildCustomRuleResult {
  rule: CreateAlertRuleInput | null;
  error: string | null;
}

export interface NotifyOptions {
  channels: NotifyChannel[];
  webhookUrl: string;
}

export const DEFAULT_NOTIFY_OPTIONS: NotifyOptions = { channels: ["ticker"], webhookUrl: "" };

/** Builds a single-predicate rule from raw operand drafts — no AND/OR/within
 * (that's the eventual full RuleBuilder's job, plan §9 phase 4b). */
export function buildCustomRule(
  left: CustomOperandDraft,
  cmp: Comparator,
  right: CustomOperandDraft,
  right2: CustomOperandDraft | null,
  symbols: string[],
  notifyOptions: NotifyOptions = DEFAULT_NOTIFY_OPTIONS
): BuildCustomRuleResult {
  const leftOp = draftToOperand(left);
  if (!leftOp) return { rule: null, error: "Pick the left side of the comparison" };
  const rightOp = draftToOperand(right);
  if (!rightOp) return { rule: null, error: "Pick the right side of the comparison" };

  let right2Op: Operand | undefined;
  if (NEEDS_SECOND_VALUE.has(cmp)) {
    if (!right2) return { rule: null, error: `"${cmp}" needs a second value` };
    const r2 = draftToOperand(right2);
    if (!r2) return { rule: null, error: "Pick the second value" };
    // The backend reads `between` as `right <= x <= right2`, so bounds entered
    // the wrong way round compile to a rule that can never be true. The second
    // value defaults to 0, which makes "between 40 and _" the easy mistake —
    // catch it in the builder instead of letting the save succeed silently.
    if (r2.src === "const" && rightOp.src === "const" && rightOp.value >= r2.value) {
      return {
        rule: null,
        error: `Lower bound (${rightOp.value}) must be less than upper bound (${r2.value})`,
      };
    }
    right2Op = r2;
  }

  const node: RuleNode = {
    op: "cmp",
    left: leftOp,
    cmp,
    right: rightOp,
    ...(right2Op ? { right2: right2Op } : {}),
  };

  const cmpLabel = COMPARATOR_OPTIONS.find((c) => c.value === cmp)?.label ?? cmp;
  const desc = `${describeOperand(left)} ${cmpLabel} ${describeOperand(right)}${
    right2 ? ` and ${describeOperand(right2)}` : ""
  }`;
  const scope: AlertScope = { type: "symbols", symbols };
  const name = `${symbols.length === 1 ? symbols[0] : `${symbols.length} symbols`} · ${desc}`;

  const channels: NotifyChannel[] = notifyOptions.channels.length
    ? notifyOptions.channels
    : ["ticker"];
  if (channels.includes("webhook") && !notifyOptions.webhookUrl.trim()) {
    return { rule: null, error: "Webhook is on but no URL is set" };
  }

  return {
    rule: {
      name,
      scope,
      expr: node,
      timeframe: "1d",
      trigger: "edge",
      cooldown_bars: 1,
      notify: channels,
      webhook_url: channels.includes("webhook") ? notifyOptions.webhookUrl.trim() : null,
    },
    error: null,
  };
}
