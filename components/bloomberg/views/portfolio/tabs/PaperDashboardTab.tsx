"use client";
import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, RefreshCw, Loader2 } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { fmt, fmtK, fmtPct, pnlColor } from "../helpers";
import type { Colors } from "../helpers";

interface PaperAccount {
  id: string; name: string; currency: string;
  initial_balance: number; created_at: string;
}

interface AccountSummary {
  account_id: string; name: string; currency: string;
  initial_balance: number; cash: number; positions_value: number;
  equity: number; unrealized_pnl: number; realized_pnl: number;
  total_return: number; total_return_pct: number; positions_count: number;
}

interface EquityPoint { date: string; equity: number; cash: number; positions_value: number }

export function PaperDashboardTab({ colors }: { colors: Colors }) {
  const [accounts, setAccounts] = useState<PaperAccount[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [curve, setCurve] = useState<EquityPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBalance, setNewBalance] = useState("100000");
  const [newCurrency, setNewCurrency] = useState("USD");

  const loadAccounts = useCallback(async () => {
    try {
      const r = await fetch("/api/paper/accounts");
      const d = await r.json();
      const list = Array.isArray(d) ? d : [];
      setAccounts(list);
      if (list.length > 0 && !activeId) setActiveId(list[0].id);
    } catch { /* */ }
  }, [activeId]);

  const loadSummary = useCallback(async () => {
    if (!activeId) return;
    setLoading(true);
    try {
      const [sr, cr] = await Promise.all([
        fetch(`/api/paper/accounts/${activeId}/summary`),
        fetch(`/api/paper/accounts/${activeId}/equity-curve`),
      ]);
      setSummary(await sr.json());
      setCurve(await cr.json());
    } catch { /* */ } finally { setLoading(false); }
  }, [activeId]);

  useEffect(() => { loadAccounts(); }, []);
  useEffect(() => { if (activeId) loadSummary(); }, [activeId, loadSummary]);

  const createAccount = async () => {
    if (!newName.trim()) return;
    await fetch("/api/paper/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, currency: newCurrency, initial_balance: parseFloat(newBalance) || 100000 }),
    });
    setShowCreate(false);
    setNewName("");
    await loadAccounts();
  };

  const deleteAccount = async (id: string) => {
    if (!confirm("Delete this paper account and all its data?")) return;
    await fetch(`/api/paper/accounts/${id}`, { method: "DELETE" });
    if (activeId === id) setActiveId("");
    await loadAccounts();
  };

  const s = summary;

  return (
    <div className="flex flex-col h-full overflow-y-auto p-2 gap-2" style={{ fontSize: 10 }}>
      {/* Account selector */}
      <div className="flex items-center gap-1 flex-wrap">
        {accounts.map(a => (
          <button key={a.id}
            className="flex items-center gap-1 px-2 py-0.5 border font-bold text-[9px]"
            style={{
              borderColor: activeId === a.id ? colors.accent : colors.border,
              color: activeId === a.id ? colors.accent : colors.textSecondary,
              background: activeId === a.id ? `${colors.accent}22` : "transparent",
            }}
            onClick={() => setActiveId(a.id)}>
            📄 {a.name}
            <span className="opacity-50 text-[8px]">{a.currency}</span>
            <Trash2 className="h-2 w-2 ml-1 opacity-40 hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); deleteAccount(a.id); }} />
          </button>
        ))}
        <button className="flex items-center gap-0.5 px-2 py-0.5 border text-[9px] font-bold"
          style={{ borderColor: colors.border, color: colors.textSecondary }}
          onClick={() => setShowCreate(!showCreate)}>
          <Plus className="h-2.5 w-2.5" /> NEW
        </button>
        {activeId && (
          <button className="ml-auto p-0.5" onClick={loadSummary}>
            {loading ? <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: colors.textSecondary }} />
                     : <RefreshCw className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />}
          </button>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="flex items-center gap-1 p-1 border" style={{ borderColor: colors.border }}>
          <input placeholder="Account name" value={newName} onChange={e => setNewName(e.target.value)}
            className="bg-transparent border px-1 py-0.5 text-[9px] w-28"
            style={{ borderColor: colors.border, color: colors.text }} />
          <select value={newCurrency} onChange={e => setNewCurrency(e.target.value)}
            className="bg-transparent border px-1 py-0.5 text-[9px]"
            style={{ borderColor: colors.border, color: colors.text }}>
            <option value="USD">USD</option>
            <option value="THB">THB</option>
          </select>
          <input placeholder="Balance" value={newBalance} onChange={e => setNewBalance(e.target.value)}
            className="bg-transparent border px-1 py-0.5 text-[9px] w-20"
            style={{ borderColor: colors.border, color: colors.text }} />
          <button onClick={createAccount}
            className="px-2 py-0.5 text-[9px] font-bold"
            style={{ background: colors.accent, color: "#000" }}>
            CREATE
          </button>
        </div>
      )}

      {/* Summary cards */}
      {s && (
        <div className="grid grid-cols-4 gap-1">
          {[
            { label: "EQUITY", value: fmtK(s.equity), sub: s.currency },
            { label: "CASH", value: fmtK(s.cash), sub: `${((s.cash / s.equity) * 100).toFixed(0)}%` },
            { label: "UNREALIZED", value: fmtK(s.unrealized_pnl), color: pnlColor(s.unrealized_pnl) },
            { label: "TOTAL RETURN", value: fmtPct(s.total_return_pct), color: pnlColor(s.total_return) },
          ].map(c => (
            <div key={c.label} className="border p-1.5" style={{ borderColor: colors.border }}>
              <div className="text-[7px] opacity-50">{c.label}</div>
              <div className="text-xs font-bold" style={{ color: c.color || colors.text }}>
                {c.value}
              </div>
              {c.sub && <div className="text-[7px] opacity-40">{c.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Equity curve */}
      {curve.length > 1 && s && (
        <div className="border flex-1 min-h-[140px]" style={{ borderColor: colors.border }}>
          <div className="text-[8px] font-bold px-2 py-1 opacity-50">EQUITY CURVE</div>
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={curve} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
              <XAxis dataKey="date" tick={{ fontSize: 7, fill: colors.textSecondary }} />
              <YAxis tick={{ fontSize: 7, fill: colors.textSecondary }} domain={["auto", "auto"]} />
              <Tooltip contentStyle={{ background: "#111", border: `1px solid ${colors.border}`, fontSize: 9 }} />
              <ReferenceLine y={s.initial_balance} stroke={colors.textSecondary} strokeDasharray="3 3" />
              <Line type="monotone" dataKey="equity" stroke={colors.accent} dot={false} strokeWidth={1.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {!activeId && accounts.length === 0 && (
        <div className="flex-1 flex items-center justify-center opacity-30 text-xs">
          Create a paper trading account to start
        </div>
      )}
    </div>
  );
}
