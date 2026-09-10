"use client";
import { Loader2, Pencil, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type Colors, fmt, pnlColor } from "../helpers";
import { OptionTradeEditModal } from "../modals/OptionTradeEditModal";

// Every option execution, immutable, with the market state captured at it.
//
// The greeks here are NOT today's — they are what the contract looked like the
// moment the trade happened. Spot and IV at a past execution cannot be
// recovered afterwards (a chain only ever reports now), which is why they are
// written at trade time and never recomputed. `unavailable` marks the trades
// that predate this table; those rows stay blank rather than being back-filled
// with today's values pretending to be history.

export interface OptionTrade {
  trade_id: string;
  contract_id: string;
  account_id: string;
  trade_date: string;
  action: "OPEN" | "CLOSE";
  side: "BUY" | "SELL";
  quantity: number;
  price: number | null;
  fees: number;
  close_reason: string | null;
  note: string;
  underlying: string;
  expiry: string;
  strike: number;
  option_type: "call" | "put";
  multiplier: number;
  currency: string;
  occ_symbol: string;
  spot: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  greeks_source: "live" | "manual" | "unavailable" | null;
  quantity_matched: number;
}

const num = (v: number | null | undefined, d: number) =>
  v === null || v === undefined ? "—" : fmt(v, d);

export function OptionTradeLog({ accountId, colors }: { accountId: string; colors: Colors }) {
  const [trades, setTrades] = useState<OptionTrade[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<OptionTrade | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (accountId !== "all") qs.set("account_id", accountId);
      const r = await fetch(`/api/options/trades?${qs}`);
      const d = await r.json();
      setTrades(Array.isArray(d) ? d : []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (t: OptionTrade) => {
    const r = await fetch(`/api/options/trades/${t.trade_id}`, { method: "DELETE" });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      // A matched OPEN cannot be deleted without orphaning the realized P&L
      // that its closes produced — the backend refuses and says why.
      alert(d?.detail ?? d?.error ?? "Delete refused");
      return;
    }
    load();
  };

  const stale = trades.filter((t) => t.greeks_source === "unavailable").length;

  return (
    <div className="p-2">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-bold" style={{ color: colors.accent }}>
          OPTION TRADE LOG
          <span className="ml-2 text-[9px] font-normal" style={{ color: colors.textSecondary }}>
            {trades.length} execution{trades.length === 1 ? "" : "s"} · greeks as captured at each
            trade
          </span>
        </div>
        <button type="button" onClick={load} className="p-0.5 opacity-60 hover:opacity-100">
          {loading ? (
            <Loader2 className="w-3 h-3 animate-spin" style={{ color: colors.textSecondary }} />
          ) : (
            <RefreshCw className="w-3 h-3" style={{ color: colors.textSecondary }} />
          )}
        </button>
      </div>

      {stale > 0 && (
        <div
          className="text-[9px] px-2 py-1 mb-2 rounded border"
          style={{ borderColor: "#f59e0b44", background: "#f59e0b11", color: "#f59e0b" }}
        >
          {stale} trade{stale > 1 ? "s" : ""} carry no greeks — they were recorded before the market
          state was captured at execution, and a chain only reports now, so this cannot be filled in
          after the fact.
        </div>
      )}

      {trades.length === 0 && !loading ? (
        <div className="text-center py-8 text-[10px]" style={{ color: colors.textSecondary }}>
          No option trades yet
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[9px] font-mono">
            <thead>
              <tr className="text-left border-b" style={{ borderColor: colors.border }}>
                {[
                  "Date",
                  "Action",
                  "Contract",
                  "Qty",
                  "Price",
                  "Fees",
                  "Reason",
                  "Spot",
                  "IV",
                  "Δ",
                  "Γ",
                  "Θ",
                  "ν",
                  "ρ",
                  "Note",
                  "",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-1.5 py-1 font-bold text-[8px]"
                    style={{ color: colors.textSecondary }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => {
                const isOpen = t.action === "OPEN";
                const actionColor = isOpen ? "#38bdf8" : "#f59e0b";
                const typeColor = t.option_type === "call" ? "#00FF00" : "#FF4444";
                return (
                  <tr key={t.trade_id} className="border-b" style={{ borderColor: "#1a1a1a" }}>
                    <td className="px-1.5 py-1" style={{ color: colors.textSecondary }}>
                      {t.trade_date}
                    </td>
                    <td className="px-1.5 py-1">
                      <span
                        className="text-[8px] px-1 rounded font-bold"
                        style={{ color: actionColor, border: `1px solid ${actionColor}` }}
                      >
                        {t.action}/{t.side}
                      </span>
                    </td>
                    <td className="px-1.5 py-1" style={{ color: colors.text }}>
                      {t.underlying} <span style={{ color: colors.textSecondary }}>{t.expiry}</span>{" "}
                      {fmt(t.strike, 0)}
                      <span style={{ color: typeColor }}>
                        {t.option_type === "call" ? "C" : "P"}
                      </span>
                    </td>
                    <td className="px-1.5 py-1 text-right" style={{ color: colors.text }}>
                      {t.quantity}
                      {isOpen && t.quantity_matched > 0 && (
                        <span
                          className="text-[8px] ml-0.5"
                          style={{ color: colors.textSecondary }}
                          title="closed against this lot"
                        >
                          (−{t.quantity_matched})
                        </span>
                      )}
                    </td>
                    <td className="px-1.5 py-1 text-right" style={{ color: colors.text }}>
                      {t.price === null ? (
                        <span style={{ color: "#f59e0b" }} title="Closing price was never recorded">
                          unknown
                        </span>
                      ) : (
                        fmt(t.price, 2)
                      )}
                    </td>
                    <td className="px-1.5 py-1 text-right" style={{ color: colors.textSecondary }}>
                      {t.fees ? fmt(t.fees, 2) : "—"}
                    </td>
                    <td className="px-1.5 py-1" style={{ color: colors.textSecondary }}>
                      {t.close_reason ?? "—"}
                    </td>
                    <td className="px-1.5 py-1 text-right" style={{ color: colors.textSecondary }}>
                      {num(t.spot, 2)}
                    </td>
                    <td className="px-1.5 py-1 text-right" style={{ color: colors.textSecondary }}>
                      {t.iv === null ? "—" : `${fmt(t.iv * 100, 1)}%`}
                    </td>
                    <td className="px-1.5 py-1 text-right" style={{ color: colors.text }}>
                      {num(t.delta, 3)}
                    </td>
                    <td className="px-1.5 py-1 text-right" style={{ color: colors.textSecondary }}>
                      {num(t.gamma, 4)}
                    </td>
                    <td
                      className="px-1.5 py-1 text-right"
                      style={{ color: t.theta === null ? colors.textSecondary : pnlColor(t.theta) }}
                    >
                      {num(t.theta, 3)}
                    </td>
                    <td className="px-1.5 py-1 text-right" style={{ color: colors.textSecondary }}>
                      {num(t.vega, 3)}
                    </td>
                    <td className="px-1.5 py-1 text-right" style={{ color: colors.textSecondary }}>
                      {num(t.rho, 3)}
                    </td>
                    <td
                      className="px-1.5 py-1 max-w-[10rem] truncate"
                      style={{ color: colors.textSecondary }}
                      title={t.note}
                    >
                      {t.note || "—"}
                    </td>
                    <td className="px-1.5 py-1 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setEditing(t)}
                        className="p-0.5 mr-0.5 opacity-40 hover:opacity-100"
                        title="Correct a mis-entered value"
                      >
                        <Pencil className="w-2.5 h-2.5" style={{ color: colors.textSecondary }} />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(t)}
                        className="p-0.5 opacity-40 hover:opacity-100 hover:text-red-400"
                        title={
                          isOpen && t.quantity_matched > 0
                            ? "Has closes matched against it — delete those first"
                            : "Delete trade"
                        }
                      >
                        <X className="w-2.5 h-2.5" style={{ color: colors.textSecondary }} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <OptionTradeEditModal
          trade={editing}
          colors={colors}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
