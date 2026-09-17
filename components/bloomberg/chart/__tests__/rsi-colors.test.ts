import assert from "node:assert/strict";
import { test } from "node:test";
import { RSI_COLORS, createRSI, rsiZoneColor } from "../indicators/rsi.ts";
import type { OhlcvBar } from "../types.ts";

test("zone colour: at or beyond a level takes that level's colour", () => {
  assert.equal(rsiZoneColor(70, 70, 30), RSI_COLORS.overbought);
  assert.equal(rsiZoneColor(69.99, 70, 30), RSI_COLORS.neutral);
  assert.equal(rsiZoneColor(30, 70, 30), RSI_COLORS.oversold);
  assert.equal(rsiZoneColor(50, 70, 30), RSI_COLORS.neutral);
});

test("RSI line is last (paints on top), thick, labelled, and coloured per point", () => {
  // Straight rally then straight sell-off: RSI must visit both extremes.
  const closes = [
    ...Array.from({ length: 30 }, (_, i) => 100 + i),
    ...Array.from({ length: 30 }, (_, i) => 129 - i * 2),
  ];
  const bars: OhlcvBar[] = closes.map((c, i) => ({
    time: 1_700_000_000 + i * 86_400,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 0,
  }));
  const rsi = createRSI();
  const out = rsi.compute(bars, rsi.config);

  assert.deepEqual(
    out.map((o) => o.id),
    ["rsi-14-mid", "rsi-14-ob", "rsi-14-os", "rsi-14-line"]
  );
  const line = out[3];
  assert.equal(line.lineWidth, 2);
  assert.equal(line.lastValueVisible, true);
  assert.equal(out[1].lineStyle, "dashed");

  const colors = new Set(line.data.map((d) => (d as { color?: string }).color));
  assert.ok(colors.has(RSI_COLORS.overbought));
  assert.ok(colors.has(RSI_COLORS.oversold));
  for (const d of line.data as { value: number; color: string }[]) {
    assert.equal(d.color, rsiZoneColor(d.value, 70, 30));
  }
});
