import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeWebull,
  isWebullEnded,
  isWebullEvent,
  webullHeadline,
  webullWhen,
} from "../../alerts/webull-alert.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
// The feed types a snapshot as indicator readings; a notice carries text in it.
const E = (ruleId: string, snapshot: Record<string, unknown> = {}) => ({
  ruleId,
  snapshot: snapshot as Record<string, number | null>,
});

describe("webull alerts", () => {
  it("are told apart from the other alerts by their rule id", () => {
    assert.equal(isWebullEvent(E("webull:TOKEN_SOON")), true);
    assert.equal(isWebullEvent(E("cal:EARNINGS")), false);
    assert.equal(isWebullEnded(E("webull:TOKEN_ENDED")), true);
    assert.equal(isWebullEnded(E("webull:FEED_ENDED")), true);
    assert.equal(isWebullEnded(E("webull:TOKEN_SOON")), false);
  });

  it("take their headline from the snapshot, or the kind when it has none", () => {
    assert.equal(
      webullHeadline(E("webull:TOKEN_SOON", { title: "Access token ends" })),
      "Access token ends"
    );
    assert.equal(webullHeadline(E("webull:FEED_SOON")), "FEED SOON");
  });

  it("word the time left from the date, when read", () => {
    const token = (ends_at: string) => E("webull:TOKEN_SOON", { ends_at });
    assert.equal(webullWhen(token("2026-10-22T16:00:00Z"), NOW), "in 2d 4h");
    assert.equal(webullWhen(token("2026-10-21T12:00:00Z"), NOW), "in 1d");
    assert.equal(webullWhen(token("2026-10-20T17:30:00Z"), NOW), "in 5h");
    assert.equal(webullWhen(token("2026-10-20T12:20:00Z"), NOW), "in 20m");
    assert.equal(webullWhen(token("2026-10-20T11:00:00Z"), NOW), "ended"); // read after the date
    assert.equal(webullWhen(token("not a date"), NOW), "");
  });

  it("count an entitlement in whole days", () => {
    const feed = E("webull:FEED_SOON", { ends_at: "2026-10-27T05:00:00Z" });
    assert.equal(webullWhen(feed, NOW), "in 6d");
  });

  it("say ended for what has ended, whatever its date", () => {
    assert.equal(
      webullWhen(E("webull:TOKEN_ENDED", { ends_at: "2030-01-01T00:00:00Z" }), NOW),
      "ended"
    );
  });

  it("describe with when, the date and what to do", () => {
    const text = describeWebull(
      E("webull:FEED_SOON", {
        ends_at: "2026-10-27T00:00:00Z",
        ends: "2026-10-27",
        detail: "Renew on the website.",
      }),
      NOW
    );
    assert.equal(text, "in 6d · 2026-10-27 · Renew on the website.");
  });
});
