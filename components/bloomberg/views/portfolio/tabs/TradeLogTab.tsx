"use client";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type Colors, FLAG, fmt, fmtK, pnlColor } from "../helpers";
import { TradeEditModal } from "../modals/TradeEditModal";
import type { Trade } from "../types";
import { WLBadge } from "../ui/AccBadge";

export function TradeLogTab({
  accountId,
  currency,
  colors,
}: { accountId: string; currency: "THB" | "USD"; colors: Colors }) {
  const [data, setData] = useState<{ trades: Trade[]; thb_per_usd: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"ALL" | "W" | "L">("ALL");
  const [search, setSearch] = useState("");
  const [editTarget, setEditTarget] = useState<Trade | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ limit: "1000" });
        if (accountId !== "all") qs.set("account_id", accountId);
        const r = await fetch(`/api/v2/portfolio/trades?${qs}`, { signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        setData(
          d && !Array.isArray(d) ? d : { trades: Array.isArray(d) ? d : [], thb_per_usd: 33.5 }
        );
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [accountId]
  );

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const trades = data?.trades ?? [];
  const thb_per_usd = data?.thb_per_usd ?? 33.5;
  const csym = currency === "THB" ? "฿" : "$";

  const toBase = (v: number, tradeCurrency: string) => {
    if (tradeCurrency === "USD" && currency === "THB") return v * thb_per_usd;
    if (tradeCurrency === "THB" && currency === "USD") return v / thb_per_usd;
    return v;
  };

  const filtered = trades.filter((t) => {
    if (filter !== "ALL" && t.win_loss !== filter) return false;
    if (search) {
      const q = search.toUpperCase();
      return (
        t.symbol.includes(q) ||
        (t.sector || "").toUpperCase().includes(q) ||
        (t.strategy_name || "").toUpperCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div>
      <div
        className="flex items-center gap-2 px-3 py-1.5 border-b"
        style={{ borderColor: colors.border }}
      >
        <span className="text-[10px] font-bold tracking-widest" style={{ color: colors.accent }}>
          TRADE LOG
        </span>
        <span className="text-[9px]" style={{ color: colors.textSecondary }}>
          ({filtered.length}/{trades.length})
        </span>
        <div className="flex gap-0.5 ml-2">
          {(["ALL", "W", "L"] as const).map((f) => (
            <button
              type="button"
              key={f}
              onClick={() => setFilter(f)}
              className="text-[9px] px-2 py-0.5 font-bold border"
              style={{
                borderColor: filter === f ? colors.accent : colors.border,
                color: filter === f ? colors.accent : colors.textSecondary,
                background: filter === f ? `${colors.accent}22` : "transparent",
              }}
            >
              {f}
            </button>
          ))}
        </div>
        <input
          className="text-[9px] px-2 py-0.5 border outline-none font-mono ml-auto w-24"
          style={{ background: colors.background, color: colors.text, borderColor: colors.border }}
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          type="button"
          onClick={() => load()}
          disabled={loading}
          className="p-1 hover:opacity-70"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" style={{ color: colors.accent }} />
          ) : (
            <RefreshCw className="h-3 w-3" style={{ color: colors.textSecondary }} />
          )}
        </button>
      </div>
      <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 280px)" }}>
        <table className="w-full text-[10px] font-mono" style={{ borderCollapse: "collapse" }}>
          <thead className="sticky top-0">
            <tr style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}>
              {[
                "DATE IN",
                "DATE OUT",
                "ACCT",
                "SYMBOL",
                "SECTOR",
                "ENTRY",
                "EXIT",
                "VOL",
                "AMOUNT",
                "P&L",
                "W/L",
                "STRATEGY",
                "NOTE",
                "",
              ].map((h) => (
                <th
                  key={h}
                  className="px-2 py-1 text-left whitespace-nowrap text-[9px] font-bold tracking-wider"
                  style={{ color: colors.textSecondary }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => {
              const pnlVal = t.pnl_amount != null ? toBase(t.pnl_amount, t.currency) : null;
              const amountVal = t.amount != null ? toBase(Math.abs(t.amount), t.currency) : null;
              return (
                <tr
                  key={t.id}
                  className="hover:bg-[#111]"
                  style={{ borderBottom: "1px solid #1a1a1a" }}
                >
                  <td
                    className="px-2 py-0.5 whitespace-nowrap"
                    style={{ color: colors.textSecondary }}
                  >
                    {t.date_entry}
                  </td>
                  <td
                    className="px-2 py-0.5 whitespace-nowrap"
                    style={{ color: colors.textSecondary }}
                  >
                    {t.date_exit || "—"}
                  </td>
                  <td className="px-2 py-0.5">{FLAG[t.currency === "USD" ? "US" : "TH"] ?? ""}</td>
                  <td className="px-2 py-0.5 font-bold" style={{ color: colors.accent }}>
                    {t.symbol}
                  </td>
                  <td className="px-2 py-0.5 text-[9px]" style={{ color: colors.textSecondary }}>
                    {t.sector || "—"}
                  </td>
                  <td className="px-2 py-0.5">
                    {t.price_entry ? `${csym}${fmt(toBase(t.price_entry, t.currency))}` : "—"}
                  </td>
                  <td className="px-2 py-0.5">
                    {t.price_exit ? `${csym}${fmt(toBase(t.price_exit, t.currency))}` : "—"}
                  </td>
                  <td className="px-2 py-0.5">{t.volume}</td>
                  <td className="px-2 py-0.5">
                    {amountVal != null ? `${csym}${fmtK(amountVal)}` : "—"}
                  </td>
                  <td className="px-2 py-0.5 font-bold" style={{ color: pnlColor(pnlVal) }}>
                    {pnlVal != null
                      ? `${csym}${fmtK(Math.abs(pnlVal))} ${pnlVal >= 0 ? "▲" : "▼"}`
                      : "—"}
                  </td>
                  <td className="px-2 py-0.5">
                    <WLBadge wl={t.win_loss} />
                  </td>
                  <td className="px-2 py-0.5 text-[8px]" style={{ color: colors.textSecondary }}>
                    {t.strategy_name || "—"}
                  </td>
                  <td
                    className="px-2 py-0.5 text-[8px] max-w-[120px] truncate"
                    style={{ color: colors.textSecondary }}
                    title={t.note}
                  >
                    {t.note || ""}
                  </td>
                  <td className="px-1 py-0.5">
                    <button
                      type="button"
                      onClick={() => setEditTarget(t)}
                      className="text-[7px] px-1 py-0.5 border font-bold hover:opacity-80"
                      style={{
                        borderColor: "#ff990055",
                        color: "#ff9900",
                        background: "#ff990010",
                      }}
                    >
                      EDIT
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && !loading && (
          <div className="py-8 text-center text-[10px]" style={{ color: colors.textSecondary }}>
            No trades found
          </div>
        )}
      </div>
      {editTarget && (
        <TradeEditModal
          trade={editTarget}
          colors={colors}
          onClose={() => setEditTarget(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
