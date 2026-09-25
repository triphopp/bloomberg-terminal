"use client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { StockCard } from "../accounting-types";
import type { Colors } from "../helpers";

const number = (value: number | null, digits = 2) =>
  value == null
    ? "—"
    : value.toLocaleString("en-US", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });

export function StockCardModal({
  accountId,
  symbol,
  colors,
  onClose,
}: {
  accountId: string;
  symbol: string;
  colors: Colors;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [method, setMethod] = useState<"AVCO" | "FIFO">("AVCO");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const { data, error, isFetching } = useQuery<StockCard>({
    queryKey: ["portfolio-stock-card", accountId, symbol, method],
    queryFn: async ({ signal }) => {
      const qs = new URLSearchParams({ account_id: accountId, symbol, method });
      const r = await fetch(`/api/v2/portfolio/ledger/stock-card?${qs}`, { signal });
      const body = await r.json();
      if (!r.ok) throw new Error(body.detail || "Stock card failed");
      return body;
    },
    staleTime: 30_000,
  });
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      className="m-auto p-0 border w-[1100px] max-w-[95vw] max-h-[90vh] backdrop:bg-black/75 font-mono"
      style={{ background: "#090909", borderColor: colors.border, color: colors.text }}
      aria-label={`Stock card ${symbol}`}
    >
      <div className="flex flex-col max-h-[88vh]">
        <div
          className="shrink-0 flex items-center gap-3 px-4 py-3 border-b"
          style={{ borderColor: colors.border }}
        >
          <strong className="text-xs" style={{ color: colors.accent }}>
            STOCK CARD · {symbol} · {accountId}
          </strong>
          {(["AVCO", "FIFO"] as const).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => setMethod(m)}
              aria-pressed={method === m}
              className="border px-2 py-1 text-[10px]"
              style={{
                borderColor: method === m ? colors.accent : colors.border,
                color: method === m ? colors.accent : colors.textSecondary,
              }}
            >
              {m}
            </button>
          ))}
          <button
            type="button"
            className="ml-auto px-2"
            aria-label="Close stock card"
            onClick={() => dialog.current?.close()}
          >
            ✕
          </button>
        </div>
        <p className="shrink-0 px-4 py-2 text-[10px]" style={{ color: colors.textSecondary }}>
          PREVIEW · Rebuilt from recorded transactions. Compare with broker statements before
          choosing a cost method.
        </p>
        {isFetching && <p className="px-4 py-2 text-xs">Loading…</p>}
        {error && (
          <p role="alert" className="px-4 py-2 text-xs text-red-400">
            {error.message}
          </p>
        )}
        {data && (
          <>
            <div className="shrink-0 flex flex-wrap gap-5 px-4 py-2 text-[10px]">
              <span>
                {data.currency} · COST IN {number(data.cost_in)}
              </span>
              <span>COST OUT {number(data.cost_out)}</span>
              <span>
                REMAINING {number(data.remaining_cost)} / {number(data.remaining_qty, 6)} units
              </span>
              <span>REALIZED {number(data.realized)}</span>
            </div>
            <div className="flex-1 overflow-auto min-h-0">
              <table className="w-full text-[10px] whitespace-nowrap">
                <thead className="sticky top-0 bg-[#111]">
                  <tr>
                    {[
                      "DATE",
                      "TYPE",
                      "QTY IN",
                      "QTY OUT",
                      "PRICE",
                      "COST IN",
                      "COST OUT",
                      "BAL QTY",
                      "BAL COST",
                      "AVG",
                      "REALIZED",
                    ].map((h) => (
                      <th key={h} className="text-right p-2">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr
                      key={r.event.id}
                      className="border-t"
                      style={{ borderColor: colors.border }}
                      title={r.allocations
                        .map(
                          (a) =>
                            `${a.buy_event_id.slice(0, 8)}: ${number(a.qty, 6)} units / ${number(a.cost)}`
                        )
                        .join("\n")}
                    >
                      <td className="p-2">{r.event.trade_date}</td>
                      <td className="p-2">{r.event.type}</td>
                      {(
                        [
                          ["qty_in", r.qty_in || null, 6],
                          ["qty_out", r.qty_out || null, 6],
                          ["price", r.event.price, 2],
                          ["cost_in", r.cost_in || null, 2],
                          ["cost_out", r.cost_out || null, 2],
                          ["bal_qty", r.bal_qty, 6],
                          ["bal_cost", r.bal_cost, 2],
                          ["avg", r.avg, 6],
                          ["realized", r.realized, 2],
                        ] as const
                      ).map(([col, v, digits]) => (
                        <td key={col} className="p-2 text-right">
                          {number(v, digits)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.findings.length > 0 && (
              <div className="shrink-0 max-h-28 overflow-auto px-4 py-2 text-[10px] text-amber-300">
                {data.findings.map((f, i) => (
                  <p key={`${f.code}-${i}`}>
                    {f.code} · {f.message}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}
