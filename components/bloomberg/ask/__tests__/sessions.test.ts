import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSessions, matchesFilter, newSessionId, sessionSignature } from "../sessions.ts";
import type { AskSessionMeta } from "../sessions.ts";
import type { AskMessage } from "../types.ts";

test("a session id is its start time and six hex digits — what the backend accepts", () => {
  const id = newSessionId(new Date(2026, 9, 6, 16, 32, 5), () => 0.5);
  assert.equal(id, "20261006-163205-800000");
  assert.match(newSessionId(), /^\d{8}-\d{6}-[0-9a-f]{6}$/);
  // The smallest random draw still fills six digits.
  assert.equal(
    newSessionId(new Date(2026, 0, 2, 3, 4, 5), () => 0),
    "20260102-030405-000000"
  );
  assert.match(
    newSessionId(new Date(), () => 0.999999999),
    /-[0-9a-f]{6}$/
  );
});

test("ids sort by when the conversation started", () => {
  const ids = [
    newSessionId(new Date(2026, 9, 6, 9, 0, 0)),
    newSessionId(new Date(2026, 8, 30, 23, 59, 59)),
    newSessionId(new Date(2026, 9, 6, 16, 0, 0)),
  ];
  assert.deepEqual(
    [...ids].sort().map((id) => id.slice(0, 15)),
    ["20260930-235959", "20261006-090000", "20261006-160000"]
  );
});

test("the signature moves when the conversation does, and only then", () => {
  const q: AskMessage = { role: "user", content: "q" };
  const a: AskMessage = { role: "assistant", content: "answer" };
  const base = sessionSignature("s1", [q, a]);
  assert.equal(sessionSignature("s1", [q, { ...a }]), base);
  assert.notEqual(sessionSignature("s2", [q, a]), base);
  assert.notEqual(sessionSignature("s1", [q, a, q, a]), base);
  assert.notEqual(sessionSignature("s1", [q, { ...a, content: "answer, longer" }]), base);
  assert.notEqual(sessionSignature("s1", [q, { ...a, error: "หยุดแล้ว" }]), base);
});

const meta = (
  id: string,
  updated: string,
  extra: Partial<AskSessionMeta> = {}
): AskSessionMeta => ({
  id,
  title: `chat ${id}`,
  created_at: updated,
  updated_at: updated,
  questions: 1,
  private: false,
  pinned: false,
  device: null,
  page: null,
  ...extra,
});

test("HISTORY groups pinned first, then by day, newest first in each", () => {
  const now = new Date(2026, 9, 6, 18, 0);
  const groups = groupSessions(
    [
      meta("old", new Date(2026, 6, 1).toISOString()),
      meta("today-early", new Date(2026, 9, 6, 9, 0).toISOString()),
      meta("pin", new Date(2026, 5, 1).toISOString(), { pinned: true }),
      meta("today-late", new Date(2026, 9, 6, 17, 0).toISOString()),
      meta("yesterday", new Date(2026, 9, 5, 23, 59).toISOString()),
      meta("week", new Date(2026, 9, 1).toISOString()),
      meta("month", new Date(2026, 8, 15).toISOString()),
    ],
    now
  );
  assert.deepEqual(
    groups.map(([g, s]) => [g, s.map((x) => x.id)]),
    [
      ["PINNED", ["pin"]],
      ["TODAY", ["today-late", "today-early"]],
      ["YESTERDAY", ["yesterday"]],
      ["LAST 7 DAYS", ["week"]],
      ["LAST 30 DAYS", ["month"]],
      ["EARLIER", ["old"]],
    ]
  );
  assert.deepEqual(groupSessions([], now), []);
});

test("the filter wants every word of it in the title", () => {
  const s = meta("x", "2026-10-06T10:00:00+07:00", { title: "สัปดาห์นี้มีตัวเลขเศรษฐกิจ NVDA" });
  assert.ok(matchesFilter(s, ""));
  assert.ok(matchesFilter(s, "nvda ตัวเลข"));
  assert.ok(!matchesFilter(s, "nvda tsla"));
});
