"use client";
import { useState } from "react";
import { X } from "lucide-react";
import type { Trade, TradeEditState } from "../types";
import { type Colors } from "../helpers";
import { STRATEGIES, SECTORS_BY_CURRENCY, TH_SECTORS } from "../constants";

function tradeToEditState(t: Trade): TradeEditState {
  return {
    symbol: t.symbol ?? "", sector: t.sector ?? "", date_entry: t.date_entry ?? "",
    price_entry: t.price_entry?.toString() ?? "", price_stoploss: t.price_stoploss?.toString() ?? "",
    price_target: t.price_target?.toString() ?? "", volume: t.volume?.toString() ?? "",
    strategy_name: t.strategy_name ?? "", entry_trigger: t.entry_trigger ?? "",
    market_trend: t.market_trend ?? "", note: t.note ?? "",
    date_exit: t.date_exit ?? "", price_exit: t.price_exit?.toString() ?? "",
    pnl_amount: t.pnl_amount?.toString() ?? "", win_loss: t.win_loss ?? "P",
    pnl_percent: t.pnl_percent?.toString() ?? "", exit_trigger: t.exit_trigger ?? "",
  };
}

const NUM_EDIT_FIELDS = ["price_entry", "price_stoploss", "price_target", "volume", "price_exit", "pnl_amount", "pnl_percent"];

export function TradeEditModal({
  trade, colors, onClose, onSaved,
}: {
  trade: Trade;
  colors: Colors;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<TradeEditState>(() => tradeToEditState(trade));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isOpen = trade.win_loss === "P";
  const isUSD = ((trade as any).acc_currency || trade.currency || "").toUpperCase() === "USD";

  const set = (k: keyof TradeEditState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    setSaving(true); setErr("");
    try {
      const orig = tradeToEditState(trade);
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(form) as (keyof TradeEditState)[]) {
        if (form[k] !== orig[k]) {
          if (NUM_EDIT_FIELDS.includes(k)) {
            const v = parseFloat(form[k] as string);
            patch[k] = isNaN(v) ? null : v;
          } else {
            patch[k] = form[k];
          }
        }
      }
      if (Object.keys(patch).length === 0) { onClose(); return; }
      const r = await fetch(`/api/v2/portfolio/trades/${trade.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(await r.text());
      onSaved(); onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    setDeleting(true); setErr("");
    try {
      const r = await fetch(`/api/v2/portfolio/trades/${trade.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await r.text());
      onSaved(); onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setConfirmDelete(false);
    } finally { setDeleting(false); }
  };

  const iCls = "w-full px-2 py-1 text-[10px] font-mono border mt-0.5 outline-none";
  const iSty = { borderColor: colors.border, color: colors.text, background: "#050505" };
  const lCls = "text-[8px] font-mono";
  const sectorList = SECTORS_BY_CURRENCY[isUSD ? "USD" : "THB"] ?? TH_SECTORS;

  const handleSymbolBlur = async () => {
    const sym = form.symbol.trim().toUpperCase();
    if (!sym) return;
    try {
      const r = await fetch(`/api/stock/sector/${encodeURIComponent(sym)}`);
      if (!r.ok) return;
      const d = await r.json();
      const rawSector: string = d.sector ?? "";
      if (!rawSector) return;
      const match = sectorList.find(s => s.toLowerCase().includes(rawSector.toLowerCase().split(" ")[0]));
      if (match) setForm(f => ({ ...f, sector: match }));
    } catch { /* silent */ }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.75)" }}
      onClick={onClose}>
      <div className="border p-4 w-[440px] max-h-[90vh] overflow-y-auto"
        style={{ background: "#0a0a0a", borderColor: colors.accent }}
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold tracking-widest" style={{ color: colors.accent }}>
            EDIT — {trade.symbol}
          </h3>
          <button onClick={onClose} className="hover:opacity-70">
            <X className="h-3 w-3" style={{ color: colors.textSecondary }} />
          </button>
        </div>

        <div className="text-[8px] font-bold tracking-widest mb-1" style={{ color: colors.textSecondary }}>ENTRY</div>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className={lCls} style={{ color: colors.textSecondary }}>SYMBOL</label>
            <input className={iCls} style={iSty} value={form.symbol} onChange={set("symbol")} onBlur={handleSymbolBlur} />
          </div>
          <div>
            <label className={lCls} style={{ color: colors.textSecondary }}>SECTOR</label>
            <select className={iCls} style={iSty} value={form.sector} onChange={set("sector")}>
              <option value="">— select —</option>
              {sectorList.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className={lCls} style={{ color: colors.textSecondary }}>DATE IN</label>
            <input type="date" className={iCls} style={iSty} value={form.date_entry} onChange={set("date_entry")} />
          </div>
          <div>
            <label className={lCls} style={{ color: colors.textSecondary }}>VOLUME</label>
            <input type="number" step="any" className={iCls} style={iSty} value={form.volume} onChange={set("volume")} />
          </div>
          <div>
            <label className={lCls} style={{ color: colors.textSecondary }}>ENTRY PRICE</label>
            <input type="number" step="any" className={iCls} style={iSty} value={form.price_entry} onChange={set("price_entry")} />
          </div>
          <div>
            <label className={lCls} style={{ color: colors.textSecondary }}>STRATEGY</label>
            <select className={iCls} style={iSty} value={form.strategy_name} onChange={set("strategy_name")}>
              <option value="">—</option>
              {STRATEGIES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {!isOpen && (
          <>
            <div className="text-[8px] font-bold tracking-widest mb-1" style={{ color: colors.textSecondary }}>EXIT</div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label className={lCls} style={{ color: colors.textSecondary }}>DATE OUT</label>
                <input type="date" className={iCls} style={iSty} value={form.date_exit} onChange={set("date_exit")} />
              </div>
              <div>
                <label className={lCls} style={{ color: colors.textSecondary }}>EXIT PRICE</label>
                <input type="number" step="any" className={iCls} style={iSty} value={form.price_exit} onChange={set("price_exit")} />
              </div>
              <div>
                <label className={lCls} style={{ color: colors.textSecondary }}>P&L</label>
                <input type="number" step="any" className={iCls} style={iSty} value={form.pnl_amount} onChange={set("pnl_amount")} />
              </div>
              <div>
                <label className={lCls} style={{ color: colors.textSecondary }}>W/L</label>
                <select className={iCls} style={iSty} value={form.win_loss} onChange={set("win_loss")}>
                  <option value="W">W — Win</option>
                  <option value="L">L — Loss</option>
                </select>
              </div>
            </div>
          </>
        )}

        <div className="mb-3">
          <label className={lCls} style={{ color: colors.textSecondary }}>NOTE</label>
          <textarea className={iCls + " resize-none"} style={iSty} rows={2} value={form.note} onChange={set("note")} />
        </div>

        {err && <div className="text-[9px] mb-2 font-mono" style={{ color: "#f87171" }}>{err}</div>}

        {/* Delete confirm banner */}
        {confirmDelete && (
          <div className="mb-3 p-2 border text-[9px] font-mono"
            style={{ borderColor: "#cc0000", background: "#1a0000", color: "#ff8888" }}>
            <div className="font-bold mb-1.5">DELETE TRADE — {trade.symbol} [{trade.date_entry}]?</div>
            <div className="text-[8px] mb-2" style={{ color: "#ff5555" }}>
              ลบถาวร ไม่สามารถกู้คืนได้
            </div>
            <div className="flex gap-2">
              <button onClick={() => setConfirmDelete(false)}
                className="px-3 py-1 border font-bold"
                style={{ borderColor: "#555", color: "#aaa" }}>CANCEL</button>
              <button onClick={handleDelete} disabled={deleting}
                className="px-3 py-1 border font-bold"
                style={{ borderColor: "#cc0000", color: "#ff4444", background: "#cc000020",
                         opacity: deleting ? 0.5 : 1 }}>
                {deleting ? "DELETING..." : "CONFIRM DELETE"}
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          {/* Delete trigger — left side */}
          {!confirmDelete && (
            <button onClick={() => setConfirmDelete(true)}
              className="text-[9px] px-3 py-1.5 border font-bold mr-auto"
              style={{ borderColor: "#cc000066", color: "#cc4444", background: "#cc000010" }}>
              DELETE
            </button>
          )}
          <button onClick={onClose}
            className="text-[9px] px-3 py-1.5 border font-bold ml-auto"
            style={{ borderColor: colors.border, color: colors.textSecondary }}>CANCEL</button>
          <button onClick={handleSave} disabled={saving}
            className="text-[9px] px-3 py-1.5 border font-bold"
            style={{ borderColor: saving ? "#555" : colors.accent, color: saving ? "#555" : colors.accent,
                     background: "#ff990010", opacity: saving ? 0.5 : 1 }}>
            {saving ? "SAVING..." : "SAVE"}
          </button>
        </div>
      </div>
    </div>
  );
}
