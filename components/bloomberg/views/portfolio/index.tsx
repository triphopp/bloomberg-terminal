"use client";
import { useAtom } from "jotai";
import { Loader2, RefreshCw } from "lucide-react";
import {
  BarChart2,
  BookOpen,
  Briefcase,
  Database,
  FileText,
  FlaskConical,
  History,
  Layers,
  LayoutDashboard,
  LineChart,
  List,
  Send,
  ShieldAlert,
  TrendingUp,
  Upload,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { isDarkModeAtom } from "../../atoms";
import { useTabShortcuts } from "../../hooks/useTabShortcuts";
import { bloombergColors } from "../../lib/theme-config";
import { FLAG, fetchRetry } from "./helpers";
import { AnalyticsTab } from "./tabs/AnalyticsTab";
import { BacktestTab } from "./tabs/BacktestTab";
import { CashTab } from "./tabs/CashTab";
import { ImportTab } from "./tabs/ImportTab";
import { OpenPositionsTab } from "./tabs/OpenPositionsTab";
import { OptionsTab } from "./tabs/OptionsTab";
import { PaperDashboardTab } from "./tabs/PaperDashboardTab";
import { PaperHistoryTab } from "./tabs/PaperHistoryTab";
import { PaperOptionsTab } from "./tabs/PaperOptionsTab";
import { PaperPositionsTab } from "./tabs/PaperPositionsTab";
import { PaperTradeTab } from "./tabs/PaperTradeTab";
import { RiskTab } from "./tabs/RiskTab";
import { ThesesTab } from "./tabs/ThesesTab";
import { TradeLogTab } from "./tabs/TradeLogTab";
import type { Account, Summary } from "./types";
import { SummaryBar } from "./ui/SummaryBar";

type TopTab = "portfolio" | "analytics" | "risk" | "tools" | "paper";
type PortfolioSub = "positions" | "options" | "trades" | "cash" | "entry";
type AnalyticsSub = "analytics" | "backtest";
type ToolsSub = "theses" | "import";
type PaperSub = "dashboard" | "trade" | "positions" | "options" | "history";

const TOP_TABS: { id: TopTab; label: string; icon: React.ReactNode }[] = [
  { id: "portfolio", label: "PORTFOLIO", icon: <Briefcase className="h-2.5 w-2.5" /> },
  { id: "analytics", label: "ANALYTICS", icon: <LineChart className="h-2.5 w-2.5" /> },
  { id: "risk", label: "RISK", icon: <ShieldAlert className="h-2.5 w-2.5" /> },
  { id: "tools", label: "TOOLS", icon: <Wrench className="h-2.5 w-2.5" /> },
  { id: "paper", label: "PAPER", icon: <FileText className="h-2.5 w-2.5" /> },
];

const PORTFOLIO_SUBS: { id: PortfolioSub; label: string; icon: React.ReactNode }[] = [
  { id: "positions", label: "POSITIONS", icon: <TrendingUp className="h-2 w-2" /> },
  { id: "options", label: "OPTIONS", icon: <Layers className="h-2 w-2" /> },
  { id: "trades", label: "TRADES", icon: <History className="h-2 w-2" /> },
  { id: "cash", label: "CASH", icon: <Database className="h-2 w-2" /> },
  { id: "entry", label: "✏️ ENTRY", icon: <Upload className="h-2 w-2" /> },
];

const ANALYTICS_SUBS: { id: AnalyticsSub; label: string; icon: React.ReactNode }[] = [
  { id: "analytics", label: "P&L", icon: <BarChart2 className="h-2 w-2" /> },
  { id: "backtest", label: "BACKTEST", icon: <FlaskConical className="h-2 w-2" /> },
];

const TOOLS_SUBS: { id: ToolsSub; label: string; icon: React.ReactNode }[] = [
  { id: "theses", label: "THESES", icon: <BookOpen className="h-2 w-2" /> },
  { id: "import", label: "IMPORT", icon: <Upload className="h-2 w-2" /> },
];

const PAPER_SUBS: { id: PaperSub; label: string; icon: React.ReactNode }[] = [
  { id: "dashboard", label: "DASHBOARD", icon: <LayoutDashboard className="h-2 w-2" /> },
  { id: "trade", label: "TRADE", icon: <Send className="h-2 w-2" /> },
  { id: "positions", label: "POSITIONS", icon: <TrendingUp className="h-2 w-2" /> },
  { id: "options", label: "OPTIONS", icon: <Layers className="h-2 w-2" /> },
  { id: "history", label: "HISTORY", icon: <List className="h-2 w-2" /> },
];

// Module-level tab bars: defining these inside PortfolioView creates a new
// component type on every render, forcing React to unmount/remount the subtree.
type ThemeColors = typeof bloombergColors.dark;

function TopTabBar({
  topTab,
  setTopTab,
  colors,
}: { topTab: TopTab; setTopTab: (t: TopTab) => void; colors: ThemeColors }) {
  return (
    <div
      className="flex items-center gap-px px-2 py-1 border-b overflow-x-auto"
      style={{ borderColor: colors.border }}
    >
      {TOP_TABS.map((t, i) => (
        <button
          type="button"
          key={t.id}
          className="flex items-center gap-1 text-[9px] px-2.5 py-0.5 font-bold hover:opacity-80 whitespace-nowrap"
          style={{
            color: topTab === t.id ? colors.accent : colors.textSecondary,
            borderBottom: topTab === t.id ? `2px solid ${colors.accent}` : "2px solid transparent",
          }}
          onClick={() => setTopTab(t.id)}
          title={`Alt+${i + 1}`}
        >
          <span
            className="text-[7px] opacity-35 hidden sm:inline mr-0.5"
            style={{ color: topTab === t.id ? colors.accent : colors.textSecondary }}
          >
            ⌥{i + 1}
          </span>
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

function SubTabBar<T extends string>({
  tabs,
  active,
  setActive,
  colors,
}: {
  tabs: { id: T; label: string; icon: React.ReactNode }[];
  active: T;
  setActive: (id: T) => void;
  colors: ThemeColors;
}) {
  return (
    <div
      className="flex items-center gap-px px-3 py-0.5 border-b"
      style={{ borderColor: colors.border, background: "#050505" }}
    >
      {tabs.map((t) => (
        <button
          type="button"
          key={t.id}
          className="flex items-center gap-1 text-[8px] px-2 py-0.5 font-bold hover:opacity-80 whitespace-nowrap"
          style={{
            color: active === t.id ? colors.accent : colors.textSecondary,
            borderBottom: active === t.id ? `1px solid ${colors.accent}` : "1px solid transparent",
          }}
          onClick={() => setActive(t.id)}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function PortfolioView() {
  const [isDarkMode] = useAtom(isDarkModeAtom);
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccount, setActiveAccount] = useState<string>("all");
  const [currency, setCurrency] = useState<"THB" | "USD">("THB");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  // Gates the tab content: every tab fetches once on mount with no retry of its
  // own, so mounting them before the backend answers leaves them blank forever.
  const [bootState, setBootState] = useState<"loading" | "ready" | "error">("loading");

  const [topTab, setTopTab] = useState<TopTab>("portfolio");
  const [portfolioSub, setPortfolioSub] = useState<PortfolioSub>("positions");
  const [analyticsSub, setAnalyticsSub] = useState<AnalyticsSub>("analytics");
  const [toolsSub, setToolsSub] = useState<ToolsSub>("theses");
  const [paperSub, setPaperSub] = useState<PaperSub>("dashboard");

  // New-account form state
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCurrency, setNewCurrency] = useState("THB");
  const [newCountry, setNewCountry] = useState("TH");
  const [newError, setNewError] = useState("");

  // Delete confirmation modal state
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  useTabShortcuts(TOP_TABS, setTopTab);

  // Y key toggles currency
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.key === "y" || e.key === "Y") &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        setCurrency((c) => (c === "THB" ? "USD" : "THB"));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const loadAccounts = useCallback(async (signal?: AbortSignal) => {
    setBootState((s) => (s === "ready" ? s : "loading"));
    try {
      const r = await fetchRetry("/api/v2/portfolio/accounts", { attempts: 10, signal });
      const d = await r.json();
      if (!r.ok || !Array.isArray(d)) throw new Error("bad payload");
      setAccounts(d);
      setBootState("ready");
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setBootState("error");
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    loadAccounts(ac.signal);
    return () => ac.abort();
  }, [loadAccounts]);

  const createAccount = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      setNewError("Name required");
      return;
    }
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!id) {
      setNewError("Invalid name");
      return;
    }
    setNewError("");
    try {
      const r = await fetch("/api/v2/portfolio/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          name,
          country: newCountry,
          currency: newCurrency.trim().toUpperCase() || "THB",
          account_type: newCountry === "CRYPTO" ? "crypto" : "equity",
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setNewError(d.detail || "Create failed");
        return;
      }
      setNewName("");
      setNewCurrency("THB");
      setNewCountry("TH");
      setShowNewForm(false);
      loadAccounts();
    } catch {
      setNewError("Network error");
    }
  }, [newName, newCurrency, newCountry, loadAccounts]);

  const openDeleteModal = useCallback((acc: Account) => {
    setDeleteTarget(acc);
    setDeleteConfirm("");
    setDeleteError("");
    setDeleting(false);
  }, []);

  const closeDeleteModal = useCallback(() => {
    if (deleting) return;
    setDeleteTarget(null);
    setDeleteConfirm("");
    setDeleteError("");
  }, [deleting]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (deleteConfirm !== deleteTarget.name) {
      setDeleteError("Name does not match");
      return;
    }
    setDeleting(true);
    setDeleteError("");
    try {
      const r = await fetch(`/api/v2/portfolio/accounts/${deleteTarget.id}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setDeleteError(d.detail || "Delete failed");
        setDeleting(false);
        return;
      }
      if (activeAccount === deleteTarget.id) setActiveAccount("all");
      setDeleteTarget(null);
      loadAccounts();
    } catch {
      setDeleteError("Network error");
      setDeleting(false);
    }
  }, [deleteTarget, deleteConfirm, activeAccount, loadAccounts]);

  const loadSummary = useCallback(
    async (signal?: AbortSignal) => {
      setLoadingSummary(true);
      try {
        const r = await fetchRetry(`/api/v2/portfolio/summary?base_currency=${currency}`, {
          attempts: 10,
          signal,
        });
        if (!r.ok) return;
        setSummary(await r.json());
      } catch {
        /* handled by the boot banner driven off loadAccounts */
      } finally {
        setLoadingSummary(false);
      }
    },
    [currency]
  );

  useEffect(() => {
    const ac = new AbortController();
    loadSummary(ac.signal);
    return () => ac.abort();
  }, [loadSummary]);

  const acctBtnCls = "flex items-center gap-1 text-[9px] px-2 py-1 font-bold border transition-all";

  return (
    <div className="flex flex-col h-full" style={{ background: "#000", color: colors.text }}>
      {/* Account row */}
      <div
        className="flex items-center gap-px px-2 pt-1.5 border-b overflow-x-auto"
        style={{ borderColor: colors.border, background: "#080808" }}
      >
        <button
          type="button"
          className={acctBtnCls}
          style={{
            borderColor: activeAccount === "all" ? colors.accent : colors.border,
            color: activeAccount === "all" ? colors.accent : colors.textSecondary,
            background: activeAccount === "all" ? `${colors.accent}22` : "transparent",
          }}
          onClick={() => setActiveAccount("all")}
        >
          🌐 ALL
        </button>
        {accounts.map((acc) => (
          <div key={acc.id} className="group relative flex items-center">
            <button
              type="button"
              className={acctBtnCls}
              style={{
                borderColor: activeAccount === acc.id ? colors.accent : colors.border,
                color: activeAccount === acc.id ? colors.accent : colors.textSecondary,
                background: activeAccount === acc.id ? `${colors.accent}22` : "transparent",
              }}
              onClick={() => setActiveAccount(acc.id)}
            >
              {FLAG[acc.country] ?? "🌐"} {acc.name.toUpperCase()}
              <span className="ml-1 text-[8px] opacity-50">{acc.currency}</span>
            </button>
            <button
              type="button"
              className="hidden group-hover:flex items-center justify-center absolute -top-1 -right-1 h-3 w-3 rounded-full text-[8px] font-bold leading-none"
              style={{ background: colors.border, color: colors.text }}
              title={`Delete ${acc.name}`}
              onClick={(e) => {
                e.stopPropagation();
                openDeleteModal(acc);
              }}
            >
              ×
            </button>
          </div>
        ))}

        {/* + NEW account */}
        <button
          type="button"
          className={acctBtnCls}
          style={{ borderColor: colors.border, color: colors.textSecondary, borderStyle: "dashed" }}
          onClick={() => {
            setShowNewForm((s) => !s);
            setNewError("");
          }}
        >
          + NEW
        </button>

        <div className="ml-auto flex items-center gap-1 pb-0.5">
          {loadingSummary && (
            <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: colors.textSecondary }} />
          )}
          <button
            type="button"
            onClick={() => {
              loadSummary();
              if (bootState !== "ready") loadAccounts();
            }}
            disabled={loadingSummary}
            className="p-0.5 hover:opacity-70"
          >
            <RefreshCw className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
          </button>
        </div>
      </div>

      {/* New-account form */}
      {showNewForm && (
        <div
          className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-b text-[9px]"
          style={{ borderColor: colors.border, background: "#0a0a0a" }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createAccount();
              if (e.key === "Escape") setShowNewForm(false);
            }}
            placeholder="Account name"
            className="px-2 py-0.5 bg-transparent border outline-none"
            style={{ borderColor: colors.border, color: colors.text, width: 140 }}
          />
          <select
            value={newCountry}
            onChange={(e) => setNewCountry(e.target.value)}
            className="px-1 py-0.5 bg-black border outline-none"
            style={{ borderColor: colors.border, color: colors.text }}
          >
            {Object.entries(FLAG).map(([code, flag]) => (
              <option key={code} value={code}>
                {flag} {code}
              </option>
            ))}
          </select>
          <input
            value={newCurrency}
            onChange={(e) => setNewCurrency(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createAccount();
              if (e.key === "Escape") setShowNewForm(false);
            }}
            placeholder="CCY"
            maxLength={6}
            className="px-2 py-0.5 bg-transparent border outline-none uppercase"
            style={{ borderColor: colors.border, color: colors.text, width: 56 }}
          />
          <button
            type="button"
            onClick={createAccount}
            className="px-2 py-0.5 font-bold border"
            style={{
              borderColor: colors.accent,
              color: colors.accent,
              background: `${colors.accent}22`,
            }}
          >
            CREATE
          </button>
          <button
            type="button"
            onClick={() => setShowNewForm(false)}
            className="px-2 py-0.5"
            style={{ color: colors.textSecondary }}
          >
            CANCEL
          </button>
          {newError && <span style={{ color: "#FF4444" }}>{newError}</span>}
        </div>
      )}

      {/* Summary bar */}
      <SummaryBar summary={summary} currency={currency} colors={colors} />

      {/* Top tab bar */}
      <TopTabBar topTab={topTab} setTopTab={setTopTab} colors={colors} />

      {/* Sub-tab bar (context-sensitive) */}
      {topTab === "portfolio" && (
        <SubTabBar
          tabs={PORTFOLIO_SUBS}
          active={portfolioSub}
          setActive={setPortfolioSub}
          colors={colors}
        />
      )}
      {topTab === "analytics" && (
        <SubTabBar
          tabs={ANALYTICS_SUBS}
          active={analyticsSub}
          setActive={setAnalyticsSub}
          colors={colors}
        />
      )}
      {topTab === "tools" && (
        <SubTabBar tabs={TOOLS_SUBS} active={toolsSub} setActive={setToolsSub} colors={colors} />
      )}
      {topTab === "paper" && (
        <SubTabBar tabs={PAPER_SUBS} active={paperSub} setActive={setPaperSub} colors={colors} />
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {bootState === "loading" && (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" style={{ color: colors.accent }} />
            <span className="text-[9px] font-bold" style={{ color: colors.textSecondary }}>
              WAITING FOR BACKEND…
            </span>
          </div>
        )}

        {bootState === "error" && (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <span className="text-[10px] font-bold" style={{ color: "#FF4444" }}>
              ⚠ BACKEND UNAVAILABLE
            </span>
            <span className="text-[9px]" style={{ color: colors.textSecondary }}>
              Could not reach the Python API on port 8000.
            </span>
            <button
              type="button"
              onClick={() => {
                loadAccounts();
                loadSummary();
              }}
              className="px-3 py-1 text-[9px] font-bold border"
              style={{
                borderColor: colors.accent,
                color: colors.accent,
                background: `${colors.accent}22`,
              }}
            >
              RETRY
            </button>
          </div>
        )}

        {bootState === "ready" && (
          <>
            {topTab === "portfolio" && portfolioSub === "positions" && (
              <OpenPositionsTab accountId={activeAccount} currency={currency} colors={colors} />
            )}
            {topTab === "portfolio" && portfolioSub === "options" && (
              <OptionsTab accountId={activeAccount} colors={colors} />
            )}
            {topTab === "portfolio" && portfolioSub === "trades" && (
              <TradeLogTab accountId={activeAccount} currency={currency} colors={colors} />
            )}
            {topTab === "portfolio" && portfolioSub === "cash" && (
              <CashTab accountId={activeAccount} colors={colors} />
            )}
            {topTab === "portfolio" && portfolioSub === "entry" && (
              <ImportTab colors={colors} variant="manual" />
            )}

            {topTab === "analytics" && analyticsSub === "analytics" && (
              <AnalyticsTab
                accountId={activeAccount}
                currency={currency}
                summary={summary}
                colors={colors}
              />
            )}
            {topTab === "analytics" && analyticsSub === "backtest" && (
              <BacktestTab colors={colors} accountId={activeAccount} currency={currency} />
            )}

            {topTab === "risk" && (
              <RiskTab accountId={activeAccount} currency={currency} colors={colors} />
            )}

            {topTab === "tools" && toolsSub === "theses" && <ThesesTab colors={colors} />}
            {topTab === "tools" && toolsSub === "import" && (
              <ImportTab colors={colors} variant="excel" />
            )}

            {topTab === "paper" && paperSub === "dashboard" && (
              <PaperDashboardTab colors={colors} />
            )}
            {topTab === "paper" && paperSub === "trade" && <PaperTradeTab colors={colors} />}
            {topTab === "paper" && paperSub === "positions" && (
              <PaperPositionsTab colors={colors} />
            )}
            {topTab === "paper" && paperSub === "options" && <PaperOptionsTab colors={colors} />}
            {topTab === "paper" && paperSub === "history" && <PaperHistoryTab colors={colors} />}
          </>
        )}
      </div>

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.75)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDeleteModal();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeDeleteModal();
          }}
        >
          <div
            className="flex flex-col gap-4 p-6 border w-[400px] max-w-[90vw]"
            style={{ background: "#0d0d0d", borderColor: "#FF4444", color: colors.text }}
          >
            {/* Header */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold" style={{ color: "#FF4444" }}>
                ⚠ DELETE ACCOUNT
              </span>
            </div>

            {/* Warning */}
            <div className="text-[9px] leading-relaxed" style={{ color: colors.textSecondary }}>
              This will permanently delete account{" "}
              <span className="font-bold" style={{ color: colors.text }}>
                {deleteTarget.name}
              </span>{" "}
              and all its cash ledger and dividend records.
              <br />
              <br />
              <span style={{ color: "#FF4444" }}>This action cannot be undone.</span>
            </div>

            {/* Confirm input */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="delete-confirm-input"
                className="text-[8px] font-bold uppercase tracking-widest"
                style={{ color: colors.textSecondary }}
              >
                Type <span style={{ color: colors.text }}>{deleteTarget.name}</span> to confirm
              </label>
              <input
                id="delete-confirm-input"
                value={deleteConfirm}
                onChange={(e) => {
                  setDeleteConfirm(e.target.value);
                  setDeleteError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmDelete();
                  if (e.key === "Escape") closeDeleteModal();
                }}
                placeholder={deleteTarget.name}
                className="px-3 py-1.5 bg-transparent border outline-none text-[10px] font-mono"
                style={{
                  borderColor: deleteConfirm === deleteTarget.name ? "#FF4444" : colors.border,
                  color: colors.text,
                }}
                disabled={deleting}
              />
              {deleteError && (
                <span className="text-[8px]" style={{ color: "#FF4444" }}>
                  {deleteError}
                </span>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={closeDeleteModal}
                disabled={deleting}
                className="px-3 py-1 text-[9px] font-bold border"
                style={{ borderColor: colors.border, color: colors.textSecondary }}
              >
                CANCEL
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleting || deleteConfirm !== deleteTarget.name}
                className="px-3 py-1 text-[9px] font-bold border transition-all"
                style={{
                  borderColor:
                    deleteConfirm === deleteTarget.name && !deleting ? "#FF4444" : "#333",
                  color: deleteConfirm === deleteTarget.name && !deleting ? "#FF4444" : "#444",
                  background:
                    deleteConfirm === deleteTarget.name && !deleting
                      ? "rgba(255,68,68,0.12)"
                      : "transparent",
                  cursor:
                    deleteConfirm === deleteTarget.name && !deleting ? "pointer" : "not-allowed",
                }}
              >
                {deleting ? "DELETING…" : "DELETE ACCOUNT"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PortfolioView;
