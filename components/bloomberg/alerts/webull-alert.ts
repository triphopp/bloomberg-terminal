/**
 * WEBULL notice presentation — shared by the ticker chip, the toast and the
 * alert list.
 *
 * The events arrive through the ordinary alert feed with rule_id
 * "webull:<KIND>" (backend/webull_scheduler.py): the access token (15 days) or
 * the market-data entitlement is about to end, or has. The snapshot is the
 * fact itself — what ends and when — and "how long is left" is worded from
 * that date when it is read, so a chip written this morning is still right
 * tonight. They lead to MKT → STRUCTURE → DEPTH, where a token is requested.
 */

import type { AlertEvent } from "../hooks/useAlertRules";

type Snap = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function isWebullEvent(e: Pick<AlertEvent, "ruleId">): boolean {
  return e.ruleId.startsWith("webull:");
}

/** Something has already stopped working — not a date coming up. */
export function isWebullEnded(e: Pick<AlertEvent, "ruleId">): boolean {
  return e.ruleId === "webull:TOKEN_ENDED" || e.ruleId === "webull:FEED_ENDED";
}

/** What ends, without the symbol (shown beside it). */
export function webullHeadline(e: Pick<AlertEvent, "ruleId" | "snapshot">): string {
  return str((e.snapshot as Snap).title) ?? e.ruleId.slice(7).replace(/_/g, " ");
}

/** "in 2d 4h" / "in 5h" / "in 20m" / "ended" — from the date, as it is read. */
export function webullWhen(
  e: Pick<AlertEvent, "ruleId" | "snapshot">,
  now: number = Date.now()
): string {
  if (isWebullEnded(e)) return "ended";
  const iso = str((e.snapshot as Snap).ends_at);
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return "";
  const left = (at - now) / 1000;
  if (left <= 0) return "ended";
  if (left < 3_600) return `in ${Math.max(1, Math.round(left / 60))}m`;
  if (left < 86_400) return `in ${Math.floor(left / 3_600)}h`;
  const days = Math.floor(left / 86_400);
  const hours = Math.floor((left % 86_400) / 3_600);
  // An entitlement is a calendar date: "in 12d", not "in 12d 0h".
  return e.ruleId.startsWith("webull:FEED") || hours === 0
    ? `in ${days}d`
    : `in ${days}d ${hours}h`;
}

/** The line under the headline in the alert list and the toast. */
export function describeWebull(
  e: Pick<AlertEvent, "ruleId" | "snapshot">,
  now: number = Date.now()
): string {
  const s = e.snapshot as Snap;
  const iso = str(s.ends_at);
  const day =
    str(s.ends) ?? (iso ? new Date(iso).toLocaleString("en-GB", { hour12: false }) : null);
  return [webullWhen(e, now), day, str(s.detail)].filter(Boolean).join(" · ");
}
