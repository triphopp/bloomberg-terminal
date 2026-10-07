// Lots received in kind when a portfolio was taken over are carried at the
// transfer price (fair value that day), so the entry column shows a number the
// previous owner never paid. The hover text of that one cell gives the old cost
// back. Pure, tested in __tests__/takeover-hint.test.ts.

export interface TransferLot {
  acquisition_type?: string | null;
  original_price_entry?: number | null;
  transfer_price_entry?: number | null;
  price_entry: number;
  date_entry: string;
  volume: number;
}

/** Dotted underline on a price that has a hint — the only sign that hovering shows more. */
export const TRANSFER_PX = "cursor-help underline decoration-dotted underline-offset-2";

const isTransfer = (l: TransferLot) =>
  l.acquisition_type === "TRANSFER_IN" && l.original_price_entry != null;

/**
 * Hover text for an entry price — null when no lot was transferred in, so every
 * other row keeps the title it had. `px` / `qty` format a price and a quantity
 * the way the cell does (currency sign, display currency).
 */
export function transferCostHint(
  lots: TransferLot[],
  px: (n: number) => string,
  qty: (n: number) => string
): string | null {
  const moved = lots.filter(isTransfer);
  if (moved.length === 0) return null;
  const line = (l: TransferLot) =>
    `transferred in ${l.date_entry} at ${px(l.transfer_price_entry ?? l.price_entry)}`;
  if (moved.length === 1 && lots.length === 1) {
    const l = moved[0];
    return `Previous owner's cost ${px(l.original_price_entry as number)} — ${line(l)}`;
  }
  const vol = moved.reduce((s, l) => s + l.volume, 0);
  const avg = moved.reduce((s, l) => s + (l.original_price_entry as number) * l.volume, 0) / vol;
  const scope =
    moved.length === lots.length
      ? `average of ${moved.length} lots`
      : `${moved.length} of ${lots.length} lots were transferred in`;
  return [
    `Previous owner's cost ${px(avg)} (${scope})`,
    ...moved.map((l) => `${qty(l.volume)} × ${px(l.original_price_entry as number)} — ${line(l)}`),
  ].join("\n");
}
