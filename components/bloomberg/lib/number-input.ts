// Typing numbers with thousands separators (PORT ENTRY / CASH forms).
//
// The field shows "1,234,567.8912" while the form state keeps "1234567.8912":
// the separators are display only, so nothing downstream parses a comma. What
// was typed is never rounded — a quantity of 0.0012345 stays 0.0012345
// (CLAUDE.md number-format house rule).

/** Keep what a number can be made of: digits, one ".", a leading "-". Commas,
 *  spaces and anything else typed or pasted are dropped. */
export function sanitizeNumber(typed: string, allowNegative = true): string {
  let out = "";
  let dot = false;
  for (const ch of typed) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "." && !dot) {
      out += ch;
      dot = true;
    } else if (ch === "-" && allowNegative && out === "") out = "-";
  }
  return out;
}

/** "1234567.8912" → "1,234,567.8912". Leaves the fraction, a trailing "." and
 *  a lone "-" exactly as typed, so the caret never fights the user. */
export function groupNumber(raw: string): string {
  const neg = raw.startsWith("-");
  const body = neg ? raw.slice(1) : raw;
  const dot = body.indexOf(".");
  const int = dot === -1 ? body : body.slice(0, dot);
  const frac = dot === -1 ? "" : body.slice(dot);
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac}`;
}

/** A form value (string or number) as the raw text to edit. */
export function toRawNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    // 1e-7 would print as "1e-7": spell it out, then trim the zeros.
    const s = String(value);
    return s.includes("e") ? value.toFixed(12).replace(/\.?0+$/, "") : s;
  }
  return sanitizeNumber(value);
}

/** Whether the text being typed already stands for `value` — "12." and "12",
 *  "0.0" and 0, "" and "" are the same number, so the field keeps what the
 *  user is in the middle of typing instead of snapping back. */
export function sameNumber(raw: string, value: string | number | null | undefined): boolean {
  const n = (x: string) => {
    const v = Number.parseFloat(x);
    return Number.isFinite(v) ? v : 0;
  };
  return n(raw) === n(toRawNumber(value));
}

/** Characters that carry meaning (digits, ".", "-") left of a caret position —
 *  separators and stray letters, which sanitizeNumber drops, do not count. */
export function significantBefore(text: string, caret: number): number {
  let n = 0;
  for (const ch of text.slice(0, caret))
    if ((ch >= "0" && ch <= "9") || ch === "." || ch === "-") n++;
  return n;
}

/** Caret index in `display` that sits after `count` meaningful characters. */
export function caretAfter(display: string, count: number): number {
  if (count <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < display.length; i++) {
    if (display[i] !== ",") seen++;
    if (seen === count) return i + 1;
  }
  return display.length;
}
