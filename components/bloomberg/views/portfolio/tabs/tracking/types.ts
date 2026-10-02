// Shapes of /api/v2/tracking — see backend/routers/tracking.py.
import type { QStatus, ZettelBrief } from "../questions/types";

export type TStatus = "KILL" | "DUE" | "OFF" | "SETUP" | "WAITING" | "RETIRED";
export type TVerdict = "IN_LINE" | "ABOVE" | "BELOW" | "OFF" | "UNSCORED";
export type TRole = "KILLER" | "WATCH";

export interface TQuestion {
  id: string;
  ref: string;
  title: string;
  status: QStatus;
}

/** The forecast a metric is waiting on — the open one that comes due first. */
export interface TNext {
  expectation_id: string;
  period: string;
  expected: string;
  low: number | null;
  high: number | null;
  date: string | null;
  date_id: string | null;
  date_ref: string | null;
  date_title: string | null;
  date_status: "CONFIRMED" | "ESTIMATED" | null;
  release_time: string;
  days_until: number | null;
  due: boolean;
}

export interface TLast {
  reading_id: string;
  period: string;
  as_of: string | null;
  value: number | null;
  value_text: string;
  verdict: TVerdict;
  kill: boolean;
  question: TQuestion | null;
  explained: boolean;
}

/** Derived on read by the backend — never stored, so it cannot drift between devices. */
export interface TState {
  status: TStatus;
  /** Still missing before this can be tracked: "source" | "kill_rule" | "expectation". */
  gaps: string[];
  next: TNext | null;
  due: boolean;
  last: TLast | null;
  unexplained: number;
  /** Every forecast tied to a calendar row, with its number once it is read. */
  waits: {
    date_id: string;
    period: string;
    expected: string;
    low: number | null;
    high: number | null;
    reading: { value_text: string; verdict: TVerdict; kill: boolean } | null;
  }[];
}

export interface TMetric {
  id: string;
  ref: string;
  thesis_id: string | null;
  symbol: string | null;
  title: string;
  role: TRole;
  unit: string;
  definition: string;
  why: string;
  kill_rule: string;
  kill_op: string | null;
  kill_value: number | null;
  cadence: string;
  source_name: string;
  source_url: string;
  source_locator: string;
  source_tool: string;
  series_id: string | null;
  question_id: string | null;
  retired_at: string | null;
  retire_reason: string;
  actor: string;
  created_at: string;
  state: TState;
}

export interface TCounts {
  kill: number;
  due: number;
  off: number;
  setup: number;
  waiting: number;
  retired: number;
  /** kill + due + off — the metrics that need someone now. */
  alert: number;
}

export interface TCountsPayload extends TCounts {
  by_thesis: Record<string, TCounts>;
}

export interface TList {
  metrics: TMetric[];
  counts: TCounts;
}

export interface TExpectation {
  id: string;
  period: string;
  expected: string;
  low: number | null;
  high: number | null;
  basis: string;
  evidence: ZettelBrief[];
  /** The day the number comes out: the calendar row's date while it is alive. */
  date: string | null;
  calendar: {
    id: string;
    ref: string;
    title: string;
    date: string;
    status: "CONFIRMED" | "ESTIMATED";
    source: string;
    source_url: string;
  } | null;
  release_time: string;
  /** Written after the number was already out. */
  late: boolean;
  actor: string;
  created_at: string;
}

export interface TReading {
  id: string;
  period: string;
  as_of: string | null;
  value: number | null;
  value_text: string;
  verdict: TVerdict;
  kill: boolean;
  note: string;
  zettel: ZettelBrief | null;
  source_url: string;
  quote: string;
  question: TQuestion | null;
  actor: string;
  created_at: string;
}

/** One period: the forecast that stands, the number that stands, and what each replaced. */
export interface TPeriod {
  period: string;
  expectation: TExpectation | null;
  reading: TReading | null;
  revisions: TExpectation[];
  corrections: TReading[];
}

export interface TSeries {
  id: string;
  label: string;
  unit: string;
  source: string;
  source_url: string;
  points: { date: string; value: number }[];
}

export interface TDetail {
  metric: TMetric;
  state: TState;
  periods: TPeriod[];
  /** The question this number helps answer. */
  question: TQuestion | null;
  series: TSeries | null;
  opened_question?: TQuestion | null;
}

export const T_STATUS: Record<TStatus, { text: string; color: string }> = {
  KILL: { text: "แตะเส้น killer", color: "#f87171" },
  DUE: { text: "ถึงวัน", color: "#60a5fa" },
  OFF: { text: "ไม่ตรง รอคำอธิบาย", color: "#fb923c" },
  SETUP: { text: "ยังตั้งไม่ครบ", color: "#fbbf24" },
  WAITING: { text: "รอประกาศ", color: "#888" },
  RETIRED: { text: "เลิกติดตาม", color: "#555" },
};

export const T_VERDICT: Record<TVerdict, { text: string; color: string }> = {
  IN_LINE: { text: "ตรงตามคาด", color: "#4ade80" },
  ABOVE: { text: "สูงกว่าคาด", color: "#fb923c" },
  BELOW: { text: "ต่ำกว่าคาด", color: "#fb923c" },
  OFF: { text: "ไม่ตรง", color: "#fb923c" },
  UNSCORED: { text: "ไม่มีค่าคาดการณ์", color: "#666" },
};

export const T_GAP: Record<string, string> = {
  source: "แหล่งอ่านตัวเลข",
  kill_rule: "เส้น killer",
  expectation: "ค่าคาดการณ์รอบถัดไป",
};

export const T_CADENCE: Record<string, string> = {
  QUARTERLY: "รายไตรมาส",
  MONTHLY: "รายเดือน",
  WEEKLY: "รายสัปดาห์",
  DAILY: "รายวัน",
  EVENT: "ตามเหตุการณ์",
};

/** A tracked value as it was entered — never rounded to a whole number or to K/M. */
export const fmtVal = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 6 });

/** The band that counts as in line: "115 – 125", "≥ 86.25", "≤ 140". */
export function band(low: number | null, high: number | null): string {
  if (low !== null && high !== null)
    return low === high ? fmtVal(low) : `${fmtVal(low)} – ${fmtVal(high)}`;
  if (low !== null) return `≥ ${fmtVal(low)}`;
  if (high !== null) return `≤ ${fmtVal(high)}`;
  return "";
}

/** What the server will decide for this value — shown while typing, never sent. */
export function previewVerdict(
  value: number,
  low: number | null,
  high: number | null
): TVerdict | null {
  if (low === null && high === null) return null;
  if (low !== null && value < low) return "BELOW";
  if (high !== null && value > high) return "ABOVE";
  return "IN_LINE";
}

const OPS: Record<string, (a: number, b: number) => boolean> = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
};

export function crossesKill(value: number, op: string | null, line: number | null): boolean {
  return !!op && line !== null && !!OPS[op]?.(value, line);
}

export function whenText(days: number | null): string {
  if (days === null) return "";
  if (days === 0) return "วันนี้";
  return days > 0 ? `อีก ${days} วัน` : `เลยมา ${-days} วัน`;
}
