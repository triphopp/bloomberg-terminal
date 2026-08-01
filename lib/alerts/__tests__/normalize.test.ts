import assert from "node:assert/strict";
import { test } from "node:test";

import type { Predicate, RuleNode } from "../ast.ts";
import { dedupe, flatten, normalize, toNNF } from "../normalize.ts";

function cmp(left: number, comparator: Predicate["cmp"], right: number): Predicate {
  return {
    op: "cmp",
    left: { src: "const", value: left },
    cmp: comparator,
    right: { src: "const", value: right },
  };
}

function rsiLte(value: number): Predicate {
  return {
    op: "cmp",
    left: { src: "indicator", id: "rsi", params: { period: 14 }, output: "rsi" },
    cmp: "lte",
    right: { src: "const", value },
  };
}

function rsiGte(value: number): Predicate {
  return {
    op: "cmp",
    left: { src: "indicator", id: "rsi", params: { period: 14 }, output: "rsi" },
    cmp: "gte",
    right: { src: "const", value },
  };
}

// ── toNNF ────────────────────────────────────────────────────────────────────

test("toNNF flips comparators via De Morgan for lt/gte/lte/gt/eq/neq", () => {
  const pairs: [Predicate["cmp"], Predicate["cmp"]][] = [
    ["lt", "gte"],
    ["gte", "lt"],
    ["lte", "gt"],
    ["gt", "lte"],
    ["eq", "neq"],
    ["neq", "eq"],
    ["between", "outside"],
  ];
  for (const [from, to] of pairs) {
    const node: RuleNode =
      from === "between"
        ? {
            op: "not",
            child: {
              op: "cmp",
              left: { src: "const", value: 1 },
              cmp: from,
              right: { src: "const", value: 2 },
              right2: { src: "const", value: 3 },
            },
          }
        : { op: "not", child: cmp(1, from, 2) };
    const result = toNNF(node) as Predicate;
    assert.equal(result.op, "cmp");
    assert.equal(result.cmp, to);
  }
});

test("toNNF pushes NOT through AND via De Morgan", () => {
  const node: RuleNode = {
    op: "not",
    child: { op: "and", children: [cmp(1, "gt", 0), cmp(2, "lt", 5)] },
  };
  const result = toNNF(node);
  assert.equal(result.op, "or");
  assert.equal(result.children.length, 2);
  assert.equal((result.children[0] as Predicate).cmp, "lte"); // NOT(gt) -> lte
  assert.equal((result.children[1] as Predicate).cmp, "gte"); // NOT(lt) -> gte
});

test("toNNF pushes NOT through OR via De Morgan", () => {
  const node: RuleNode = {
    op: "not",
    child: { op: "or", children: [cmp(1, "eq", 0), cmp(2, "neq", 5)] },
  };
  const result = toNNF(node);
  assert.equal(result.op, "and");
  assert.equal((result.children[0] as Predicate).cmp, "neq");
  assert.equal((result.children[1] as Predicate).cmp, "eq");
});

test("toNNF eliminates double negation", () => {
  const node: RuleNode = { op: "not", child: { op: "not", child: cmp(1, "gt", 0) } };
  const result = toNNF(node) as Predicate;
  assert.equal(result.op, "cmp");
  assert.equal(result.cmp, "gt");
});

test("toNNF leaves NOT(crossesAbove) wrapped — no complement comparator exists", () => {
  const node: RuleNode = {
    op: "not",
    child: {
      op: "cmp",
      left: { src: "const", value: 1 },
      cmp: "crossesAbove",
      right: { src: "const", value: 2 },
    },
  };
  const result = toNNF(node);
  assert.equal(result.op, "not");
});

test("toNNF leaves NOT(within/sustained) wrapped, but normalizes inside the child", () => {
  const node: RuleNode = {
    op: "not",
    child: { op: "within", bars: 3, child: { op: "not", child: cmp(1, "gt", 0) } },
  };
  const result = toNNF(node);
  assert.equal(result.op, "not");
  assert.equal(result.child.op, "within");
  const inner = (result.child as { child: RuleNode }).child as Predicate;
  assert.equal(inner.cmp, "lte"); // the nested NOT(gt) was still pushed to lte
});

// ── flatten ──────────────────────────────────────────────────────────────────

test("flatten merges nested AND-under-AND into one group", () => {
  const node: RuleNode = {
    op: "and",
    children: [{ op: "and", children: [cmp(1, "gt", 0), cmp(2, "gt", 0)] }, cmp(3, "gt", 0)],
  };
  const result = flatten(node);
  assert.equal(result.op, "and");
  assert.equal(result.children.length, 3);
});

test("flatten does not merge AND-under-OR", () => {
  const node: RuleNode = {
    op: "or",
    children: [{ op: "and", children: [cmp(1, "gt", 0), cmp(2, "gt", 0)] }],
  };
  const result = flatten(node);
  assert.equal(result.op, "or");
  assert.equal(result.children.length, 1);
  assert.equal(result.children[0].op, "and");
});

// ── dedupe ───────────────────────────────────────────────────────────────────

test("dedupe drops duplicate predicates regardless of indicator param key order", () => {
  const a: Predicate = {
    op: "cmp",
    left: { src: "indicator", id: "macd", params: { fast: 12, slow: 26 }, output: "hist" },
    cmp: "gt",
    right: { src: "const", value: 0 },
  };
  const b: Predicate = {
    op: "cmp",
    left: { src: "indicator", id: "macd", params: { slow: 26, fast: 12 }, output: "hist" },
    cmp: "gt",
    right: { src: "const", value: 0 },
  };
  const node: RuleNode = { op: "and", children: [a, b] };
  const result = dedupe(node);
  assert.equal(result.op, "and");
  assert.equal(result.children.length, 1);
});

// ── normalize: interval analysis ────────────────────────────────────────────

test("normalize flags a contradiction: RSI <= 30 AND RSI >= 70", () => {
  const node: RuleNode = { op: "and", children: [rsiLte(30), rsiGte(70)] };
  const { warnings } = normalize(node);
  assert.equal(
    warnings.some((w) => w.kind === "contradiction"),
    true
  );
});

test("normalize flags redundancy: RSI <= 30 AND RSI <= 50", () => {
  const node: RuleNode = { op: "and", children: [rsiLte(30), rsiLte(50)] };
  const { warnings } = normalize(node);
  assert.equal(
    warnings.some((w) => w.kind === "redundant"),
    true
  );
});

test("normalize has no warnings for two independent operands", () => {
  const rvolSpike: Predicate = {
    op: "cmp",
    left: { src: "indicator", id: "rvol", params: { lookback: 20 }, output: "rvol" },
    cmp: "gte",
    right: { src: "const", value: 2 },
  };
  const node: RuleNode = { op: "and", children: [rsiLte(30), rvolSpike] };
  const { warnings } = normalize(node);
  assert.deepEqual(warnings, []);
});

test("normalize does not cross-contaminate OR branches", () => {
  // RSI<=30 AND (RSI>=70 OR RVOL>=2) — the contradiction only exists inside the OR's
  // own AND-less branch, not across the top-level AND, so this must NOT be flagged.
  const rvolSpike: Predicate = {
    op: "cmp",
    left: { src: "indicator", id: "rvol", params: { lookback: 20 }, output: "rvol" },
    cmp: "gte",
    right: { src: "const", value: 2 },
  };
  const node: RuleNode = {
    op: "and",
    children: [rsiLte(30), { op: "or", children: [rsiGte(70), rvolSpike] }],
  };
  const { warnings } = normalize(node);
  assert.equal(
    warnings.some((w) => w.kind === "contradiction"),
    false
  );
});

test("normalize throws on a structurally invalid AST before doing anything else", () => {
  const bad = { op: "and", children: [] } as unknown as RuleNode;
  assert.throws(() => normalize(bad));
});

test("normalize output is idempotent (normalize(normalize(x).node) has no new warnings)", () => {
  const node: RuleNode = { op: "and", children: [rsiLte(30), rsiLte(50)] };
  const once = normalize(node);
  const twice = normalize(once.node);
  assert.deepEqual(once.warnings, twice.warnings);
});
