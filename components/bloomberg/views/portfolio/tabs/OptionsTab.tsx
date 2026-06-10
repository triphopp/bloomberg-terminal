"use client";
import React, { useState, useEffect, useCallback } from "react";
import { Clock, AlertTriangle, Plus, X, RefreshCw, Loader2, TrendingUp, TrendingDown } from "lucide-react";
import type { Colors } from "../helpers";
import { fmt, pnlColor } from "../helpers";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DataFreshness {
  fetched_at: string;
  is_realtime: boolean;
  source: string;
  delay_minutes: number;
  warning: string;
}

interface OptionPosition {
  id: string;
  account_id: string;
  underlying: string;
  expiry: string;
  strike: number;
  option_type: "call" | "put";
  quantity: number;
  entry_price: number;
  entry_date: string;
  status: string;
  notes: string;
}

interface PositionQuote {
  position_id: string;
  last_price: number | null;
  bid: number | null;
  ask: number | null;
  implied_volatility: number | null;
  volume: number | null;
  open_interest: number | null;
  in_the_money: boolean | null;
  freshness: DataFreshness;
}

// ── Freshness badge + tooltip ─────────────────────────────────────────────────

function FreshnessBadge({ freshness }: { freshness: DataFreshness }) {
  const [show, setShow] = useState(false);

  if (freshness.is_realtime) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] text-green-400 font-mono">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
        LIVE
      </span>
    );
  }

  return (
    <span
      className="relative inline-flex items-center gap-0.5 text-[9px] font-mono cursor-help"
      style={{ color: "#f59e0b" }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <Clock className="w-2.5 h-2.5" />
      ~{freshness.delay_minutes}m delay
      {show && (
        <span
          className="absolute bottom-full left-0 mb-1 z-50 w-56 rounded px-2 py-1.5 text-[10px] leading-snug shadow-lg border"
          style={{ background: "#1a1a1a", borderColor: "#f59e0b", color: "#f59e0b" }}
        >
          <AlertTriangle className="inline w-3 h-3 mr-1 mb-0.5" />
          {freshness.warning}
          <br />
          <span style={{ color: "#666" }}>
            Source: {freshness.source} · fetched {new Date(freshness.fetched_at).toLocaleTimeString()}
          </span>
        </span>
      )}
    </span>
  );
}

// ── Add position form ─────────────────────────────────────────────────────────

const EMPTY_FORM = {
  underlying: "", expiry: "", strike: "", option_type: "call" as "call" | "put",
  quantity: "1", entry_price: "", entry_date: new Date().toISOString().slice(0, 10),
  notes: "",
};

function AddPositionForm({
  accountId, colors, onAdded,
}: { accountId: string; colors: Colors; onAdded: () => void }) {
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [verifyStatus, setVerifyStatus] = useState<"idle" | "ok" | "not_found">("idle");

  const set = (k: keyof typeof EMPTY_FORM, v: string) =>
    setForm(f => ({ ...f, [k]: v }));

  const canVerify = form.underlying && form.expiry && form.strike && form.option_type;

  const verify = useCallback(async () => {
    if (!canVerify) return;
    try {
      const r = await fetch(`/api/options/${form.underlying.toUpperCase()}`);
      if (!r.ok) { setVerifyStatus("not_found"); return; }
      const data = await r.json();
      const found = data.expirations?.includes(form.expiry);
      setVerifyStatus(found ? "ok" : "not_found");
    } catch { setVerifyStatus("not_found"); }
  }, [form.underlying, form.expiry, canVerify]);

  const submit = async () => {
    if (!form.underlying || !form.expiry || !form.strike || !form.entry_price) {
      setError("Fill all required fields");
      return;
    }
    setSaving(true); setError("");
    try {
      const r = await fetch("/api/options/positions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountId === "all" ? "dime" : accountId,
          underlying: form.underlying.toUpperCase(),
          expiry: form.expiry,
          strike: parseFloat(form.strike),
          option_type: form.option_type,
          quantity: parseInt(form.quantity),
          entry_price: parseFloat(form.entry_price),
          entry_date: form.entry_date,
          notes: form.notes,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || "Save failed");
      setForm({ ...EMPTY_FORM });
      setVerifyStatus("idle");
      onAdded();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const labelCls = "text-[9px] font-bold mb-0.5 block";
  const inputCls = `w-full text-[10px] px-2 py-1 font-mono border rounded bg-transparent outline-none`;

  return (
    <div className="border rounded p-3 mb-3" style={{ borderColor: colors.border }}>
      <div className="text-[10px] font-bold mb-2 flex items-center gap-1" style={{ color: colors.accent }}>
        <Plus className="w-3 h-3" /> ADD OPTION POSITION
      </div>

      <div className="grid grid-cols-4 gap-2 mb-2">
        <div>
          <label className={labelCls} style={{ color: colors.textSecondary }}>Underlying *</label>
          <input
            className={inputCls} placeholder="AAPL"
            style={{ borderColor: colors.border, color: colors.text }}
            value={form.underlying}
            onChange={e => { set("underlying", e.target.value.toUpperCase()); setVerifyStatus("idle"); }}
          />
        </div>
        <div>
          <label className={labelCls} style={{ color: colors.textSecondary }}>Expiry *</label>
          <input
            type="date" className={inputCls}
            style={{ borderColor: colors.border, color: colors.text }}
            value={form.expiry}
            onChange={e => { set("expiry", e.target.value); setVerifyStatus("idle"); }}
          />
        </div>
        <div>
          <label className={labelCls} style={{ color: colors.textSecondary }}>Strike (K) *</label>
          <input
            type="number" className={inputCls} placeholder="150.00"
            style={{ borderColor: colors.border, color: colors.text }}
            value={form.strike}
            onChange={e => set("strike", e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} style={{ color: colors.textSecondary }}>Type *</label>
          <select
            className={inputCls}
            style={{ borderColor: colors.border, color: colors.text, background: colors.bg }}
            value={form.option_type}
            onChange={e => set("option_type", e.target.value as "call" | "put")}
          >
            <option value="call">CALL</option>
            <option value="put">PUT</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 mb-2">
        <div>
          <label className={labelCls} style={{ color: colors.textSecondary }}>Qty (contracts)</label>
          <input
            type="number" className={inputCls} placeholder="1"
            style={{ borderColor: colors.border, color: colors.text }}
            value={form.quantity}
            onChange={e => set("quantity", e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} style={{ color: colors.textSecondary }}>Entry premium *</label>
          <input
            type="number" className={inputCls} placeholder="3.20"
            style={{ borderColor: colors.border, color: colors.text }}
            value={form.entry_price}
            onChange={e => set("entry_price", e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} style={{ color: colors.textSecondary }}>Entry date</label>
          <input
            type="date" className={inputCls}
            style={{ borderColor: colors.border, color: colors.text }}
            value={form.entry_date}
            onChange={e => set("entry_date", e.target.value)}
          />
        </div>
        <div className="flex items-end gap-1">
          <button
            onClick={verify}
            disabled={!canVerify}
            className="px-2 py-1 text-[9px] font-bold border rounded disabled:opacity-40"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            VERIFY
          </button>
          {verifyStatus === "ok" && <span className="text-[9px] text-green-400">✓ found</span>}
          {verifyStatus === "not_found" && <span className="text-[9px] text-red-400">✗ not found</span>}
        </div>
      </div>

      {error && <div className="text-[9px] text-red-400 mb-1">{error}</div>}

      <div className="flex items-center justify-between">
        <p className="text-[9px]" style={{ color: colors.textSecondary }}>
          * Verify confirms contract exists in market data provider
        </p>
        <button
          onClick={submit} disabled={saving}
          className="flex items-center gap-1 px-3 py-1 text-[9px] font-bold border rounded"
          style={{ borderColor: colors.accent, color: colors.accent }}
        >
          {saving ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Plus className="w-2.5 h-2.5" />}
          SAVE
        </button>
      </div>
    </div>
  );
}

// ── Position row ──────────────────────────────────────────────────────────────

function PositionRow({
  pos, colors, onClose, onDelete,
}: { pos: OptionPosition; colors: Colors; onClose: () => void; onDelete: () => void }) {
  const [quote, setQuote] = useState<PositionQuote | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);

  const loadQuote = useCallback(async () => {
    setLoadingQuote(true);
    try {
      const r = await fetch(`/api/options/positions/${pos.id}/quote`);
      if (r.ok) setQuote(await r.json());
    } catch { /* ignore */ } finally { setLoadingQuote(false); }
  }, [pos.id]);

  useEffect(() => { loadQuote(); }, [loadQuote]);

  const currentPrice = quote?.last_price ?? null;
  const pnlPerShare = currentPrice !== null ? (currentPrice - pos.entry_price) * (pos.option_type === "call" ? 1 : 1) : null;
  const pnlTotal = pnlPerShare !== null ? pnlPerShare * pos.quantity * 100 : null;
  const pnlPct = pnlPerShare !== null && pos.entry_price > 0 ? (pnlPerShare / pos.entry_price) * 100 : null;

  const isCall = pos.option_type === "call";
  const typeColor = isCall ? "#00FF00" : "#FF4444";

  return (
    <tr className="border-b text-[10px] font-mono" style={{ borderColor: colors.border }}>
      <td className="px-2 py-1.5">
        <span className="font-bold" style={{ color: colors.text }}>{pos.underlying}</span>
      </td>
      <td className="px-2 py-1.5">
        <span className="font-bold text-[9px] px-1 rounded" style={{ color: typeColor, border: `1px solid ${typeColor}` }}>
          {pos.option_type.toUpperCase()}
        </span>
      </td>
      <td className="px-2 py-1.5 text-right" style={{ color: colors.text }}>${fmt(pos.strike)}</td>
      <td className="px-2 py-1.5 text-right" style={{ color: colors.textSecondary }}>{pos.expiry}</td>
      <td className="px-2 py-1.5 text-right" style={{ color: colors.text }}>{pos.quantity}</td>
      <td className="px-2 py-1.5 text-right" style={{ color: colors.textSecondary }}>${fmt(pos.entry_price, 2)}</td>
      <td className="px-2 py-1.5 text-right">
        {loadingQuote ? (
          <Loader2 className="w-3 h-3 animate-spin inline" style={{ color: colors.textSecondary }} />
        ) : currentPrice !== null ? (
          <span style={{ color: colors.text }}>${fmt(currentPrice, 2)}</span>
        ) : (
          <span style={{ color: colors.textSecondary }}>—</span>
        )}
      </td>
      <td className="px-2 py-1.5 text-right">
        {pnlTotal !== null ? (
          <span style={{ color: pnlColor(pnlTotal) }}>
            {pnlTotal >= 0 ? "+" : ""}${fmt(Math.abs(pnlTotal), 0)}
            {pnlPct !== null && (
              <span className="text-[9px] ml-1">({pnlPct >= 0 ? "+" : ""}{fmt(pnlPct, 1)}%)</span>
            )}
          </span>
        ) : <span style={{ color: colors.textSecondary }}>—</span>}
      </td>
      <td className="px-2 py-1.5">
        {quote?.freshness && <FreshnessBadge freshness={quote.freshness} />}
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1">
          <button
            onClick={loadQuote}
            className="p-0.5 opacity-50 hover:opacity-100"
            title="Refresh quote"
          >
            <RefreshCw className="w-2.5 h-2.5" style={{ color: colors.textSecondary }} />
          </button>
          <button
            onClick={onClose}
            className="text-[8px] px-1 border rounded opacity-60 hover:opacity-100"
            style={{ borderColor: colors.textSecondary, color: colors.textSecondary }}
            title="Close position"
          >
            CLOSE
          </button>
          <button onClick={onDelete} className="p-0.5 opacity-40 hover:opacity-100 hover:text-red-400">
            <X className="w-2.5 h-2.5" style={{ color: colors.textSecondary }} />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export function OptionsTab({
  accountId, colors,
}: { accountId: string; colors: Colors }) {
  const [positions, setPositions] = useState<OptionPosition[]>([]);
  const [loading, setLoading]     = useState(false);
  const [showForm, setShowForm]   = useState(false);
  const [seeding, setSeeding]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ status: "open" });
      if (accountId !== "all") qs.set("account_id", accountId);
      const r = await fetch(`/api/options/positions/list?${qs}`);
      setPositions(await r.json());
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  const handleClose = async (id: string) => {
    await fetch(`/api/options/positions/${id}/close`, { method: "PATCH" });
    load();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/options/positions/${id}`, { method: "DELETE" });
    load();
  };

  const handleSeedDemo = async () => {
    setSeeding(true);
    try {
      await fetch("/api/options/positions/seed-demo", { method: "POST" });
      load();
    } catch { /* ignore */ } finally { setSeeding(false); }
  };

  const handleClearDemo = async () => {
    await fetch("/api/options/positions/demo/clear", { method: "DELETE" });
    load();
  };

  const calls = positions.filter(p => p.option_type === "call");
  const puts  = positions.filter(p => p.option_type === "put");

  return (
    <div className="p-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-bold" style={{ color: colors.accent }}>
          DERIVATIVES · OPTIONS
          {positions.length > 0 && (
            <span className="ml-2 text-[9px] font-normal" style={{ color: colors.textSecondary }}>
              {calls.length}C / {puts.length}P open
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={load}
            className="p-0.5 opacity-60 hover:opacity-100"
          >
            {loading
              ? <Loader2 className="w-3 h-3 animate-spin" style={{ color: colors.textSecondary }} />
              : <RefreshCw className="w-3 h-3" style={{ color: colors.textSecondary }} />
            }
          </button>
          <button
            onClick={handleSeedDemo}
            disabled={seeding}
            className="flex items-center gap-1 px-2 py-0.5 text-[8px] font-bold border rounded opacity-60 hover:opacity-100"
            style={{ borderColor: "#555", color: "#888" }}
            title="Insert 6 demo positions for testing"
          >
            {seeding ? <Loader2 className="w-2 h-2 animate-spin" /> : null}
            DEMO
          </button>
          <button
            onClick={handleClearDemo}
            className="px-2 py-0.5 text-[8px] font-bold border rounded opacity-50 hover:opacity-100"
            style={{ borderColor: "#FF4444", color: "#FF4444" }}
            title="Remove all demo positions (notes starting with 'demo')"
          >
            CLEAR DEMO
          </button>
          <button
            onClick={() => setShowForm(v => !v)}
            className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold border rounded"
            style={{ borderColor: colors.accent, color: colors.accent }}
          >
            <Plus className="w-2.5 h-2.5" />
            ADD
          </button>
        </div>
      </div>

      {/* Delay disclaimer — always visible */}
      <div
        className="flex items-center gap-1.5 text-[9px] px-2 py-1 rounded mb-2 border"
        style={{ borderColor: "#f59e0b44", background: "#f59e0b11", color: "#f59e0b" }}
      >
        <Clock className="w-3 h-3 flex-shrink-0" />
        Market data via Yahoo Finance · ~15 min delay · Greeks not available · For position tracking only, not active trading decisions
      </div>

      {showForm && (
        <AddPositionForm
          accountId={accountId}
          colors={colors}
          onAdded={() => { load(); setShowForm(false); }}
        />
      )}

      {positions.length === 0 && !loading ? (
        <div className="text-center py-8 text-[10px]" style={{ color: colors.textSecondary }}>
          No open option positions
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="text-left border-b" style={{ borderColor: colors.border }}>
                {["Underlying", "Type", "Strike", "Expiry", "Qty", "Entry", "Last", "P&L", "Data", ""].map(h => (
                  <th key={h} className="px-2 py-1 font-bold text-[9px]" style={{ color: colors.textSecondary }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map(pos => (
                <PositionRow
                  key={pos.id}
                  pos={pos}
                  colors={colors}
                  onClose={() => handleClose(pos.id)}
                  onDelete={() => handleDelete(pos.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
