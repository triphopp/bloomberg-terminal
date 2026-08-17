/**
 * US equities session maths — pure, no React, so it can be unit-tested against
 * fixed instants (holidays and half-days are otherwise unreachable in a live UI).
 *
 * A note on lunch breaks: NYSE and NASDAQ do not have one. They trade
 * continuously 09:30–16:00 ET. The exchanges that pause midday are elsewhere —
 * SET 12:30–14:30 ICT, TSE 11:30–12:30 JST, HKEX 12:00–13:00 HKT. What US
 * trading has instead is pre-market, regular hours, after-hours, and a 13:00 ET
 * early close on half-days, which is what this models.
 *
 * All wall-clock work goes through Intl with timeZone America/New_York, so
 * EST/EDT transitions are the platform's problem rather than ours.
 */

// ── Session boundaries, minutes from ET midnight ──────────────────────────────

export const PRE_OPEN = 4 * 60; // 04:00 ET
export const REGULAR_OPEN = 9 * 60 + 30; // 09:30 ET
export const REGULAR_CLOSE = 16 * 60; // 16:00 ET
export const AFTER_CLOSE = 20 * 60; // 20:00 ET

/** Half-days close at 13:00; after-hours then ends at 17:00. */
export const HALF_DAY_CLOSE = 13 * 60;
export const HALF_DAY_AFTER_CLOSE = 17 * 60;

/**
 * NYSE full closures, `YYYY-MM-DD` in Eastern Time.
 *
 * Hand-maintained: there is no free holiday feed worth a network dependency for
 * ten dates a year. **Covers 2026–2027 only** — past that the clock falls back
 * to weekday rules and would show a holiday as a normal session, so it flags
 * itself as stale instead. Refresh from nyse.com/markets/hours-calendars.
 */
export const NYSE_HOLIDAYS = new Set([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day observed (Jul 4 is a Saturday)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26", // Good Friday
  "2027-05-31",
  "2027-06-18", // Juneteenth observed (Jun 19 is a Saturday)
  "2027-07-05", // Independence Day observed (Jul 4 is a Sunday)
  "2027-09-06",
  "2027-11-25",
  "2027-12-24", // Christmas observed (Dec 25 is a Saturday)
]);

/**
 * 13:00 ET early closes. Only the ones that recur unambiguously are listed —
 * the Christmas-week schedule shifts with the weekday and the exchange confirms
 * it each year, so guessing it would be worse than omitting it.
 */
export const NYSE_HALF_DAYS = new Set([
  "2026-11-27", // day after Thanksgiving
  "2026-12-24", // Christmas Eve
  "2027-11-26", // day after Thanksgiving
]);

/** Last year the calendars above cover. */
export const LAST_CALENDAR_YEAR = 2027;

export type Phase = "CLOSED" | "PRE" | "OPEN" | "AFTER";

export interface SessionState {
  phase: Phase;
  /** ET wall clock as HH:MM:SS. */
  etTime: string;
  etZone: string;
  etDateKey: string;
  etWeekday: string;
  /** Minutes from ET midnight. */
  minutes: number;
  isHoliday: boolean;
  isWeekend: boolean;
  isHalfDay: boolean;
  closeMinute: number;
  afterCloseMinute: number;
  /** Minutes until the next phase change; null when nothing else happens today. */
  nextChangeIn: number | null;
  nextChangeLabel: string | null;
  /** True once the date is past the hand-maintained holiday calendar. */
  calendarStale: boolean;
}

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  timeZoneName: "short",
});

function readEasternParts(now: Date) {
  const parts = ET_PARTS.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Some engines render midnight as "24" under hour12:false.
  const rawHour = Number(get("hour"));
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday"),
    zone: get("timeZoneName"),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function computeSession(now: Date): SessionState {
  const et = readEasternParts(now);
  const etDateKey = `${et.year}-${et.month}-${et.day}`;
  const minutes = et.hour * 60 + et.minute;

  const isWeekend = et.weekday === "Sat" || et.weekday === "Sun";
  const isHoliday = NYSE_HOLIDAYS.has(etDateKey);
  const isHalfDay = NYSE_HALF_DAYS.has(etDateKey);
  const calendarStale = Number(et.year) > LAST_CALENDAR_YEAR;
  const tradingDay = !isWeekend && !isHoliday;

  const closeMinute = isHalfDay ? HALF_DAY_CLOSE : REGULAR_CLOSE;
  const afterCloseMinute = isHalfDay ? HALF_DAY_AFTER_CLOSE : AFTER_CLOSE;

  let phase: Phase = "CLOSED";
  if (tradingDay) {
    if (minutes >= PRE_OPEN && minutes < REGULAR_OPEN) phase = "PRE";
    else if (minutes >= REGULAR_OPEN && minutes < closeMinute) phase = "OPEN";
    else if (minutes >= closeMinute && minutes < afterCloseMinute) phase = "AFTER";
  }

  let nextChangeIn: number | null = null;
  let nextChangeLabel: string | null = null;
  if (tradingDay) {
    const upcoming: [number, string][] = [
      [PRE_OPEN, "pre-market opens"],
      [REGULAR_OPEN, "market opens"],
      [closeMinute, "market closes"],
      [afterCloseMinute, "after-hours ends"],
    ];
    const next = upcoming.find(([m]) => m > minutes);
    if (next) {
      nextChangeIn = next[0] - minutes;
      nextChangeLabel = next[1];
    }
  }

  return {
    phase,
    etTime: `${pad(et.hour)}:${pad(et.minute)}:${pad(et.second)}`,
    etZone: et.zone || "ET",
    etDateKey,
    etWeekday: et.weekday,
    minutes,
    isHoliday,
    isWeekend,
    isHalfDay,
    closeMinute,
    afterCloseMinute,
    nextChangeIn,
    nextChangeLabel,
    calendarStale,
  };
}

export function fmtCountdown(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Minutes-from-midnight → "HH:MM". */
export function fmtClock(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
