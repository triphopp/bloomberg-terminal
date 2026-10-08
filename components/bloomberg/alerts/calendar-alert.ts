/**
 * CALENDAR reminder presentation — shared by the ticker chip, the toast and
 * the alert list.
 *
 * The events arrive through the ordinary alert feed with rule_id "cal:<KIND>"
 * (backend/calendar_scheduler.py). The snapshot is not indicator readings but
 * the event itself: its date, its title and the thesis it belongs to — which is
 * where the alert links.
 */

import type { ToolsRequest } from "../atoms";
import type { AlertEvent } from "../hooks/useAlertRules";

type Snap = Record<string, unknown>;

/** Where a reminder leads: a place in PORT → TOOLS, or a day of the CAL view. */
export type CalendarTarget = ToolsRequest | { sub: "calendar"; date?: string };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function isCalendarEvent(e: Pick<AlertEvent, "ruleId">): boolean {
  return e.ruleId.startsWith("cal:");
}

/** The event's own day, YYYY-MM-DD (bar_time is "<date>#<hash>"). */
export function calendarDateOf(e: Pick<AlertEvent, "snapshot" | "barTime">): string {
  return str((e.snapshot as Snap).date) ?? e.barTime.slice(0, 10);
}

/** Local calendar day, so "today" matches the user's clock, not UTC. */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const utc = (iso: string) => {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(toIso) - utc(fromIso)) / 86_400_000);
}

/** "วันนี้" / "พรุ่งนี้" / "อีก 3 วัน" / "ผ่านมา 2 วัน" — worded from the date
 *  when it is read, so one reminder stays right on both days it is shown. */
export function whenText(dateIso: string, today: string = todayIso()): string {
  const n = daysBetween(today, dateIso);
  if (n === 0) return "วันนี้";
  if (n === 1) return "พรุ่งนี้";
  return n > 0 ? `อีก ${n} วัน` : `ผ่านมา ${-n} วัน`;
}

/**
 * Where a calendar reminder leads: the thesis the date belongs to — on NOTES
 * at the note when it is one, on QUESTIONS when a question waits on it — and
 * that day of the calendar when no thesis claims it (a macro release).
 */
export function calendarTargetOf(
  e: Pick<AlertEvent, "ruleId" | "snapshot" | "barTime">
): CalendarTarget {
  const s = e.snapshot as Snap;
  const thesisId = str(s.thesis_id);
  const noteId = str(s.note_id);
  const questionId = str(s.question_id);
  if (thesisId && noteId) return { sub: "theses", thesisId, thesisSub: "notes", noteId };
  if (questionId) return { sub: "questions", thesisId, questionId };
  if (thesisId) return { sub: "theses", thesisId, thesisSub: "thesis" };
  return { sub: "calendar", date: calendarDateOf(e) };
}

export function calendarLinkLabel(target: CalendarTarget): string {
  if (target.sub === "theses") return "OPEN THESIS";
  if (target.sub === "questions") return "OPEN QUESTION";
  return "OPEN CALENDAR";
}

/** Short headline: what happens, without the symbol (shown beside it). */
export function calendarHeadline(e: Pick<AlertEvent, "ruleId" | "snapshot">): string {
  const s = e.snapshot as Snap;
  return str(s.title) ?? e.ruleId.slice(4);
}

/** One line under the headline: when, and what to look at. */
export function describeCalendar(
  e: Pick<AlertEvent, "snapshot" | "barTime">,
  today: string = todayIso()
): string {
  const s = e.snapshot as Snap;
  const day = calendarDateOf(e);
  const bits = [`${whenText(day, today)} · ${day}${s.estimated === true ? " (ประมาณ)" : ""}`];
  const detail = str(s.detail);
  if (detail) bits.push(detail);
  const thesis = str(s.thesis_symbol);
  if (thesis && thesis !== str(s.symbol)) bits.push(`thesis ${thesis}`);
  return bits.join(" · ");
}

export interface CalendarToast {
  title: string;
  description: string;
  target: CalendarTarget;
}

/**
 * The toasts for one batch of reminders: one per thesis, not one per date. A
 * results day with four scenarios written against it would otherwise open five
 * toasts at once, which is how people learn to stop reading them. A lone
 * reminder keeps its own wording and its own link.
 */
export function calendarToasts(
  events: Pick<AlertEvent, "ruleId" | "snapshot" | "barTime" | "symbol">[],
  today: string = todayIso()
): CalendarToast[] {
  const groups = new Map<string, typeof events>();
  for (const e of events) {
    const key = str((e.snapshot as Snap).thesis_id) ?? `#${calendarDateOf(e)}#${e.symbol}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  return [...groups.values()].map((list) => {
    const first = list[0];
    if (list.length === 1)
      return {
        title: `${first.symbol} · ${calendarHeadline(first)}`,
        description: describeCalendar(first, today),
        target: calendarTargetOf(first),
      };
    const s = first.snapshot as Snap;
    const thesisId = str(s.thesis_id);
    const heads = list
      .slice(0, 2)
      .map((e) => `${whenText(calendarDateOf(e), today)}: ${calendarHeadline(e)}`);
    const more = list.length - heads.length;
    return {
      title: `${str(s.thesis_symbol) ?? first.symbol} · ${list.length} เรื่องในปฏิทิน`,
      description: `${heads.join(" · ")}${more > 0 ? ` · +${more}` : ""}`,
      target: thesisId
        ? {
            sub: "theses",
            thesisId,
            thesisSub: list.some((e) => str((e.snapshot as Snap).note_id)) ? "notes" : "thesis",
          }
        : calendarTargetOf(first),
    };
  });
}
