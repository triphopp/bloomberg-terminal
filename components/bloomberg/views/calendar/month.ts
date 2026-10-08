/**
 * Calendar grid arithmetic and the filter — pure, no React, tested
 * (views/calendar/__tests__/calendar-month.test.ts).
 *
 * Days are "YYYY-MM-DD" strings throughout and all arithmetic goes through
 * Date.UTC: a local Date at midnight drifts a day across a DST change, and the
 * backend speaks in plain dates.
 */
import type { CalCategory, CalEvent } from "./types";

/** Monday first: the week the markets keep. */
export const WEEKDAYS = ["จ", "อ", "พ", "พฤ", "ศ", "ส", "อา"] as const;
export const MONTHS_TH = [
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
] as const;

export const CATEGORIES: CalCategory[] = ["MACRO", "COMPANY", "THESIS", "PORT"];

const pad = (n: number) => String(n).padStart(2, "0");

export function iso(y: number, m0: number, d: number): string {
  const t = new Date(Date.UTC(y, m0, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function parts(day: string): { y: number; m0: number; d: number } {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return { y, m0: m - 1, d };
}

export function addDays(day: string, n: number): string {
  const { y, m0, d } = parts(day);
  return iso(y, m0, d + n);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayMon0(day: string): number {
  const { y, m0, d } = parts(day);
  return (new Date(Date.UTC(y, m0, d)).getUTCDay() + 6) % 7;
}

export function shiftMonth(y: number, m0: number, delta: number): { y: number; m0: number } {
  const t = new Date(Date.UTC(y, m0 + delta, 1));
  return { y: t.getUTCFullYear(), m0: t.getUTCMonth() };
}

/** Six weeks of days, Monday first, covering the month — always 42 cells, so
 *  the grid does not change height from one month to the next. */
export function monthGrid(y: number, m0: number): string[][] {
  const first = iso(y, m0, 1);
  const start = addDays(first, -weekdayMon0(first));
  return Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d))
  );
}

export function gridRange(y: number, m0: number): { start: string; end: string } {
  const grid = monthGrid(y, m0);
  return { start: grid[0][0], end: grid[5][6] };
}

export function inMonth(day: string, y: number, m0: number): boolean {
  const p = parts(day);
  return p.y === y && p.m0 === m0;
}

export interface CalFilter {
  /** Categories shown; empty = all of them. */
  categories: CalCategory[];
  /** Kinds switched off one by one (EARNINGS, CLAIMS, …). */
  hiddenKinds: string[];
  /** Weekly / low-impact macro prints (jobless claims, EIA). Off by default:
   *  eight of them a month bury the dates that matter. */
  lowImpact: boolean;
  /** Only events that belong to some thesis. */
  linkedOnly: boolean;
  /** Only events of this thesis ("" = any). */
  thesisId: string;
}

export const FILTER_DEFAULT: CalFilter = {
  categories: [],
  hiddenKinds: [],
  lowImpact: false,
  linkedOnly: false,
  thesisId: "",
};

/** Everything but the kind switches — what decides which kind chips exist. */
export function matchesScope(e: CalEvent, f: CalFilter): boolean {
  if (f.categories.length > 0 && !f.categories.includes(e.category)) return false;
  if (!f.lowImpact && e.category === "MACRO" && e.impact === "low") return false;
  if (f.thesisId) return e.theses.some((t) => t.id === f.thesisId);
  if (f.linkedOnly && e.theses.length === 0) return false;
  return true;
}

export function matches(e: CalEvent, f: CalFilter): boolean {
  return matchesScope(e, f) && !f.hiddenKinds.includes(e.kind);
}

export function byDay(events: CalEvent[]): Map<string, CalEvent[]> {
  const out = new Map<string, CalEvent[]>();
  for (const e of events) {
    const list = out.get(e.date);
    if (list) list.push(e);
    else out.set(e.date, [e]);
  }
  return out;
}

/** Kinds present under the current scope, with how many — the kind chips. */
export function kindCounts(events: CalEvent[], f: CalFilter): { kind: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (matchesScope(e, f)) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, n]) => ({ kind, n }));
}

/** Toggle one category; choosing the last missing one is the same as ALL. */
export function toggleCategory(current: CalCategory[], c: CalCategory): CalCategory[] {
  const next = current.includes(c) ? current.filter((x) => x !== c) : [...current, c];
  return next.length === CATEGORIES.length ? [] : CATEGORIES.filter((x) => next.includes(x));
}

const KIND_SHORT: Record<string, string> = {
  EARNINGS: "งบ",
  DIVIDEND: "XD",
  SPLIT: "แตกหุ้น",
  NOTE: "โน้ต",
  QDATE: "รอคำตอบ",
  TRACK: "ตัวเลข",
  EXPIRY: "OPT หมดอายุ",
  REVIEW: "ทบทวน HOLD",
};

/** Short kind name: the macro code as it is (FOMC, CPI), Thai for the rest. */
export function kindLabel(kind: string): string {
  return KIND_SHORT[kind] ?? kind;
}

/** What a grid cell says about one event — it has ~14 characters. */
export function cellLabel(e: CalEvent): string {
  if (e.category === "MACRO") return e.kind;
  if (e.category === "COMPANY" || e.category === "PORT")
    return `${e.symbol ?? ""} ${kindLabel(e.kind)}`.trim();
  return `${e.symbol ?? ""} ${e.title}`.trim();
}

export function monthTitle(y: number, m0: number): string {
  return `${MONTHS_TH[m0]} ${y}`;
}

const MONTHS_TH_SHORT = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
] as const;

/** "พ. 28 ต.ค. 2026" */
export function dayTitle(day: string): string {
  const { y, m0, d } = parts(day);
  return `${WEEKDAYS[weekdayMon0(day)]}. ${d} ${MONTHS_TH_SHORT[m0]} ${y}`;
}
