"use client";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BLANK_CASH, BLANK_DIV } from "../constants";
import { type Colors, fmtK, pnlColor } from "../helpers";
import { ConfirmDeleteModal } from "../modals/ConfirmDeleteModal";
import type { CashEntry, Dividend } from "../types";
import { SubPortSelect } from "../ui/SubPortSelect";

export function CashTab({ accountId, colors }: { accountId: string; colors: Colors }) {
  const [cash, setCash] = useState<CashEntry[]>([]);
  const [dividends, setDivs] = useState<Dividend[]>([]);
  const [loading, setLoading] = useState(false);
  const [subTab, setSubTab] = useState<"cash" | "dividends" | "reinvest">("cash");
  const [showForm, setShowForm] = useState(false);
  const [showTransferForm, setShowTransferForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [cashForm, setCashForm] = useState<Omit<CashEntry, "id">>(BLANK_CASH);
  const [transferForm, setTransferForm] = useState({
    from_account_id: "finansia",
    to_account_id: "dime",
    date: new Date().toISOString().slice(0, 10),
    amount: 0,
    note: "",
  });
  const [divForm, setDivForm] = useState<Omit<Dividend, "id">>(BLANK_DIV);
  const [saving, setSaving] = useState(false);
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
        const [cr, dr] = await Promise.all([
          fetch(`/api/v2/portfolio/cash${qs}`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
          fetch(`/api/v2/portfolio/dividends${qs}`, { signal }).then((r) => {
            if (!r.ok) throw new Error();
            return r.json();
          }),
        ]);
        setCash(Array.isArray(cr) ? cr : []);
        setDivs(Array.isArray(dr) ? dr : []);
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

  const totalIn = cash.reduce((a, c) => a + c.income, 0);
  const totalInv = cash.reduce((a, c) => a + c.investment, 0);
  const totalDiv = dividends.reduce<Record<string, number>>((a, d) => {
    a[d.currency || "THB"] = (a[d.currency || "THB"] || 0) + d.total_received;
    return a;
  }, {});
  const totalReinvest = dividends.reduce<Record<string, number>>((a, d) => {
    a[d.currency || "THB"] = (a[d.currency || "THB"] || 0) + (d.reinvested_amount || 0);
    return a;
  }, {});
  const money = (amount: number, ccy: string) => `${ccy === "THB" ? "฿" : "$"}${fmtK(amount)}`;
  const mixedMoney = (values: Record<string, number>) =>
    Object.entries(values)
      .filter(([, value]) => value !== 0)
      .map(([ccy, value]) => money(value, ccy))
      .join(" / ") || "—";

  const saveCash = async () => {
    if (!cashForm.date) return;
    setSaving(true);
    try {
      const url = editId ? `/api/v2/portfolio/cash/${editId}` : "/api/v2/portfolio/cash";
      const method = editId ? "PUT" : "POST";
      await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cashForm),
      });
      setShowForm(false);
      setEditId(null);
      setCashForm(BLANK_CASH);
      load();
    } catch {
      /* ignore */
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
    setCashForm({
      account_id: c.account_id,
      date: c.date,
      income: c.income,
      investment: c.investment,
      exchange_rate: c.exchange_rate,
      note: c.note,
    });
    setEditId(c.id);
    setShowForm(true);
    setSubTab("cash");
  };

  const saveDiv = async () => {
    if (!divForm.asset) return;
    setSaving(true);
    try {
      const url = editId ? `/api/v2/portfolio/dividends/${editId}` : "/api/v2/portfolio/dividends";
      const method = editId ? "PUT" : "POST";
      await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(divForm),
      });
      setShowForm(false);
      setEditId(null);
      setDivForm(BLANK_DIV);
      load();
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  };

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
            setCashForm(BLANK_CASH);
            setDivForm(BLANK_DIV);
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
          <span style={{ color: colors.textSecondary }}>
            IN: <span style={{ color: "#4ade80" }}>฿{fmtK(totalIn)}</span>
          </span>
          <span style={{ color: colors.textSecondary }}>
            INV: <span style={{ color: "#f87171" }}>฿{fmtK(totalInv)}</span>
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
          <div className="grid grid-cols-6 gap-2">
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
                value={cashForm.account_id}
                onChange={(e) => setCashForm((f) => ({ ...f, account_id: e.target.value }))}
              >
                <option value="finansia">Finansia</option>
                <option value="dime">Dime</option>
                <option value="innovestx">InnovestX</option>
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
              <label
                htmlFor="cash-income"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                INCOME
              </label>
              <input
                id="cash-income"
                type="number"
                style={inputStyle}
                value={cashForm.income || ""}
                onChange={(e) =>
                  setCashForm((f) => ({ ...f, income: Number.parseFloat(e.target.value) || 0 }))
                }
              />
            </div>
            <div>
              <label
                htmlFor="cash-investment"
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
              >
                INVESTMENT
              </label>
              <input
                id="cash-investment"
                type="number"
                style={inputStyle}
                value={cashForm.investment || ""}
                onChange={(e) =>
                  setCashForm((f) => ({ ...f, investment: Number.parseFloat(e.target.value) || 0 }))
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
                disabled={saving || !cashForm.date}
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
          <div className="grid grid-cols-6 gap-2">
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
                <option value="finansia">Finansia</option>
                <option value="dime">Dime</option>
                <option value="innovestx">InnovestX</option>
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
                <option value="finansia">Finansia</option>
                <option value="dime">Dime</option>
                <option value="innovestx">InnovestX</option>
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
          <div className="grid grid-cols-6 gap-2 mb-1.5">
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
                <option value="finansia">Finansia</option>
                <option value="dime">Dime</option>
                <option value="innovestx">InnovestX</option>
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
                onChange={(e) => setDivForm((f) => ({ ...f, currency: e.target.value }))}
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
          <div className="grid grid-cols-5 gap-2 mb-1.5">
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
                onClick={saveDiv}
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
        </div>
      )}

      {/* CASH TABLE */}
      {subTab === "cash" && (
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
          <table className="w-full text-[10px] font-mono" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}>
                {["DATE", "ACCOUNT", "SUB", "INCOME", "INVESTED", "NET FLOW", "FX", ""].map((h) => (
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
                    colSpan={8}
                    className="px-3 py-4 text-center text-[9px]"
                    style={{ color: colors.textSecondary }}
                  >
                    No cash entries — click + ADD
                  </td>
                </tr>
              )}
              {cash.map((c) => {
                const net = c.income - c.investment;
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
                    <td
                      className="px-2 py-1 text-[8px]"
                      style={{ color: c.entry_type === "TRANSFER" ? "#60a5fa" : "#555" }}
                    >
                      {c.entry_type === "TRANSFER" ? `⇄ ${c.note || "TRANSFER"}` : c.note || "—"}
                    </td>
                    <td className="px-2 py-1" style={{ color: "#4ade80" }}>
                      {c.income > 0 ? `฿${fmtK(c.income)}` : "—"}
                    </td>
                    <td className="px-2 py-1" style={{ color: "#f87171" }}>
                      {c.investment > 0 ? `฿${fmtK(c.investment)}` : "—"}
                    </td>
                    <td className="px-2 py-1 font-bold" style={{ color: pnlColor(net) }}>
                      {fmtK(Math.abs(net))} {net >= 0 ? "▲" : "▼"}
                    </td>
                    <td className="px-2 py-1" style={{ color: colors.textSecondary }}>
                      {c.exchange_rate !== 1 ? c.exchange_rate.toFixed(3) : "—"}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap opacity-60 group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => editCash(c)}
                        className="text-[8px] mr-1 hover:underline"
                        style={{ color: colors.accent }}
                      >
                        EDIT
                      </button>
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
              {dividends.map((d) => (
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
              {dividends.filter((d) => d.reinvested_amount > 0).length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-4 text-center text-[9px]"
                    style={{ color: colors.textSecondary }}
                  >
                    No reinvestments — add via DIVIDENDS tab (fill reinvest fields)
                  </td>
                </tr>
              )}
              {dividends
                .filter((d) => d.reinvested_amount > 0)
                .map((d) => (
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
                      {d.pay_date || "—"}
                    </td>
                    <td className="px-2 py-1" style={{ color: "#4ade80" }}>
                      {money(d.total_received, d.currency)}
                    </td>
                    <td className="px-2 py-1 font-bold" style={{ color: "#c084fc" }}>
                      {money(d.reinvested_amount, d.currency)}
                    </td>
                    <td className="px-2 py-1 font-bold" style={{ color: colors.accent }}>
                      {d.reinvest_asset || "—"}
                    </td>
                    <td className="px-2 py-1">
                      {d.reinvest_price > 0 ? money(d.reinvest_price, d.currency) : "—"}
                    </td>
                    <td className="px-2 py-1">
                      {d.reinvest_units > 0 ? d.reinvest_units.toFixed(4) : "—"}
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
