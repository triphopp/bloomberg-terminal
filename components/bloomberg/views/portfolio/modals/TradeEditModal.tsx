"use client";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import { SECTORS_BY_CURRENCY, STRATEGIES, TH_SECTORS } from "../constants";
import { type Colors, composeNote, fmt, splitNote } from "../helpers";
import type { Trade, TradeEditState } from "../types";
import { SubPortSelect } from "../ui/SubPortSelect";

interface AuditEntry {
  id: number;
  trade_id: string;
  action: string;
  fields_changed: Record<string, { old: unknown; new: unknown }>;
  reason: string;
  snapshot: Record<string, unknown>;
  created_at: string;
}

function tradeToEditState(t: Trade): TradeEditState {
  return {
    symbol: t.symbol ?? "",
    sector: t.sector ?? "",
    date_entry: t.date_entry ?? "",
    price_entry: t.price_entry?.toString() ?? "",
    price_stoploss: t.price_stoploss?.toString() ?? "",
    price_target: t.price_target?.toString() ?? "",
    volume: t.volume?.toString() ?? "",
    strategy_name: t.strategy_name ?? "",
    entry_trigger: t.entry_trigger ?? "",
    market_trend: t.market_trend ?? "",
    note: t.note ?? "",
    date_exit: t.date_exit ?? "",
    price_exit: t.price_exit?.toString() ?? "",
    pnl_amount: t.pnl_amount?.toString() ?? "",
    win_loss: t.win_loss ?? "P",
    pnl_percent: t.pnl_percent?.toString() ?? "",
    exit_trigger: t.exit_trigger ?? "",
  };
}

const NUM_EDIT_FIELDS = [
  "price_entry",
  "price_stoploss",
  "price_target",
  "volume",
  "price_exit",
  "pnl_amount",
  "pnl_percent",
];

export function TradeEditModal({
  trade,
  colors,
  mergedAvg,
  mergedVolume,
  costOverride,
  onClose,
  onSaved,
}: {
  trade: Trade;
  colors: Colors;
  mergedAvg?: number;
  mergedVolume?: number;
  costOverride?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<TradeEditState>(() => tradeToEditState(trade));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [confirmAvg, setConfirmAvg] = useState(false);
  const [avgInput, setAvgInput] = useState(costOverride?.toString() ?? "");
  const [avgReason, setAvgReason] = useState("");
  const [savingAvg, setSavingAvg] = useState(false);
  const isOpen = trade.win_loss === "P";

  useEffect(() => {
    fetch(`/api/v2/portfolio/trades/${trade.id}/audit-log`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.audit_log && setAuditLog(d.audit_log))
      .catch(() => {});
  }, [trade.id]);
  const isUSD =
    (trade.currency || trade.pos_currency || trade.acc_currency || "").toUpperCase() !== "THB";

  const set =
    (k: keyof TradeEditState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    setSaving(true);
    setErr("");
    try {
      const orig = tradeToEditState(trade);
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(form) as (keyof TradeEditState)[]) {
        if (form[k] !== orig[k]) {
          if (NUM_EDIT_FIELDS.includes(k)) {
            const v = Number.parseFloat(form[k] as string);
            patch[k] = Number.isNaN(v) ? null : v;
          } else {
            patch[k] = form[k];
          }
        }
      }
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      if (adjustmentReason && patch.price_entry !== undefined) {
        patch.adjustment_reason = adjustmentReason;
      }
      const r = await fetch(`/api/v2/portfolio/trades/${trade.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
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

  const handleDelete = async () => {
    setDeleting(true);
    setErr("");
    try {
      const r = await fetch(`/api/v2/portfolio/trades/${trade.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await r.text());
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const handleSetAvg = async () => {
    const v = Number.parseFloat(avgInput);
    if (Number.isNaN(v) || v <= 0) return;
    setSavingAvg(true);
    try {
      const r = await fetch("/api/v2/portfolio/cost-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: trade.account_id,
          symbol: trade.symbol,
          avg_cost: v,
          reason: avgReason,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingAvg(false);
    }
  };

  const handleClearAvg = async () => {
    setSavingAvg(true);
    try {
      await fetch(`/api/v2/portfolio/cost-overrides/${trade.account_id}/${trade.symbol}`, {
        method: "DELETE",
      });
      onSaved();
      onClose();
    } catch {
      /* ignore */
    } finally {
      setSavingAvg(false);
    }
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
      const match = sectorList.find((s) =>
        s.toLowerCase().includes(rawSector.toLowerCase().split(" ")[0])
      );
      if (match) setForm((f) => ({ ...f, sector: match }));
    } catch {
      /* silent */
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.75)" }}
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="presentation"
    >
      <div
        className="border p-4 w-[440px] max-h-[90vh] overflow-y-auto"
        style={{ background: "#0a0a0a", borderColor: colors.accent }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        // biome-ignore lint/a11y/useSemanticElements: styled div modal, not native dialog
        role="dialog"
        aria-label={`Edit trade ${trade.symbol}`}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold tracking-widest" style={{ color: colors.accent }}>
            EDIT — {trade.symbol}
          </h3>
          <button type="button" onClick={onClose} className="hover:opacity-70">
            <X className="h-3 w-3" style={{ color: colors.textSecondary }} />
          </button>
        </div>

        <div
          className="text-[8px] font-bold tracking-widest mb-1"
          style={{ color: colors.textSecondary }}
        >
          ENTRY
        </div>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label htmlFor="te-symbol" className={lCls} style={{ color: colors.textSecondary }}>
              SYMBOL
            </label>
            <input
              id="te-symbol"
              className={iCls}
              style={iSty}
              value={form.symbol}
              onChange={set("symbol")}
              onBlur={handleSymbolBlur}
            />
          </div>
          <div>
            <label htmlFor="te-sector" className={lCls} style={{ color: colors.textSecondary }}>
              SECTOR
            </label>
            <select
              id="te-sector"
              className={iCls}
              style={iSty}
              value={form.sector}
              onChange={set("sector")}
            >
              <option value="">— select —</option>
              {sectorList.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="te-date-in" className={lCls} style={{ color: colors.textSecondary }}>
              DATE IN
            </label>
            <input
              id="te-date-in"
              type="date"
              className={iCls}
              style={iSty}
              value={form.date_entry}
              onChange={set("date_entry")}
            />
          </div>
          <div>
            <label htmlFor="te-volume" className={lCls} style={{ color: colors.textSecondary }}>
              VOLUME
            </label>
            <input
              id="te-volume"
              type="number"
              step="any"
              className={iCls}
              style={iSty}
              value={form.volume}
              onChange={set("volume")}
            />
          </div>
          <div>
            <label
              htmlFor="te-entry-price"
              className={lCls}
              style={{ color: colors.textSecondary }}
            >
              ENTRY PRICE
            </label>
            <input
              id="te-entry-price"
              type="number"
              step="any"
              className={iCls}
              style={iSty}
              value={form.price_entry}
              onChange={set("price_entry")}
            />
          </div>
          {form.price_entry !== (trade.price_entry?.toString() ?? "") && (
            <div className="col-span-2">
              <label htmlFor="te-price-reason" className={lCls} style={{ color: "#f59e0b" }}>
                REASON FOR PRICE CHANGE
              </label>
              <input
                id="te-price-reason"
                className={iCls}
                style={{ ...iSty, borderColor: "#f59e0b55" }}
                placeholder="e.g. adjusted after partial sell, commission included…"
                value={adjustmentReason}
                onChange={(e) => setAdjustmentReason(e.target.value)}
              />
            </div>
          )}
          <div>
            <label htmlFor="te-strategy" className={lCls} style={{ color: colors.textSecondary }}>
              STRATEGY
            </label>
            <select
              id="te-strategy"
              className={iCls}
              style={iSty}
              value={form.strategy_name}
              onChange={set("strategy_name")}
            >
              <option value="">—</option>
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        {!isOpen && (
          <>
            <div
              className="text-[8px] font-bold tracking-widest mb-1"
              style={{ color: colors.textSecondary }}
            >
              EXIT
            </div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label
                  htmlFor="te-date-out"
                  className={lCls}
                  style={{ color: colors.textSecondary }}
                >
                  DATE OUT
                </label>
                <input
                  id="te-date-out"
                  type="date"
                  className={iCls}
                  style={iSty}
                  value={form.date_exit}
                  onChange={set("date_exit")}
                />
              </div>
              <div>
                <label
                  htmlFor="te-exit-price"
                  className={lCls}
                  style={{ color: colors.textSecondary }}
                >
                  EXIT PRICE
                </label>
                <input
                  id="te-exit-price"
                  type="number"
                  step="any"
                  className={iCls}
                  style={iSty}
                  value={form.price_exit}
                  onChange={set("price_exit")}
                />
              </div>
              <div>
                <label htmlFor="te-pnl" className={lCls} style={{ color: colors.textSecondary }}>
                  P&L
                </label>
                <input
                  id="te-pnl"
                  type="number"
                  step="any"
                  className={iCls}
                  style={iSty}
                  value={form.pnl_amount}
                  onChange={set("pnl_amount")}
                />
              </div>
              <div>
                <label
                  htmlFor="te-winloss"
                  className={lCls}
                  style={{ color: colors.textSecondary }}
                >
                  W/L
                </label>
                <select
                  id="te-winloss"
                  className={iCls}
                  style={iSty}
                  value={form.win_loss}
                  onChange={set("win_loss")}
                >
                  <option value="W">W — Win</option>
                  <option value="L">L — Loss</option>
                </select>
              </div>
            </div>
          </>
        )}

        <div className="mb-3">
          <div className={lCls} style={{ color: colors.textSecondary }}>
            SUB-PORT
          </div>
          <SubPortSelect
            accountId={trade.account_id}
            value={splitNote(form.note).subPort}
            onChange={(v) =>
              setForm((f) => ({ ...f, note: composeNote(v, splitNote(f.note).rest) }))
            }
            colors={colors}
            inputStyle={{ ...iSty, padding: "3px 6px", fontSize: 10, width: "100%" }}
          />
        </div>

        <div className="mb-3">
          <label htmlFor="te-note" className={lCls} style={{ color: colors.textSecondary }}>
            NOTE
          </label>
          <textarea
            id="te-note"
            className={`${iCls} resize-none`}
            style={iSty}
            rows={2}
            value={splitNote(form.note).rest}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                note: composeNote(splitNote(f.note).subPort, e.target.value),
              }))
            }
          />
        </div>

        {err && (
          <div className="text-[9px] mb-2 font-mono" style={{ color: "#f87171" }}>
            {err}
          </div>
        )}

        {/* Audit log — collapsible */}
        <div className="mb-3 border" style={{ borderColor: colors.border }}>
          <button
            type="button"
            className="w-full flex items-center gap-1.5 px-2 py-1 text-[8px] font-bold tracking-widest"
            style={{ background: "#060606", color: colors.textSecondary }}
            onClick={() => setAuditOpen((o) => !o)}
          >
            {auditOpen ? (
              <ChevronDown className="w-2.5 h-2.5" />
            ) : (
              <ChevronRight className="w-2.5 h-2.5" />
            )}
            AUDIT LOG
            <span className="ml-1 font-normal">({auditLog.length})</span>
          </button>
          {auditOpen && (
            <div className="overflow-y-auto" style={{ maxHeight: 160, background: "#040404" }}>
              {auditLog.length === 0 ? (
                <div className="px-2 py-2 text-[8px]" style={{ color: colors.textSecondary }}>
                  No changes recorded yet.
                </div>
              ) : (
                auditLog.map((e) => (
                  <div
                    key={e.id}
                    className="border-b px-2 py-1.5 text-[8px] font-mono"
                    style={{ borderColor: "#111" }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="font-bold px-0.5 rounded text-[7px]"
                        style={{
                          background: e.action.startsWith("SELL")
                            ? "#ef444420"
                            : e.action === "DELETE"
                              ? "#cc000020"
                              : "#f59e0b20",
                          color: e.action.startsWith("SELL")
                            ? "#f87171"
                            : e.action === "DELETE"
                              ? "#f87171"
                              : "#f59e0b",
                        }}
                      >
                        {e.action}
                      </span>
                      <span style={{ color: colors.textSecondary }}>
                        {e.created_at.replace("T", " ").slice(0, 16)}
                      </span>
                      {e.reason && <span style={{ color: colors.text }}>{e.reason}</span>}
                    </div>
                    {Object.keys(e.fields_changed).length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                        {Object.entries(e.fields_changed).map(([field, diff]) => (
                          <span key={field} style={{ color: colors.textSecondary }}>
                            {field}:{" "}
                            <span style={{ color: "#f87171" }}>
                              {typeof diff.old === "number"
                                ? fmt(diff.old as number)
                                : String(diff.old ?? "—")}
                            </span>
                            {" → "}
                            <span style={{ color: "#4ade80" }}>
                              {typeof diff.new === "number"
                                ? fmt(diff.new as number)
                                : String(diff.new ?? "—")}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* SET AVG COST section — only when opened from merged position */}
        {mergedAvg !== undefined && isOpen && (
          <div className="mb-3 border" style={{ borderColor: "#f59e0b44" }}>
            {!confirmAvg ? (
              <div className="flex items-center justify-between px-2 py-1.5">
                <div className="text-[8px] font-mono">
                  <span className="font-bold tracking-widest" style={{ color: "#f59e0b" }}>
                    SET AVG COST
                  </span>
                  <span className="ml-2" style={{ color: colors.textSecondary }}>
                    computed: {fmt(mergedAvg, 4)}
                    {costOverride !== undefined && (
                      <span style={{ color: "#f59e0b" }}> · override: {fmt(costOverride, 4)}</span>
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmAvg(true)}
                  className="text-[8px] px-2 py-0.5 border font-bold"
                  style={{ borderColor: "#f59e0b55", color: "#f59e0b", background: "#f59e0b10" }}
                >
                  {costOverride !== undefined ? "EDIT OVERRIDE" : "SET OVERRIDE"}
                </button>
              </div>
            ) : (
              <div className="p-2 text-[9px] font-mono" style={{ background: "#0d0900" }}>
                <div className="font-bold mb-2" style={{ color: "#f59e0b" }}>
                  SET AVG COST — {trade.symbol} ({mergedVolume} shares)
                </div>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <div>
                    <label
                      htmlFor="te-avg-input"
                      className="text-[8px]"
                      style={{ color: colors.textSecondary }}
                    >
                      TARGET AVG
                    </label>
                    <input
                      id="te-avg-input"
                      type="number"
                      step="any"
                      className={iCls}
                      style={{
                        borderColor: "#f59e0b55",
                        color: colors.text,
                        background: "#050505",
                      }}
                      placeholder={mergedAvg.toFixed(4)}
                      value={avgInput}
                      onChange={(e) => setAvgInput(e.target.value)}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="te-avg-reason"
                      className="text-[8px]"
                      style={{ color: colors.textSecondary }}
                    >
                      REASON
                    </label>
                    <input
                      id="te-avg-reason"
                      className={iCls}
                      style={{
                        borderColor: colors.border,
                        color: colors.text,
                        background: "#050505",
                      }}
                      placeholder="broker statement, commission…"
                      value={avgReason}
                      onChange={(e) => setAvgReason(e.target.value)}
                    />
                  </div>
                </div>
                {(() => {
                  const v = Number.parseFloat(avgInput);
                  if (!Number.isNaN(v) && v > 0 && mergedVolume) {
                    const delta = v - mergedAvg;
                    return (
                      <div
                        className="text-[8px] mb-2"
                        style={{ color: delta >= 0 ? "#f87171" : "#4ade80" }}
                      >
                        {delta >= 0 ? "▲" : "▼"} {fmt(Math.abs(delta), 4)} per share · new cost
                        basis: {fmt(v * mergedVolume, 2)}
                      </div>
                    );
                  }
                })()}
                <div className="flex gap-2">
                  {costOverride !== undefined && (
                    <button
                      type="button"
                      onClick={handleClearAvg}
                      disabled={savingAvg}
                      className="text-[8px] px-2 py-0.5 border font-bold"
                      style={{ borderColor: "#55555566", color: "#888" }}
                    >
                      CLEAR
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setConfirmAvg(false)}
                    className="text-[8px] px-2 py-0.5 border font-bold ml-auto"
                    style={{ borderColor: colors.border, color: colors.textSecondary }}
                  >
                    CANCEL
                  </button>
                  <button
                    type="button"
                    onClick={handleSetAvg}
                    disabled={savingAvg || !(Number.parseFloat(avgInput) > 0)}
                    className="text-[8px] px-2 py-0.5 border font-bold"
                    style={{
                      borderColor: "#f59e0b",
                      color: "#f59e0b",
                      background: "#f59e0b10",
                      opacity: savingAvg ? 0.5 : 1,
                    }}
                  >
                    {savingAvg ? "SAVING…" : "CONFIRM SET AVG"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Delete confirm banner */}
        {confirmDelete && (
          <div
            className="mb-3 p-2 border text-[9px] font-mono"
            style={{ borderColor: "#cc0000", background: "#1a0000", color: "#ff8888" }}
          >
            <div className="font-bold mb-1.5">
              DELETE TRADE — {trade.symbol} [{trade.date_entry}]?
            </div>
            <div className="text-[8px] mb-2" style={{ color: "#ff5555" }}>
              ลบถาวร ไม่สามารถกู้คืนได้
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1 border font-bold"
                style={{ borderColor: "#555", color: "#aaa" }}
              >
                CANCEL
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="px-3 py-1 border font-bold"
                style={{
                  borderColor: "#cc0000",
                  color: "#ff4444",
                  background: "#cc000020",
                  opacity: deleting ? 0.5 : 1,
                }}
              >
                {deleting ? "DELETING..." : "CONFIRM DELETE"}
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          {/* Delete trigger — left side */}
          {!confirmDelete && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="text-[9px] px-3 py-1.5 border font-bold mr-auto"
              style={{ borderColor: "#cc000066", color: "#cc4444", background: "#cc000010" }}
            >
              DELETE
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
            disabled={saving}
            className="text-[9px] px-3 py-1.5 border font-bold"
            style={{
              borderColor: saving ? "#555" : colors.accent,
              color: saving ? "#555" : colors.accent,
              background: "#ff990010",
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
