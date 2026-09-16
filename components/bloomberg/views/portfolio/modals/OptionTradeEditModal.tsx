"use client";
import { Loader2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Colors } from "../helpers";
import { fmt } from "../helpers";
import type { OptionTrade } from "../ui/OptionTradeLog";

// Correcting a mis-entered trade — not recording that something changed in the
// market. Option trades are otherwise immutable, so every edit is written to
// trade_audit_log with a reason, and the backend recomputes any match that
// touches the trade: `realized_pnl` is materialized, so a corrected price that
// is not re-matched would keep reporting the old profit.

interface AuditRow {
  id: number;
  action: string;
  fields_changed: string;
  reason: string;
  created_at: string;
}

export function OptionTradeEditModal({
  trade,
  colors,
  onClose,
  onSaved,
}: {
  trade: OptionTrade;
  colors: Colors;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    trade_date: trade.trade_date,
    price: trade.price === null ? "" : String(trade.price),
    quantity: String(trade.quantity),
    fees: String(trade.fees ?? 0),
    close_reason: trade.close_reason ?? "TRADE",
    note: trade.note ?? "",
    strike: String(trade.strike),
    expiry: trade.expiry,
    underlying: trade.underlying,
    option_type: trade.option_type,
    multiplier: String(trade.multiplier),
    currency: trade.currency,
    reason: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);

  // A trade that closes have already consumed cannot move to a different
  // contract: the match would pair a close on one instrument with an open on
  // another. The backend refuses it; the form says so before you try.
  const isMatched = trade.action === "OPEN" && (trade.quantity_matched ?? 0) > 0;

  const loadAudit = useCallback(async () => {
    try {
      const r = await fetch(`/api/options/trades/${trade.trade_id}/audit-log`);
      if (r.ok) {
        const d = await r.json();
        setAudit(Array.isArray(d) ? d : []);
      }
    } catch {
      /* ignore */
    }
  }, [trade.trade_id]);

  useEffect(() => {
    loadAudit();
  }, [loadAudit]);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    setError("");
    setResult(null);
    try {
      const priceGiven = form.price.trim() !== "";
      const body: Record<string, unknown> = {
        trade_date: form.trade_date,
        quantity: Number.parseFloat(form.quantity),
        fees: Number.parseFloat(form.fees) || 0,
        note: form.note,
        reason: form.reason,
      };
      if (priceGiven) body.price = Number.parseFloat(form.price);
      // An empty price on a close is "we never recorded it", which the backend
      // stores as close_reason UNKNOWN — not as a zero-priced trade.
      else if (trade.action === "CLOSE") {
        body.clear_price = true;
        body.close_reason = "UNKNOWN";
      }
      if (trade.action === "CLOSE" && priceGiven) body.close_reason = form.close_reason;
      if (!isMatched) {
        body.underlying = form.underlying.trim().toUpperCase();
        body.expiry = form.expiry;
        body.strike = Number.parseFloat(form.strike);
        body.option_type = form.option_type;
      }
      body.multiplier = Number.parseFloat(form.multiplier) || 100;
      body.currency = form.currency.trim().toUpperCase();

      const r = await fetch(`/api/options/trades/${trade.trade_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.detail ?? d?.error ?? `HTTP ${r.status}`);
      setResult(
        [
          `${d.matches_recomputed} match(es) revalued`,
          d.contract_changed ? "moved to a different contract" : null,
          d.warning,
        ]
          .filter(Boolean)
          .join(" · ")
      );
      await loadAudit();
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const labelCls = "text-[9px] font-bold mb-0.5 block";
  const inputCls =
    "w-full text-[10px] px-2 py-1 font-mono border rounded bg-transparent outline-none";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.7)" }}
    >
      <div
        className="border rounded w-[46rem] max-w-[95vw] max-h-[85vh] overflow-y-auto"
        style={{ background: "#0a0a0a", borderColor: colors.border }}
      >
        <div
          className="flex items-center justify-between px-3 py-2 border-b"
          style={{ borderColor: colors.border }}
        >
          <div className="text-[11px] font-bold" style={{ color: colors.accent }}>
            EDIT OPTION TRADE
            <span className="ml-2 text-[9px] font-normal" style={{ color: colors.textSecondary }}>
              {trade.action}/{trade.side} · {trade.underlying} {trade.expiry} {fmt(trade.strike, 0)}
              {trade.option_type === "call" ? "C" : "P"}
            </span>
          </div>
          <button type="button" onClick={onClose} className="opacity-60 hover:opacity-100">
            <X className="w-3.5 h-3.5" style={{ color: colors.textSecondary }} />
          </button>
        </div>

        <div className="p-3">
          <div
            className="text-[9px] px-2 py-1 mb-3 rounded border"
            style={{ borderColor: "#f59e0b44", background: "#f59e0b11", color: "#f59e0b" }}
          >
            This corrects a data-entry mistake. Every change is written to the audit log below, and
            any realized P&amp;L computed from this trade is recalculated — a corrected price that
            was not re-matched would keep reporting the old profit.
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
            <div>
              <label
                htmlFor="ote-date"
                className={labelCls}
                style={{ color: colors.textSecondary }}
              >
                Trade date
              </label>
              <input
                id="ote-date"
                type="date"
                className={inputCls}
                style={{ borderColor: colors.border, color: colors.text }}
                value={form.trade_date}
                onChange={(e) => set("trade_date", e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="ote-qty" className={labelCls} style={{ color: colors.textSecondary }}>
                Contracts
              </label>
              <input
                id="ote-qty"
                type="number"
                className={inputCls}
                style={{ borderColor: colors.border, color: colors.text }}
                value={form.quantity}
                onChange={(e) => set("quantity", e.target.value)}
                title={
                  isMatched
                    ? `Cannot go below ${trade.quantity_matched} — that much is already matched`
                    : undefined
                }
              />
              {isMatched && (
                <div className="text-[8px] mt-0.5" style={{ color: "#f59e0b" }}>
                  ≥ {trade.quantity_matched} (already matched)
                </div>
              )}
            </div>
            <div>
              <label
                htmlFor="ote-price"
                className={labelCls}
                style={{ color: colors.textSecondary }}
              >
                Premium
              </label>
              <input
                id="ote-price"
                type="number"
                step="0.01"
                className={inputCls}
                placeholder={trade.action === "CLOSE" ? "blank = unknown" : ""}
                style={{ borderColor: colors.border, color: colors.text }}
                value={form.price}
                onChange={(e) => set("price", e.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="ote-fees"
                className={labelCls}
                style={{ color: colors.textSecondary }}
              >
                Fees
              </label>
              <input
                id="ote-fees"
                type="number"
                step="0.01"
                className={inputCls}
                style={{ borderColor: colors.border, color: colors.text }}
                value={form.fees}
                onChange={(e) => set("fees", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
            <div>
              <label
                htmlFor="ote-underlying"
                className={labelCls}
                style={{ color: colors.textSecondary }}
              >
                Underlying
              </label>
              <input
                id="ote-underlying"
                className={inputCls}
                disabled={isMatched}
                style={{
                  borderColor: colors.border,
                  color: isMatched ? colors.textSecondary : colors.text,
                }}
                value={form.underlying}
                onChange={(e) => set("underlying", e.target.value.toUpperCase())}
              />
            </div>
            <div>
              <label
                htmlFor="ote-expiry"
                className={labelCls}
                style={{ color: colors.textSecondary }}
              >
                Expiry
              </label>
              <input
                id="ote-expiry"
                type="date"
                className={inputCls}
                disabled={isMatched}
                style={{
                  borderColor: colors.border,
                  color: isMatched ? colors.textSecondary : colors.text,
                }}
                value={form.expiry}
                onChange={(e) => set("expiry", e.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="ote-strike"
                className={labelCls}
                style={{ color: colors.textSecondary }}
              >
                Strike
              </label>
              <input
                id="ote-strike"
                type="number"
                className={inputCls}
                disabled={isMatched}
                style={{
                  borderColor: colors.border,
                  color: isMatched ? colors.textSecondary : colors.text,
                }}
                value={form.strike}
                onChange={(e) => set("strike", e.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="ote-type"
                className={labelCls}
                style={{ color: colors.textSecondary }}
              >
                Type
              </label>
              <select
                id="ote-type"
                className={inputCls}
                disabled={isMatched}
                style={{
                  borderColor: colors.border,
                  color: isMatched ? colors.textSecondary : colors.text,
                  background: "#0a0a0a",
                }}
                value={form.option_type}
                onChange={(e) => set("option_type", e.target.value)}
              >
                <option value="call">CALL</option>
                <option value="put">PUT</option>
              </select>
            </div>
          </div>

          {isMatched && (
            <div className="text-[9px] mb-2" style={{ color: "#f59e0b" }}>
              Contract terms are locked: closes are matched against this lot, and moving it to a
              different instrument would pair them across two contracts. Delete the matching close
              first if the contract itself was entered wrong.
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
            <div>
              <label
                htmlFor="ote-mult"
                className={labelCls}
                style={{ color: colors.textSecondary }}
              >
                Multiplier
              </label>
              <input
                id="ote-mult"
                type="number"
                className={inputCls}
                style={{ borderColor: colors.border, color: colors.text }}
                value={form.multiplier}
                onChange={(e) => set("multiplier", e.target.value)}
                title="Belongs to the contract — changing it revalues every trade on that contract, not just this one"
              />
            </div>
            <div>
              <label htmlFor="ote-ccy" className={labelCls} style={{ color: colors.textSecondary }}>
                Currency
              </label>
              <input
                id="ote-ccy"
                className={inputCls}
                style={{ borderColor: colors.border, color: colors.text }}
                value={form.currency}
                onChange={(e) => set("currency", e.target.value.toUpperCase())}
              />
            </div>
            {trade.action === "CLOSE" && (
              <div>
                <label
                  htmlFor="ote-reason"
                  className={labelCls}
                  style={{ color: colors.textSecondary }}
                >
                  Close reason
                </label>
                <select
                  id="ote-reason"
                  className={inputCls}
                  style={{
                    borderColor: colors.border,
                    color: colors.text,
                    background: "#0a0a0a",
                  }}
                  value={form.close_reason}
                  onChange={(e) => set("close_reason", e.target.value)}
                >
                  {["TRADE", "EXPIRED", "EXERCISED", "ASSIGNED", "UNKNOWN"].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className={trade.action === "CLOSE" ? "" : "col-span-2"}>
              <label
                htmlFor="ote-note"
                className={labelCls}
                style={{ color: colors.textSecondary }}
              >
                Note
              </label>
              <input
                id="ote-note"
                className={inputCls}
                style={{ borderColor: colors.border, color: colors.text }}
                value={form.note}
                onChange={(e) => set("note", e.target.value)}
              />
            </div>
          </div>

          <div className="mb-2">
            <label htmlFor="ote-why" className={labelCls} style={{ color: colors.textSecondary }}>
              Why are you changing this? (goes in the audit log)
            </label>
            <input
              id="ote-why"
              className={inputCls}
              placeholder="e.g. entry premium was 6.00, not 5.00"
              style={{ borderColor: colors.border, color: colors.text }}
              value={form.reason}
              onChange={(e) => set("reason", e.target.value)}
            />
          </div>

          {error && <div className="text-[9px] text-red-400 mb-2">{error}</div>}
          {result && (
            <div className="text-[9px] mb-2" style={{ color: "#4ade80" }}>
              Saved — {result}
            </div>
          )}

          <div className="flex items-center gap-2 mb-3">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1 px-3 py-1 text-[9px] font-bold border rounded disabled:opacity-40"
              style={{ borderColor: colors.accent, color: colors.accent }}
            >
              {saving && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
              SAVE
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 text-[9px] border rounded opacity-60 hover:opacity-100"
              style={{ borderColor: colors.border, color: colors.textSecondary }}
            >
              CLOSE
            </button>
          </div>

          {audit.length > 0 && (
            <div className="border-t pt-2" style={{ borderColor: colors.border }}>
              <div className="text-[9px] font-bold mb-1" style={{ color: colors.textSecondary }}>
                AUDIT LOG
              </div>
              <table className="w-full text-[9px] font-mono">
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id} style={{ borderBottom: "1px solid #1a1a1a" }}>
                      <td className="py-0.5 pr-2" style={{ color: colors.textSecondary }}>
                        {a.created_at?.slice(0, 16)}
                      </td>
                      <td className="py-0.5 pr-2" style={{ color: colors.accent }}>
                        {a.action}
                      </td>
                      <td className="py-0.5 pr-2" style={{ color: colors.text }}>
                        {a.fields_changed}
                      </td>
                      <td className="py-0.5" style={{ color: colors.textSecondary }}>
                        {a.reason || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
