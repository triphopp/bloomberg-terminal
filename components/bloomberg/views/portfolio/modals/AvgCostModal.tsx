"use client";
import { X } from "lucide-react";
import { useState } from "react";
import { type Colors, fmt } from "../helpers";

interface Props {
  accountId: string;
  symbol: string;
  currentAvg: number;
  volume: number;
  currency: string;
  existingOverride?: number;
  colors: Colors;
  onClose: () => void;
  onSaved: () => void;
}

export function AvgCostModal({
  accountId,
  symbol,
  currentAvg,
  volume,
  currency,
  existingOverride,
  colors,
  onClose,
  onSaved,
}: Props) {
  const [newAvg, setNewAvg] = useState(existingOverride?.toString() ?? "");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const sym = currency === "USD" ? "$" : "฿";
  const parsed = Number.parseFloat(newAvg);
  const valid = !Number.isNaN(parsed) && parsed > 0;
  const delta = valid ? parsed - currentAvg : null;
  const newCostBasis = valid ? parsed * volume : null;

  const handleSave = async () => {
    if (!valid) return;
    setSaving(true);
    setErr("");
    try {
      const r = await fetch("/api/v2/portfolio/cost-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId, symbol, avg_cost: parsed, reason }),
      });
      if (!r.ok) throw new Error(await r.text());
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      await fetch(`/api/v2/portfolio/cost-overrides/${accountId}/${symbol}`, { method: "DELETE" });
      onSaved();
      onClose();
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  };

  const iCls = "w-full px-2 py-1 text-[10px] font-mono border mt-0.5 outline-none";
  const iSty = { borderColor: colors.border, color: colors.text, background: "#050505" };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.75)" }}
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="presentation"
    >
      <div
        className="border p-4 w-[360px]"
        style={{ background: "#0a0a0a", borderColor: "#f59e0b" }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        // biome-ignore lint/a11y/useSemanticElements: styled div modal, not native dialog
        role="dialog"
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold tracking-widest" style={{ color: "#f59e0b" }}>
            SET AVG COST — {symbol}
          </h3>
          <button type="button" onClick={onClose}>
            <X className="h-3 w-3" style={{ color: colors.textSecondary }} />
          </button>
        </div>

        {/* Current info */}
        <div
          className="border p-2 mb-3 text-[9px] font-mono"
          style={{ borderColor: colors.border }}
        >
          <div className="flex justify-between">
            <span style={{ color: colors.textSecondary }}>Computed avg</span>
            <span style={{ color: colors.text }}>
              {sym}
              {fmt(currentAvg, 4)}
            </span>
          </div>
          {existingOverride !== undefined && (
            <div className="flex justify-between">
              <span style={{ color: "#f59e0b" }}>Current override</span>
              <span style={{ color: "#f59e0b" }}>
                {sym}
                {fmt(existingOverride, 4)}
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span style={{ color: colors.textSecondary }}>Volume</span>
            <span style={{ color: colors.text }}>{volume}</span>
          </div>
        </div>

        <div className="mb-2">
          <label
            htmlFor="avg-input"
            className="text-[8px] font-mono"
            style={{ color: colors.textSecondary }}
          >
            TARGET AVG COST ({currency})
          </label>
          <input
            id="avg-input"
            type="number"
            step="any"
            className={iCls}
            style={{ ...iSty, borderColor: valid ? "#f59e0b55" : colors.border }}
            placeholder="e.g. 1089.3570"
            value={newAvg}
            onChange={(e) => setNewAvg(e.target.value)}
          />
        </div>

        {/* Live delta */}
        {valid && delta !== null && (
          <div
            className="text-[9px] font-mono mb-2 px-1"
            style={{ color: delta >= 0 ? "#f87171" : "#4ade80" }}
          >
            {delta >= 0 ? "▲" : "▼"} {sym}
            {fmt(Math.abs(delta), 4)} per share
            {newCostBasis !== null && (
              <span style={{ color: colors.textSecondary }}>
                {" "}
                · New cost basis: {sym}
                {fmt(newCostBasis, 2)}
              </span>
            )}
          </div>
        )}

        <div className="mb-3">
          <label
            htmlFor="avg-reason"
            className="text-[8px] font-mono"
            style={{ color: colors.textSecondary }}
          >
            REASON
          </label>
          <input
            id="avg-reason"
            className={iCls}
            style={iSty}
            placeholder="e.g. corrected after partial sell, broker statement"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        {err && (
          <div className="text-[9px] mb-2 font-mono" style={{ color: "#f87171" }}>
            {err}
          </div>
        )}

        <div className="flex gap-2">
          {existingOverride !== undefined && (
            <button
              type="button"
              onClick={handleClear}
              disabled={saving}
              className="text-[9px] px-3 py-1.5 border font-bold"
              style={{ borderColor: "#55555566", color: "#888" }}
            >
              CLEAR OVERRIDE
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-[9px] px-3 py-1.5 border font-bold ml-auto"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            CANCEL
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!valid || saving}
            className="text-[9px] px-3 py-1.5 border font-bold"
            style={{
              borderColor: valid ? "#f59e0b" : "#555",
              color: valid ? "#f59e0b" : "#555",
              background: "#f59e0b10",
              opacity: saving ? 0.5 : 1,
            }}
          >
            {saving ? "SAVING..." : "SAVE"}
          </button>
        </div>
      </div>
    </div>
  );
}
