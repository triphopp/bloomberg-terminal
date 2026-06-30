"use client";
import { X } from "lucide-react";
import { useCallback, useState } from "react";
import { type Colors, fmt, fmtK } from "../helpers";
import type { Trade } from "../types";

interface Props {
  target: Trade;
  avgEntry?: number; // weighted avg across all lots (position-level)
  allLots?: Trade[]; // all open lots — enables multi-lot full sell
  colors: Colors;
  onClose: () => void;
  onSold: () => void;
}

export function SellModal({ target, avgEntry, allLots, colors, onClose, onSold }: Props) {
  const effectiveAvgEntry = avgEntry ?? target.price_entry;
  const positionVolume = allLots ? allLots.reduce((s, l) => s + l.volume, 0) : target.volume;

  const [sellPrice, setSellPrice] = useState(
    target.current_price != null
      ? Number.parseFloat(target.current_price.toFixed(4)).toString()
      : ""
  );
  const [sellVolume, setSellVolume] = useState(positionVolume.toString());
  const [sellDate, setSellDate] = useState(new Date().toISOString().slice(0, 10));
  const [sellPartial, setSellPartial] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSell = useCallback(async () => {
    if (!sellDate) return;
    const price = Number.parseFloat(sellPrice);
    if (!price || price <= 0) return;
    if (sellPartial) {
      const vol = Number.parseFloat(sellVolume);
      if (!vol || vol <= 0 || vol > positionVolume) return;
    }
    setLoading(true);
    try {
      const isMultiLot = allLots && allLots.length > 1;
      if (!sellPartial && isMultiLot) {
        // Close every lot individually so all are marked sold
        for (const lot of allLots) {
          const r = await fetch("/api/v2/portfolio/sell", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              trade_id: lot.id,
              sell_volume: 0,
              sell_price: price,
              sell_date: sellDate,
            }),
          });
          if (!r.ok) throw new Error(await r.text());
        }
      } else {
        const vol = sellPartial ? Number.parseFloat(sellVolume) : 0;
        const r = await fetch("/api/v2/portfolio/sell", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            trade_id: target.id,
            sell_volume: vol,
            sell_price: price,
            sell_date: sellDate,
          }),
        });
        if (!r.ok) throw new Error(await r.text());
      }
      onSold();
      onClose();
    } catch (e) {
      alert(`Sell failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }, [
    target,
    allLots,
    positionVolume,
    sellPrice,
    sellVolume,
    sellDate,
    sellPartial,
    onSold,
    onClose,
  ]);

  const sellDisabled =
    loading ||
    !sellDate ||
    !sellPrice ||
    Number.parseFloat(sellPrice) <= 0 ||
    (sellPartial &&
      (!sellVolume ||
        Number.parseFloat(sellVolume) <= 0 ||
        Number.parseFloat(sellVolume) > positionVolume));

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.7)" }}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        role="presentation"
        className="border p-4 w-[360px] max-h-[90vh] overflow-y-auto"
        style={{ background: "#0a0a0a", borderColor: colors.border }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold tracking-widest" style={{ color: "#f87171" }}>
            SELL {target.symbol}
          </h3>
          <button type="button" onClick={onClose} className="p-0.5 hover:opacity-70">
            <X className="h-3 w-3" style={{ color: colors.textSecondary }} />
          </button>
        </div>

        {/* Position summary */}
        <div
          className="text-[9px] font-mono mb-3 p-2 border"
          style={{ borderColor: colors.border, background: "#050505" }}
        >
          <div className="flex justify-between">
            <span style={{ color: colors.textSecondary }}>Position</span>
            <span style={{ color: colors.text }}>
              {target.symbol} × {positionVolume.toLocaleString()}
              {allLots && allLots.length > 1 && (
                <span
                  className="ml-1 text-[7px] px-1 rounded"
                  style={{ background: "#f59e0b22", color: "#f59e0b" }}
                >
                  {allLots.length} lots
                </span>
              )}
            </span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: colors.textSecondary }}>Avg Entry</span>
            <span style={{ color: colors.text }}>
              {target.acc_currency === "USD" ? "$" : "฿"}
              {fmt(effectiveAvgEntry, 4)}
            </span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: colors.textSecondary }}>Current</span>
            <span
              style={{
                color:
                  target.current_price != null && target.current_price >= effectiveAvgEntry
                    ? "#4ade80"
                    : "#f87171",
              }}
            >
              {target.current_price != null
                ? `${target.acc_currency === "USD" ? "$" : "฿"}${fmt(target.current_price, 4)}`
                : "—"}
            </span>
          </div>
        </div>

        {/* Partial toggle */}
        <label
          className="flex items-center gap-2 mb-3 cursor-pointer text-[9px] font-mono"
          style={{ color: sellPartial ? "#ff9900" : colors.textSecondary }}
        >
          <input
            type="checkbox"
            className="w-3 h-3"
            checked={sellPartial}
            onChange={(e) => setSellPartial(e.target.checked)}
          />
          PARTIAL SELL
        </label>

        {sellPartial && (
          <div className="mb-2">
            <label
              htmlFor="sell-volume"
              className="text-[8px] font-mono"
              style={{ color: colors.textSecondary }}
            >
              Sell Volume (remaining: {positionVolume.toLocaleString()})
            </label>
            <input
              id="sell-volume"
              type="number"
              step="any"
              className="w-full px-2 py-1 text-[10px] font-mono border mt-0.5 outline-none"
              style={{ background: "#050505", borderColor: colors.border, color: colors.text }}
              value={sellVolume}
              onChange={(e) => setSellVolume(e.target.value)}
              placeholder="e.g. 1000"
            />
          </div>
        )}

        {/* Sell price */}
        <div className="mb-2">
          <label
            htmlFor="sell-price"
            className="text-[8px] font-mono"
            style={{ color: colors.textSecondary }}
          >
            Sell Price
          </label>
          <input
            id="sell-price"
            type="number"
            step="any"
            className="w-full px-2 py-1 text-[10px] font-mono border mt-0.5 outline-none"
            style={{ background: "#050505", borderColor: colors.border, color: colors.text }}
            value={sellPrice}
            onChange={(e) => {
              const v = e.target.value;
              const dot = v.indexOf(".");
              setSellPrice(
                dot >= 0 && v.length - dot - 1 > 4 ? Number.parseFloat(v).toFixed(4) : v
              );
            }}
            placeholder="e.g. 185.50"
          />
        </div>

        {/* Sell date */}
        <div className="mb-3">
          <label
            htmlFor="sell-date"
            className="text-[8px] font-mono"
            style={{ color: colors.textSecondary }}
          >
            Sell Date
          </label>
          <input
            id="sell-date"
            type="date"
            className="w-full px-2 py-1 text-[10px] font-mono border mt-0.5 outline-none"
            style={{ background: "#050505", borderColor: colors.border, color: colors.text }}
            value={sellDate}
            onChange={(e) => setSellDate(e.target.value)}
          />
        </div>

        {/* P&L preview */}
        {sellPrice && (
          <div
            className="text-[9px] font-mono mb-3 p-2 border"
            style={{ borderColor: colors.border, background: "#050505" }}
          >
            <div className="flex justify-between">
              <span style={{ color: colors.textSecondary }}>Est. P&L</span>
              {(() => {
                const ep = Number.parseFloat(sellPrice) || 0;
                const vol = sellPartial ? Number.parseFloat(sellVolume) || 0 : positionVolume;
                const pnl = (ep - effectiveAvgEntry) * vol;
                return (
                  <span className="font-bold" style={{ color: pnl >= 0 ? "#4ade80" : "#f87171" }}>
                    {pnl >= 0 ? "+" : ""}
                    {fmt(pnl, 2)} {target.acc_currency === "USD" ? "USD" : "THB"}
                  </span>
                );
              })()}
            </div>
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-[9px] px-3 py-1.5 border font-bold"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            CANCEL
          </button>
          <button
            type="button"
            onClick={handleSell}
            disabled={sellDisabled}
            className="text-[9px] px-3 py-1.5 border font-bold"
            style={{
              borderColor: "#ef444466",
              color: sellDisabled ? "#555" : "#f87171",
              background: "#ef444410",
              opacity: sellDisabled ? 0.5 : 1,
            }}
          >
            {loading ? "..." : sellPartial ? "SELL PARTIAL" : "SELL ALL"}
          </button>
        </div>
      </div>
    </div>
  );
}
