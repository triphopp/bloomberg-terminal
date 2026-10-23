/**
 * Time-axis labels: a month tick carries its number as a small subscript
 * ("Mar₃", "Nov₁₁") so the month reads at a glance without counting from
 * January. The axis is plain canvas text, so a Unicode subscript is the only
 * way to set the number smaller than the name.
 *
 * Every other tick (year, day, time) returns null — lightweight-charts' own
 * label, unchanged.
 */

import type { Time } from "lightweight-charts";

/** `TickMarkType.Month` — the enum is not imported so this stays runnable under `node --test`. */
const MONTH_TICK = 1;

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

function subscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUBSCRIPT[Number(d)])
    .join("");
}

/** Year and 1-based month of a chart time, read in UTC as the axis itself does. */
function yearMonth(time: Time): { year: number; month: number } | null {
  if (typeof time === "number") {
    const d = new Date(time * 1000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  }
  if (typeof time === "string") {
    const m = /^(\d{4})-(\d{2})/.exec(time);
    return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
  }
  return { year: time.year, month: time.month };
}

export function tickMarkFormatter(time: Time, tickMarkType: number, locale: string): string | null {
  if (tickMarkType !== MONTH_TICK) return null;
  const ym = yearMonth(time);
  if (!ym) return null;
  const name = new Date(Date.UTC(ym.year, ym.month - 1, 1)).toLocaleString(locale, {
    month: "short",
    timeZone: "UTC",
  });
  return `${name}${subscript(ym.month)}`;
}
