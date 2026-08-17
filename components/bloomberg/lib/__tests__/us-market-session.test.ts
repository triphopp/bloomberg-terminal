import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HALF_DAY_CLOSE,
  REGULAR_CLOSE,
  computeSession,
  fmtClock,
  fmtCountdown,
} from "../us-market-session.ts";

/**
 * Instants are given in UTC so the test does not depend on the machine's zone.
 * Eastern Time is UTC−4 in summer (EDT) and UTC−5 in winter (EST), which is
 * itself part of what these assert.
 */
const at = (iso: string) => new Date(iso);

describe("phase boundaries (summer, EDT = UTC−4)", () => {
  it("is closed overnight before pre-market", () => {
    // 03:59 ET Wed
    const s = computeSession(at("2026-08-19T07:59:00Z"));
    assert.equal(s.phase, "CLOSED");
    assert.equal(s.etTime, "03:59:00");
  });

  it("opens pre-market exactly at 04:00 ET", () => {
    const s = computeSession(at("2026-08-19T08:00:00Z"));
    assert.equal(s.phase, "PRE");
    assert.equal(s.nextChangeLabel, "market opens");
    assert.equal(s.nextChangeIn, 330); // 5h30m to 09:30
  });

  it("is still pre-market one minute before the bell", () => {
    assert.equal(computeSession(at("2026-08-19T13:29:00Z")).phase, "PRE");
  });

  it("opens regular trading exactly at 09:30 ET", () => {
    const s = computeSession(at("2026-08-19T13:30:00Z"));
    assert.equal(s.phase, "OPEN");
    assert.equal(s.etTime, "09:30:00");
    assert.equal(s.closeMinute, REGULAR_CLOSE);
    assert.equal(s.nextChangeLabel, "market closes");
    assert.equal(s.nextChangeIn, 390); // 6h30m session
  });

  it("has no midday gap — 12:30 ET is still OPEN", () => {
    // The whole point: SET and TSE would be on lunch here.
    const s = computeSession(at("2026-08-19T16:30:00Z"));
    assert.equal(s.phase, "OPEN");
  });

  it("switches to after-hours at 16:00 ET", () => {
    const s = computeSession(at("2026-08-19T20:00:00Z"));
    assert.equal(s.phase, "AFTER");
    assert.equal(s.nextChangeLabel, "after-hours ends");
  });

  it("closes for the day at 20:00 ET", () => {
    const s = computeSession(at("2026-08-20T00:00:00Z"));
    assert.equal(s.phase, "CLOSED");
    assert.equal(s.nextChangeIn, null);
  });
});

describe("daylight saving", () => {
  it("uses EST offset in winter", () => {
    // 14:30 UTC in January is 09:30 EST — the bell.
    const s = computeSession(at("2026-01-14T14:30:00Z"));
    assert.equal(s.etTime, "09:30:00");
    assert.equal(s.phase, "OPEN");
    assert.match(s.etZone, /EST/);
  });

  it("uses EDT offset in summer", () => {
    // The same 14:30 UTC in August is 10:30 EDT, an hour into the session.
    const s = computeSession(at("2026-08-19T14:30:00Z"));
    assert.equal(s.etTime, "10:30:00");
    assert.match(s.etZone, /EDT/);
  });
});

describe("non-trading days", () => {
  it("is closed on Saturday during what would be session hours", () => {
    const s = computeSession(at("2026-08-15T14:00:00Z"));
    assert.equal(s.phase, "CLOSED");
    assert.equal(s.isWeekend, true);
    assert.equal(s.nextChangeIn, null);
  });

  it("is closed on Sunday", () => {
    assert.equal(computeSession(at("2026-08-16T14:00:00Z")).isWeekend, true);
  });

  it("is closed on Thanksgiving even though it is a Thursday", () => {
    const s = computeSession(at("2026-11-26T15:00:00Z")); // 10:00 ET
    assert.equal(s.isHoliday, true);
    assert.equal(s.phase, "CLOSED");
    assert.equal(s.etWeekday, "Thu");
  });

  it("is closed on the observed Independence Day when 4 July is a Saturday", () => {
    const s = computeSession(at("2026-07-03T15:00:00Z"));
    assert.equal(s.etDateKey, "2026-07-03");
    assert.equal(s.isHoliday, true);
  });

  it("is closed on Good Friday", () => {
    assert.equal(computeSession(at("2026-04-03T15:00:00Z")).isHoliday, true);
  });
});

describe("half-days", () => {
  it("closes at 13:00 ET on the day after Thanksgiving", () => {
    const s = computeSession(at("2026-11-27T15:00:00Z")); // 10:00 ET
    assert.equal(s.isHalfDay, true);
    assert.equal(s.phase, "OPEN");
    assert.equal(s.closeMinute, HALF_DAY_CLOSE);
    assert.equal(s.nextChangeLabel, "market closes");
    assert.equal(s.nextChangeIn, 180);
  });

  it("is already in after-hours at 14:00 ET on a half-day", () => {
    // 14:00 ET would be mid-session on a normal day.
    const s = computeSession(at("2026-11-27T19:00:00Z"));
    assert.equal(s.phase, "AFTER");
    assert.equal(s.afterCloseMinute, 17 * 60);
  });

  it("treats a normal Friday as a full session", () => {
    const s = computeSession(at("2026-11-20T19:00:00Z")); // 14:00 ET
    assert.equal(s.isHalfDay, false);
    assert.equal(s.phase, "OPEN");
  });
});

describe("calendar staleness", () => {
  it("does not flag dates inside the maintained range", () => {
    assert.equal(computeSession(at("2027-12-01T15:00:00Z")).calendarStale, false);
  });

  it("flags dates past the maintained range, where holidays would be missed", () => {
    const s = computeSession(at("2028-07-04T15:00:00Z"));
    assert.equal(s.calendarStale, true);
    // Independence Day 2028 is a Tuesday and is NOT in the table — the widget
    // would otherwise silently claim the market is open.
    assert.equal(s.isHoliday, false);
  });
});

describe("formatting", () => {
  it("renders minutes-from-midnight as a clock", () => {
    assert.equal(fmtClock(4 * 60), "04:00");
    assert.equal(fmtClock(9 * 60 + 30), "09:30");
    assert.equal(fmtClock(16 * 60), "16:00");
  });

  it("renders countdowns with hours only when there are hours", () => {
    assert.equal(fmtCountdown(45), "45m");
    assert.equal(fmtCountdown(390), "6h 30m");
    assert.equal(fmtCountdown(60), "1h 0m");
  });
});
