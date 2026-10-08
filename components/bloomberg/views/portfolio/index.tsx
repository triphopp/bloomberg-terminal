"use client";
import { installLedgerCorrectionRetry } from "@/lib/ledger-correction";
import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { Loader2, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isDarkModeAtom, portfolioTabRequestAtom, toolsRequestAtom } from "../../atoms";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { useTabShortcuts } from "../../hooks/useTabShortcuts";
import { bloombergColors } from "../../lib/theme-config";
import { FLAG } from "./helpers";
import { portfolioQueries } from "./queries";
import { AnalyticsTab } from "./tabs/AnalyticsTab";
import { AuditTab } from "./tabs/AuditTab";
import { CashTab } from "./tabs/CashTab";
import { ImportTab } from "./tabs/ImportTab";
import { OpenPositionsTab } from "./tabs/OpenPositionsTab";
import { OptionsTab } from "./tabs/OptionsTab";
import { RiskTab } from "./tabs/RiskTab";
import { ThesesTab } from "./tabs/ThesesTab";
import { TradeLogTab } from "./tabs/TradeLogTab";
import { QuestionBadges, QuestionsTab, useQuestionCounts } from "./tabs/questions";
import { TrackBadges, TrackingTab, useTrackCounts } from "./tabs/tracking";
import type { Account, Summary } from "./types";
import type { OptionEntryPrefill } from "./ui/OptionEntryForm";
import { SummaryBar } from "./ui/SummaryBar";

type TopTab = "portfolio" | "analytics" | "risk" | "tools";
type PortfolioSub = "positions" | "options" | "trades" | "cash" | "entry";
type ToolsSub = "theses" | "questions" | "track" | "import" | "audit";

type Tab<T extends string> = { id: T; label: string };

const TOP_TABS: Tab<TopTab>[] = [
  { id: "portfolio", label: "PORTFOLIO" },
  { id: "analytics", label: "ANALYTICS" },
  { id: "risk", label: "RISK" },
  { id: "tools", label: "TOOLS" },
];

const PORTFOLIO_SUBS: Tab<PortfolioSub>[] = [
  { id: "positions", label: "POSITIONS" },
  { id: "options", label: "OPTIONS" },
  { id: "trades", label: "TRADES" },
  { id: "cash", label: "CASH" },
  { id: "entry", label: "ENTRY" },
];

const TOOLS_SUBS: Tab<ToolsSub>[] = [
  { id: "theses", label: "THESES" },
  { id: "questions", label: "QUESTIONS" },
  { id: "track", label: "TRACK" },
  { id: "import", label: "IMPORT" },
  { id: "audit", label: "AUDIT" },
];

// Module-level tab strip: defining it inside PortfolioView creates a new
// component type on every render, forcing React to unmount/remount the subtree.
type ThemeColors = typeof bloombergColors.dark;

function TabStrip<T extends string>({
  tabs,
  active,
  setActive,
  colors,
  sub,
  badges,
}: {
  tabs: Tab<T>[];
  active: T;
  setActive: (id: T) => void;
  colors: ThemeColors;
  /** Sub-tabs sit after the top tabs on the same row, a step smaller. */
  sub?: boolean;
  /** Counts shown after a tab's label (open questions on TOOLS / QUESTIONS). */
  badges?: Partial<Record<T, ReactNode>>;
}) {
  return (
    <>
      {tabs.map((t, i) => (
        <button
          aria-pressed={active === t.id}
          type="button"
          key={t.id}
          className={`${sub ? "text-[8px] px-1.5" : "text-[9px] px-2"} py-1 font-bold hover:opacity-80 whitespace-nowrap`}
          style={{ color: active === t.id ? colors.accent : colors.textSecondary }}
          onClick={() => setActive(t.id)}
          title={sub ? undefined : `Alt+${i + 1}`}
        >
          {t.label}
          {badges?.[t.id]}
        </button>
      ))}
    </>
  );
}

export function PortfolioView() {
  const [isDarkMode] = useAtom(isDarkModeAtom);
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;
  // A write into a period agreed with the broker asks for a reason (lib/ledger-correction.ts).
  useEffect(() => installLedgerCorrectionRetry(), []);

  const [activeAccount, setActiveAccount] = useState<string>("all");
  const [currency, setCurrency] = useState<"THB" | "USD">("THB");
  // Gates the tab content: a tab mounted before the backend answers would fetch
  // once, get nothing, and sit blank.

  const [tabRequest, setTabRequest] = useAtom(portfolioTabRequestAtom);
  // Start on the requested tab (GUARD ribbon → RISK). Starting on "portfolio"
  // and flipping in the effect mounted POSITIONS for one throwaway render inside
  // the click — the bulk of that interaction's INP.
  const [topTab, setTopTab] = useState<TopTab>(() => tabRequest ?? "portfolio");
  useEffect(() => {
    if (!tabRequest) return;
    setTopTab(tabRequest);
    setTabRequest(null);
  }, [tabRequest, setTabRequest]);
  // A place in TOOLS another screen asked for: a date on the calendar or a
  // CALENDAR alert → the thesis it belongs to, or the question waiting on it.
  // Read into the initial state for the same reason as the tab request above.
  const [toolsRequest, setToolsRequest] = useAtom(toolsRequestAtom);
  const [portfolioSub, setPortfolioSub] = useState<PortfolioSub>("positions");
  // OPTIONS → ADD / CLOSE hand the contract to ENTRY; seq makes a repeat click refill.
  const [optionPrefill, setOptionPrefill] = useState<(OptionEntryPrefill & { seq: number }) | null>(
    null
  );
  const openOptionEntry = (p: OptionEntryPrefill) => {
    setOptionPrefill({ ...p, seq: Date.now() });
    setPortfolioSub("entry");
  };
  const [toolsSub, setToolsSub] = useState<ToolsSub>(() => toolsRequest?.sub ?? "theses");
  // Open questions across every thesis — the badge on TOOLS and on QUESTIONS.
  const { data: qCounts } = useQuestionCounts();
  // Tracked numbers that came due, missed, or crossed a kill line — same two places.
  const { data: tCounts } = useTrackCounts();
  // A miss in TRACK opens a question; this carries the jump to it in QUESTIONS.
  const [openQuestion, setOpenQuestion] = useState<{
    thesisId: string | null;
    questionId: string;
  } | null>(() =>
    toolsRequest?.sub === "questions"
      ? { thesisId: toolsRequest.thesisId, questionId: toolsRequest.questionId }
      : null
  );
  // QUESTIONS takes a hand-over once, on mount: a new one while it is open remounts it.
  const [questionsKey, setQuestionsKey] = useState(0);
  // A thesis to land on (and its NOTES, at one note), from the calendar or an alert.
  const [openThesisAt, setOpenThesisAt] = useState<{
    thesisId: string;
    sub: "thesis" | "notes";
    noteId?: string;
  } | null>(() =>
    toolsRequest?.sub === "theses"
      ? {
          thesisId: toolsRequest.thesisId,
          sub: toolsRequest.thesisSub ?? "thesis",
          noteId: toolsRequest.noteId,
        }
      : null
  );
  const showQuestion = useCallback((thesisId: string | null, questionId: string) => {
    setOpenQuestion({ thesisId, questionId });
    setQuestionsKey((k) => k + 1);
    setToolsSub("questions");
  }, []);
  const showThesis = useCallback((thesisId: string, sub: "thesis" | "notes", noteId?: string) => {
    setOpenThesisAt({ thesisId, sub, noteId });
    setToolsSub("theses");
  }, []);
  // The request this view was opened with is already in the state above.
  const takenAtMount = useRef(toolsRequest);
  useEffect(() => {
    if (!toolsRequest) return;
    if (takenAtMount.current === toolsRequest) {
      takenAtMount.current = null;
      setToolsRequest(null);
      return;
    }
    setTopTab("tools");
    if (toolsRequest.sub === "questions")
      showQuestion(toolsRequest.thesisId, toolsRequest.questionId);
    else showThesis(toolsRequest.thesisId, toolsRequest.thesisSub ?? "thesis", toolsRequest.noteId);
    setToolsRequest(null);
  }, [toolsRequest, setToolsRequest, showQuestion, showThesis]);
  // Symbol handed over when the positions table jumps to TOOLS → THESES, so the
  // rail can preselect (or pre-fill a new thesis for) that holding.
  const [thesisSymbol, setThesisSymbol] = useState<string | null>(null);

  const openThesis = (symbol: string) => {
    setThesisSymbol(symbol);
    setTopTab("tools");
    setToolsSub("theses");
  };

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

  // Accounts and summary go through React Query so the terminal shell can warm
  // them before PORT is opened (`prewarmPortfolio`) — on a warm cache the view
  // paints with data instead of the boot spinner.
  const {
    data: accountsData,
    isError: accountsError,
    refetch: refetchAccounts,
  } = useQuery({ ...portfolioQueries.accounts(), retry: 5 });
  const accounts = useMemo<Account[]>(
    () => (Array.isArray(accountsData) ? (accountsData as Account[]) : []),
    [accountsData]
  );
  const bootState: "loading" | "ready" | "error" = accountsError
    ? "error"
    : accountsData
      ? "ready"
      : "loading";
  const loadAccounts = useCallback(() => {
    void refetchAccounts();
  }, [refetchAccounts]);

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

  const {
    data: summaryData,
    isFetching: loadingSummary,
    refetch: refetchSummary,
  } = useLiveQuery({
    // Live cadence (60s real-time / 5m idle), same as MKT: P&L, NAV and cash
    // move with prices, and PORT stays open through a trading session.
    // Polling stops on its own when PORT is left — the view unmounts.
    queryKey: portfolioQueries.summary(currency).queryKey,
    queryFn: portfolioQueries.summary(currency).queryFn,
    retry: 5,
    placeholderData: (prev) => prev,
  });
  const summary = (summaryData as Summary | undefined) ?? null;
  const loadSummary = useCallback(() => {
    void refetchSummary();
  }, [refetchSummary]);

  const acctBtnCls = "text-[9px] px-1.5 py-1 font-bold whitespace-nowrap hover:opacity-80";
  const subTabs =
    topTab === "portfolio" ? (
      <TabStrip
        tabs={PORTFOLIO_SUBS}
        active={portfolioSub}
        setActive={setPortfolioSub}
        colors={colors}
        sub
      />
    ) : topTab === "tools" ? (
      <TabStrip
        tabs={TOOLS_SUBS}
        active={toolsSub}
        setActive={setToolsSub}
        colors={colors}
        sub
        badges={{
          questions: <QuestionBadges pending={qCounts?.pending ?? 0} watch={qCounts?.watch ?? 0} />,
          track: <TrackBadges alert={tCounts?.alert ?? 0} setup={tCounts?.setup ?? 0} />,
        }}
      />
    ) : null;

  return (
    <div className="flex flex-col h-full" style={{ background: "#000", color: colors.text }}>
      {/* Row 1 — accounts on the left, book totals on the right */}
      <div
        className="flex flex-wrap items-center gap-x-3 px-2 border-b"
        style={{ borderColor: colors.border, background: "#080808" }}
      >
        <div className="flex items-center overflow-x-auto">
          <button
            aria-pressed={activeAccount === "all"}
            type="button"
            className={acctBtnCls}
            style={{ color: activeAccount === "all" ? colors.accent : colors.textSecondary }}
            onClick={() => setActiveAccount("all")}
          >
            ALL
          </button>
          {accounts.map((acc) => (
            <div key={acc.id} className="group relative flex items-center">
              <button
                aria-pressed={activeAccount === acc.id}
                type="button"
                className={acctBtnCls}
                style={{ color: activeAccount === acc.id ? colors.accent : colors.textSecondary }}
                title={`${acc.name} · ${acc.country} · ${acc.currency}`}
                onClick={() => setActiveAccount(acc.id)}
              >
                {acc.name.toUpperCase()}
                <span className="ml-1 text-[7px] font-normal opacity-50">{acc.currency}</span>
              </button>
              <button
                type="button"
                // Hover reveals it with a mouse; a touch screen has no hover, so it stays.
                className="hidden group-hover:flex [@media(hover:none)]:flex items-center justify-center absolute -top-0.5 -right-0.5 h-3 w-3 text-[8px] font-bold leading-none"
                style={{ color: colors.textSecondary }}
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
          <button
            type="button"
            className={acctBtnCls}
            style={{ color: colors.textSecondary }}
            title="New account"
            onClick={() => {
              setShowNewForm((s) => !s);
              setNewError("");
            }}
          >
            +
          </button>
        </div>

        <SummaryBar
          summary={summary}
          currency={currency}
          colors={colors}
          accountId={activeAccount}
          onToggleCurrency={() => setCurrency((c) => (c === "THB" ? "USD" : "THB"))}
        />

        <button
          type="button"
          onClick={() => {
            loadSummary();
            if (bootState !== "ready") loadAccounts();
          }}
          disabled={loadingSummary}
          className="ml-auto p-0.5 hover:opacity-70"
          title="Refresh"
        >
          {loadingSummary ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: colors.textSecondary }} />
          ) : (
            <RefreshCw className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
          )}
        </button>
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

      {/* Row 2 — top tabs, then the active tab's sub-tabs on the same line */}
      <div
        className="flex items-center px-1 border-b overflow-x-auto"
        style={{ borderColor: colors.border }}
      >
        <TabStrip
          tabs={TOP_TABS}
          active={topTab}
          setActive={setTopTab}
          colors={colors}
          badges={{
            tools: (
              <>
                <QuestionBadges pending={qCounts?.pending ?? 0} watch={0} />
                <TrackBadges alert={tCounts?.alert ?? 0} setup={0} />
              </>
            ),
          }}
        />
        {subTabs && (
          <>
            <span className="mx-1.5 text-[9px]" style={{ color: colors.border }}>
              │
            </span>
            {subTabs}
          </>
        )}
      </div>

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
              Could not reach the Python API. Check that the backend is running.
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
              <OpenPositionsTab
                accountId={activeAccount}
                currency={currency}
                colors={colors}
                onOpenThesis={openThesis}
              />
            )}
            {topTab === "portfolio" && portfolioSub === "options" && (
              <OptionsTab
                accountId={activeAccount}
                currency={currency}
                colors={colors}
                onOpenEntry={openOptionEntry}
              />
            )}
            {topTab === "portfolio" && portfolioSub === "trades" && (
              <TradeLogTab accountId={activeAccount} currency={currency} colors={colors} />
            )}
            {topTab === "portfolio" && portfolioSub === "cash" && (
              <CashTab accountId={activeAccount} summary={summary} colors={colors} />
            )}
            {topTab === "portfolio" && portfolioSub === "entry" && (
              <ImportTab colors={colors} variant="manual" optionPrefill={optionPrefill} />
            )}

            {topTab === "analytics" && (
              <AnalyticsTab
                accountId={activeAccount}
                currency={currency}
                summary={summary}
                colors={colors}
              />
            )}

            {topTab === "risk" && (
              <RiskTab accountId={activeAccount} currency={currency} colors={colors} />
            )}

            {topTab === "tools" && toolsSub === "theses" && (
              <ThesesTab
                colors={colors}
                accountId={activeAccount}
                initialSymbol={thesisSymbol}
                onConsumeInitialSymbol={() => setThesisSymbol(null)}
                initialOpen={openThesisAt}
                onConsumeInitialOpen={() => setOpenThesisAt(null)}
              />
            )}
            {topTab === "tools" && toolsSub === "questions" && (
              <QuestionsTab
                key={questionsKey}
                colors={colors}
                initialQuestion={openQuestion}
                onConsumeInitialQuestion={() => setOpenQuestion(null)}
              />
            )}
            {topTab === "tools" && toolsSub === "track" && (
              <TrackingTab colors={colors} onOpenQuestion={showQuestion} />
            )}
            {topTab === "tools" && toolsSub === "import" && (
              <ImportTab colors={colors} variant="excel" />
            )}
            {topTab === "tools" && toolsSub === "audit" && (
              <AuditTab accountId={activeAccount} colors={colors} />
            )}
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
