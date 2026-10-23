import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTone } from "../tone-summary.ts";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

test("counts 72 h and 24 h separately, newest first", () => {
  const s = summarizeTone(
    [
      { title: "a", published_at: ago(1), sentiment: "NEG", symbols: ["GOOGL"] },
      { title: "b", published_at: ago(30), sentiment: "POS", symbols: ["GOOGL"] },
      { title: "c", published_at: ago(50), sentiment: "NEU", symbols: ["GOOGL"] },
      { title: "d", published_at: ago(80), sentiment: "NEG", symbols: ["GOOGL"] },
    ],
    "GOOGL",
    NOW
  );
  assert.deepEqual(s.last72h, { n: 3, pos: 1, neg: 1, neu: 1 });
  assert.deepEqual(s.last24h, { n: 1, pos: 0, neg: 1, neu: 0 });
  assert.deepEqual(
    s.latest.map((a) => a.title),
    ["a", "b", "c"]
  );
  assert.equal(s.outside, 1);
});

test("drops other symbols' headlines and duplicates", () => {
  const s = summarizeTone(
    [
      { title: "x", url: "u1", published_at: ago(1), sentiment: "POS", symbols: ["MSFT"] },
      { title: "y", url: "u2", published_at: ago(2), sentiment: "POS", symbols: ["googl"] },
      { title: "y again", url: "u2", published_at: ago(2), sentiment: "POS", symbols: ["GOOGL"] },
    ],
    "GOOGL",
    NOW
  );
  assert.equal(s.last72h.n, 1);
});

test("an unreadable date is outside, not counted", () => {
  const s = summarizeTone(
    [{ title: "z", published_at: "not a date", sentiment: "NEG" }],
    "GOOGL",
    NOW
  );
  assert.equal(s.last72h.n, 0);
  assert.equal(s.outside, 1);
});
