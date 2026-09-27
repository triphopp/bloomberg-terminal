/**
 * Indicator performance rules — the conditions every indicator (and the
 * library code behind one) must meet to be merged. Why: indicators run on
 * EVERY live tick over the WHOLE loaded history, so an O(N·k) window loop or a
 * sort per bar on a 5Y chart turned into 100+ ms of main-thread work per tick
 * (BB volume overlay, 2026-09-26). Written up in chart/indicators/index.ts
 * ("Performance rules") and memory/reference/gotchas.md.
 *
 * Two kinds of check:
 *   1. Source rules — banned patterns in compute code. A deliberate exception
 *      carries `perf-ok: <reason>` on the same line or the line above.
 *   2. Complexity — measured: cost may not grow with the window parameter, and
 *      must grow ~linearly with the bar count.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { bbVolumeColumns } from "../../lib/bb-volume.ts";
import { classifyVolumeEvents } from "../../lib/volume-events.ts";
import { fitBollingerSharpe } from "../bollinger-fit.ts";
import { INDICATOR_REGISTRY } from "../indicators/index.ts";
import type { IndicatorRegistryEntry, OhlcvBar } from "../types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHART = join(HERE, "..");
const LIB = join(HERE, "..", "..", "lib");

// ── 1. Source rules ──────────────────────────────────────────────────────────

/** Files whose code runs per compute / per tick over the whole history. */
const COMPUTE_FILES = [
  ...readdirSync(join(CHART, "indicators"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(CHART, "indicators", f)),
  join(CHART, "bollinger-fit.ts"),
  join(CHART, "bb-volume-overlay.ts"),
  join(LIB, "volume-stats.ts"),
  join(LIB, "volume-events.ts"),
  join(LIB, "bb-volume.ts"),
];

const RULES: { id: string; re: RegExp; fix: string }[] = [
  {
    id: "spread-min-max",
    re: /Math\.(max|min)\(\s*\.\.\./,
    fix: "loop instead — spreading a MAX intraday array throws RangeError, and per bar it is O(k)",
  },
  {
    id: "window-reslice",
    re: /\.slice\(\s*[a-z]\w*\s*-/,
    fix: "rolling.ts (rollingMean/rollingVariance/rollingMax/Min) — re-slicing the window per bar is O(N·k) + an array per bar",
  },
  {
    id: "window-inner-loop",
    // An inner loop whose start is the OUTER index minus something:
    // `for (let j = i - k …` — not an outer loop that merely starts at k − 1.
    re: /for \(let \w+ = (Math\.max\(0,\s*)?[i-n] - /,
    fix: "rolling.ts — a loop over the prior k bars at every bar is O(N·k)",
  },
  {
    id: "array-shift",
    re: /\.shift\(\)/,
    fix: "RollingSample / a ring buffer — Array#shift is O(k)",
  },
  {
    id: "sort",
    re: /\.sort\(/,
    fix: "SortedWindow / RollingSample (median, MAD, quantile) — a sort per bar is O(N·k log k)",
  },
];

function violations(file: string): string[] {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const out: string[] = [];
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/^\s*(\*|\/\*)/.test(code)) return; // doc comment
    const waived = /perf-ok:/.test(line) || /perf-ok:/.test(lines[i - 1] ?? "");
    for (const r of RULES) {
      if (r.re.test(code) && !waived) {
        out.push(
          `${file.slice(CHART.length - 5)}:${i + 1} [${r.id}] ${line.trim()}\n      → ${r.fix}`
        );
      }
    }
  });
  return out;
}

test("compute code has no per-bar window loops, sorts, shifts or spreads (or says why)", () => {
  const found = COMPUTE_FILES.flatMap(violations);
  assert.deepEqual(found, [], `\n${found.join("\n")}\n`);
});

// ── 2. Measured complexity ───────────────────────────────────────────────────

function bars(n: number): OhlcvBar[] {
  const out: OhlcvBar[] = [];
  let p = 100;
  const t0 = Date.UTC(1950, 0, 2);
  for (let i = 0; i < n; i++) {
    const o = p;
    p *= 1 + (Math.sin(i * 0.37) * 0.5 + (((i * 7919) % 13) - 6) / 12) * 0.02;
    out.push({
      time: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
      open: o,
      high: Math.max(o, p) * 1.004,
      low: Math.min(o, p) * 0.996,
      close: p,
      volume: i % 17 === 0 ? 0 : 1e6 + ((i * 104729) % 23) * 1e5,
    });
  }
  return out;
}

// A collection left over from the previous run would land inside whichever
// timed run it happens to hit and swing a ratio by 2×. Collect before each.
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** Best of `reps` runs, ms — the minimum is the least noisy estimate. */
function bestMs(fn: () => unknown, reps = 5): number {
  fn(); // warm the JIT
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < reps; r++) {
    gc();
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

/** Every numeric param at its UI maximum — the widest window a user can pick. */
function maxConfig(e: IndicatorRegistryEntry): Record<string, number> {
  const c: Record<string, number> = {};
  for (const p of e.defaultParams) if (p.type === "number" && p.max != null) c[p.key] = p.max;
  return c;
}

/** Every select option on its own — each is a separate code path. */
function optionConfigs(e: IndicatorRegistryEntry): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const p of e.defaultParams) {
    if (p.type !== "select" || !p.options) continue;
    for (const o of p.options) out.push({ [p.key]: typeof o === "string" ? o : String(o.value) });
  }
  return out;
}

/**
 * Run a timing check up to 3 times; pass if any attempt passes. `node --test`
 * runs test FILES in parallel, so another file can steal the CPU in the middle
 * of one measurement. A real regression (the ones this file exists for were
 * 7×–180×) fails every attempt; noise does not.
 */
function timed(check: () => void): void {
  for (let attempt = 1; ; attempt++) {
    try {
      check();
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
    }
  }
}

// Below this the timer is noise; a ratio of two sub-0.3 ms numbers means nothing.
const FLOOR_MS = 0.3;
const ratio = (a: number, b: number) => Math.max(a, FLOOR_MS) / Math.max(b, FLOOR_MS);

/** Cost at the widest window ≤ this × cost at the default window. O(N) ≈ 1; O(N·k) = k_max/k_def. */
const MAX_WINDOW_RATIO = 3;
/**
 * Cost at 8× the bars ≤ this × cost at 1×. O(N) = 8, O(N log N) ≈ 10, O(N²) = 64.
 * Measured wall time of genuinely linear code reaches ~12–15× (allocation and
 * cache effects on the bigger output), so the line sits well clear of both.
 */
const MAX_SCALING_RATIO = 24;
/** Absolute ceiling at 16,000 bars (~63 years daily, ~9 months of 5m) — a loose tripwire, not a budget. */
const MAX_MS_AT_16K = 80;

// 2k → 16k: far enough apart that noise cannot fake a quadratic, and the
// widest window (rv-rank lookback 1,250) is already full in the small run.
const B2K = bars(2000);
const B8K = bars(8000);
const B16K = bars(16000);

for (const e of INDICATOR_REGISTRY) {
  test(`indicator ${e.id}: cost independent of window, linear in bars`, () =>
    timed(() => {
      const def = e.factory({});
      const wide = e.factory(maxConfig(e));
      const tDef = bestMs(() => def.compute(B8K, def.config));
      const tWide = bestMs(() => wide.compute(B8K, wide.config));
      assert.ok(
        ratio(tWide, tDef) <= MAX_WINDOW_RATIO,
        `${e.id}: ${tWide.toFixed(2)} ms at max params vs ${tDef.toFixed(2)} ms at defaults — cost grows with the window (O(N·k)); use chart/rolling.ts`
      );

      for (const cfg of [{}, maxConfig(e), ...optionConfigs(e)]) {
        const ind = e.factory(cfg);
        const small = bestMs(() => ind.compute(B2K, ind.config), 3);
        const big = bestMs(() => ind.compute(B16K, ind.config), 3);
        const label = `${e.id} ${JSON.stringify(cfg)}`;
        assert.ok(
          ratio(big, small) <= MAX_SCALING_RATIO,
          `${label}: 8× the bars cost ${(big / small).toFixed(1)}× (${small.toFixed(2)} → ${big.toFixed(2)} ms) — worse than linear`
        );
        assert.ok(
          big <= MAX_MS_AT_16K,
          `${label}: ${big.toFixed(1)} ms at 16,000 bars (ceiling ${MAX_MS_AT_16K})`
        );
      }
    }));
}

test("BB volume overlay columns: cost independent of lookback, linear in bars", () =>
  timed(() => {
    for (const mode of ["spike", "delta", "vol", "rvol", "events"] as const) {
      for (const basis of ["z", "ratio"] as const) {
        const run = (b: OhlcvBar[], lookback: number) => () =>
          bbVolumeColumns(b, { mode, sigma: 2, lookback, basis });
        const narrow = bestMs(run(B8K, 8));
        const wide = bestMs(run(B8K, 120));
        assert.ok(
          ratio(wide, narrow) <= MAX_WINDOW_RATIO,
          `bb-volume ${mode}/${basis}: lookback 120 costs ${(wide / narrow).toFixed(1)}× lookback 8`
        );
        const small = bestMs(run(B2K, 120), 3);
        const big = bestMs(run(B16K, 120), 3);
        assert.ok(
          ratio(big, small) <= MAX_SCALING_RATIO,
          `bb-volume ${mode}/${basis}: worse than linear`
        );
      }
    }
    const narrow = bestMs(() => classifyVolumeEvents(B8K, { lookback: 8 }));
    const wide = bestMs(() => classifyVolumeEvents(B8K, { lookback: 120 }));
    assert.ok(ratio(wide, narrow) <= MAX_WINDOW_RATIO, "classifyVolumeEvents grows with lookback");
  }));

// ── 3. Tick stability: caches must survive a live tick ───────────────────────

test("expensive fits are cached on closed bars, so a tick does not refit", () =>
  timed(() => {
    // A tick hands over a NEW array whose last bar moved. Anything keyed on the
    // array's identity misses every time.
    const data = bars(2500);
    // Cold = a CLOSED bar differs, so the key must change and the search re-run.
    let salt = 1;
    const cold = bestMs(() => {
      const d = [...data];
      d[d.length - 2] = { ...d[d.length - 2], close: d[d.length - 2].close * (1 + salt++ * 1e-6) };
      return fitBollingerSharpe(d, 5);
    }, 3);
    const last = data[data.length - 1];
    const ticked = [...data.slice(0, -1), { ...last, close: last.close * 1.01 }];
    fitBollingerSharpe(data, 5);
    const hit = bestMs(() => fitBollingerSharpe(ticked, 5));
    assert.ok(
      hit * 5 < cold,
      `fit after a tick took ${hit.toFixed(2)} ms vs ${cold.toFixed(2)} ms cold — cache missed`
    );
  }));
