// Sub-ports (Finansia 0153717 / 6065151 / 6065157) — pure, tested in
// __tests__/sub-ports.test.ts. Same rule as backend/sub_port.py, which pools
// average cost per sub-port: two sub-accounts holding one stock are two
// positions, so PORT shows each account's sub-ports as sections of its group.

// Only the FIRST segment is a sub-port — composeNote always writes it first —
// and its name holds no ; ( ) so free text ending in "(…)" is not taken for one.
const SUB_PORT_RE = /^[^();|\n]+\s\(([^()]+)\)$/;

/** The leading tag, e.g. "Finansia (6065151)", and the note without it. */
export function splitNote(note: string | undefined | null): { subPort: string; rest: string } {
  if (!note) return { subPort: "", rest: "" };
  const parts = note
    .split(" | ")
    .map((s) => s.trim())
    .filter(Boolean);
  // A closed row has "\n[SOLD …]" straight after the tag.
  const first = (parts[0] ?? "").split("\n")[0].trim();
  if (!SUB_PORT_RE.test(first) || first.startsWith("VAT:")) return { subPort: "", rest: note };
  const rest = [parts[0].slice(first.length).trim(), ...parts.slice(1)].filter(Boolean).join(" | ");
  return { subPort: first, rest };
}

/** "Finansia (6065151) | …" → "6065151"; "" when the note has no tag. */
export function subPortOf(note: string | undefined | null): string {
  const m = splitNote(note).subPort.match(SUB_PORT_RE);
  return m ? m[1] : "";
}

export interface SubPortSection<T> {
  /** "" = rows without a sub-port */
  sub: string;
  rows: T[];
}

/**
 * One account group's rows, cut into sub-port sections. Only an account with
 * two or more sub-ports is cut — a single tag is a label, not a second book
 * (backend `split_accounts`). Otherwise one section with sub "" holds them all.
 * Sections follow the order their first row appears in, so the group's own
 * sort (biggest cost first) also orders the sections.
 */
export function subPortSections<T extends { note?: string | null }>(
  rows: T[]
): SubPortSection<T>[] {
  const subs = new Set(rows.map((r) => subPortOf(r.note)).filter(Boolean));
  if (subs.size < 2) return [{ sub: "", rows }];
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = subPortOf(r.note);
    if (!out.has(k)) out.set(k, []);
    out.get(k)?.push(r);
  }
  return Array.from(out, ([sub, rs]) => ({ sub, rows: rs }));
}

/** Every sub-port present, sorted — the filter chips. */
export function subPortsIn(rows: { note?: string | null }[]): string[] {
  return [...new Set(rows.map((r) => subPortOf(r.note)).filter(Boolean))].sort();
}
