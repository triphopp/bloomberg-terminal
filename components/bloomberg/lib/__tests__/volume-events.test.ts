import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EVENT_CODE,
  type EventBar,
  type VolumeEventType,
  classifyVolumeEvents,
  forwardReturnPct,
} from "../volume-events.ts";

/**
 * A quiet baseline: daily returns cycling through ±1%, a 2%-of-price range, and
 * volume around 100-140k — enough spread that MAD has something to measure.
 *
 * Deterministic rather than random so a failure is reproducible and the
 * thresholds under test are the only moving part. The return σ matters as much
 * as the volume spread: every event type is a joint claim about participation
 * and result, so a baseline with unrealistically tiny returns would make any
 * move at all read as "big" and collapse the taxonomy onto one label.
 */
const BASE_RETS = [-1.2, 0.8, -0.4, 1.0, 0.3, -0.9, 0.6, -0.2, 0.5, -0.7];
const RANGE_PCT = 0.02;

function baseline(n = 30): EventBar[] {
  const bars: EventBar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = open * (1 + BASE_RETS[i % BASE_RETS.length] / 100);
    const range = open * RANGE_PCT;
    const mid = (open + close) / 2;
    bars.push({
      time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open,
      high: Math.max(mid + range / 2, open, close),
      low: Math.min(mid - range / 2, open, close),
      close,
      volume: 100_000 + ((i * 37) % 11) * 4000,
    });
  }
  return bars;
}

/** Append one bar built on the previous close. */
function addBar(
  bars: EventBar[],
  spec: { retPct: number; volume: number; rangeMult?: number; closePos?: number }
): EventBar[] {
  const prev = bars[bars.length - 1];
  const open = prev.close;
  const close = open * (1 + spec.retPct / 100);
  const range = open * RANGE_PCT * (spec.rangeMult ?? 1);
  // Place the close inside the bar at the requested position, then stretch the
  // bar around it so the range is exactly `range`.
  const pos = spec.closePos ?? (close >= open ? 0.8 : 0.2);
  const low = close - pos * range;
  const high = low + range;
  const next: EventBar = {
    time: new Date(Date.UTC(2026, 0, 1 + bars.length)).toISOString().slice(0, 10),
    open: Math.min(Math.max(open, low), high),
    high: Math.max(high, close),
    low: Math.min(low, close),
    close,
    volume: spec.volume,
  };
  return [...bars, next];
}

function typeAt(bars: EventBar[], index: number): VolumeEventType | null {
  const found = classifyVolumeEvents(bars).find((e) => e.index === index);
  return found?.type ?? null;
}

describe("classifyVolumeEvents — a quiet series has no events", () => {
  it("labels nothing on the baseline", () => {
    const events = classifyVolumeEvents(baseline());
    assert.deepEqual(events, [], `unexpected: ${events.map((e) => e.type).join(",")}`);
  });
});

describe("climax", () => {
  it("needs heavy volume AND a big move AND an extreme close", () => {
    const bars = baseline();
    const full = addBar(bars, { retPct: 6, volume: 1_400_000, closePos: 0.95 });
    assert.equal(typeAt(full, 30), "climax");

    // Same volume, same move, but the close gave everything back → not a climax.
    const midClose = addBar(bars, { retPct: 6, volume: 1_400_000, closePos: 0.5 });
    assert.notEqual(typeAt(midClose, 30), "climax");

    // Same move and close, ordinary volume → not a climax either.
    const noVolume = addBar(bars, { retPct: 6, volume: 105_000, closePos: 0.95 });
    assert.notEqual(typeAt(noVolume, 30), "climax");
  });

  it("reports the bar's own direction, never a forecast", () => {
    const up = addBar(baseline(), { retPct: 6, volume: 1_400_000, closePos: 0.95 });
    const down = addBar(baseline(), { retPct: -6, volume: 1_400_000, closePos: 0.05 });
    assert.equal(classifyVolumeEvents(up).find((e) => e.index === 30)?.dir, 1);
    assert.equal(classifyVolumeEvents(down).find((e) => e.index === 30)?.dir, -1);
  });
});

describe("vacuum", () => {
  it("flags a big move on below-normal volume", () => {
    const bars = addBar(baseline(), { retPct: -5, volume: 45_000 });
    const e = classifyVolumeEvents(bars).find((x) => x.index === 30);
    assert.equal(e?.type, "vacuum");
    assert.equal(e?.dir, -1);
    assert.ok((e?.z as number) < -0.5);
  });

  it("does not fire when the move is ordinary", () => {
    const bars = addBar(baseline(), { retPct: 0.2, volume: 45_000 });
    assert.notEqual(typeAt(bars, 30), "vacuum");
  });
});

describe("breakout", () => {
  it("needs the close beyond the prior range and volume behind it", () => {
    // The baseline oscillates in a narrow band; +4% clears its 20-bar high.
    // The close is mid-bar and the volume notable rather than extreme, so this
    // is a breakout and not the climax the priority order would otherwise
    // claim — a bar that closes on its high on 8σ of volume is a climax first.
    const withVol = addBar(baseline(), { retPct: 4, volume: 170_000, closePos: 0.6 });
    assert.equal(typeAt(withVol, 30), "breakout");

    const withoutVol = addBar(baseline(), { retPct: 4, volume: 100_000, closePos: 0.6 });
    assert.notEqual(typeAt(withoutVol, 30), "breakout");
  });

  it("takes its direction from the side that broke, not from the return", () => {
    const down = addBar(baseline(), { retPct: -4, volume: 170_000, closePos: 0.4 });
    const e = classifyVolumeEvents(down).find((x) => x.index === 30);
    assert.equal(e?.type, "breakout");
    assert.equal(e?.dir, -1);
  });
});

describe("absorption", () => {
  it("fires on heavy volume, a compressed range and a close against the move", () => {
    // Up move that could not hold: close in the bottom quarter of a tight bar.
    const bars = addBar(baseline(), {
      retPct: 0.9,
      volume: 700_000,
      rangeMult: 0.6,
      closePos: 0.2,
    });
    const e = classifyVolumeEvents(bars).find((x) => x.index === 30);
    assert.equal(e?.type, "absorption");
    assert.equal(e?.dir, -1, "a close in the lower half means buyers were absorbed");
  });

  it("does not fire when the range is not compressed", () => {
    const bars = addBar(baseline(), {
      retPct: 0.9,
      volume: 700_000,
      rangeMult: 3,
      closePos: 0.2,
    });
    assert.notEqual(typeAt(bars, 30), "absorption");
  });
});

describe("noDemand", () => {
  it("fires on heavy volume, a compressed range and a close that went nowhere", () => {
    const bars = addBar(baseline(), {
      retPct: 0.01,
      volume: 400_000,
      rangeMult: 0.5,
      closePos: 0.5,
    });
    const e = classifyVolumeEvents(bars).find((x) => x.index === 30);
    assert.equal(e?.type, "noDemand");
    assert.equal(e?.dir, 0, "nothing was decided, so there is no side to report");
  });
});

describe("dryUp", () => {
  it("needs a RUN — one quiet bar is not an event", () => {
    let bars = baseline();
    bars = addBar(bars, { retPct: 0.1, volume: 40_000 });
    assert.equal(typeAt(bars, 30), null);

    for (let i = 0; i < 3; i++) bars = addBar(bars, { retPct: 0.1, volume: 40_000 });
    const events = classifyVolumeEvents(bars).filter((e) => e.type === "dryUp");
    assert.equal(events.length, 1, "one event per run, not one per bar");
    assert.equal(events[0].index, bars.length - 1, "emitted at the end of the run");
    assert.equal(events[0].runLength, 4);
  });

  it("yields to a more specific label on the same bar", () => {
    // Three dry bars, the last of which is also a big move → vacuum wins and
    // the run produces nothing, rather than two labels on one bar.
    let bars = baseline();
    bars = addBar(bars, { retPct: 0.1, volume: 40_000 });
    bars = addBar(bars, { retPct: 0.1, volume: 40_000 });
    bars = addBar(bars, { retPct: -5, volume: 40_000 });
    const last = bars.length - 1;
    const onLast = classifyVolumeEvents(bars).filter((e) => e.index === last);
    assert.equal(onLast.length, 1);
    assert.equal(onLast[0].type, "vacuum");
  });
});

describe("one label per bar", () => {
  it("never emits two events for the same index", () => {
    // A bar that satisfies climax, breakout and absorption-volume at once.
    const bars = addBar(baseline(), { retPct: 7, volume: 2_000_000, closePos: 0.98 });
    const events = classifyVolumeEvents(bars);
    const seen = new Set<number>();
    for (const e of events) {
      assert.ok(!seen.has(e.index), `duplicate label on bar ${e.index}`);
      seen.add(e.index);
    }
    // Priority says climax, not breakout.
    assert.equal(typeAt(bars, 30), "climax");
  });
});

describe("warm-up and degenerate input", () => {
  it("emits nothing before the z-score has a baseline", () => {
    const short = baseline(6);
    assert.deepEqual(classifyVolumeEvents(short), []);
  });

  it("emits nothing for a symbol with no volume", () => {
    const noVol = baseline().map((b) => ({ ...b, volume: 0 }));
    const spike = addBar(noVol, { retPct: 6, volume: 0, closePos: 0.95 });
    assert.deepEqual(classifyVolumeEvents(spike), []);
  });

  it("survives an empty array", () => {
    assert.deepEqual(classifyVolumeEvents([]), []);
  });

  it("has a code for every type it can emit", () => {
    const bars = addBar(baseline(), { retPct: 6, volume: 1_400_000, closePos: 0.95 });
    for (const e of classifyVolumeEvents(bars)) {
      assert.ok(EVENT_CODE[e.type], `no code for ${e.type}`);
    }
  });
});

describe("forwardReturnPct", () => {
  it("measures close-to-close and is null past the data", () => {
    const bars: EventBar[] = [100, 110, 121].map((c, i) => ({
      time: `2026-01-0${i + 1}`,
      open: c,
      high: c,
      low: c,
      close: c,
    }));
    assert.ok(Math.abs((forwardReturnPct(bars, 0, 1) as number) - 10) < 1e-9);
    assert.ok(Math.abs((forwardReturnPct(bars, 0, 2) as number) - 21) < 1e-9);
    assert.equal(forwardReturnPct(bars, 2, 1), null, "no outcome yet is null, not 0");
    assert.equal(forwardReturnPct(bars, -1, 1), null);
  });
});
