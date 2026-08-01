/**
 * NNF → flatten → dedup, plus interval-analysis warnings — the "value" layer
 * of boolean algebra (plan §4). Runs client-side for instant feedback in the
 * rule builder; the backend re-runs the same checks before persisting
 * (it's the source of truth, this is just fast UI feedback).
 *
 * Interval analysis here is self-contained: it only catches contradictions
 * and redundancy that don't need external domain knowledge. A true tautology
 * check (e.g. "RSI > 0 always fires") needs an indicator's natural range,
 * which lives in IndicatorOutput.range in the chart registry (plan §8.5.1) —
 * that gets wired in when labels land in phase 3, not here.
 */

import {
  type Comparator,
  type ConstOperand,
  type Predicate,
  type RuleNode,
  nodeKey,
  operandKey,
  validateNode,
} from "./ast.ts";

export type NormalizeWarning =
  | { kind: "contradiction"; operandKey: string; detail: string }
  | { kind: "redundant"; operandKey: string; detail: string };

export interface NormalizeResult {
  node: RuleNode;
  warnings: NormalizeWarning[];
}

const NEGATED_COMPARATOR: Partial<Record<Comparator, Comparator>> = {
  lt: "gte",
  gte: "lt",
  lte: "gt",
  gt: "lte",
  eq: "neq",
  neq: "eq",
  between: "outside",
  outside: "between",
};

/**
 * Push NOT down to the leaves via De Morgan. crossesAbove/crossesBelow have
 * no complement comparator, so NOT wraps them unchanged — "did not cross
 * above" isn't itself a single comparator, and that's correct, not a gap.
 * Same for NOT(within)/NOT(sustained): "did not happen within/throughout the
 * window" is already the tightest expression (plan §1 design note).
 */
export function toNNF(node: RuleNode): RuleNode {
  if (node.op === "not") {
    const child = node.child;
    if (child.op === "and") {
      return { op: "or", children: child.children.map((c) => toNNF({ op: "not", child: c })) };
    }
    if (child.op === "or") {
      return { op: "and", children: child.children.map((c) => toNNF({ op: "not", child: c })) };
    }
    if (child.op === "not") {
      return toNNF(child.child);
    }
    if (child.op === "cmp") {
      const negated = NEGATED_COMPARATOR[child.cmp];
      if (!negated) return { op: "not", child: toNNF(child) };
      return { ...child, cmp: negated };
    }
    // within / sustained
    return { op: "not", child: toNNF(child) };
  }

  if (node.op === "and" || node.op === "or") {
    return { op: node.op, children: node.children.map(toNNF) };
  }
  if (node.op === "within" || node.op === "sustained") {
    return { ...node, child: toNNF(node.child) };
  }
  return node; // cmp
}

/** Merge nested AND-under-AND / OR-under-OR into a single flat group. */
export function flatten(node: RuleNode): RuleNode {
  if (node.op === "and" || node.op === "or") {
    const children: RuleNode[] = [];
    for (const raw of node.children) {
      const c = flatten(raw);
      if (c.op === node.op) children.push(...c.children);
      else children.push(c);
    }
    return { op: node.op, children };
  }
  if (node.op === "not") return { ...node, child: flatten(node.child) };
  if (node.op === "within" || node.op === "sustained")
    return { ...node, child: flatten(node.child) };
  return node;
}

/** Drop children that are structurally identical (same canonical key) within the same AND/OR group. */
export function dedupe(node: RuleNode): RuleNode {
  if (node.op === "and" || node.op === "or") {
    const seen = new Set<string>();
    const children: RuleNode[] = [];
    for (const raw of node.children) {
      const c = dedupe(raw);
      const k = nodeKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      children.push(c);
    }
    return { op: node.op, children };
  }
  if (node.op === "not") return { ...node, child: dedupe(node.child) };
  if (node.op === "within" || node.op === "sustained")
    return { ...node, child: dedupe(node.child) };
  return node;
}

// ── Interval analysis (plan §4 item 4) ──────────────────────────────────────

interface Interval {
  lo: number;
  loOpen: boolean;
  hi: number;
  hiOpen: boolean;
}

const FULL: Interval = {
  lo: Number.NEGATIVE_INFINITY,
  loOpen: false,
  hi: Number.POSITIVE_INFINITY,
  hiOpen: false,
};

/** Only const-bound, single-convex-interval comparators are analyzable here. */
function predicateInterval(p: Predicate): Interval | null {
  if (p.right.src !== "const") return null;
  const v = (p.right as ConstOperand).value;
  switch (p.cmp) {
    case "lt":
      return { ...FULL, hi: v, hiOpen: true };
    case "lte":
      return { ...FULL, hi: v, hiOpen: false };
    case "gt":
      return { ...FULL, lo: v, loOpen: true };
    case "gte":
      return { ...FULL, lo: v, loOpen: false };
    case "eq":
      return { lo: v, loOpen: false, hi: v, hiOpen: false };
    case "between": {
      if (!p.right2 || p.right2.src !== "const") return null;
      return { lo: v, loOpen: false, hi: (p.right2 as ConstOperand).value, hiOpen: false };
    }
    default:
      // neq/outside/crossesAbove/crossesBelow aren't a single convex interval
      return null;
  }
}

function intersect(a: Interval, b: Interval): Interval {
  const lo = a.lo > b.lo ? a.lo : b.lo;
  const loOpen = a.lo === b.lo ? a.loOpen || b.loOpen : a.lo > b.lo ? a.loOpen : b.loOpen;
  const hi = a.hi < b.hi ? a.hi : b.hi;
  const hiOpen = a.hi === b.hi ? a.hiOpen || b.hiOpen : a.hi < b.hi ? a.hiOpen : b.hiOpen;
  return { lo, loOpen, hi, hiOpen };
}

function isEmpty(iv: Interval): boolean {
  if (iv.lo > iv.hi) return true;
  if (iv.lo === iv.hi && (iv.loOpen || iv.hiOpen)) return true;
  return false;
}

function sameInterval(a: Interval, b: Interval): boolean {
  return a.lo === b.lo && a.loOpen === b.loOpen && a.hi === b.hi && a.hiOpen === b.hiOpen;
}

/** Only meaningful inside a single AND group — OR branches are independent scenarios. */
function analyzeAndGroup(children: RuleNode[], warnings: NormalizeWarning[]): void {
  const byOperand = new Map<string, Interval[]>();
  for (const c of children) {
    if (c.op !== "cmp") continue;
    const iv = predicateInterval(c);
    if (!iv) continue;
    const key = operandKey(c.left);
    const list = byOperand.get(key) ?? [];
    list.push(iv);
    byOperand.set(key, list);
  }

  for (const [key, intervals] of byOperand) {
    if (intervals.length < 2) continue;
    let running = FULL;
    for (const iv of intervals) {
      const next = intersect(running, iv);
      if (isEmpty(next)) {
        warnings.push({
          kind: "contradiction",
          operandKey: key,
          detail: `conditions on ${key} can never all be true at once`,
        });
        return; // one contradiction report per group is enough
      }
      if (sameInterval(running, next)) {
        warnings.push({
          kind: "redundant",
          operandKey: key,
          detail: `a condition on ${key} is already implied by the others in this group`,
        });
      }
      running = next;
    }
  }
}

/**
 * Full pipeline: validate → NNF → flatten → dedup, plus warnings from
 * interval analysis. Run on every builder edit (debounced) and again,
 * authoritatively, on the backend before persisting.
 */
export function normalize(node: RuleNode): NormalizeResult {
  validateNode(node);

  let result = toNNF(node);
  result = flatten(result);
  result = dedupe(result);

  const warnings: NormalizeWarning[] = [];
  const walk = (n: RuleNode): void => {
    if (n.op === "and") analyzeAndGroup(n.children, warnings);
    if (n.op === "and" || n.op === "or") n.children.forEach(walk);
    if (n.op === "not" || n.op === "within" || n.op === "sustained") walk(n.child);
  };
  walk(result);

  return { node: result, warnings };
}
