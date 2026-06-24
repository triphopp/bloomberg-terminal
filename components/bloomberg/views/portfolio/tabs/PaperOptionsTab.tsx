"use client";
import { Loader2, RefreshCw, Send, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fmt, fmtK, fmtPct, pnlColor } from "../helpers";
import type { Colors } from "../helpers";

interface PaperAccount {
  id: string;
  name: string;
  currency: string;
}

interface OptionPosition {
  id: string;
  underlying: string;
  expiry: string;
  strike: number;
  option_type: string;
  quantity: number;
  entry_price: number;
  entry_date: string;
  status: string;
  commission: number;
  exit_price?: number;
  realized_pnl?: number;
  notes: string;
  spot_price?: number;
  live_price?: number;
  market_value?: number;
  unrealized_pnl?: number;
  unrealized_pnl_pct?: number;
  dte?: number;
  direction: string;
}

interface ClosedOption extends OptionPosition {
  exit_date?: string;
}

type SubView = "positions" | "trade" | "closed";

export function PaperOptionsTab({ colors }: { colors: Colors }) {
  const [accounts, setAccounts] = useState<PaperAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [subView, setSubView] = useState<SubView>("positions");
  const [positions, setPositions] = useState<OptionPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<ClosedOption[]>([]);
  const [loading, setLoading] = useState(false);

  // Trade form
  const [underlying, setUnderlying] = useState("");
  const [expiry, setExpiry] = useState("");
  const [strike, setStrike] = useState("");
  const [optionType, setOptionType] = useState<"call" | "put">("call");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState("1");
  const [limitPrice, setLimitPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const loadPositions = useCallback(
    async (signal?: AbortSignal) => {
      if (!accountId) return;
      setLoading(true);
      try {
        const [openR, closedR] = await Promise.all([
          fetch(`/api/paper/accounts/${accountId}/options`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
          fetch(`/api/paper/accounts/${accountId}/options/closed`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
        ]);
        setPositions(Array.isArray(openR) ? openR : []);
        setClosedPositions(Array.isArray(closedR) ? closedR : []);
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      } finally {
        setLoading(false);
      }
    },
    [accountId]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: accountId covered by loadPositions deps
  useEffect(() => {
    const ac = new AbortController();
    loadPositions(ac.signal);
    return () => ac.abort();
  }, [accountId, loadPositions]);

  const submitOrder = async () => {
    setError(null);
    setResult(null);
    if (!accountId || !underlying || !expiry || !strike || !quantity) {
      setError("Fill all required fields");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        account_id: accountId,
        underlying: underlying.toUpperCase(),
        expiry,
        strike: Number.parseFloat(strike),
        option_type: optionType,
        side,
        quantity: Number.parseInt(quantity),
        notes,
      };
      if (limitPrice) body.limit_price = Number.parseFloat(limitPrice);

      const r = await fetch("/api/paper/options/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.detail || "Order failed");
        return;
      }

      const action = d.action || "done";
      const priceStr = d.fill_price ? ` @ $${fmt(d.fill_price, 2)}` : "";
      setResult(
        `${action.toUpperCase()}: ${underlying.toUpperCase()} ${optionType} ${strike}${priceStr}`
      );
      setUnderlying("");
      setExpiry("");
      setStrike("");
      setLimitPrice("");
      setNotes("");
      loadPositions();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const closePosition = async (posId: string) => {
    try {
      const r = await fetch(`/api/paper/options/${posId}/close`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        alert(d.detail || "Close failed");
        return;
      }
      loadPositions();
    } catch {
      /* */
    }
  };

  const expirePosition = async (posId: string) => {
    try {
      const r = await fetch(`/api/paper/options/${posId}/expire`, { method: "POST" });
      if (!r.ok) {
        alert("Expire failed");
        return;
      }
      loadPositions();
    } catch {
      /* */
    }
  };

  const inputCls = "bg-transparent border px-1.5 py-0.5 text-[9px] font-mono";
  const inputStyle = { borderColor: colors.border, color: colors.text };

  const totalUnrealized = positions.reduce((s, p) => s + (p.unrealized_pnl || 0), 0);
  const totalValue = positions.reduce(
    (s, p) => s + (p.market_value ? Math.abs(p.market_value) : 0),
    0
  );

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
          className={inputCls}
          style={inputStyle}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {(["positions", "trade", "closed"] as const).map((t) => (
          <button
            type="button"
            key={t}
            className="px-2 py-0.5 text-[9px] font-bold"
            style={{
              color: subView === t ? colors.accent : colors.textSecondary,
              borderBottom: subView === t ? `1px solid ${colors.accent}` : "1px solid transparent",
            }}
            onClick={() => setSubView(t)}
          >
            {t === "positions"
              ? `OPEN (${positions.length})`
              : t === "trade"
                ? "NEW ORDER"
                : `CLOSED (${closedPositions.length})`}
          </button>
        ))}
        <span className="text-[8px] ml-1" style={{ color: pnlColor(totalUnrealized) }}>
          Unreal: {fmtK(totalUnrealized)}
        </span>
        <button type="button" className="ml-auto p-0.5" onClick={() => loadPositions()}>
          {loading ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: colors.textSecondary }} />
          ) : (
            <RefreshCw className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ── Trade form ── */}
        {subView === "trade" && (
          <div className="p-2 space-y-1.5">
            <div className="border p-2" style={{ borderColor: colors.border }}>
              <div className="text-[8px] font-bold opacity-50 mb-1">OPTION ORDER</div>
              <div className="flex items-center gap-1 flex-wrap">
                <input
                  placeholder="UNDERLYING"
                  value={underlying}
                  onChange={(e) => setUnderlying(e.target.value)}
                  className={`${inputCls} w-16 uppercase`}
                  style={inputStyle}
                />

                <input
                  placeholder="EXPIRY"
                  type="date"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                  className={`${inputCls} w-28`}
                  style={inputStyle}
                />

                <input
                  placeholder="STRIKE"
                  value={strike}
                  onChange={(e) => setStrike(e.target.value)}
                  className={`${inputCls} w-16`}
                  style={inputStyle}
                  type="number"
                />

                <div className="flex border" style={{ borderColor: colors.border }}>
                  {(["call", "put"] as const).map((t) => (
                    <button
                      type="button"
                      key={t}
                      className="px-2 py-0.5 text-[9px] font-bold"
                      style={{
                        background:
                          optionType === t ? (t === "call" ? "#0066CC" : "#CC6600") : "transparent",
                        color: optionType === t ? "#fff" : colors.textSecondary,
                      }}
                      onClick={() => setOptionType(t)}
                    >
                      {t.toUpperCase()}
                    </button>
                  ))}
                </div>

                <div className="flex border" style={{ borderColor: colors.border }}>
                  {(["buy", "sell"] as const).map((s) => (
                    <button
                      type="button"
                      key={s}
                      className="px-2 py-0.5 text-[9px] font-bold"
                      style={{
                        background:
                          side === s ? (s === "buy" ? "#00AA00" : "#CC0000") : "transparent",
                        color: side === s ? "#fff" : colors.textSecondary,
                      }}
                      onClick={() => setSide(s)}
                    >
                      {s === "buy" ? "BUY (LONG)" : "SELL (SHORT)"}
                    </button>
                  ))}
                </div>

                <input
                  placeholder="QTY"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className={`${inputCls} w-12`}
                  style={inputStyle}
                  type="number"
                  min="1"
                />

                <input
                  placeholder="Limit $ (opt)"
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                  className={`${inputCls} w-20`}
                  style={inputStyle}
                  type="number"
                />
              </div>

              <div className="flex items-center gap-1 mt-1">
                <input
                  placeholder="Notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className={`${inputCls} flex-1`}
                  style={inputStyle}
                />

                <button
                  type="button"
                  onClick={submitOrder}
                  disabled={submitting}
                  className="flex items-center gap-0.5 px-3 py-0.5 text-[9px] font-bold"
                  style={{
                    background: side === "buy" ? "#00AA00" : "#CC0000",
                    color: "#fff",
                  }}
                >
                  {submitting ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <Send className="h-2.5 w-2.5" />
                  )}
                  {side === "buy" ? "BUY" : "SELL (WRITE)"}
                </button>
              </div>

              {result && (
                <div className="text-[9px] mt-1" style={{ color: "#00FF00" }}>
                  {result}
                </div>
              )}
              {error && (
                <div className="text-[9px] mt-1" style={{ color: "#FF4444" }}>
                  {error}
                </div>
              )}

              <div className="text-[7px] opacity-30 mt-1">
                BUY = long (pay premium) · SELL = short/write (receive premium, unlimited risk on
                calls) · 1 contract = 100 shares · Commission: $0.65/contract
              </div>
            </div>
          </div>
        )}

        {/* ── Open positions ── */}
        {subView === "positions" &&
          (positions.length === 0 ? (
            <div className="flex items-center justify-center h-full opacity-30 text-xs">
              No open option positions
            </div>
          ) : (
            <table className="w-full text-[9px]">
              <thead className="sticky top-0" style={{ background: "#0a0a0a" }}>
                <tr className="text-left" style={{ color: colors.textSecondary }}>
                  <th className="px-2 py-1">UNDERLYING</th>
                  <th className="px-1">TYPE</th>
                  <th className="px-1 text-right">STRIKE</th>
                  <th className="px-1">EXPIRY</th>
                  <th className="px-1 text-right">DTE</th>
                  <th className="px-1">DIR</th>
                  <th className="px-1 text-right">QTY</th>
                  <th className="px-1 text-right">ENTRY</th>
                  <th className="px-1 text-right">LIVE</th>
                  <th className="px-1 text-right">P&L</th>
                  <th className="px-1 text-right">P&L %</th>
                  <th className="px-1" />
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b hover:bg-white/5"
                    style={{ borderColor: `${colors.border}44` }}
                  >
                    <td className="px-2 py-0.5 font-bold" style={{ color: colors.accent }}>
                      {p.underlying}
                      {p.spot_price && (
                        <span className="ml-1 opacity-40 font-normal">${fmt(p.spot_price)}</span>
                      )}
                    </td>
                    <td
                      className="px-1"
                      style={{
                        color: p.option_type === "call" ? "#4488FF" : "#FF8844",
                      }}
                    >
                      {p.option_type.toUpperCase()}
                    </td>
                    <td className="px-1 text-right font-mono">{fmt(p.strike)}</td>
                    <td className="px-1 font-mono opacity-60">{p.expiry}</td>
                    <td
                      className="px-1 text-right font-mono"
                      style={{
                        color:
                          p.dte != null && p.dte <= 7
                            ? "#FF4444"
                            : p.dte != null && p.dte <= 21
                              ? "#ff9900"
                              : colors.text,
                      }}
                    >
                      {p.dte ?? "—"}
                    </td>
                    <td
                      className="px-1 font-bold"
                      style={{
                        color: p.direction === "LONG" ? "#00FF00" : "#FF4444",
                      }}
                    >
                      {p.direction}
                    </td>
                    <td className="px-1 text-right font-mono">{Math.abs(p.quantity)}</td>
                    <td className="px-1 text-right font-mono">${fmt(p.entry_price, 2)}</td>
                    <td className="px-1 text-right font-mono">
                      {p.live_price ? `$${fmt(p.live_price, 2)}` : "—"}
                    </td>
                    <td
                      className="px-1 text-right font-mono"
                      style={{ color: pnlColor(p.unrealized_pnl) }}
                    >
                      {p.unrealized_pnl != null ? fmtK(p.unrealized_pnl) : "—"}
                    </td>
                    <td
                      className="px-1 text-right font-mono"
                      style={{ color: pnlColor(p.unrealized_pnl_pct) }}
                    >
                      {p.unrealized_pnl_pct != null ? fmtPct(p.unrealized_pnl_pct) : "—"}
                    </td>
                    <td className="px-1 flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => closePosition(p.id)}
                        className="px-1 py-0.5 text-[8px] border hover:opacity-80"
                        style={{ borderColor: colors.border, color: "#ff9900" }}
                        title="Close at market"
                      >
                        CLOSE
                      </button>
                      {p.dte != null && p.dte <= 0 && (
                        <button
                          type="button"
                          onClick={() => expirePosition(p.id)}
                          className="px-1 py-0.5 text-[8px] border hover:opacity-80"
                          style={{ borderColor: colors.border, color: "#FF4444" }}
                          title="Expire / Exercise"
                        >
                          EXP
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}

        {/* ── Closed positions ── */}
        {subView === "closed" &&
          (closedPositions.length === 0 ? (
            <div className="flex items-center justify-center h-full opacity-30 text-xs">
              No closed option trades
            </div>
          ) : (
            <table className="w-full text-[9px]">
              <thead className="sticky top-0" style={{ background: "#0a0a0a" }}>
                <tr className="text-left" style={{ color: colors.textSecondary }}>
                  <th className="px-2 py-1">UNDERLYING</th>
                  <th className="px-1">TYPE</th>
                  <th className="px-1 text-right">STRIKE</th>
                  <th className="px-1">EXPIRY</th>
                  <th className="px-1 text-right">QTY</th>
                  <th className="px-1 text-right">ENTRY</th>
                  <th className="px-1 text-right">EXIT</th>
                  <th className="px-1 text-right">P&L</th>
                  <th className="px-1">STATUS</th>
                </tr>
              </thead>
              <tbody>
                {closedPositions.map((p) => (
                  <tr key={p.id} className="border-b" style={{ borderColor: `${colors.border}44` }}>
                    <td className="px-2 py-0.5 font-bold" style={{ color: colors.accent }}>
                      {p.underlying}
                    </td>
                    <td
                      className="px-1"
                      style={{
                        color: p.option_type === "call" ? "#4488FF" : "#FF8844",
                      }}
                    >
                      {p.option_type.toUpperCase()}
                    </td>
                    <td className="px-1 text-right font-mono">{fmt(p.strike)}</td>
                    <td className="px-1 font-mono opacity-60">{p.expiry}</td>
                    <td className="px-1 text-right font-mono">{p.quantity}</td>
                    <td className="px-1 text-right font-mono">${fmt(p.entry_price, 2)}</td>
                    <td className="px-1 text-right font-mono">
                      {p.exit_price != null ? `$${fmt(p.exit_price, 2)}` : "—"}
                    </td>
                    <td
                      className="px-1 text-right font-mono"
                      style={{ color: pnlColor(p.realized_pnl) }}
                    >
                      {p.realized_pnl != null ? fmtK(p.realized_pnl) : "—"}
                    </td>
                    <td
                      className="px-1 font-bold text-[8px]"
                      style={{
                        color:
                          p.status === "closed"
                            ? "#ff9900"
                            : p.status === "exercised"
                              ? "#00FF00"
                              : "#FF4444",
                      }}
                    >
                      {p.status.toUpperCase()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </div>
    </div>
  );
}
