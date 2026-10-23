/**
 * RRG quadrant colours and the sector → quadrant lookup, for every surface that
 * shows where a group sits on MKT → STRUCTURE → ROT (the table, the map, the
 * members list, PORT's position rows).
 *
 * The palette has no green and no red on purpose: across the app green/red
 * mean up/down. PORT tints a position's row by its sector's quadrant while the
 * P&L in that row stays green/red, so a quadrant colour must never be read as a
 * gain or a loss. Lagging is grey — a group the market has stopped favouring,
 * not a losing one. One palette everywhere, so a colour means the same quadrant
 * on ROT and on PORT.
 */

export type Quadrant = "Leading" | "Improving" | "Weakening" | "Lagging";

export const QUAD_COLOR: Record<Quadrant, string> = {
  Leading: "#22d3ee",
  Improving: "#a78bfa",
  Weakening: "#fbbf24",
  Lagging: "#94a3b8",
};

export const QUADRANTS: Quadrant[] = ["Leading", "Improving", "Weakening", "Lagging"];

/** A ROT table row, as far as this module needs it. */
export interface QuadrantRow {
  id: string;
  name: string;
  kind: string;
  quadrant: Quadrant | null;
  mom_dir: "up" | "down" | null;
}

export interface SectorQuadrant {
  quadrant: Quadrant;
  momDir: "up" | "down" | null;
  /** The ROT group it was read from: "XLV" or the SET code "ENERG". */
  groupId: string;
  groupName: string;
  market: "US" | "TH";
}

const norm = (s: string) => s.trim().toUpperCase();

/**
 * sector label → its ROT group's quadrant.
 *
 * PORT stores a US holding's sector as its GICS name ("Health Care") and a Thai
 * holding's as its SET code ("ENERG", "PROP") — the same names the ROT rows
 * carry: a US sector row is "Health Care (XLV)", a TH row's id is the SET code.
 * Only sectors are matched (US themes and SET industry groups are not a
 * holding's sector). Anything else — "ETF", "CRYPTO", "Other", blank — has no
 * quadrant, and gets none rather than a guess.
 */
export function sectorQuadrants(
  usRows: QuadrantRow[] | undefined,
  thRows: QuadrantRow[] | undefined
): Map<string, SectorQuadrant> {
  const out = new Map<string, SectorQuadrant>();
  for (const r of usRows ?? []) {
    if (r.kind !== "sector" || !r.quadrant) continue;
    const gics = r.name.replace(/\s*\([^)]*\)\s*$/, "");
    out.set(norm(gics), {
      quadrant: r.quadrant,
      momDir: r.mom_dir,
      groupId: r.id,
      groupName: gics,
      market: "US",
    });
  }
  for (const r of thRows ?? []) {
    if (r.kind !== "sector" || !r.quadrant) continue;
    out.set(norm(r.id), {
      quadrant: r.quadrant,
      momDir: r.mom_dir,
      groupId: r.id,
      groupName: r.name,
      market: "TH",
    });
  }
  return out;
}

export function quadrantOf(
  map: Map<string, SectorQuadrant>,
  sector: string | null | undefined
): SectorQuadrant | null {
  if (!sector) return null;
  return map.get(norm(sector)) ?? null;
}

export interface HoldingQuadrant extends SectorQuadrant {
  /** "SET" = placed by the exchange's own sector for that symbol; "label" = by
   *  the sector typed on the trade (US holdings, and Thai ones the SET list lacks). */
  basis: "SET" | "label";
}

/**
 * A holding's quadrant. A Thai share (`XXX.BK`) is placed by the SET's sector
 * for its symbol (`setSectorOf`, from the ROT TH table) — the label on a trade
 * is typed by hand and can be wrong (TASCO filed as CONS when the SET lists it
 * under CONMAT). Everything else, and a Thai symbol the SET list does not hold
 * (DRs, warrants), falls back to the label.
 */
export function holdingQuadrant(
  map: Map<string, SectorQuadrant>,
  setSectorOf: Record<string, string> | undefined,
  sector: string | null | undefined,
  yfSymbol: string | null | undefined
): HoldingQuadrant | null {
  const m = /^(.+)\.BK$/i.exec((yfSymbol ?? "").trim());
  const official = m && setSectorOf ? setSectorOf[m[1].toUpperCase()] : undefined;
  if (official) {
    const q = quadrantOf(map, official);
    return q ? { ...q, basis: "SET" } : null;
  }
  const q = quadrantOf(map, sector);
  return q ? { ...q, basis: "label" } : null;
}

/** `#rrggbb` + alpha (0–1) → `rgba(…)`. */
export function quadrantTint(q: Quadrant, alpha: number): string {
  const hex = QUAD_COLOR[q].slice(1);
  const n = Number.parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
