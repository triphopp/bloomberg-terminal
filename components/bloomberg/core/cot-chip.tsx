"use client";

/**
 * A two-glyph CFTC crowding mark for a quote row: "▼p4" = a crowded net short,
 * "▲p97" = a crowded net long, in the group the flag rule names.
 *
 * Only rows with an active crowding FLAG get one — not every row that maps to a
 * COT contract. The flag rules already pick the group and side that mean
 * something (leveraged-fund shorts in UST futures are mostly basis-trade hedges,
 * so a raw "lev ▲p98" on the 2Y row would read as a bet when it is plumbing).
 */

import { COT_GROUP_LABEL, type CotFlag } from "../hooks/useCot";

export function CotChip({ flags }: { flags: CotFlag[] | undefined }) {
  if (!flags?.length) return null;
  const f = flags[0];
  const color = f.side === "short" ? "#FF5252" : "#4CAF50";
  return (
    <span
      className="shrink-0 tabular-nums"
      style={{ color, fontSize: 8.5, fontWeight: "normal", marginLeft: 4 }}
      title={flags
        .map(
          (x) =>
            `${x.label} — ${COT_GROUP_LABEL[x.group]} ${x.contract_label} z ${x.z >= 0 ? "+" : ""}${x.z.toFixed(
              1
            )} · p${Math.round(x.pct)}\n${x.why}\nCFTC as of Tue ${x.as_of} · released Fri ${x.released} · context only`
        )
        .join("\n\n")}
    >
      {f.side === "short" ? "▼" : "▲"}p{Math.round(f.pct)}
    </span>
  );
}

/** US rate-board row id ("US 10Y") → COT contract key. */
export const COT_KEY_BY_RATE_ID: Record<string, string> = {
  "US 3M": "SOFR3M",
  "US 2Y": "UST2Y",
  "US 5Y": "UST5Y",
  "US 10Y": "UST10Y",
  "US 30Y": "USB",
};
