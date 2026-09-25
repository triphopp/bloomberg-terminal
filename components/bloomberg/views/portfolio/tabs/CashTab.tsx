"use client";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BLANK_CASH, BLANK_DIV } from "../constants";
import { type Colors, fmtK, pnlColor } from "../helpers";
import { BLANK_FILTER, type LedgerFilter, applyFilter, yearsOf } from "../ledger-filter";
import { CashReconcileModal } from "../modals/CashReconcileModal";
import { ConfirmDeleteModal } from "../modals/ConfirmDeleteModal";
import type { CashEntry, CashFlowForm, CashFlowType, Dividend, Summary, Trade } from "../types";
import { LedgerFilterBar } from "../ui/LedgerFilterBar";
import { SubPortSelect } from "../ui/SubPortSelect";

type SubTab = "cash" | "dividends" | "reinvest";

/** POST /api/v2/portfolio/dividends/check — see backend/dividend_check.py */
interface DivCheckIssue {
  level: "error" | "warn" | "info";
  code: string;
  message: string;
  fix?: { currency?: string; amount_per_unit?: number; total_received?: number; label: string };
  alt_fix?: { currency?: string; label: string };
}
interface DivCheck {
  instrument_currency: string | null;
  entered_currency: string;
  expected_per_unit: number | null;
  expected_ex_date: string | null;
  held_units: number | null;
  gross_expected: number | null;
  issues: DivCheckIssue[];
}
const FILTER_KEY = "bloomberg_cash_filters";

export function CashTab({
  accountId,
  summary,
  colors,
}: { accountId: string; summary?: Summary | null; colors: Colors }) {
  const [cash, setCash] = useState<CashEntry[]>([]);
  const [dividends, setDivs] = useState<Dividend[]>([]);
  const [reinvestTrades, setReinvestTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(false);
  const [subTab, setSubTab] = useState<SubTab>("cash");
  // One filter per ledger, remembered across visits (read in the initializer,
  // written by the effect below — CLAUDE.md localStorage pattern).
  const [filters, setFilters] = useState<Record<SubTab, LedgerFilter>>(() => {
    const blank = { cash: BLANK_FILTER, dividends: BLANK_FILTER, reinvest: BLANK_FILTER };
    if (typeof window === "undefined") return blank;
    try {
      const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
      return {
        cash: { ...BLANK_FILTER, ...saved.cash },
        dividends: { ...BLANK_FILTER, ...saved.dividends },
        reinvest: { ...BLANK_FILTER, ...saved.reinvest },
      };
    } catch {
      return blank;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
    } catch {
      /* storage unavailable — filters just won't persist */
    }
  }, [filters]);
  const updateFilter = (tab: SubTab) => (fn: (f: LedgerFilter) => LedgerFilter) =>
    setFilters((all) => ({ ...all, [tab]: fn(all[tab]) }));
  const [showForm, setShowForm] = useState(false);
  const [showTransferForm, setShowTransferForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [cashForm, setCashForm] = useState<CashFlowForm>(BLANK_CASH);
  const [cashError, setCashError] = useState<string | null>(null);
  const [transferForm, setTransferForm] = useState({
    from_account_id: "finansia",
    to_account_id: "dime",
    date: new Date().toISOString().slice(0, 10),
    amount: 0,
    note: "",
  });
  const [divForm, setDivForm] = useState<Omit<Dividend, "id">>(BLANK_DIV);
  // Unit check of the dividend being typed. Until the user picks a currency
  // themselves, it follows the asset's (the old silent server override).
  const [divCheck, setDivCheck] = useState<DivCheck | null>(null);
  const [currencyTouched, setCurrencyTouched] = useState(false);
  const [divSaveError, setDivSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cashEditOpen, setCashEditOpen] = useState(false);
  const [deleteCashTarget, setDeleteCashTarget] = useState<CashEntry | null>(null);
  const [deleteDivTarget, setDeleteDivTarget] = useState<Dividend | null>(null);
  const [suggestions, setSuggestions] = useState<
    {
      asset: string;
      account_id: string;
      amount_per_unit: number;
      ex_date: string;
      pay_date: string;
      currency: string;
    }[]
  >([]);
  const [suggestLoading, setSuggestLoading] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const qs = accountId !== "all" ? `?account_id=${accountId}` : "";
        const tradeQs = accountId !== "all" ? `?account_id=${accountId}&` : "?";
        const [cr, dr, tr] = await Promise.all([
          fetch(`/api/v2/portfolio/cash${qs}`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
          fetch(`/api/v2/portfolio/dividends${qs}`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
          fetch(`/api/v2/portfolio/trades${tradeQs}is_reinvest=true`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
        ]);
        setCash(Array.isArray(cr) ? cr : []);
        setDivs(Array.isArray(dr) ? dr : []);
        setReinvestTrades(Array.isArray(tr?.trades) ? tr.trades : []);
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
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

  const fetchSuggestions = useCallback(
    async (signal?: AbortSignal) => {
      setSuggestLoading(true);
      try {
        const qs = accountId !== "all" ? `?account_id=${accountId}` : "";
        const r = await fetch(`/api/v2/portfolio/dividend-suggestions${qs}`, { signal });
        if (!r.ok) throw new Error();
        const data = await r.json();
        setSuggestions(data.suggestions ?? []);
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
        setSuggestions([]);
      } finally {
        setSuggestLoading(false);
      }
    },
    [accountId]
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchSuggestions(ac.signal);
    return () => ac.abort();
  }, [fetchSuggestions]);

  const applySuggestion = useCallback((s: (typeof suggestions)[0]) => {
    setSubTab("dividends");
    setShowForm(true);
    setEditId(null);
    setDivForm({
      account_id: s.account_id,
      asset: s.asset,
      ex_date: s.ex_date,
      pay_date: s.pay_date,
      amount_per_unit: s.amount_per_unit,
      total_received: 0,
      reinvested_amount: 0,
      reinvest_asset: "",
      reinvest_price: 0,
      reinvest_units: 0,
      currency: s.currency || "THB",
    });
  }, []);

  const untagTrade = useCallback(async (tradeId: string) => {
    const r = await fetch(`/api/v2/portfolio/trades/${tradeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_reinvest: false, adjustment_reason: "Untagged from REINVEST" }),
    });
    if (r.ok) setReinvestTrades((list) => list.filter((t) => t.id !== tradeId));
  }, []);

  // Two different numbers on purpose: IN/INV are what was typed into this
  // ledger; CASH~ also folds in realized P&L from closed positions. Labelling
  // them apart is the point — a reader who assumes they should match will read
  // the difference as a bug.
  const derivedCash =
    accountId === "all"
      ? summary?.total_cash_base
      : summary?.accounts.find((a) => a.account.id === accountId)?.cash_base;
  const cashReconciled =
    accountId === "all"
      ? summary?.cash_is_estimate === false
      : !!summary?.accounts.find((a) => a.account.id === accountId)?.cash_reconciled_at;
  const summaryCcy: "THB" | "USD" = summary?.base_currency === "USD" ? "USD" : "THB";

  const accountOptions = (summary?.accounts ?? []).map((a) => a.account);
  const defaultAccount = accountId !== "all" ? accountId : (accountOptions[0]?.id ?? "");
  const flowOf = (c: CashEntry): CashFlowType =>
    c.flow_type ??
    (c.entry_type === "TRANSFER"
      ? c.investment < 0
        ? "TRANSFER_OUT"
        : "TRANSFER_IN"
      : c.investment < 0
        ? "WITHDRAW"
        : "DEPOSIT");
  // Capital in / out of the portfolio. Transfers move money between accounts,
  // so they are counted apart — inside ALL they net to zero.
  const totalDeposit = cash
    .filter((c) => flowOf(c) === "DEPOSIT")
    .reduce((a, c) => a + c.investment, 0);
  const totalWithdraw = cash
    .filter((c) => flowOf(c) === "WITHDRAW")
    .reduce((a, c) => a - c.investment, 0);
  const totalTransfer = cash
    .filter((c) => c.entry_type === "TRANSFER")
    .reduce((a, c) => a + c.investment, 0);
  const netCapital = cash.reduce((a, c) => a + c.investment, 0);
  // Running net capital, oldest first — the balance column of a ledger. The
  // list arrives newest first, so walk it backwards.
  const runningCapital = new Map<string, number>();
  {
    let bal = 0;
    for (let i = cash.length - 1; i >= 0; i--) {
      bal += cash[i].investment;
      runningCapital.set(cash[i].id, bal);
    }
  }
  const totalDiv = dividends.reduce<Record<string, number>>((a, d) => {
    a[d.currency || "THB"] = (a[d.currency || "THB"] || 0) + d.total_received;
    return a;
  }, {});
  // REINVEST view merges two sources: dividend rows carrying reinvest fields,
  // and trades ticked "REINVEST?" in ENTRY. Trade rows are a label only — they
  // are already counted in positions/cost basis, so nothing else is adjusted.
  type ReinvestRow = {
    key: string;
    source: string;
    account_id: string;
    date: string;
    divAmount: number | null;
    reinvestAmount: number;
    asset: string;
    price: number;
    units: number;
    currency: string;
    dividend?: Dividend;
    trade?: Trade;
  };

  const reinvestRows: ReinvestRow[] = [
    ...dividends
      .filter((d) => d.reinvested_amount > 0)
      .map((d) => ({
        key: `div-${d.id}`,
        source: d.asset,
        account_id: d.account_id,
        date: d.pay_date || "",
        divAmount: d.total_received,
        reinvestAmount: d.reinvested_amount,
        asset: d.reinvest_asset || "",
        price: d.reinvest_price || 0,
        units: d.reinvest_units || 0,
        currency: d.currency || "THB",
        dividend: d,
      })),
    ...reinvestTrades.map((t) => ({
      key: `trade-${t.id}`,
      source: "TRADE",
      account_id: t.account_id,
      date: t.date_entry || "",
      divAmount: null,
      reinvestAmount: Math.abs(t.amount ?? t.price_entry * t.volume),
      asset: t.symbol,
      price: t.price_entry,
      units: t.volume,
      currency: t.currency || "THB",
      trade: t,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const today = new Date().toISOString().slice(0, 10);
  const filteredCash = applyFilter(
    cash,
    filters.cash,
    {
      date: (c) => c.date,
      amount: (c) => c.investment,
      account: (c) => c.account_id,
      // IN and OUT legs share one chip: "show me the transfers".
      type: (c) => (c.entry_type === "TRANSFER" ? "TRANSFER" : flowOf(c)),
      text: (c) => [c.note, c.account_id, flowOf(c)],
    },
    today
  );
  const filteredDivs = useMemo(
    () =>
      applyFilter(
        dividends,
        filters.dividends,
        {
          date: (d) => d.pay_date || d.ex_date || "",
          amount: (d) => d.total_received,
          account: (d) => d.account_id,
          type: (d) => d.currency || "THB",
          text: (d) => [d.asset, d.account_id],
        },
        today
      ),
    [dividends, filters.dividends, today]
  );
  const filteredReinvest = applyFilter(
    reinvestRows,
    filters.reinvest,
    {
      date: (r) => r.date,
      amount: (r) => r.reinvestAmount,
      account: (r) => r.account_id,
      type: (r) => (r.trade ? "TRADE" : "DIV"),
      text: (r) => [r.source, r.asset, r.account_id],
    },
    today
  );
  const shownOf = (n: number, total: number) =>
    n === total ? `${total} rows` : `${n} / ${total} rows`;
  const sumBy = <T,>(rows: T[], ccy: (r: T) => string, amt: (r: T) => number) =>
    rows.reduce<Record<string, number>>((a, r) => {
      a[ccy(r)] = (a[ccy(r)] || 0) + amt(r);
      return a;
    }, {});

  const totalReinvest = reinvestRows.reduce<Record<string, number>>((a, r) => {
    a[r.currency] = (a[r.currency] || 0) + r.reinvestAmount;
    return a;
  }, {});
  const money = (amount: number, ccy: string) => `${ccy === "THB" ? "฿" : "$"}${fmtK(amount)}`;
  const mixedMoney = (values: Record<string, number>) =>
    Object.entries(values)
      .filter(([, value]) => value !== 0)
      .map(([ccy, value]) => money(value, ccy))
      .join(" / ") || "—";

  const saveCash = async () => {
    const account = cashForm.account_id || defaultAccount;
    if (!cashForm.date || !account || cashForm.amount <= 0) return;
    setSaving(true);
    setCashError(null);
    try {
      const url = editId ? `/api/v2/portfolio/cash/${editId}` : "/api/v2/portfolio/cash";
      const method = editId ? "PUT" : "POST";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...cashForm, account_id: account, exchange_rate: 1 }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setCashError(typeof d?.detail === "string" ? d.detail : `Save failed (${r.status})`);
        return;
      }
      // A server that predates typed flows drops flow_type/amount and posts a
      // zero row without complaint — its reply has no entry_type to echo.
      const saved = await r.json().catch(() => ({}));
      if (!saved?.entry_type) {
        setCashError("Backend is running old code — restart it, then delete any ฿0 row");
        load();
        return;
      }
      setShowForm(false);
      setEditId(null);
      setCashForm(BLANK_CASH);
      load();
    } catch {
      setCashError("Backend unavailable");
    } finally {
      setSaving(false);
    }
  };

  const deleteCash = async (id: string) => {
    await fetch(`/api/v2/portfolio/cash/${id}`, { method: "DELETE" });
    setDeleteCashTarget(null);
    load();
  };

  const saveTransfer = async () => {
    if (!transferForm.date || transferForm.amount <= 0) return;
    if (transferForm.from_account_id === transferForm.to_account_id) return;
    setSaving(true);
    try {
      await fetch("/api/v2/portfolio/cash/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(transferForm),
      });
      setShowTransferForm(false);
      setTransferForm((f) => ({ ...f, amount: 0, note: "" }));
      load();
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  };

  const editCash = (c: CashEntry) => {
    const amount = Math.abs(c.investment);
    setCashForm({
      account_id: c.account_id,
      date: c.date,
      flow_type: c.investment < 0 ? "WITHDRAW" : "DEPOSIT",
      amount,
      note: c.note,
      // Excel-imported rows can carry a gross that differs from the capital
      // flow; keep it rather than overwrite it with the amount.
      ...(Math.abs(c.income) !== amount ? { income: c.income } : {}),
    });
    setCashError(null);
    setEditId(c.id);
    setShowForm(true);
    setSubTab("cash");
  };

  const saveDiv = async (force = false) => {
    if (!divForm.asset) return;
    setSaving(true);
    setDivSaveError(null);
    try {
      const url = editId ? `/api/v2/portfolio/dividends/${editId}` : "/api/v2/portfolio/dividends";
      const method = editId ? "PUT" : "POST";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...divForm, force }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        // 422 = a unit problem the check calls an error; the panel shows it
        // with a fix, and SAVE ANYWAY re-sends with force.
        if (r.status === 422 && d?.detail?.check) setDivCheck(d.detail.check);
        setDivSaveError(
          typeof d?.detail === "string"
            ? d.detail
            : (d?.detail?.message ?? `Save failed (${r.status})`)
        );
        return;
      }
      setShowForm(false);
      setEditId(null);
      setDivForm(BLANK_DIV);
      setDivCheck(null);
      load();
    } catch {
      setDivSaveError("Backend unavailable");
    } finally {
      setSaving(false);
    }
  };

  // Live unit check while the dividend form is open (debounced).
  const divFormOpen = showForm && (subTab === "dividends" || subTab === "reinvest");
  useEffect(() => {
    // Any edit makes the last save's rejection stale.
    setDivSaveError(null);
    if (!divFormOpen || !divForm.asset || !(divForm.ex_date || divForm.pay_date)) {
      setDivCheck(null);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch("/api/v2/portfolio/dividends/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Untouched currency → let the server say what the asset trades in.
          body: JSON.stringify({ ...divForm, currency: currencyTouched ? divForm.currency : null }),
          signal: ac.signal,
        });
        if (!r.ok) return;
        const d: DivCheck = await r.json();
        setDivCheck(d);
        if (!currencyTouched && d.entered_currency && d.entered_currency !== divForm.currency) {
          setDivForm((f) => ({ ...f, currency: d.entered_currency }));
        }
      } catch {
        /* aborted or offline — no check shown */
      }
    }, 500);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [divFormOpen, divForm, currencyTouched]);

  const deleteDiv = async (id: string) => {
    await fetch(`/api/v2/portfolio/dividends/${id}`, { method: "DELETE" });
    setDeleteDivTarget(null);
    load();
  };

  const editDiv = (d: Dividend) => {
    setDivForm({
      account_id: d.account_id,
      asset: d.asset,
      ex_date: d.ex_date,
      pay_date: d.pay_date,
      amount_per_unit: d.amount_per_unit,
      total_received: d.total_received,
      reinvested_amount: d.reinvested_amount || 0,
      reinvest_asset: d.reinvest_asset || "",
      reinvest_price: d.reinvest_price || 0,
      reinvest_units: d.reinvest_units || 0,
      currency: d.currency || "THB",
    });
    setEditId(d.id);
    setCurrencyTouched(true);
    setDivSaveError(null);
    setShowForm(true);
    setSubTab("dividends");
  };

  const inputStyle: React.CSSProperties = {
    background: "#111",
    border: `1px solid ${colors.border}`,
    color: colors.text,
    padding: "3px 6px",
    fontSize: "10px",
    fontFamily: "monospace",
    width: "100%",
  };

  return (
    <div>
      {/* Header bar */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 border-b flex-wrap"
        style={{ borderColor: colors.border }}
      >
        {(["cash", "dividends", "reinvest"] as const).map((t) => (
          <button
            type="button"
            key={t}
            onClick={() => {
              setSubTab(t);
              setShowForm(false);
              setEditId(null);
            }}
            className="text-[9px] px-2 py-0.5 border font-bold uppercase"
            style={{
              borderColor: subTab === t ? colors.accent : colors.border,
              color: subTab === t ? colors.accent : colors.textSecondary,
              background: subTab === t ? `${colors.accent}22` : "transparent",
            }}
          >
            {t === "reinvest" ? "REINVEST" : t}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            setShowForm(!showForm);
            setShowTransferForm(false);
            setEditId(null);
            setCashForm({ ...BLANK_CASH, account_id: defaultAccount });
            setCashError(null);
            setDivForm(BLANK_DIV);
            setCurrencyTouched(false);
            setDivCheck(null);
            setDivSaveError(null);
          }}
          className="text-[9px] px-2 py-0.5 border font-bold"
          style={{ borderColor: colors.accent, color: "#000", background: colors.accent }}
        >
          + ADD
        </button>
        {subTab === "cash" && (
          <button
            type="button"
            onClick={() => {
              setShowTransferForm(!showTransferForm);
              setShowForm(false);
              setEditId(null);
            }}
            className="text-[9px] px-2 py-0.5 border font-bold"
            style={{
              borderColor: "#60a5fa",
              color: showTransferForm ? "#000" : "#60a5fa",
              background: showTransferForm ? "#60a5fa" : "transparent",
            }}
          >
            ⇄ TRANSFER
          </button>
        )}
        <div className="ml-auto flex gap-3 text-[9px] font-mono flex-wrap">
          {derivedCash != null && (
            <button
              type="button"
              onClick={() => setCashEditOpen(true)}
              className="hover:opacity-80"
              style={{ color: colors.textSecondary }}
              title={
                "invested + realized P&L (equities and options) + dividends − open cost basis, " +
                "plus any EDIT you made. It will NOT equal NET below: that is what " +
                "you typed into this ledger, while this also folds in every position you have " +
                "closed. Click to set it to the broker balance."
              }
            >
              CASH{cashReconciled ? "" : "~"}{" "}
              <span style={{ color: derivedCash >= 0 ? "#facc15" : "#f87171" }}>
                {derivedCash < 0 ? "-" : ""}
                {summaryCcy === "THB" ? "฿" : "$"}
                {fmtK(Math.abs(derivedCash))}
              </span>
              {!cashReconciled && <span className="ml-0.5 text-[8px]">est</span>}
              <span className="ml-1 text-[8px] border px-1" style={{ borderColor: colors.border }}>
                EDIT
              </span>
            </button>
          )}
          {cashEditOpen && summary && (
            <CashReconcileModal
              summary={summary}
              currency={summaryCcy}
              colors={colors}
              accountId={accountId}
              onClose={() => setCashEditOpen(false)}
            />
          )}
          <span style={{ color: colors.textSecondary }} title="Capital deposited (ledger, THB)">
            DEP: <span style={{ color: "#4ade80" }}>฿{fmtK(totalDeposit)}</span>
          </span>
          <span style={{ color: colors.textSecondary }} title="Capital withdrawn (ledger, THB)">
            WD: <span style={{ color: "#f87171" }}>฿{fmtK(totalWithdraw)}</span>
          </span>
          {totalTransfer !== 0 && (
            <span style={{ color: colors.textSecondary }} title="Net transfers into this scope">
              XFER:{" "}
              <span style={{ color: "#60a5fa" }}>
                {totalTransfer < 0 ? "-" : ""}฿{fmtK(Math.abs(totalTransfer))}
              </span>
            </span>
          )}
          <span
            style={{ color: colors.textSecondary }}
            title="DEP − WD ± transfers = invested capital. CASH above differs: it also folds in realized P&L, dividends and what is still deployed."
          >
            NET:{" "}
            <span style={{ color: colors.text }}>
              {netCapital < 0 ? "-" : ""}฿{fmtK(Math.abs(netCapital))}
            </span>
          </span>
          <span style={{ color: colors.textSecondary }}>
            DIV: <span style={{ color: "#60a5fa" }}>{mixedMoney(totalDiv)}</span>
          </span>
          {Object.values(totalReinvest).some((value) => value > 0) && (
            <span style={{ color: colors.textSecondary }}>
              REINV: <span style={{ color: "#c084fc" }}>{mixedMoney(totalReinvest)}</span>
            </span>
          )}
        </div>
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

      {/* Suggestion chips */}
      {suggestions.length > 0 && (
        <div
          className="px-3 py-1.5 border-b flex items-center gap-2 flex-wrap"
          style={{ borderColor: colors.border, background: "#050505" }}
        >
          <span className="text-[8px] font-mono" style={{ color: "#60a5fa" }}>
            DIV SUGGESTIONS:
          </span>
          {suggestions.map((s) => (
            <button
              key={`${s.asset}-${s.account_id}-${s.ex_date}`}
              type="button"
              onClick={() => applySuggestion(s)}
              className="text-[8px] px-2 py-0.5 border font-mono hover:opacity-80"
              style={{ borderColor: "#60a5fa33", color: "#60a5fa", background: "#60a5fa08" }}
            >
              {s.asset} {s.currency === "THB" ? "฿" : "$"}
              {s.amount_per_unit.toFixed(4)} <span style={{ color: "#555" }}>{s.ex_date}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => fetchSuggestions()}
            disabled={suggestLoading}
            className="ml-auto p-0.5 hover:opacity-70"
            title="Refresh dividend suggestions"
          >
            <RefreshCw
              className={`h-2.5 w-2.5 ${suggestLoading ? "animate-spin" : ""}`}
              style={{ color: "#60a5fa" }}
            />
          </button>
        </div>
      )}

      {/* ADD / EDIT FORM — Cash */}
      {showForm && subTab === "cash" && (
        <div
          className="px-3 py-2 border-b"
          style={{ borderColor: colors.border, background: "#080808" }}
        >
          <div className="text-[9px] font-bold mb-1.5" style={{ color: colors.accent }}>
            {editId ? "EDIT CASH FLOW" : "ADD CASH FLOW"}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <div>
              <label
                htmlFor="cash-account"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                ACCOUNT
              </label>
              <select
                id="cash-account"
                style={inputStyle}
                value={cashForm.account_id || defaultAccount}
                onChange={(e) => setCashForm((f) => ({ ...f, account_id: e.target.value }))}
              >
                {accountOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="cash-date"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                DATE
              </label>
              <input
                id="cash-date"
                type="date"
                style={inputStyle}
                value={cashForm.date}
                onChange={(e) => setCashForm((f) => ({ ...f, date: e.target.value }))}
              />
            </div>
            <div>
              <span className="text-[8px]" style={{ color: colors.textSecondary }}>
                TYPE
              </span>
              <div className="flex gap-1">
                {(["DEPOSIT", "WITHDRAW"] as const).map((t) => {
                  const on = cashForm.flow_type === t;
                  const c = t === "DEPOSIT" ? "#4ade80" : "#f87171";
                  return (
                    <button
                      type="button"
                      key={t}
                      data-frame
                      onClick={() => setCashForm((f) => ({ ...f, flow_type: t }))}
                      className="flex-1 text-[9px] py-[3px] font-bold border"
                      style={{
                        borderColor: on ? c : colors.border,
                        color: on ? "#000" : c,
                        background: on ? c : "transparent",
                      }}
                    >
                      {t === "DEPOSIT" ? "+ DEPOSIT" : "− WITHDRAW"}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label
                htmlFor="cash-amount"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                AMOUNT (THB)
              </label>
              <input
                id="cash-amount"
                type="number"
                min={0}
                style={inputStyle}
                value={cashForm.amount || ""}
                onChange={(e) =>
                  setCashForm((f) => ({
                    ...f,
                    amount: Math.abs(Number.parseFloat(e.target.value) || 0),
                  }))
                }
              />
            </div>
            <div>
              <label
                htmlFor="cash-note"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                SUB-ACCOUNT
              </label>
              <SubPortSelect
                accountId={cashForm.account_id}
                value={cashForm.note}
                onChange={(v) => setCashForm((f) => ({ ...f, note: v }))}
                colors={colors}
                inputStyle={inputStyle}
              />
            </div>
            <div className="flex items-end gap-1">
              <button
                type="button"
                onClick={saveCash}
                disabled={saving || !cashForm.date || cashForm.amount <= 0}
                className="text-[9px] px-3 py-1 font-bold"
                style={{ background: colors.accent, color: "#000" }}
              >
                {saving ? "..." : editId ? "UPDATE" : "SAVE"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditId(null);
                }}
                className="text-[9px] px-2 py-1 font-bold"
                style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
              >
                CANCEL
              </button>
            </div>
          </div>
          {cashForm.flow_type === "WITHDRAW" &&
            !editId &&
            summary &&
            (() => {
              const acct = summary.accounts.find(
                (a) => a.account.id === (cashForm.account_id || defaultAccount)
              );
              const avail = acct?.cash_base;
              if (avail == null || summaryCcy !== "THB") return null;
              const after = avail - cashForm.amount;
              return (
                <div
                  className="text-[8px] mt-1 font-mono"
                  style={{ color: after < 0 ? "#f87171" : colors.textSecondary }}
                >
                  CASH{acct?.cash_reconciled_at ? "" : "~"} ฿{fmtK(avail)} → after ฿
                  {after < 0 ? "-" : ""}
                  {fmtK(Math.abs(after))}
                  {after < 0 &&
                    " — more than the cash this account shows; check for an unrecorded sale or deposit"}
                </div>
              );
            })()}
          {cashError && (
            <div className="text-[8px] mt-1" style={{ color: "#f87171" }}>
              {cashError}
            </div>
          )}
        </div>
      )}

      {/* TRANSFER FORM */}
      {showTransferForm && subTab === "cash" && (
        <div
          className="px-3 py-2 border-b"
          style={{ borderColor: colors.border, background: "#080808" }}
        >
          <div className="text-[9px] font-bold mb-1.5" style={{ color: "#60a5fa" }}>
            TRANSFER BETWEEN ACCOUNTS
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <div>
              <label
                htmlFor="tr-from"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                FROM
              </label>
              <select
                id="tr-from"
                style={inputStyle}
                value={transferForm.from_account_id}
                onChange={(e) =>
                  setTransferForm((f) => ({ ...f, from_account_id: e.target.value }))
                }
              >
                {accountOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="tr-to" className="text-[8px]" style={{ color: colors.textSecondary }}>
                TO
              </label>
              <select
                id="tr-to"
                style={inputStyle}
                value={transferForm.to_account_id}
                onChange={(e) => setTransferForm((f) => ({ ...f, to_account_id: e.target.value }))}
              >
                {accountOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="tr-date"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                DATE
              </label>
              <input
                id="tr-date"
                type="date"
                style={inputStyle}
                value={transferForm.date}
                onChange={(e) => setTransferForm((f) => ({ ...f, date: e.target.value }))}
              />
            </div>
            <div>
              <label
                htmlFor="tr-amount"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                AMOUNT
              </label>
              <input
                id="tr-amount"
                type="number"
                style={inputStyle}
                value={transferForm.amount || ""}
                onChange={(e) =>
                  setTransferForm((f) => ({ ...f, amount: Number.parseFloat(e.target.value) || 0 }))
                }
              />
            </div>
            <div>
              <label
                htmlFor="tr-note"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                NOTE
              </label>
              <input
                id="tr-note"
                style={inputStyle}
                value={transferForm.note}
                onChange={(e) => setTransferForm((f) => ({ ...f, note: e.target.value }))}
                placeholder="optional"
              />
            </div>
            <div className="flex items-end gap-1">
              <button
                type="button"
                onClick={saveTransfer}
                disabled={
                  saving ||
                  !transferForm.date ||
                  transferForm.amount <= 0 ||
                  transferForm.from_account_id === transferForm.to_account_id
                }
                className="text-[9px] px-3 py-1 font-bold"
                style={{ background: "#60a5fa", color: "#000" }}
              >
                {saving ? "..." : "TRANSFER"}
              </button>
              <button
                type="button"
                onClick={() => setShowTransferForm(false)}
                className="text-[9px] px-2 py-1 font-bold"
                style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
              >
                CANCEL
              </button>
            </div>
          </div>
          {transferForm.from_account_id === transferForm.to_account_id && (
            <div className="text-[8px] mt-1" style={{ color: "#f87171" }}>
              FROM and TO must differ
            </div>
          )}
        </div>
      )}

      {/* ADD / EDIT FORM — Dividends */}
      {showForm && (subTab === "dividends" || subTab === "reinvest") && (
        <div
          className="px-3 py-2 border-b"
          style={{ borderColor: colors.border, background: "#080808" }}
        >
          <div className="text-[9px] font-bold mb-1.5" style={{ color: colors.accent }}>
            {editId ? "EDIT DIVIDEND" : "ADD DIVIDEND"}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-1.5">
            <div>
              <label
                htmlFor="div-account"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                ACCOUNT
              </label>
              <select
                id="div-account"
                style={inputStyle}
                value={divForm.account_id}
                onChange={(e) => setDivForm((f) => ({ ...f, account_id: e.target.value }))}
              >
                {accountOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="div-asset"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                ASSET
              </label>
              <input
                id="div-asset"
                style={inputStyle}
                value={divForm.asset}
                onChange={(e) => setDivForm((f) => ({ ...f, asset: e.target.value.toUpperCase() }))}
                placeholder="SCB"
              />
            </div>
            <div>
              <label
                htmlFor="div-currency"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                CURRENCY
              </label>
              <select
                id="div-currency"
                style={inputStyle}
                value={divForm.currency}
                onChange={(e) => {
                  setCurrencyTouched(true);
                  setDivForm((f) => ({ ...f, currency: e.target.value }));
                }}
              >
                <option value="THB">THB ฿</option>
                <option value="USD">USD $</option>
                <option value="USDT">USDT $</option>
              </select>
            </div>
            <div>
              <label
                htmlFor="div-ex-date"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                EX DATE
              </label>
              <input
                id="div-ex-date"
                type="date"
                style={inputStyle}
                value={divForm.ex_date}
                onChange={(e) => setDivForm((f) => ({ ...f, ex_date: e.target.value }))}
              />
            </div>
            <div>
              <label
                htmlFor="div-pay-date"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                PAY DATE
              </label>
              <input
                id="div-pay-date"
                type="date"
                style={inputStyle}
                value={divForm.pay_date}
                onChange={(e) => setDivForm((f) => ({ ...f, pay_date: e.target.value }))}
              />
            </div>
            <div>
              <label
                htmlFor="div-amount"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                AMOUNT / UNIT
              </label>
              <input
                id="div-amount"
                type="number"
                step="0.01"
                style={inputStyle}
                value={divForm.amount_per_unit || ""}
                onChange={(e) =>
                  setDivForm((f) => ({
                    ...f,
                    amount_per_unit: Number.parseFloat(e.target.value) || 0,
                  }))
                }
              />
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-1.5">
            <div>
              <label
                htmlFor="div-total"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                TOTAL RECEIVED (after tax)
              </label>
              <input
                id="div-total"
                type="number"
                step="0.01"
                style={inputStyle}
                value={divForm.total_received || ""}
                onChange={(e) =>
                  setDivForm((f) => ({
                    ...f,
                    total_received: Number.parseFloat(e.target.value) || 0,
                  }))
                }
              />
            </div>
            <div style={{ borderLeft: `1px solid ${colors.border}`, paddingLeft: 8 }}>
              <label htmlFor="div-reinvest-amt" className="text-[8px]" style={{ color: "#c084fc" }}>
                REINVEST AMOUNT
              </label>
              <input
                id="div-reinvest-amt"
                type="number"
                step="0.01"
                style={inputStyle}
                value={divForm.reinvested_amount || ""}
                onChange={(e) =>
                  setDivForm((f) => ({
                    ...f,
                    reinvested_amount: Number.parseFloat(e.target.value) || 0,
                  }))
                }
              />
            </div>
            <div>
              <label
                htmlFor="div-reinvest-asset"
                className="text-[8px]"
                style={{ color: "#c084fc" }}
              >
                REINVEST ASSET
              </label>
              <input
                id="div-reinvest-asset"
                style={inputStyle}
                value={divForm.reinvest_asset}
                onChange={(e) =>
                  setDivForm((f) => ({ ...f, reinvest_asset: e.target.value.toUpperCase() }))
                }
                placeholder="SCB"
              />
            </div>
            <div>
              <label
                htmlFor="div-reinvest-price"
                className="text-[8px]"
                style={{ color: "#c084fc" }}
              >
                PRICE / UNIT
              </label>
              <input
                id="div-reinvest-price"
                type="number"
                step="0.01"
                style={inputStyle}
                value={divForm.reinvest_price || ""}
                onChange={(e) =>
                  setDivForm((f) => ({
                    ...f,
                    reinvest_price: Number.parseFloat(e.target.value) || 0,
                  }))
                }
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label
                  htmlFor="div-reinvest-units"
                  className="text-[8px]"
                  style={{ color: "#c084fc" }}
                >
                  UNITS
                </label>
                <input
                  id="div-reinvest-units"
                  type="number"
                  step="0.001"
                  style={inputStyle}
                  value={divForm.reinvest_units || ""}
                  onChange={(e) =>
                    setDivForm((f) => ({
                      ...f,
                      reinvest_units: Number.parseFloat(e.target.value) || 0,
                    }))
                  }
                />
              </div>
              <button
                type="button"
                onClick={() => saveDiv(false)}
                disabled={saving || !divForm.asset}
                className="text-[9px] px-3 py-1 font-bold"
                style={{ background: colors.accent, color: "#000" }}
              >
                {saving ? "..." : editId ? "UPDATE" : "SAVE"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditId(null);
                }}
                className="text-[9px] px-2 py-1 font-bold"
                style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
              >
                X
              </button>
            </div>
          </div>
          {divCheck && (
            <div className="mt-1.5 text-[9px] font-mono flex flex-col gap-0.5">
              <div style={{ color: colors.textSecondary }}>
                {divCheck.expected_per_unit != null && (
                  <>
                    MARKET {divCheck.instrument_currency} {divCheck.expected_per_unit}/unit (ex{" "}
                    {divCheck.expected_ex_date}) ·{" "}
                  </>
                )}
                {divCheck.held_units != null && <>HELD {divCheck.held_units} units</>}
                {divCheck.gross_expected != null && (
                  <>
                    {" "}
                    → gross {divForm.currency} {fmtK(divCheck.gross_expected)}
                  </>
                )}
                {divCheck.instrument_currency &&
                  divCheck.instrument_currency !== divForm.currency && (
                    <span style={{ color: "#facc15" }}>
                      {" "}
                      · entered in {divForm.currency}, asset trades in{" "}
                      {divCheck.instrument_currency}
                    </span>
                  )}
              </div>
              {divCheck.issues.map((i) => (
                <div
                  key={i.code}
                  style={{
                    color:
                      i.level === "error" ? "#f87171" : i.level === "warn" ? "#facc15" : "#777",
                  }}
                >
                  {i.level === "error" ? "✕" : i.level === "warn" ? "!" : "·"} {i.message}
                  {i.fix && (
                    <button
                      type="button"
                      className="ml-2 underline font-bold"
                      style={{ color: "#4ade80" }}
                      onClick={() => {
                        const { label: _l, ...fix } = i.fix ?? { label: "" };
                        setCurrencyTouched(true);
                        setDivForm((f) => ({ ...f, ...fix }));
                      }}
                    >
                      {i.fix.label}
                    </button>
                  )}
                  {i.alt_fix && (
                    <button
                      type="button"
                      className="ml-2 underline"
                      style={{ color: colors.textSecondary }}
                      onClick={() => {
                        setCurrencyTouched(true);
                        setDivForm((f) => ({ ...f, currency: i.alt_fix?.currency ?? f.currency }));
                      }}
                    >
                      {i.alt_fix.label}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {divSaveError && (
            <div className="mt-1 text-[9px]" style={{ color: "#f87171" }}>
              {divSaveError}
              <button
                type="button"
                className="ml-2 underline font-bold"
                style={{ color: "#f87171" }}
                onClick={() => saveDiv(true)}
                title="The numbers are right (special dividend, broker rounding…) — save as typed"
              >
                SAVE ANYWAY
              </button>
            </div>
          )}
        </div>
      )}

      {/* FILTER — one strip per ledger */}
      {subTab === "cash" && (
        <LedgerFilterBar
          filter={filters.cash}
          onUpdate={updateFilter("cash")}
          typeOptions={[
            { key: "DEPOSIT", label: "DEPOSIT", color: "#4ade80" },
            { key: "WITHDRAW", label: "WITHDRAW", color: "#f87171" },
            { key: "TRANSFER", label: "TRANSFER", color: "#60a5fa" },
          ]}
          accounts={accountId === "all" ? accountOptions : []}
          years={yearsOf(cash, (c) => c.date)}
          placeholder="search note / account"
          colors={colors}
          summary={(() => {
            const inflow = filteredCash
              .filter((c) => c.investment > 0)
              .reduce((a, c) => a + c.investment, 0);
            const outflow = filteredCash
              .filter((c) => c.investment < 0)
              .reduce((a, c) => a - c.investment, 0);
            return (
              <>
                {shownOf(filteredCash.length, cash.length)} · in{" "}
                <span style={{ color: "#4ade80" }}>฿{fmtK(inflow)}</span> · out{" "}
                <span style={{ color: "#f87171" }}>฿{fmtK(outflow)}</span> · net{" "}
                <span style={{ color: colors.text }}>
                  {inflow - outflow < 0 ? "-" : ""}฿{fmtK(Math.abs(inflow - outflow))}
                </span>
              </>
            );
          })()}
        />
      )}
      {subTab === "dividends" && (
        <LedgerFilterBar
          filter={filters.dividends}
          onUpdate={updateFilter("dividends")}
          typeOptions={[
            { key: "THB", label: "THB", color: colors.accent },
            { key: "USD", label: "USD", color: colors.accent },
          ]}
          accounts={accountId === "all" ? accountOptions : []}
          years={yearsOf(dividends, (d) => d.pay_date || d.ex_date || "")}
          placeholder="search asset"
          colors={colors}
          summary={
            <>
              {shownOf(filteredDivs.length, dividends.length)} · received{" "}
              <span style={{ color: "#4ade80" }}>
                {mixedMoney(
                  sumBy(
                    filteredDivs,
                    (d) => d.currency || "THB",
                    (d) => d.total_received
                  )
                )}
              </span>
            </>
          }
        />
      )}
      {subTab === "reinvest" && (
        <LedgerFilterBar
          filter={filters.reinvest}
          onUpdate={updateFilter("reinvest")}
          typeOptions={[
            { key: "DIV", label: "FROM DIV", color: colors.accent },
            { key: "TRADE", label: "TRADE", color: "#c084fc" },
          ]}
          accounts={accountId === "all" ? accountOptions : []}
          years={yearsOf(reinvestRows, (r) => r.date)}
          placeholder="search asset / source"
          colors={colors}
          summary={
            <>
              {shownOf(filteredReinvest.length, reinvestRows.length)} · reinvested{" "}
              <span style={{ color: "#c084fc" }}>
                {mixedMoney(
                  sumBy(
                    filteredReinvest,
                    (r) => r.currency,
                    (r) => r.reinvestAmount
                  )
                )}
              </span>
            </>
          }
        />
      )}

      {/* CASH TABLE */}
      {subTab === "cash" && (
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
          <table className="w-full text-[10px] font-mono" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}>
                {["DATE", "ACCOUNT", "TYPE", "SUB / NOTE", "AMOUNT", "NET CAPITAL", ""].map((h) => (
                  <th
                    key={h}
                    className="px-2 py-1 text-left text-[9px] font-bold"
                    style={{ color: colors.textSecondary }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cash.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-4 text-center text-[9px]"
                    style={{ color: colors.textSecondary }}
                  >
                    No cash entries — click + ADD
                  </td>
                </tr>
              )}
              {cash.length > 0 && filteredCash.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-4 text-center text-[9px]"
                    style={{ color: colors.textSecondary }}
                  >
                    No entries match the filter
                  </td>
                </tr>
              )}
              {filteredCash.map((c) => {
                const flow = flowOf(c);
                const isTransfer = c.entry_type === "TRANSFER";
                const flowColor = isTransfer ? "#60a5fa" : c.investment < 0 ? "#f87171" : "#4ade80";
                const label =
                  flow === "DEPOSIT"
                    ? "DEPOSIT"
                    : flow === "WITHDRAW"
                      ? "WITHDRAW"
                      : flow === "TRANSFER_OUT"
                        ? "⇄ OUT"
                        : "⇄ IN";
                const bal = runningCapital.get(c.id) ?? 0;
                return (
                  <tr
                    key={c.id}
                    className="hover:bg-[#111] group"
                    style={{ borderBottom: "1px solid #1a1a1a" }}
                  >
                    <td className="px-2 py-1" style={{ color: colors.textSecondary }}>
                      {c.date}
                    </td>
                    <td className="px-2 py-1">{c.account_id}</td>
                    <td className="px-2 py-1 text-[9px] font-bold" style={{ color: flowColor }}>
                      {label}
                    </td>
                    <td className="px-2 py-1 text-[8px]" style={{ color: "#555" }}>
                      {c.note || "—"}
                    </td>
                    <td className="px-2 py-1 font-bold tabular-nums" style={{ color: flowColor }}>
                      {c.investment < 0 ? "−" : "+"}฿{fmtK(Math.abs(c.investment))}
                    </td>
                    <td className="px-2 py-1 tabular-nums" style={{ color: colors.textSecondary }}>
                      {bal < 0 ? "-" : ""}฿{fmtK(Math.abs(bal))}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap opacity-60 group-hover:opacity-100">
                      {!isTransfer && (
                        <button
                          type="button"
                          onClick={() => editCash(c)}
                          className="text-[8px] mr-1 hover:underline"
                          style={{ color: colors.accent }}
                        >
                          EDIT
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setDeleteCashTarget(c)}
                        className="text-[8px] hover:underline"
                        style={{ color: "#f87171" }}
                      >
                        DEL
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* DIVIDENDS TABLE */}
      {subTab === "dividends" && (
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
          <table className="w-full text-[10px] font-mono" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}>
                {["ASSET", "ACCOUNT", "EX DATE", "PAY DATE", "/ UNIT", "RECEIVED", ""].map((h) => (
                  <th
                    key={h}
                    className="px-2 py-1 text-left text-[9px] font-bold"
                    style={{ color: colors.textSecondary }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dividends.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-4 text-center text-[9px]"
                    style={{ color: colors.textSecondary }}
                  >
                    No dividends — click + ADD
                  </td>
                </tr>
              )}
              {dividends.length > 0 && filteredDivs.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-4 text-center text-[9px]"
                    style={{ color: colors.textSecondary }}
                  >
                    No dividends match the filter
                  </td>
                </tr>
              )}
              {filteredDivs.map((d) => (
                <tr
                  key={d.id}
                  className="hover:bg-[#111] group"
                  style={{ borderBottom: "1px solid #1a1a1a" }}
                >
                  <td className="px-2 py-1 font-bold" style={{ color: colors.accent }}>
                    {d.asset}
                  </td>
                  <td className="px-2 py-1">{d.account_id}</td>
                  <td className="px-2 py-1" style={{ color: colors.textSecondary }}>
                    {d.ex_date || "—"}
                  </td>
                  <td className="px-2 py-1" style={{ color: colors.textSecondary }}>
                    {d.pay_date || "—"}
                  </td>
                  <td className="px-2 py-1">
                    {d.currency === "THB" ? "฿" : "$"}
                    {d.amount_per_unit.toFixed(4)}
                  </td>
                  <td className="px-2 py-1 font-bold" style={{ color: "#4ade80" }}>
                    {money(d.total_received, d.currency)}
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap opacity-60 group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => editDiv(d)}
                      className="text-[8px] mr-1 hover:underline"
                      style={{ color: colors.accent }}
                    >
                      EDIT
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteDivTarget(d)}
                      className="text-[8px] hover:underline"
                      style={{ color: "#f87171" }}
                    >
                      DEL
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* REINVESTMENT TABLE */}
      {subTab === "reinvest" && (
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
          <table className="w-full text-[10px] font-mono" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}>
                {[
                  "SOURCE",
                  "ACCOUNT",
                  "PAY DATE",
                  "DIV AMT",
                  "REINVEST AMT",
                  "ASSET",
                  "PRICE",
                  "UNITS",
                  "",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-2 py-1 text-left text-[9px] font-bold"
                    style={{ color: colors.textSecondary }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reinvestRows.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-4 text-center text-[9px]"
                    style={{ color: colors.textSecondary }}
                  >
                    No reinvestments — tick REINVEST? in ENTRY, or fill reinvest fields in DIVIDENDS
                  </td>
                </tr>
              )}
              {reinvestRows.length > 0 && filteredReinvest.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-4 text-center text-[9px]"
                    style={{ color: colors.textSecondary }}
                  >
                    No reinvestments match the filter
                  </td>
                </tr>
              )}
              {filteredReinvest.map((r) => (
                <tr
                  key={r.key}
                  className="hover:bg-[#111] group"
                  style={{ borderBottom: "1px solid #1a1a1a" }}
                >
                  <td
                    className="px-2 py-1 font-bold"
                    style={{ color: r.trade ? "#c084fc" : colors.accent }}
                  >
                    {r.source}
                  </td>
                  <td className="px-2 py-1">{r.account_id}</td>
                  <td className="px-2 py-1" style={{ color: colors.textSecondary }}>
                    {r.date || "—"}
                  </td>
                  <td className="px-2 py-1" style={{ color: "#4ade80" }}>
                    {r.divAmount === null ? "—" : money(r.divAmount, r.currency)}
                  </td>
                  <td className="px-2 py-1 font-bold" style={{ color: "#c084fc" }}>
                    {money(r.reinvestAmount, r.currency)}
                  </td>
                  <td className="px-2 py-1 font-bold" style={{ color: colors.accent }}>
                    {r.asset || "—"}
                  </td>
                  <td className="px-2 py-1">{r.price > 0 ? money(r.price, r.currency) : "—"}</td>
                  <td className="px-2 py-1">{r.units > 0 ? r.units.toFixed(4) : "—"}</td>
                  <td className="px-2 py-1 whitespace-nowrap opacity-60 group-hover:opacity-100">
                    {r.dividend && (
                      <>
                        <button
                          type="button"
                          onClick={() => r.dividend && editDiv(r.dividend)}
                          className="text-[8px] mr-1 hover:underline"
                          style={{ color: colors.accent }}
                        >
                          EDIT
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteDivTarget(r.dividend ?? null)}
                          className="text-[8px] hover:underline"
                          style={{ color: "#f87171" }}
                        >
                          DEL
                        </button>
                      </>
                    )}
                    {r.trade && (
                      <button
                        type="button"
                        onClick={() => r.trade && untagTrade(r.trade.id)}
                        className="text-[8px] hover:underline"
                        style={{ color: "#f87171" }}
                        title="Remove the reinvest tag — the trade itself is untouched"
                      >
                        UNTAG
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deleteCashTarget && (
        <ConfirmDeleteModal
          title="DELETE CASH FLOW"
          message={
            deleteCashTarget.entry_type === "TRANSFER"
              ? `Delete ${deleteCashTarget.date} transfer (${deleteCashTarget.account_id})? This deletes BOTH linked rows. Cannot be undone.`
              : `Delete ${deleteCashTarget.date} entry (${deleteCashTarget.account_id})? This cannot be undone.`
          }
          colors={colors}
          onCancel={() => setDeleteCashTarget(null)}
          onConfirm={() => deleteCash(deleteCashTarget.id)}
        />
      )}

      {deleteDivTarget && (
        <ConfirmDeleteModal
          title="DELETE DIVIDEND"
          message={`Delete ${deleteDivTarget.asset} dividend (${deleteDivTarget.ex_date || deleteDivTarget.pay_date})? This cannot be undone.`}
          colors={colors}
          onCancel={() => setDeleteDivTarget(null)}
          onConfirm={() => deleteDiv(deleteDivTarget.id)}
        />
      )}
    </div>
  );
}
