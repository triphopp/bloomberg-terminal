"use client";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type Colors, fmtK, pnlColor } from "../helpers";
import type { CashAdjustment, Summary } from "../types";

interface Props {
  summary: Summary;
  currency: "THB" | "USD";
  colors: Colors;
  /** Pre-selected account; "all" or unknown falls back to the first account. */
  accountId?: string;
  onClose: () => void;
}

/**
 * EDIT for idle cash. The balance on screen is derived from the trade log, so
 * the user types what the broker actually shows and the backend stores the
 * DIFFERENCE. Later buys and sells keep moving the derived part; the offset
 * rides along — that is what makes this an edit rather than a frozen override.
 */
export function CashReconcileModal({ summary, currency, colors, accountId, onClose }: Props) {
  const qc = useQueryClient();
  const accounts = summary.accounts;
  const [selected, setSelected] = useState(
    accounts.find((a) => a.account.id === accountId)?.account.id ?? accounts[0]?.account.id ?? ""
  );
  const stat = accounts.find((a) => a.account.id === selected);
  const current = stat?.cash_base ?? 0;
  const [actual, setActual] = useState<string>(current.toFixed(2));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [category, setCategory] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<CashAdjustment[]>([]);
  const sym = currency === "THB" ? "฿" : "$";
  const money = (n: number, ccy = currency) =>
    `${n < 0 ? "-" : ""}${ccy === "THB" ? "฿" : "$"}${fmtK(Math.abs(n))}`;

  const loadHistory = useCallback(async () => {
    if (!selected) return;
    try {
      const r = await fetch(`/api/v2/portfolio/cash/adjustments?account_id=${selected}`);
      if (r.ok) setHistory(await r.json());
    } catch {
      /* history is secondary — the form still works */
    }
  }, [selected]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // Seed the input on account switch only — a background summary refetch must
  // not overwrite a number the user is halfway through typing.
  const selectAccount = (id: string) => {
    setSelected(id);
    setActual((accounts.find((a) => a.account.id === id)?.cash_base ?? 0).toFixed(2));
  };

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["portfolio", "summary"] }),
      loadHistory(),
    ]);
  };

  const parsed = Number.parseFloat(actual);
  const delta = Number.isFinite(parsed) ? parsed - current : 0;

  const save = async () => {
    if (!selected || !Number.isFinite(parsed)) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/v2/portfolio/cash/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: selected,
          actual_balance: parsed,
          currency,
          date,
          note,
          category,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.detail ?? d.error ?? `HTTP ${r.status}`);
        return;
      }
      setNote("");
      setCategory("");
      await refresh();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  const undo = async (id: string) => {
    setError(null);
    const r = await fetch(`/api/v2/portfolio/cash/adjustments/${id}`, { method: "DELETE" });
    if (!r.ok) setError(`Undo failed (HTTP ${r.status})`);
    await refresh();
  };

  const inputCls = "w-full bg-transparent border px-2 py-1 text-[10px] font-mono outline-none";

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
        className="border p-4 w-[420px] max-w-[95vw] max-h-[90vh] overflow-y-auto font-mono"
        style={{ background: "#0a0a0a", borderColor: colors.border }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold tracking-widest" style={{ color: colors.accent }}>
            EDIT CASH BALANCE
          </h3>
          <button type="button" onClick={onClose} className="p-0.5 hover:opacity-70">
            <X className="h-3 w-3" style={{ color: colors.textSecondary }} />
          </button>
        </div>

        <div className="text-[9px] mb-1" style={{ color: colors.textSecondary }}>
          ACCOUNT
        </div>
        <select
          value={selected}
          onChange={(e) => selectAccount(e.target.value)}
          className={`${inputCls} mb-3`}
          style={{ borderColor: colors.border, color: colors.text, background: "#0a0a0a" }}
        >
          {accounts.map((a) => (
            <option key={a.account.id} value={a.account.id}>
              {a.account.name} · {sym}
              {fmtK(a.cash_base ?? 0)}
            </option>
          ))}
        </select>

        {stat && (
          <div
            className="grid grid-cols-3 gap-2 mb-3 border p-2 text-[9px]"
            style={{ borderColor: colors.border }}
          >
            <div title="invested + realized P&L + dividends − open cost basis">
              <div style={{ color: colors.textSecondary }}>DERIVED</div>
              <div style={{ color: colors.text }}>{money(stat.cash_derived_base ?? current)}</div>
            </div>
            <div title="Sum of your earlier edits">
              <div style={{ color: colors.textSecondary }}>ADJUST</div>
              <div style={{ color: pnlColor(stat.cash_adjustment_base ?? 0) }}>
                {money(stat.cash_adjustment_base ?? 0)}
              </div>
            </div>
            <div>
              <div style={{ color: colors.textSecondary }}>CASH NOW</div>
              <div className="font-bold" style={{ color: current >= 0 ? "#facc15" : "#f87171" }}>
                {money(current)}
              </div>
            </div>
          </div>
        )}

        <div className="text-[9px] mb-1" style={{ color: colors.textSecondary }}>
          ACTUAL BALANCE AT BROKER ({currency})
        </div>
        <input
          type="number"
          step="0.01"
          value={actual}
          onChange={(e) => setActual(e.target.value)}
          className={`${inputCls} mb-1`}
          style={{ borderColor: colors.border, color: colors.text }}
        />
        <div className="text-[9px] mb-3" style={{ color: colors.textSecondary }}>
          ADJUSTMENT{" "}
          <span style={{ color: pnlColor(delta) }}>
            {delta >= 0 ? "+" : ""}
            {money(delta)}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <div className="text-[9px] mb-1" style={{ color: colors.textSecondary }}>
              EFFECTIVE DATE
            </div>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputCls}
              style={{ borderColor: colors.border, color: colors.text, colorScheme: "dark" }}
            />
          </div>
          <div>
            <div className="text-[9px] mb-1" style={{ color: colors.textSecondary }}>
              NOTE
            </div>
            <input
              type="text"
              value={note}
              placeholder="fees, tax, interest…"
              onChange={(e) => setNote(e.target.value)}
              className={inputCls}
              style={{ borderColor: colors.border, color: colors.text }}
            />
          </div>
        </div>

        <div className="text-[9px] mb-1" style={{ color: colors.textSecondary }}>
          REASON CATEGORY
        </div>
        <select
          aria-label="Cash adjustment category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className={`${inputCls} mb-2`}
          style={{ borderColor: colors.border, color: colors.text, background: "#0a0a0a" }}
        >
          <option value="">Choose a category</option>
          {[
            "FX_REVALUATION",
            "FEE",
            "TAX",
            "INTEREST",
            "MISSING_DEPOSIT",
            "MISSING_WITHDRAWAL",
            "MISSING_TRADE",
            "DATA_FIX",
            "UNKNOWN",
          ].map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        {category.startsWith("MISSING_") || ["FEE", "TAX", "INTEREST"].includes(category) ? (
          <p className="text-[8px] mb-3" style={{ color: colors.textSecondary }}>
            This category describes the gap. Record the actual transaction when broker evidence is
            available.
          </p>
        ) : null}

        <div className="flex items-center gap-2 justify-end mb-3">
          {error && (
            <span className="text-[9px] mr-auto" style={{ color: "#f87171" }}>
              {error}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-[9px] px-3 py-1 border"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            CLOSE
          </button>
          <button
            type="button"
            onClick={save}
            disabled={
              saving ||
              !category ||
              (category === "UNKNOWN" && !note.trim()) ||
              !Number.isFinite(parsed) ||
              Math.abs(delta) < 0.005
            }
            className="text-[9px] px-3 py-1 border font-bold disabled:opacity-40 flex items-center gap-1"
            style={{ borderColor: colors.accent, color: colors.accent }}
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            SAVE
          </button>
        </div>

        <p className="text-[8px] leading-snug mb-3" style={{ color: "#555" }}>
          Cash is always recomputed from trades, deposits and dividends. SAVE stores only the
          difference, so later buys and sells keep moving the balance. It does not count as invested
          capital, so returns are unaffected.
        </p>

        {history.length > 0 && (
          <div className="border-t pt-2" style={{ borderColor: colors.border }}>
            <div
              className="text-[9px] mb-1 tracking-widest"
              style={{ color: colors.textSecondary }}
            >
              HISTORY
            </div>
            {history.map((h) => (
              <div
                key={h.id}
                className="flex items-center gap-2 text-[9px] py-0.5"
                style={{ color: colors.text }}
              >
                <span style={{ color: colors.textSecondary }}>{h.date}</span>
                <span style={{ color: pnlColor(h.amount) }}>
                  {h.amount >= 0 ? "+" : ""}
                  {money(h.amount, h.currency === "USD" ? "USD" : "THB")}
                </span>
                <span className="truncate flex-1" style={{ color: colors.textSecondary }}>
                  {h.category || "UNKNOWN"} · {h.note}
                </span>
                <button
                  type="button"
                  title="Undo this adjustment"
                  onClick={() => undo(h.id)}
                  className="p-0.5 hover:opacity-70"
                >
                  <Undo2 className="h-3 w-3" style={{ color: "#f87171" }} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
