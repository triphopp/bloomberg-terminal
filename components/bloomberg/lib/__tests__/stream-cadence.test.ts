import assert from "node:assert/strict";
import test from "node:test";
import {
  QUIET_BACKOFF_MS,
  STREAM_BACKOFF_MS,
  STREAM_TICK_FRESH_MS,
  isOpenMarketState,
  openSymbolsOf,
  pollInterval,
  streamCadence,
  symbolKey,
} from "../stream-cadence.ts";

const NOW = 1_000_000_000;
const up = { connected: true, denied: new Set<string>() };
const ticked = (...syms: string[]) => new Map(syms.map((s) => [s, NOW - 1_000]));

test("open states are REGULAR / PRE / POST only", () => {
  assert.equal(isOpenMarketState("REGULAR"), true);
  assert.equal(isOpenMarketState("POST"), true);
  assert.equal(isOpenMarketState("PREPRE"), false);
  assert.equal(isOpenMarketState("CLOSED"), false);
  assert.equal(isOpenMarketState(null), false);
});

test("unknown market state counts as open (conservative)", () => {
  const rows = [
    { symbol: "A", marketState: "REGULAR" },
    { symbol: "B", marketState: "CLOSED" },
    { symbol: "C" },
    { marketState: "REGULAR" },
  ];
  assert.deepEqual(openSymbolsOf(rows), ["A", "C"]);
});

test("symbolKey is order/case independent", () => {
  assert.equal(symbolKey(["b", "A", "a", ""]), "A,B");
});

test("streamed only when open, connected, not denied and every symbol ticked recently", () => {
  assert.equal(streamCadence("A,B", up, true, ticked("A", "B"), NOW), "streamed");
  assert.equal(streamCadence("A,B", up, false, ticked("A", "B"), NOW), null, "stream closed");
  assert.equal(streamCadence("A,B", null, true, ticked("A", "B"), NOW), null, "no coverage yet");
  assert.equal(
    streamCadence("A,B", { connected: false, denied: new Set() }, true, ticked("A", "B"), NOW),
    null,
    "yahoo socket down"
  );
  assert.equal(
    streamCadence("A,B", { connected: true, denied: new Set(["B"]) }, true, ticked("A", "B"), NOW),
    null,
    "denied slot"
  );
  assert.equal(streamCadence("A,B", up, true, ticked("A"), NOW), null, "B open but silent");
  const stale = new Map([["A", NOW - STREAM_TICK_FRESH_MS - 1]]);
  assert.equal(streamCadence("A", up, true, stale, NOW), null, "tick too old");
});

test("nothing open → quiet, with or without the stream", () => {
  assert.equal(streamCadence("", up, true, new Map(), NOW), "quiet");
  assert.equal(streamCadence("", null, false, new Map(), NOW), "quiet");
});

test("pollInterval backs off only, never speeds up, keeps false", () => {
  assert.equal(pollInterval(60_000, null), 60_000);
  assert.equal(pollInterval(60_000, "streamed"), STREAM_BACKOFF_MS);
  assert.equal(pollInterval(60_000, "quiet"), QUIET_BACKOFF_MS);
  assert.equal(pollInterval(600_000, "streamed"), 600_000);
  assert.equal(pollInterval(300_000, "quiet"), 300_000);
  assert.equal(pollInterval(false, "streamed"), false);
});
