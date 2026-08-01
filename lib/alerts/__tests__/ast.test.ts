import assert from "node:assert/strict";
import { test } from "node:test";

import { AstValidationError, type RuleNode, nodeKey, operandKey, validateNode } from "../ast.ts";

// ── validateNode: valid shapes ──────────────────────────────────────────────

test("validateNode accepts a plain cmp predicate", () => {
  const node: RuleNode = {
    op: "cmp",
    left: { src: "indicator", id: "rsi", params: { period: 14 }, output: "rsi" },
    cmp: "lte",
    right: { src: "const", value: 30 },
  };
  assert.doesNotThrow(() => validateNode(node));
});

test("validateNode accepts and/or/not/within/sustained nesting", () => {
  const node: RuleNode = {
    op: "and",
    children: [
      {
        op: "not",
        child: {
          op: "cmp",
          left: { src: "price", field: "close" },
          cmp: "gt",
          right: { src: "const", value: 0 },
        },
      },
      {
        op: "within",
        bars: 3,
        child: {
          op: "cmp",
          left: { src: "indicator", id: "macd", params: {}, output: "hist" },
          cmp: "crossesAbove",
          right: { src: "const", value: 0 },
        },
      },
      {
        op: "or",
        children: [
          {
            op: "cmp",
            left: { src: "price", field: "close" },
            cmp: "gte",
            right: { src: "const", value: 100 },
          },
          {
            op: "sustained",
            bars: 5,
            child: {
              op: "cmp",
              left: { src: "price", field: "volume" },
              cmp: "gt",
              right: { src: "const", value: 0 },
            },
          },
        ],
      },
    ],
  };
  assert.doesNotThrow(() => validateNode(node));
});

test("validateNode accepts between/outside with right2", () => {
  const node: RuleNode = {
    op: "cmp",
    left: { src: "price", field: "close" },
    cmp: "between",
    right: { src: "const", value: 10 },
    right2: { src: "const", value: 20 },
  };
  assert.doesNotThrow(() => validateNode(node));
});

test("validateNode accepts pctRank operands", () => {
  const node: RuleNode = {
    op: "cmp",
    left: {
      src: "pctRank",
      of: { src: "indicator", id: "bb-width", params: { period: 20, stdDev: 2 }, output: "width" },
      window: 120,
    },
    cmp: "lt",
    right: { src: "const", value: 0.1 },
  };
  assert.doesNotThrow(() => validateNode(node));
});

// ── validateNode: structural errors ─────────────────────────────────────────

test("validateNode rejects empty and/or children", () => {
  assert.throws(
    () => validateNode({ op: "and", children: [] } as unknown as RuleNode),
    AstValidationError
  );
  assert.throws(
    () => validateNode({ op: "or", children: [] } as unknown as RuleNode),
    AstValidationError
  );
});

test("validateNode rejects unknown node op", () => {
  assert.throws(() => validateNode({ op: "xor" } as unknown as RuleNode), AstValidationError);
});

test("validateNode rejects unknown comparator", () => {
  const node = {
    op: "cmp",
    left: { src: "const", value: 1 },
    cmp: "wat",
    right: { src: "const", value: 2 },
  } as unknown as RuleNode;
  assert.throws(() => validateNode(node), AstValidationError);
});

test("validateNode requires right2 for between/outside", () => {
  const node: RuleNode = {
    op: "cmp",
    left: { src: "const", value: 1 },
    cmp: "between",
    right: { src: "const", value: 2 },
  };
  assert.throws(() => validateNode(node), AstValidationError);
});

test("validateNode rejects right2 on a non-range comparator", () => {
  const node: RuleNode = {
    op: "cmp",
    left: { src: "const", value: 1 },
    cmp: "lt",
    right: { src: "const", value: 2 },
    right2: { src: "const", value: 3 },
  };
  assert.throws(() => validateNode(node), AstValidationError);
});

test("validateNode rejects non-positive within/sustained bars", () => {
  const bad: RuleNode = {
    op: "within",
    bars: 0,
    child: {
      op: "cmp",
      left: { src: "const", value: 1 },
      cmp: "gt",
      right: { src: "const", value: 0 },
    },
  };
  assert.throws(() => validateNode(bad), AstValidationError);
});

test("validateNode rejects negative offset", () => {
  const node: RuleNode = {
    op: "cmp",
    left: { src: "price", field: "close", offset: -1 },
    cmp: "gt",
    right: { src: "const", value: 0 },
  };
  assert.throws(() => validateNode(node), AstValidationError);
});

test("validateNode rejects invalid price field", () => {
  const node = {
    op: "cmp",
    left: { src: "price", field: "wat" },
    cmp: "gt",
    right: { src: "const", value: 0 },
  } as unknown as RuleNode;
  assert.throws(() => validateNode(node), AstValidationError);
});

test("validateNode rejects indicator operand missing id/output", () => {
  const missingId = {
    op: "cmp",
    left: { src: "indicator", params: {}, output: "rsi" },
    cmp: "gt",
    right: { src: "const", value: 0 },
  } as unknown as RuleNode;
  assert.throws(() => validateNode(missingId), AstValidationError);
});

test("validateNode rejects pctRank window below 2", () => {
  const node: RuleNode = {
    op: "cmp",
    left: { src: "pctRank", of: { src: "const", value: 1 }, window: 1 },
    cmp: "lt",
    right: { src: "const", value: 0.5 },
  };
  assert.throws(() => validateNode(node), AstValidationError);
});

// ── operandKey / nodeKey ─────────────────────────────────────────────────────

test("operandKey is stable regardless of params key order", () => {
  const a = operandKey({
    src: "indicator",
    id: "macd",
    params: { fast: 12, slow: 26 },
    output: "hist",
  });
  const b = operandKey({
    src: "indicator",
    id: "macd",
    params: { slow: 26, fast: 12 },
    output: "hist",
  });
  assert.equal(a, b);
});

test("operandKey distinguishes different offsets", () => {
  const a = operandKey({ src: "price", field: "close", offset: 0 });
  const b = operandKey({ src: "price", field: "close", offset: 1 });
  assert.notEqual(a, b);
});

test("nodeKey is order-independent for and/or children", () => {
  const a: RuleNode = {
    op: "and",
    children: [
      {
        op: "cmp",
        left: { src: "price", field: "close" },
        cmp: "gt",
        right: { src: "const", value: 1 },
      },
      {
        op: "cmp",
        left: { src: "price", field: "volume" },
        cmp: "gt",
        right: { src: "const", value: 2 },
      },
    ],
  };
  const b: RuleNode = {
    op: "and",
    children: [
      {
        op: "cmp",
        left: { src: "price", field: "volume" },
        cmp: "gt",
        right: { src: "const", value: 2 },
      },
      {
        op: "cmp",
        left: { src: "price", field: "close" },
        cmp: "gt",
        right: { src: "const", value: 1 },
      },
    ],
  };
  assert.equal(nodeKey(a), nodeKey(b));
});

test("nodeKey distinguishes structurally different predicates", () => {
  const a: RuleNode = {
    op: "cmp",
    left: { src: "const", value: 1 },
    cmp: "gt",
    right: { src: "const", value: 0 },
  };
  const b: RuleNode = {
    op: "cmp",
    left: { src: "const", value: 1 },
    cmp: "gte",
    right: { src: "const", value: 0 },
  };
  assert.notEqual(nodeKey(a), nodeKey(b));
});
