import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BB_WIDTH_LABELS,
  BOLLINGER_B_LABELS,
  BOLLINGER_LABELS,
  EMA_LABELS,
  MACD_LABELS,
  RSI_LABELS,
  RVOL_LABELS,
  SMA_LABELS,
  STOCHASTIC_LABELS,
} from "../../../components/bloomberg/chart/indicators/alertLabels.ts";
import { validateNode } from "../ast.ts";
import { CONCEPT_META } from "../concepts.ts";
import { defaultLabelParams, resolveCalibration } from "../labels.ts";

const ALL_LABEL_SETS = {
  RSI: RSI_LABELS,
  MACD: MACD_LABELS,
  EMA: EMA_LABELS,
  SMA: SMA_LABELS,
  Stochastic: STOCHASTIC_LABELS,
  RVOL: RVOL_LABELS,
  Bollinger: BOLLINGER_LABELS,
  "Bollinger %B": BOLLINGER_B_LABELS,
  "BB Width": BB_WIDTH_LABELS,
};

const IND_PARAMS = {
  period: 14,
  fast: 12,
  slow: 26,
  signal: 9,
  lookback: 20,
  stdDev: 2,
  kPeriod: 14,
  dPeriod: 3,
  smooth: 3,
};

function mustFind<T extends { concept: string }>(labels: T[], concept: string): T {
  const found = labels.find((l) => l.concept === concept);
  if (!found) throw new Error(`no label with concept "${concept}"`);
  return found;
}

// ── every declared label's concept resolves to real metadata ───────────────

test("every label's concept has CONCEPT_META (unless it's an x: escape hatch)", () => {
  for (const [indicator, labels] of Object.entries(ALL_LABEL_SETS)) {
    for (const label of labels) {
      if (label.concept.startsWith("x:")) continue;
      assert.ok(
        label.concept in CONCEPT_META,
        `${indicator}'s "${label.concept}" label has no CONCEPT_META entry`
      );
    }
  }
});

// ── every label's build() produces a structurally valid, evaluable AST ─────

test("every label's build() produces a valid RuleNode for its default calibration", () => {
  for (const [indicator, labels] of Object.entries(ALL_LABEL_SETS)) {
    for (const label of labels) {
      const calibration = resolveCalibration(label);
      const node = label.build({
        indParams: IND_PARAMS,
        labelParams: defaultLabelParams(label),
        calibration,
      });
      assert.doesNotThrow(
        () => validateNode(node),
        `${indicator}'s "${label.concept}" (${calibration.mode}) produced an invalid AST`
      );
    }
  }
});

test("labels with multiple calibrations produce a valid AST under EVERY declared mode", () => {
  for (const [indicator, labels] of Object.entries(ALL_LABEL_SETS)) {
    for (const label of labels) {
      for (const mode of label.calibrations) {
        const calibration =
          mode === "adaptive" ? { mode: "adaptive" as const, window: 252 } : { mode };
        const node = label.build({
          indParams: IND_PARAMS,
          labelParams: defaultLabelParams(label),
          calibration,
        });
        assert.doesNotThrow(
          () => validateNode(node),
          `${indicator}'s "${label.concept}" under calibration "${mode}" produced an invalid AST`
        );
      }
    }
  }
});

// ── calibration resolution ──────────────────────────────────────────────────

test("resolveCalibration keeps a requested mode the label actually supports", () => {
  const label = mustFind(RSI_LABELS, "oversold");
  const resolved = resolveCalibration(label, { mode: "adaptive", window: 60 });
  assert.deepEqual(resolved, { mode: "adaptive", window: 60 });
});

test("resolveCalibration falls back to the label's first declared mode when unsupported", () => {
  const squeeze = mustFind(BB_WIDTH_LABELS, "compression");
  assert.deepEqual(squeeze.calibrations, ["adaptive"]); // no static mode makes sense for squeeze
  const resolved = resolveCalibration(squeeze, { mode: "static" });
  assert.equal(resolved.mode, "adaptive");
});

test("resolveCalibration with no request uses the label's default (first) mode", () => {
  const label = mustFind(EMA_LABELS, "priceAbove");
  assert.deepEqual(resolveCalibration(label), { mode: "static" });
});

// ── specific build() shapes, spot-checked ───────────────────────────────────

test("RSI oversold static compiles to indicator <= threshold", () => {
  const label = mustFind(RSI_LABELS, "oversold");
  const node = label.build({
    indParams: IND_PARAMS,
    labelParams: { th: 25 },
    calibration: { mode: "static" },
  });
  assert.equal(node.op, "cmp");
  if (node.op !== "cmp") throw new Error("unreachable");
  assert.equal(node.cmp, "lte");
  assert.equal(node.left.src, "indicator");
  assert.equal(node.right.src, "const");
  assert.equal((node.right as { value: number }).value, 25);
});

test("RSI oversold adaptive compiles to a pctRank compare, ignoring labelParams.th", () => {
  const label = mustFind(RSI_LABELS, "oversold");
  const node = label.build({
    indParams: IND_PARAMS,
    labelParams: { th: 999 },
    calibration: { mode: "adaptive", window: 100 },
  });
  assert.equal(node.op, "cmp");
  if (node.op !== "cmp") throw new Error("unreachable");
  assert.equal(node.left.src, "pctRank");
  if (node.left.src !== "pctRank") throw new Error("unreachable");
  assert.equal(node.left.window, 100);
});

test("MACD bullCross compiles to a crossesAbove-zero on the histogram", () => {
  const label = mustFind(MACD_LABELS, "bullCross");
  const node = label.build({
    indParams: IND_PARAMS,
    labelParams: {},
    calibration: { mode: "static" },
  });
  assert.equal(node.op, "cmp");
  if (node.op !== "cmp") throw new Error("unreachable");
  assert.equal(node.cmp, "crossesAbove");
  assert.equal(node.left.src, "indicator");
  if (node.left.src !== "indicator") throw new Error("unreachable");
  assert.equal(node.left.id, "macd");
  assert.equal(node.left.output, "hist");
});

test("EMA risingSlope compares the indicator against itself offset by 1 bar", () => {
  const label = mustFind(EMA_LABELS, "risingSlope");
  const node = label.build({
    indParams: IND_PARAMS,
    labelParams: {},
    calibration: { mode: "static" },
  });
  assert.equal(node.op, "cmp");
  if (node.op !== "cmp") throw new Error("unreachable");
  assert.equal(node.right.src, "indicator");
  if (node.right.src !== "indicator") throw new Error("unreachable");
  assert.equal(node.right.offset, 1);
  assert.equal(node.left.src, "indicator");
  if (node.left.src !== "indicator") throw new Error("unreachable");
  assert.equal(node.left.offset ?? 0, 0); // "today" side stays at offset 0
});

// ── indicator/output/label wiring matches what the backend can resolve ─────
// (a fixed allowlist, updated by hand as backend/alerts/operands.py grows —
// this is a deliberate tripwire, not something to "fix" by widening it.)

const BACKEND_SUPPORTED: Record<string, string[]> = {
  rsi: ["rsi"],
  ema: ["value"],
  sma: ["value"],
  macd: ["hist"],
  rvol: ["rvol"],
  stochastic: ["k", "d"],
  bollinger: ["upper", "middle", "lower"],
  "bollinger-b": ["b"],
  "bb-width": ["width"],
};

test("every label's build() only references indicator outputs the backend actually resolves", () => {
  function walk(
    node: ReturnType<(typeof RSI_LABELS)[number]["build"]>,
    indicator: string,
    concept: string
  ) {
    if (node.op === "cmp") {
      for (const op of [node.left, node.right, node.right2]) {
        if (!op) continue;
        if (op.src === "indicator") {
          const allowed = BACKEND_SUPPORTED[op.id];
          assert.ok(allowed, `${indicator}'s "${concept}" references unknown indicator "${op.id}"`);
          assert.ok(
            allowed.includes(op.output),
            `${indicator}'s "${concept}" references ${op.id}.${op.output}, backend only resolves ${allowed.join("/")}`
          );
        }
        if (op.src === "pctRank" && op.of.src === "indicator") {
          const allowed = BACKEND_SUPPORTED[op.of.id];
          assert.ok(allowed?.includes(op.of.output));
        }
      }
    } else if (node.op === "and" || node.op === "or") {
      for (const c of node.children) walk(c, indicator, concept);
    } else if (node.op === "not" || node.op === "within" || node.op === "sustained") {
      walk(node.child, indicator, concept);
    }
  }

  for (const [indicator, labels] of Object.entries(ALL_LABEL_SETS)) {
    for (const label of labels) {
      for (const mode of label.calibrations) {
        const calibration =
          mode === "adaptive" ? { mode: "adaptive" as const, window: 252 } : { mode };
        const node = label.build({
          indParams: IND_PARAMS,
          labelParams: defaultLabelParams(label),
          calibration,
        });
        walk(node, indicator, label.concept);
      }
    }
  }
});
