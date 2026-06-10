"use client";
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { fmt, fmtK, fmtPct, pnlColor } from "../helpers";
import type { Colors } from "../helpers";

interface PaperAccount { id: string; name: string; currency: string }
interface Position {
  id: string; symbol: string; quantity: number; avg_cost: number;
  realized_pnl: number; current_price: number | null;
  market_value: number | null; unrealized_pnl: number | null;
  unrealized_pnl_pct: number | null;
}

export function PaperPositionsTab({ colors }: { colors: Colors }) {
  const [accounts, setAccounts] = useState<PaperAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/paper/accounts").then(r => r.json()).then(d => {
      const list = Array.isArray(d) ? d : [];
      setAccounts(list);
      if (list.length > 0 && !accountId) setAccountId(list[0].id);
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/paper/accounts/${accountId}/positions`);
      setPositions(await r.json());
    } catch { /* */ } finally { setLoading(false); }
  }, [accountId]);

  useEffect(() => { load(); }, [accountId, load]);

  const totalValue = positions.reduce((s, p) => s + (p.market_value || 0), 0);
  const totalUnrealized = positions.reduce((s, p) => s + (p.unrealized_pnl || 0), 0);

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ fontSize: 10 }}>
      {/* Header */}
      <div className="flex items-center gap-1 px-2 py-1 border-b shrink-0" style={{ borderColor: colors.border }}>
        <select value={accountId} onChange={e => setAccountId(e.target.value)}
          className="bg-transparent border px-1 py-0.5 text-[9px]"
          style={{ borderColor: colors.border, color: colors.text }}>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <span className="text-[8px] opacity-50">
          {positions.length} positions · MV {fmtK(totalValue)}
        </span>
        <span className="text-[8px]" style={{ color: pnlColor(totalUnrealized) }}>
          · P&L {fmtK(totalUnrealized)}
        </span>
        <button className="ml-auto p-0.5" onClick={load}>
          {loading ? <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: colors.textSecondary }} />
                   : <RefreshCw className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />}
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {positions.length === 0 ? (
          <div className="flex items-center justify-center h-full opacity-30 text-xs">No positions</div>
        ) : (
          <table className="w-full text-[9px]">
            <thead className="sticky top-0" style={{ background: "#0a0a0a" }}>
              <tr className="text-left" style={{ color: colors.textSecondary }}>
                <th className="px-2 py-1">SYMBOL</th>
                <th className="px-1 text-right">QTY</th>
                <th className="px-1 text-right">AVG COST</th>
                <th className="px-1 text-right">PRICE</th>
                <th className="px-1 text-right">MKT VALUE</th>
                <th className="px-1 text-right">P&L</th>
                <th className="px-1 text-right">P&L %</th>
                <th className="px-1 text-right">WEIGHT</th>
              </tr>
            </thead>
            <tbody>
              {positions.map(p => (
                <tr key={p.id} className="border-b hover:bg-white/5" style={{ borderColor: `${colors.border}44` }}>
                  <td className="px-2 py-0.5 font-bold" style={{ color: colors.accent }}>{p.symbol}</td>
                  <td className="px-1 text-right font-mono">{fmt(p.quantity, p.quantity % 1 ? 4 : 0)}</td>
                  <td className="px-1 text-right font-mono">{fmt(p.avg_cost)}</td>
                  <td className="px-1 text-right font-mono">
                    {p.current_price ? fmt(p.current_price) : "—"}
                  </td>
                  <td className="px-1 text-right font-mono">
                    {p.market_value != null ? fmtK(p.market_value) : "—"}
                  </td>
                  <td className="px-1 text-right font-mono" style={{ color: pnlColor(p.unrealized_pnl) }}>
                    {p.unrealized_pnl != null ? fmtK(p.unrealized_pnl) : "—"}
                  </td>
                  <td className="px-1 text-right font-mono" style={{ color: pnlColor(p.unrealized_pnl_pct) }}>
                    {p.unrealized_pnl_pct != null ? fmtPct(p.unrealized_pnl_pct) : "—"}
                  </td>
                  <td className="px-1 text-right font-mono opacity-50">
                    {totalValue > 0 && p.market_value ? `${((p.market_value / totalValue) * 100).toFixed(1)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
