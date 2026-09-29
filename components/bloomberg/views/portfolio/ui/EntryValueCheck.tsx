"use client";

/**
 * ENTRY — the order as the broker slip prints it, recomputed from the form.
 *
 * Laid out in the slip's own order (total, price · quantity, share value,
 * commission, VAT) so a slip read by OCR can be checked line against line
 * instead of re-multiplying by hand. Share value is price × quantity; the total
 * adds the fees on a buy and takes them off on a sell.
 *
 * Fee lines come from, in order: the slip that filled the form (while its fee
 * is still the one in the field), a fee typed by hand (one line — its split is
 * unknown), or the broker estimate the backend will apply to a blank field.
 */

import type { FeeEstimate } from "../accounting-types";
import { type Colors, fmtAmt, fmtPx, fmtQty } from "../helpers";

const FEE_LABEL: Record<string, string> = {
  commission: "COMMISSION",
  vat: "VAT",
  sec_fee: "SEC FEE",
  taf_fee: "TAF FEE",
};

export function EntryValueCheck({
  side,
  symbol,
  price,
  qty,
  fee,
  estimate,
  slipItems,
  currency,
  colors,
}: {
  side: "buy" | "sell";
  symbol: string;
  price: string;
  qty: string;
  /** The fee field as typed ("" = blank, the estimate applies). */
  fee: string;
  estimate: FeeEstimate | null;
  /** Slip line items, only while the slip's fee is still the typed one. */
  slipItems: Record<string, string> | null;
  currency: string;
  colors: Colors;
}) {
  const px = Number.parseFloat(price);
  const q = Number.parseFloat(qty);
  if (!(px > 0) || !(q > 0)) return null;

  const gross = px * q;
  let source: "slip" | "typed" | "est." | null = null;
  let lines: [string, number][] = [];
  if (slipItems && Object.keys(slipItems).length > 0) {
    source = "slip";
    lines = Object.entries(slipItems)
      .map(([k, v]) => [FEE_LABEL[k] ?? k.toUpperCase(), Number.parseFloat(v)] as [string, number])
      .filter(([, v]) => Number.isFinite(v));
  } else if (fee !== "") {
    source = "typed";
    lines = [["FEES", Number.parseFloat(fee) || 0]];
  } else if (estimate?.total != null) {
    source = "est.";
    lines = (
      [
        ["COMMISSION", estimate.commission],
        ["VAT", estimate.vat],
        ["SEC FEE", estimate.sec_fee],
        ["TAF FEE", estimate.taf_fee],
      ] as [string, number | undefined][]
    ).filter((l): l is [string, number] => l[1] != null && (l[1] !== 0 || l[0] === "VAT"));
  }
  const fees = lines.reduce((s, [, v]) => s + v, 0);
  const total = side === "buy" ? gross + fees : gross - fees;
  const buy = side === "buy";
  const sideColor = buy ? "#4ade80" : "#f87171";
  const ccy = currency ? ` ${currency}` : "";

  const row = (label: string, value: string, color?: string, bold = false) => (
    <div key={label} className="flex items-baseline justify-between gap-3">
      <span style={{ color: colors.textSecondary }}>{label}</span>
      <span
        className={bold ? "font-bold" : undefined}
        style={{ color: color ?? colors.text, fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </span>
    </div>
  );

  return (
    <div
      className="border px-3 py-2 text-[10px] font-mono"
      style={{ borderColor: `${sideColor}55`, background: `${sideColor}08` }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-bold" style={{ color: sideColor }}>
          {buy ? "BUY" : "SELL"} {symbol.toUpperCase()}
        </span>
        <span className="text-[8px] tracking-wider" style={{ color: colors.textSecondary }}>
          CHECK VS SLIP
        </span>
      </div>
      <div
        className="mt-0.5 text-[15px] font-bold"
        style={{ color: sideColor, fontVariantNumeric: "tabular-nums" }}
      >
        {fmtAmt(total)}
        {ccy}
      </div>
      <div className="text-[8px] mb-1.5" style={{ color: colors.textSecondary }}>
        {buy ? "total paid = value + fees" : "net proceeds = value − fees"}
      </div>
      <div className="grid grid-cols-2 gap-x-4 mb-1.5">
        <div>
          <div className="text-[8px]" style={{ color: colors.textSecondary }}>
            PRICE
          </div>
          <div className="font-bold" style={{ fontVariantNumeric: "tabular-nums" }}>
            {fmtPx(px)}
            {ccy}
          </div>
        </div>
        <div>
          <div className="text-[8px]" style={{ color: colors.textSecondary }}>
            QUANTITY
          </div>
          <div className="font-bold" style={{ fontVariantNumeric: "tabular-nums" }}>
            {fmtQty(q)}
          </div>
        </div>
      </div>
      <div className="space-y-0.5 border-t pt-1.5" style={{ borderColor: colors.border }}>
        {row("SHARE VALUE (px × qty)", `${fmtAmt(gross)}${ccy}`)}
        {lines.map(([label, v]) => row(label, `${fmtAmt(v)}${ccy}`))}
        {source && (
          <div className="text-[8px] text-right" style={{ color: colors.textSecondary }}>
            fees: {source === "slip" ? "from slip" : source === "typed" ? "typed" : "broker estimate"}
          </div>
        )}
      </div>
    </div>
  );
}
