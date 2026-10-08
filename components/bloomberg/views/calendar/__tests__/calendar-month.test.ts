import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarDateOf,
  calendarTargetOf,
  calendarToasts,
  daysBetween,
  describeCalendar,
  isCalendarEvent,
  whenText,
} from "../../../alerts/calendar-alert.ts";
import {
  FILTER_DEFAULT,
  addDays,
  byDay,
  cellLabel,
  dayTitle,
  gridRange,
  inMonth,
  kindCounts,
  matches,
  monthGrid,
  shiftMonth,
  toggleCategory,
  weekdayMon0,
} from "../month.ts";

// biome-ignore lint/suspicious/noExplicitAny: an event with only the fields under test
const E = (o: Record<string, unknown>): any => ({
  id: `${o.kind}:${o.date}:${o.symbol ?? ""}`,
  title: "",
  symbol: null,
  impact: null,
  estimated: false,
  done: false,
  due: false,
  theses: [],
  ref: null,
  tag: null,
  ...o,
});

const events = [
  E({
    date: "2026-10-28",
    category: "MACRO",
    kind: "FOMC",
    title: "FOMC decision",
    impact: "high",
  }),
  E({
    date: "2026-10-29",
    category: "MACRO",
    kind: "CLAIMS",
    title: "Weekly Jobless Claims",
    impact: "low",
  }),
  E({
    date: "2026-10-29",
    category: "COMPANY",
    kind: "EARNINGS",
    symbol: "INTC",
    theses: [{ id: "T1" }],
  }),
  E({ date: "2026-10-14", category: "COMPANY", kind: "DIVIDEND", symbol: "MU" }),
  E({
    date: "2026-10-29",
    category: "THESIS",
    kind: "NOTE",
    symbol: "INTC",
    title: "18A yield",
    theses: [{ id: "T1" }],
  }),
  E({
    date: "2026-11-20",
    category: "PORT",
    kind: "EXPIRY",
    symbol: "NVDA",
    theses: [{ id: "T2" }],
  }),
];
const kindsOf = (f: typeof FILTER_DEFAULT) =>
  events.filter((e) => matches(e, f)).map((e) => e.kind);

// ── The grid ────────────────────────────────────────────────────────────────

test("a month is always six Monday-first weeks that contain it", () => {
  const grid = monthGrid(2026, 9); // October 2026 starts on a Thursday
  assert.equal(grid.length, 6);
  assert.ok(grid.every((w) => w.length === 7));
  assert.equal(grid[0][0], "2026-09-28");
  assert.equal(grid[0][3], "2026-10-01");
  assert.equal(grid[5][6], "2026-11-08");
  assert.ok(grid.every((w) => weekdayMon0(w[0]) === 0));
  assert.deepEqual(gridRange(2026, 9), { start: "2026-09-28", end: "2026-11-08" });
});

test("a month that starts on a Monday starts the grid", () => {
  assert.equal(monthGrid(2026, 5)[0][0], "2026-06-01");
  // February 2027: 28 days starting Monday still gets six rows.
  assert.equal(monthGrid(2027, 1)[5][6], "2027-03-14");
});

test("day arithmetic crosses months, years and leap days", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.deepEqual(shiftMonth(2026, 11, 1), { y: 2027, m0: 0 });
  assert.deepEqual(shiftMonth(2026, 0, -1), { y: 2025, m0: 11 });
  assert.equal(inMonth("2026-09-28", 2026, 9), false);
  assert.equal(dayTitle("2026-10-28"), "พ. 28 ต.ค. 2026");
});

// ── The filter ──────────────────────────────────────────────────────────────

test("everything shows by default except the weekly macro prints", () => {
  assert.deepEqual(kindsOf(FILTER_DEFAULT), ["FOMC", "EARNINGS", "DIVIDEND", "NOTE", "EXPIRY"]);
  assert.ok(kindsOf({ ...FILTER_DEFAULT, lowImpact: true }).includes("CLAIMS"));
});

test("categories, kinds and the thesis each narrow it", () => {
  assert.deepEqual(kindsOf({ ...FILTER_DEFAULT, categories: ["MACRO"] }), ["FOMC"]);
  assert.deepEqual(
    kindsOf({ ...FILTER_DEFAULT, categories: ["COMPANY"], hiddenKinds: ["DIVIDEND"] }),
    ["EARNINGS"]
  );
  assert.deepEqual(kindsOf({ ...FILTER_DEFAULT, linkedOnly: true }), [
    "EARNINGS",
    "NOTE",
    "EXPIRY",
  ]);
  assert.deepEqual(kindsOf({ ...FILTER_DEFAULT, thesisId: "T1" }), ["EARNINGS", "NOTE"]);
});

test("the kind chips count what the scope allows, hidden or not", () => {
  const f = { ...FILTER_DEFAULT, categories: ["COMPANY" as const], hiddenKinds: ["DIVIDEND"] };
  assert.deepEqual(kindCounts(events, f), [
    { kind: "EARNINGS", n: 1 },
    { kind: "DIVIDEND", n: 1 },
  ]);
});

test("choosing every category is the same as ALL", () => {
  assert.deepEqual(toggleCategory([], "MACRO"), ["MACRO"]);
  assert.deepEqual(toggleCategory(["MACRO"], "MACRO"), []);
  assert.deepEqual(toggleCategory(["THESIS", "MACRO"], "PORT"), ["MACRO", "THESIS", "PORT"]);
  assert.deepEqual(toggleCategory(["MACRO", "COMPANY", "THESIS"], "PORT"), []);
});

test("events group under their day and label themselves for a cell", () => {
  const days = byDay(events);
  assert.equal(days.get("2026-10-29")?.length, 3);
  assert.equal(days.get("2026-10-30"), undefined);
  assert.deepEqual(events.map(cellLabel), [
    "FOMC",
    "CLAIMS",
    "INTC งบ",
    "MU XD",
    "INTC 18A yield",
    "NVDA OPT หมดอายุ",
  ]);
});

// ── Reminders ───────────────────────────────────────────────────────────────

const alert = (snapshot: Record<string, unknown>, ruleId = "cal:NOTE") =>
  // biome-ignore lint/suspicious/noExplicitAny: snapshot is typed for indicator readings
  ({ ruleId, barTime: "2026-10-29#ab12cd34", snapshot }) as any;

test("a reminder is worded from its date when it is read", () => {
  assert.equal(daysBetween("2026-10-28", "2026-11-02"), 5);
  assert.equal(whenText("2026-10-29", "2026-10-29"), "วันนี้");
  assert.equal(whenText("2026-10-29", "2026-10-28"), "พรุ่งนี้");
  assert.equal(whenText("2026-11-02", "2026-10-30"), "อีก 3 วัน");
  assert.equal(whenText("2026-10-29", "2026-10-31"), "ผ่านมา 2 วัน");
  assert.equal(calendarDateOf(alert({})), "2026-10-29");
  assert.equal(
    describeCalendar(
      alert({ date: "2026-10-29", detail: "EPS est 0.39", thesis_symbol: "INTC", symbol: "INTC" }),
      "2026-10-28"
    ),
    "พรุ่งนี้ · 2026-10-29 · EPS est 0.39"
  );
});

test("a reminder leads to the thesis the date belongs to", () => {
  assert.ok(isCalendarEvent(alert({})));
  assert.ok(!isCalendarEvent(alert({}, "guard:STOP_HIT")));
  // a note of a thesis → that thesis, on NOTES, at the note
  assert.deepEqual(calendarTargetOf(alert({ thesis_id: "T1", note_id: "N1" })), {
    sub: "theses",
    thesisId: "T1",
    thesisSub: "notes",
    noteId: "N1",
  });
  // a date a question waits on → the question
  assert.deepEqual(calendarTargetOf(alert({ thesis_id: "T1", question_id: "Q1" }, "cal:QDATE")), {
    sub: "questions",
    thesisId: "T1",
    questionId: "Q1",
  });
  // earnings of a symbol that has a thesis → the thesis
  assert.deepEqual(calendarTargetOf(alert({ thesis_id: "T1" }, "cal:EARNINGS")), {
    sub: "theses",
    thesisId: "T1",
    thesisSub: "thesis",
  });
  // a macro release nobody claims → that day on the calendar
  assert.deepEqual(calendarTargetOf(alert({ date: "2026-10-28" }, "cal:FOMC")), {
    sub: "calendar",
    date: "2026-10-28",
  });
});

test("a batch of reminders is one toast per thesis", () => {
  const note = (id: string, title: string) => ({
    ...alert({ date: "2026-10-29", thesis_id: "T1", thesis_symbol: "MEM", note_id: id, title }),
    symbol: "MEM",
  });
  const toasts = calendarToasts(
    [
      note("N1", "Scenario 1"),
      note("N2", "Scenario 2"),
      note("N3", "Scenario 3"),
      {
        ...alert({ date: "2026-10-30", thesis_id: "T2", title: "Ex-dividend" }, "cal:DIVIDEND"),
        symbol: "ORCL",
      },
    ],
    "2026-10-29"
  );
  assert.deepEqual(toasts, [
    {
      title: "MEM · 3 เรื่องในปฏิทิน",
      description: "วันนี้: Scenario 1 · วันนี้: Scenario 2 · +1",
      target: { sub: "theses", thesisId: "T1", thesisSub: "notes" },
    },
    {
      title: "ORCL · Ex-dividend",
      description: "พรุ่งนี้ · 2026-10-30",
      target: { sub: "theses", thesisId: "T2", thesisSub: "thesis" },
    },
  ]);
});
