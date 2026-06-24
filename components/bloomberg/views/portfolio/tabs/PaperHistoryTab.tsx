"use client";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fmt } from "../helpers";
import type { Colors } from "../helpers";

interface PaperAccount {
  id: string;
  name: string;
  currency: string;
}

interface Order {
  id: string;
  symbol: string;
  side: string;
  order_type: string;
  quantity: number;
  limit_price?: number;
  stop_price?: number;
  status: string;
  filled_qty: number;
  filled_price?: number;
  filled_at?: string;
  created_at: string;
}

interface Fill {
  id: string;
  order_id: string;
  symbol: string;
  side: string;
  order_type: string;
  quantity: number;
  price: number;
  commission: number;
  filled_at: string;
}

type SubTab = "orders" | "fills";

export function PaperHistoryTab({ colors }: { colors: Colors }) {
  const [accounts, setAccounts] = useState<PaperAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [subTab, setSubTab] = useState<SubTab>("orders");
  const [orders, setOrders] = useState<Order[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);
  const [loading, setLoading] = useState(false);

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

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!accountId) return;
      setLoading(true);
      try {
        const [or, fr] = await Promise.all([
          fetch(`/api/paper/accounts/${accountId}/orders`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
          fetch(`/api/paper/accounts/${accountId}/fills`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
        ]);
        setOrders(Array.isArray(or) ? or : []);
        setFills(Array.isArray(fr) ? fr : []);
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      } finally {
        setLoading(false);
      }
    },
    [accountId]
  );

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const statusColor = (s: string) => {
    if (s === "filled") return "#00FF00";
    if (s === "cancelled" || s === "expired") return "#FF4444";
    return "#ff9900";
  };

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ fontSize: 10 }}>
      {/* Header */}
      <div
        className="flex items-center gap-1 px-2 py-1 border-b shrink-0"
        style={{ borderColor: colors.border }}
      >
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="bg-transparent border px-1 py-0.5 text-[9px]"
          style={{ borderColor: colors.border, color: colors.text }}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {(["orders", "fills"] as const).map((t) => (
          <button
            type="button"
            key={t}
            className="px-2 py-0.5 text-[9px] font-bold"
            style={{
              color: subTab === t ? colors.accent : colors.textSecondary,
              borderBottom: subTab === t ? `1px solid ${colors.accent}` : "1px solid transparent",
            }}
            onClick={() => setSubTab(t)}
          >
            {t.toUpperCase()} ({t === "orders" ? orders.length : fills.length})
          </button>
        ))}
        <button type="button" className="ml-auto p-0.5" onClick={() => load()}>
          {loading ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: colors.textSecondary }} />
          ) : (
            <RefreshCw className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
          )}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {subTab === "orders" ? (
          orders.length === 0 ? (
            <div className="flex items-center justify-center h-full opacity-30 text-xs">
              No orders
            </div>
          ) : (
            <table className="w-full text-[9px]">
              <thead className="sticky top-0" style={{ background: "#0a0a0a" }}>
                <tr className="text-left" style={{ color: colors.textSecondary }}>
                  <th className="px-2 py-1">TIME</th>
                  <th className="px-1">SYMBOL</th>
                  <th className="px-1">SIDE</th>
                  <th className="px-1">TYPE</th>
                  <th className="px-1 text-right">QTY</th>
                  <th className="px-1 text-right">PRICE</th>
                  <th className="px-1 text-right">FILLED</th>
                  <th className="px-1">STATUS</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b" style={{ borderColor: `${colors.border}44` }}>
                    <td className="px-2 py-0.5 opacity-50 font-mono">
                      {o.created_at?.slice(5, 16)}
                    </td>
                    <td className="px-1 font-bold" style={{ color: colors.accent }}>
                      {o.symbol}
                    </td>
                    <td
                      className="px-1"
                      style={{ color: o.side === "buy" ? "#00FF00" : "#FF4444" }}
                    >
                      {o.side.toUpperCase()}
                    </td>
                    <td className="px-1 opacity-60">{o.order_type.toUpperCase()}</td>
                    <td className="px-1 text-right font-mono">{o.quantity}</td>
                    <td className="px-1 text-right font-mono">
                      {o.limit_price
                        ? fmt(o.limit_price)
                        : o.stop_price
                          ? fmt(o.stop_price)
                          : "MKT"}
                    </td>
                    <td className="px-1 text-right font-mono">
                      {o.filled_price ? `${o.filled_qty} @ ${fmt(o.filled_price)}` : "—"}
                    </td>
                    <td className="px-1 font-bold" style={{ color: statusColor(o.status) }}>
                      {o.status.toUpperCase()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : fills.length === 0 ? (
          <div className="flex items-center justify-center h-full opacity-30 text-xs">No fills</div>
        ) : (
          <table className="w-full text-[9px]">
            <thead className="sticky top-0" style={{ background: "#0a0a0a" }}>
              <tr className="text-left" style={{ color: colors.textSecondary }}>
                <th className="px-2 py-1">TIME</th>
                <th className="px-1">SYMBOL</th>
                <th className="px-1">SIDE</th>
                <th className="px-1 text-right">QTY</th>
                <th className="px-1 text-right">PRICE</th>
                <th className="px-1 text-right">COMMISSION</th>
                <th className="px-1 text-right">NOTIONAL</th>
              </tr>
            </thead>
            <tbody>
              {fills.map((f) => (
                <tr key={f.id} className="border-b" style={{ borderColor: `${colors.border}44` }}>
                  <td className="px-2 py-0.5 opacity-50 font-mono">{f.filled_at?.slice(5, 16)}</td>
                  <td className="px-1 font-bold" style={{ color: colors.accent }}>
                    {f.symbol}
                  </td>
                  <td className="px-1" style={{ color: f.side === "buy" ? "#00FF00" : "#FF4444" }}>
                    {f.side.toUpperCase()}
                  </td>
                  <td className="px-1 text-right font-mono">{f.quantity}</td>
                  <td className="px-1 text-right font-mono">{fmt(f.price, 4)}</td>
                  <td className="px-1 text-right font-mono opacity-50">{fmt(f.commission)}</td>
                  <td className="px-1 text-right font-mono">{fmt(f.quantity * f.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
