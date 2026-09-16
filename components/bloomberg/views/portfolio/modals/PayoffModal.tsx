"use client";
import { X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Colors } from "../helpers";
import { fmt, fmtK, pnlColor } from "../helpers";
import type { OptionLot } from "../tabs/OptionsTab";
import { PayoffChart } from "../ui/PayoffChart";
import { type PayoffLeg, usePayoff } from "../ui/usePayoff";

// Combined by default, because the payoff of one leg of a spread is not the
// payoff of the position — a hedge looks like a pure loss on its own. The
// toggle keeps the single-lot view for when that is the actual question.

export function PayoffModal({
  lot,
  allLots,
  colors,
  onClose,
}: {
  lot: OptionLot;
  allLots: OptionLot[];
  colors: Colors;
  onClose: () => void;
}) {
  const siblings = useMemo(
    () => allLots.filter((l) => l.underlying === lot.underlying),
    [allLots, lot.underlying]
  );
  const [combined, setCombined] = useState(siblings.length > 1);

  const shown = useMemo(() => (combined ? siblings : [lot]), [combined, siblings, lot]);

  const legs: PayoffLeg[] = useMemo(
    () =>
      shown.map((l) => ({
        underlying: l.underlying,
        expiry: l.expiry,
        strike: l.strike,
        option_type: l.option_type,
        quantity: l.quantity, // signed — shorts carry their own direction
        entry_price: l.entry_price,
        multiplier: l.multiplier,
        fees: 0, // entry fees live on the trade, not the lot view
      })),
    [shown]
  );

  const { payoff, loading } = usePayoff(legs, { debounceMs: 0 });

  // What the book says right now, from the same marks the positions table uses.
  const markPnl = shown.reduce((a, l) => a + (l.unrealized_pnl_usd ?? 0), 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.7)" }}
    >
      <div
        className="border rounded w-[54rem] max-w-[95vw] max-h-[88vh] overflow-y-auto"
        style={{ background: "#0a0a0a", borderColor: colors.border }}
      >
        <div
          className="flex items-center justify-between px-3 py-2 border-b"
          style={{ borderColor: colors.border }}
        >
          <div className="text-[11px] font-bold" style={{ color: colors.accent }}>
            PAYOFF · {lot.underlying}
            <span className="ml-2 text-[9px] font-normal" style={{ color: colors.textSecondary }}>
              {shown.length} leg{shown.length === 1 ? "" : "s"} · USD
              {loading && " · loading"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {siblings.length > 1 && (
              <button
                type="button"
                onClick={() => setCombined((c) => !c)}
                className="px-2 py-0.5 text-[8px] font-bold border rounded"
                style={{
                  borderColor: combined ? colors.accent : colors.border,
                  color: combined ? colors.accent : colors.textSecondary,
                }}
                title={
                  combined
                    ? "Showing every lot on this underlying together — click for this lot alone"
                    : "Showing this lot alone — click to combine every lot on this underlying"
                }
              >
                {combined ? `COMBINED (${siblings.length})` : "THIS LOT ONLY"}
              </button>
            )}
            <button type="button" onClick={onClose} className="opacity-60 hover:opacity-100">
              <X className="w-3.5 h-3.5" style={{ color: colors.textSecondary }} />
            </button>
          </div>
        </div>

        <div className="p-3">
          <PayoffChart data={payoff} colors={colors} height={280} />

          <div className="mt-3 border-t pt-2" style={{ borderColor: colors.border }}>
            <div className="flex items-center gap-4 mb-1 text-[10px] font-mono">
              <span>
                <span style={{ color: colors.textSecondary }}>MARKED NOW </span>
                <span style={{ color: pnlColor(markPnl) }}>
                  {markPnl >= 0 ? "+" : "-"}${fmtK(Math.abs(markPnl))}
                </span>
              </span>
              {payoff?.current.pnl_today != null && (
                <span title="What the model says the position is worth at today's spot — compare with MARKED NOW, which uses the actual quoted premium. A gap means the quote is stale or the chain's IV disagrees with the last trade.">
                  <span style={{ color: colors.textSecondary }}>MODEL AT SPOT </span>
                  <span style={{ color: pnlColor(payoff.current.pnl_today) }}>
                    {payoff.current.pnl_today >= 0 ? "+" : "-"}$
                    {fmtK(Math.abs(payoff.current.pnl_today))}
                  </span>
                </span>
              )}
              <span title="What this position would be worth if the underlying stopped here and expiry were today — the value with all remaining time value stripped out">
                <span style={{ color: colors.textSecondary }}>IF EXPIRED AT SPOT </span>
                <span style={{ color: pnlColor(payoff?.current.pnl_if_expired_now ?? 0) }}>
                  {(payoff?.current.pnl_if_expired_now ?? 0) >= 0 ? "+" : "-"}$
                  {fmtK(Math.abs(payoff?.current.pnl_if_expired_now ?? 0))}
                </span>
              </span>
            </div>

            <table className="w-full text-[9px] font-mono mt-2">
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {["CONTRACT", "QTY", "ENTRY", "MARK", "Δ", "UNREALIZED"].map((h) => (
                    <th
                      key={h}
                      className={h === "CONTRACT" ? "text-left py-0.5" : "text-right py-0.5"}
                      style={{ color: colors.textSecondary }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => (
                  <tr
                    key={l.id}
                    style={{
                      borderBottom: "1px solid #1a1a1a",
                      background: l.id === lot.id && combined ? `${colors.accent}0d` : undefined,
                    }}
                  >
                    <td className="py-0.5" style={{ color: colors.text }}>
                      {l.expiry} {fmt(l.strike, 0)}
                      <span style={{ color: l.option_type === "call" ? "#00FF00" : "#FF4444" }}>
                        {l.option_type === "call" ? "C" : "P"}
                      </span>
                    </td>
                    <td className="text-right py-0.5" style={{ color: colors.text }}>
                      {l.quantity}
                    </td>
                    <td className="text-right py-0.5" style={{ color: colors.textSecondary }}>
                      ${fmt(l.entry_price, 2)}
                    </td>
                    <td className="text-right py-0.5" style={{ color: colors.text }}>
                      ${fmt(l.mark, 2)}
                    </td>
                    <td className="text-right py-0.5" style={{ color: colors.textSecondary }}>
                      {l.delta === null ? "—" : fmt(l.delta, 3)}
                    </td>
                    <td
                      className="text-right py-0.5"
                      style={{ color: pnlColor(l.unrealized_pnl_usd) }}
                    >
                      {l.unrealized_pnl_usd >= 0 ? "+" : "-"}${fmtK(Math.abs(l.unrealized_pnl_usd))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {payoff?.model_note && (
              <div className="text-[8px] mt-2" style={{ color: colors.textSecondary }}>
                {payoff.model_note}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
