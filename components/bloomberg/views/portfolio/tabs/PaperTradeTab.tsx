"use client";
import { Loader2, Send, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fmt, pnlColor } from "../helpers";
import type { Colors } from "../helpers";

interface PaperAccount {
  id: string;
  name: string;
  currency: string;
}
interface PendingOrder {
  id: string;
  symbol: string;
  side: string;
  order_type: string;
  quantity: number;
  limit_price?: number;
  stop_price?: number;
  status: string;
  created_at: string;
}

export function PaperTradeTab({ colors }: { colors: Colors }) {
  const [accounts, setAccounts] = useState<PaperAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit" | "stop" | "stop_limit">("market");
  const [quantity, setQuantity] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/paper/accounts", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const list = Array.isArray(d) ? d : [];
        setAccounts(list);
        if (list.length > 0) setAccountId((prev) => prev || list[0].id);
      })
      .catch((e) => {
        if (e?.name === "AbortError") return;
      });
    return () => ac.abort();
  }, []);

  const loadPending = useCallback(
    async (signal?: AbortSignal) => {
      if (!accountId) return;
      try {
        const r = await fetch(`/api/paper/accounts/${accountId}/orders?status=pending`, { signal });
        if (!r.ok) throw new Error();
        setPendingOrders(await r.json());
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      }
    },
    [accountId]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: accountId covered by loadPending deps
  useEffect(() => {
    const ac = new AbortController();
    loadPending(ac.signal);
    return () => ac.abort();
  }, [accountId, loadPending]);

  const submit = async () => {
    setError(null);
    setResult(null);
    if (!accountId || !symbol || !quantity) {
      setError("Fill required fields");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        account_id: accountId,
        symbol: symbol.toUpperCase(),
        side,
        order_type: orderType,
        quantity: Number.parseFloat(quantity),
      };
      if (limitPrice) body.limit_price = Number.parseFloat(limitPrice);
      if (stopPrice) body.stop_price = Number.parseFloat(stopPrice);

      const r = await fetch("/api/paper/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.detail || "Order failed");
        return;
      }
      if (d.status === "filled") {
        setResult(`Filled ${symbol.toUpperCase()} × ${quantity} @ ${fmt(d.filled_price, 4)}`);
      } else {
        setResult(`Order pending: ${d.order_id}`);
      }
      setSymbol("");
      setQuantity("");
      setLimitPrice("");
      setStopPrice("");
      loadPending();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const cancelOrder = async (orderId: string) => {
    await fetch(`/api/paper/orders/${orderId}/cancel`, { method: "POST" });
    loadPending();
  };

  const inputCls = "bg-transparent border px-1.5 py-0.5 text-[9px] font-mono";
  const inputStyle = { borderColor: colors.border, color: colors.text };

  return (
    <div className="flex flex-col h-full overflow-y-auto p-2 gap-2" style={{ fontSize: 10 }}>
      {/* Order form */}
      <div className="border p-2 space-y-1.5" style={{ borderColor: colors.border }}>
        <div className="text-[8px] font-bold opacity-50 mb-1">PLACE ORDER</div>

        <div className="flex items-center gap-1 flex-wrap">
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className={inputCls}
            style={inputStyle}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>

          <input
            placeholder="SYMBOL"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className={`${inputCls} w-20 uppercase`}
            style={inputStyle}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />

          <div className="flex border" style={{ borderColor: colors.border }}>
            {(["buy", "sell"] as const).map((s) => (
              <button
                type="button"
                key={s}
                className="px-2 py-0.5 text-[9px] font-bold"
                style={{
                  background: side === s ? (s === "buy" ? "#00AA00" : "#CC0000") : "transparent",
                  color: side === s ? "#fff" : colors.textSecondary,
                }}
                onClick={() => setSide(s)}
              >
                {s.toUpperCase()}
              </button>
            ))}
          </div>

          <select
            value={orderType}
            onChange={(e) => setOrderType(e.target.value as typeof orderType)}
            className={inputCls}
            style={inputStyle}
          >
            <option value="market">MARKET</option>
            <option value="limit">LIMIT</option>
            <option value="stop">STOP</option>
            <option value="stop_limit">STOP LIMIT</option>
          </select>

          <input
            placeholder="QTY"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className={`${inputCls} w-16`}
            style={inputStyle}
            type="number"
          />

          {(orderType === "limit" || orderType === "stop_limit") && (
            <input
              placeholder="Limit $"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              className={`${inputCls} w-20`}
              style={inputStyle}
              type="number"
            />
          )}
          {(orderType === "stop" || orderType === "stop_limit") && (
            <input
              placeholder="Stop $"
              value={stopPrice}
              onChange={(e) => setStopPrice(e.target.value)}
              className={`${inputCls} w-20`}
              style={inputStyle}
              type="number"
            />
          )}

          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="flex items-center gap-0.5 px-3 py-0.5 text-[9px] font-bold"
            style={{ background: side === "buy" ? "#00AA00" : "#CC0000", color: "#fff" }}
          >
            {submitting ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <Send className="h-2.5 w-2.5" />
            )}
            {side === "buy" ? "BUY" : "SELL"}
          </button>
        </div>

        {result && (
          <div className="text-[9px]" style={{ color: "#00FF00" }}>
            {result}
          </div>
        )}
        {error && (
          <div className="text-[9px]" style={{ color: "#FF4444" }}>
            {error}
          </div>
        )}
      </div>

      {/* Pending orders */}
      <div className="border flex-1 overflow-y-auto" style={{ borderColor: colors.border }}>
        <div
          className="text-[8px] font-bold opacity-50 px-2 py-1 border-b"
          style={{ borderColor: colors.border }}
        >
          PENDING ORDERS ({pendingOrders.length})
        </div>
        {pendingOrders.length === 0 ? (
          <div className="text-center py-4 opacity-30 text-[9px]">No pending orders</div>
        ) : (
          <table className="w-full text-[9px]">
            <thead>
              <tr
                className="text-left opacity-50"
                style={{ borderBottom: `1px solid ${colors.border}` }}
              >
                <th className="px-2 py-0.5">SYMBOL</th>
                <th className="px-1">SIDE</th>
                <th className="px-1">TYPE</th>
                <th className="px-1 text-right">QTY</th>
                <th className="px-1 text-right">PRICE</th>
                <th className="px-1">TIME</th>
                <th className="px-1" />
              </tr>
            </thead>
            <tbody>
              {pendingOrders.map((o) => (
                <tr key={o.id} className="border-b" style={{ borderColor: `${colors.border}44` }}>
                  <td className="px-2 py-0.5 font-bold">{o.symbol}</td>
                  <td className="px-1" style={{ color: o.side === "buy" ? "#00FF00" : "#FF4444" }}>
                    {o.side.toUpperCase()}
                  </td>
                  <td className="px-1 opacity-60">{o.order_type.toUpperCase()}</td>
                  <td className="px-1 text-right">{o.quantity}</td>
                  <td className="px-1 text-right font-mono">
                    {o.limit_price ? fmt(o.limit_price) : o.stop_price ? fmt(o.stop_price) : "—"}
                  </td>
                  <td className="px-1 opacity-40">{o.created_at?.slice(5, 16)}</td>
                  <td className="px-1">
                    <button
                      type="button"
                      onClick={() => cancelOrder(o.id)}
                      className="hover:opacity-80"
                      style={{ color: "#FF4444" }}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
