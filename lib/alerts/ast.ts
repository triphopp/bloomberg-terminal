/**
 * Alert Rule Engine — AST types + structural validation.
 *
 * Mirrors backend/alerts/ast.py field-for-field: a rule's `expr` crosses the
 * wire as plain JSON (stored as expr_json, sent from the modal as-is), so
 * both sides parse/serialize the exact same shape.
 *
 * See memory/plans/alert-rule-engine.md §1.
 */

export type RuleNode = AndNode | OrNode | NotNode | WithinNode | SustainedNode | Predicate;

export interface AndNode {
  op: "and";
  children: RuleNode[];
}

export interface OrNode {
  op: "or";
  children: RuleNode[];
}

export interface NotNode {
  op: "not";
  child: RuleNode;
}

/** True if `child` was true at least once in the trailing `bars` bars (inclusive of now). */
export interface WithinNode {
  op: "within";
  bars: number;
  child: RuleNode;
}

/** True if `child` has been true for every bar in the trailing `bars` bars. */
export interface SustainedNode {
  op: "sustained";
  bars: number;
  child: RuleNode;
}

export interface Predicate {
  op: "cmp";
  left: Operand;
  cmp: Comparator;
  right: Operand;
  /** Second bound — required for "between" / "outside", disallowed otherwise. */
  right2?: Operand;
  /** Where this predicate came from — lets the UI render a label chip instead of the raw compare. */
  origin?: PredicateOrigin;
}

export interface PredicateOrigin {
  kind: "label";
  indicator: string;
  concept: string;
  calibration: { mode: "static" | "adaptive" | "regime"; window?: number };
  labelParams: Record<string, number>;
  /** Version of the label definition at save time — frozen; see plan §8.5.5. */
  defVersion: number;
}

export type Comparator =
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "eq"
  | "neq"
  | "crossesAbove"
  | "crossesBelow"
  | "between"
  | "outside";

export type Operand = IndicatorOperand | PriceOperand | ConstOperand | PctRankOperand;

export interface IndicatorOperand {
  src: "indicator";
  id: string;
  params: Record<string, number | string | boolean>;
  output: string;
  /** Bars to look back. 0 = current bar. */
  offset?: number;
}

export interface PriceOperand {
  src: "price";
  field: "open" | "high" | "low" | "close" | "volume";
  offset?: number;
}

export interface ConstOperand {
  src: "const";
  value: number;
}

export interface PctRankOperand {
  src: "pctRank";
  of: Operand;
  window: number;
}

const COMPARATORS = new Set<Comparator>([
  "lt",
  "lte",
  "gt",
  "gte",
  "eq",
  "neq",
  "crossesAbove",
  "crossesBelow",
  "between",
  "outside",
]);

const RANGE_COMPARATORS = new Set<Comparator>(["between", "outside"]);
const PRICE_FIELDS = new Set(["open", "high", "low", "close", "volume"]);

export class AstValidationError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${path}: ${message}`);
    this.name = "AstValidationError";
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new AstValidationError(message, path);
}

/** Throws AstValidationError on any structural problem. Safe to call before save or before eval. */
export function validateNode(node: RuleNode, path = "$"): void {
  if (node == null || typeof node !== "object") fail(path, "node must be an object");

  switch (node.op) {
    case "and":
    case "or":
      if (!Array.isArray(node.children) || node.children.length === 0)
        fail(path, `${node.op} requires at least 1 child`);
      node.children.forEach((c, i) => validateNode(c, `${path}.children[${i}]`));
      return;
    case "not":
      if (!node.child) fail(path, "not requires a child");
      validateNode(node.child, `${path}.child`);
      return;
    case "within":
    case "sustained":
      if (!Number.isInteger(node.bars) || node.bars < 1)
        fail(path, `${node.op}.bars must be a positive integer`);
      if (!node.child) fail(path, `${node.op} requires a child`);
      validateNode(node.child, `${path}.child`);
      return;
    case "cmp":
      if (!COMPARATORS.has(node.cmp)) fail(path, `unknown comparator "${node.cmp}"`);
      validateOperand(node.left, `${path}.left`);
      validateOperand(node.right, `${path}.right`);
      if (RANGE_COMPARATORS.has(node.cmp)) {
        if (!node.right2) fail(path, `${node.cmp} requires right2`);
        else validateOperand(node.right2, `${path}.right2`);
      } else if (node.right2) {
        fail(path, `right2 is only valid for between/outside, not ${node.cmp}`);
      }
      return;
    default:
      fail(path, `unknown node op "${(node as { op?: unknown }).op}"`);
  }
}

function validateOperand(op: Operand, path: string): void {
  if (op == null || typeof op !== "object") fail(path, "operand must be an object");

  if ((op.src === "indicator" || op.src === "price") && op.offset !== undefined) {
    if (!Number.isInteger(op.offset) || op.offset < 0)
      fail(path, "offset must be a non-negative integer");
  }

  switch (op.src) {
    case "indicator":
      if (!op.id) fail(path, "indicator operand requires id");
      if (!op.output) fail(path, "indicator operand requires output");
      return;
    case "price":
      if (!PRICE_FIELDS.has(op.field)) fail(path, `invalid price field "${op.field}"`);
      return;
    case "const":
      if (typeof op.value !== "number" || Number.isNaN(op.value))
        fail(path, "const operand requires a numeric value");
      return;
    case "pctRank":
      if (!Number.isInteger(op.window) || op.window < 2)
        fail(path, "pctRank.window must be an integer >= 2");
      validateOperand(op.of, `${path}.of`);
      return;
    default:
      fail(path, `unknown operand src "${(op as { src?: unknown }).src}"`);
  }
}

/**
 * Deterministic string key for an operand — equal operands (any object key
 * order) produce equal keys. Used for dedup, operand memoization (plan §6),
 * and interval-analysis grouping (plan §4).
 */
export function operandKey(op: Operand): string {
  switch (op.src) {
    case "const":
      return `const:${op.value}`;
    case "price":
      return `price:${op.field}:${op.offset ?? 0}`;
    case "indicator": {
      const params = Object.keys(op.params)
        .sort()
        .map((k) => `${k}=${op.params[k]}`)
        .join(",");
      return `ind:${op.id}:${params}:${op.output}:${op.offset ?? 0}`;
    }
    case "pctRank":
      return `pctRank:${operandKey(op.of)}:${op.window}`;
  }
}

/** Deterministic string key for a whole node — order-independent for and/or children. */
export function nodeKey(node: RuleNode): string {
  switch (node.op) {
    case "and":
    case "or":
      return `${node.op}(${node.children.map(nodeKey).sort().join(",")})`;
    case "not":
      return `not(${nodeKey(node.child)})`;
    case "within":
    case "sustained":
      return `${node.op}(${node.bars},${nodeKey(node.child)})`;
    case "cmp": {
      const parts = [operandKey(node.left), node.cmp, operandKey(node.right)];
      if (node.right2) parts.push(operandKey(node.right2));
      return `cmp(${parts.join(",")})`;
    }
  }
}
