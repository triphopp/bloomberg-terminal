"use client";
import { useState, useCallback, useEffect } from "react";
import { useTabShortcuts } from "../../hooks/useTabShortcuts";
import { Loader2, RefreshCw } from "lucide-react";
import {
  Briefcase, LineChart, ShieldAlert, Wrench, FileText,
  TrendingUp, Layers, History, Database,
  BarChart2, FlaskConical,
  BookOpen, Upload,
  LayoutDashboard, Send, List,
} from "lucide-react";
import { useAtom } from "jotai";
import { bloombergColors } from "../../lib/theme-config";
import { isDarkModeAtom } from "../../atoms";
import type { Account, Summary } from "./types";
import { FLAG } from "./helpers";
import { SummaryBar }        from "./ui/SummaryBar";
import { OpenPositionsTab }  from "./tabs/OpenPositionsTab";
import { OptionsTab }        from "./tabs/OptionsTab";
import { TradeLogTab }       from "./tabs/TradeLogTab";
import { CashTab }           from "./tabs/CashTab";
import { AnalyticsTab }      from "./tabs/AnalyticsTab";
import { BacktestTab }       from "./tabs/BacktestTab";
import { RiskTab }           from "./tabs/RiskTab";
import { ThesesTab }         from "./tabs/ThesesTab";
import { ImportTab }         from "./tabs/ImportTab";
import { PaperDashboardTab } from "./tabs/PaperDashboardTab";
import { PaperTradeTab }     from "./tabs/PaperTradeTab";
import { PaperPositionsTab } from "./tabs/PaperPositionsTab";
import { PaperHistoryTab }   from "./tabs/PaperHistoryTab";
import { PaperOptionsTab }  from "./tabs/PaperOptionsTab";

type TopTab      = "portfolio" | "analytics" | "risk" | "tools" | "paper";
type PortfolioSub = "positions" | "options" | "trades" | "cash";
type AnalyticsSub = "analytics" | "backtest";
type ToolsSub    = "theses" | "import";
type PaperSub    = "dashboard" | "trade" | "positions" | "options" | "history";

const TOP_TABS: { id: TopTab; label: string; icon: React.ReactNode }[] = [
  { id: "portfolio", label: "PORTFOLIO", icon: <Briefcase   className="h-2.5 w-2.5" /> },
  { id: "analytics", label: "ANALYTICS", icon: <LineChart   className="h-2.5 w-2.5" /> },
  { id: "risk",      label: "RISK",      icon: <ShieldAlert className="h-2.5 w-2.5" /> },
  { id: "tools",     label: "TOOLS",     icon: <Wrench      className="h-2.5 w-2.5" /> },
  { id: "paper",     label: "PAPER",     icon: <FileText    className="h-2.5 w-2.5" /> },
];

const PORTFOLIO_SUBS: { id: PortfolioSub; label: string; icon: React.ReactNode }[] = [
  { id: "positions", label: "POSITIONS", icon: <TrendingUp className="h-2 w-2" /> },
  { id: "options",   label: "OPTIONS",   icon: <Layers     className="h-2 w-2" /> },
  { id: "trades",    label: "TRADES",    icon: <History    className="h-2 w-2" /> },
  { id: "cash",      label: "CASH",      icon: <Database   className="h-2 w-2" /> },
];

const ANALYTICS_SUBS: { id: AnalyticsSub; label: string; icon: React.ReactNode }[] = [
  { id: "analytics", label: "P&L",      icon: <BarChart2    className="h-2 w-2" /> },
  { id: "backtest",  label: "BACKTEST",  icon: <FlaskConical className="h-2 w-2" /> },
];

const TOOLS_SUBS: { id: ToolsSub; label: string; icon: React.ReactNode }[] = [
  { id: "theses", label: "THESES", icon: <BookOpen className="h-2 w-2" /> },
  { id: "import", label: "IMPORT", icon: <Upload   className="h-2 w-2" /> },
];

const PAPER_SUBS: { id: PaperSub; label: string; icon: React.ReactNode }[] = [
  { id: "dashboard",  label: "DASHBOARD",  icon: <LayoutDashboard className="h-2 w-2" /> },
  { id: "trade",      label: "TRADE",      icon: <Send            className="h-2 w-2" /> },
  { id: "positions",  label: "POSITIONS",  icon: <TrendingUp      className="h-2 w-2" /> },
  { id: "options",    label: "OPTIONS",    icon: <Layers          className="h-2 w-2" /> },
  { id: "history",    label: "HISTORY",    icon: <List            className="h-2 w-2" /> },
];

export function PortfolioView() {
  const [isDarkMode] = useAtom(isDarkModeAtom);
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  const [accounts, setAccounts]           = useState<Account[]>([]);
  const [activeAccount, setActiveAccount] = useState<string>("all");
  const [currency, setCurrency]           = useState<"THB" | "USD">("THB");
  const [summary, setSummary]             = useState<Summary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);

  const [topTab,        setTopTab]        = useState<TopTab>("portfolio");
  const [portfolioSub,  setPortfolioSub]  = useState<PortfolioSub>("positions");
  const [analyticsSub,  setAnalyticsSub]  = useState<AnalyticsSub>("analytics");
  const [toolsSub,      setToolsSub]      = useState<ToolsSub>("theses");
  const [paperSub,      setPaperSub]      = useState<PaperSub>("dashboard");

  useTabShortcuts(TOP_TABS, setTopTab);

  // Y key toggles currency
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.key === "y" || e.key === "Y") &&
          document.activeElement?.tagName !== "INPUT" &&
          document.activeElement?.tagName !== "TEXTAREA") {
        setCurrency(c => c === "THB" ? "USD" : "THB");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    fetch("/api/v2/portfolio/accounts")
      .then(r => r.json())
      .then(d => setAccounts(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  const loadSummary = useCallback(async () => {
    setLoadingSummary(true);
    try {
      const r = await fetch(`/api/v2/portfolio/summary?base_currency=${currency}`);
      setSummary(await r.json());
    } catch { /* ignore */ } finally { setLoadingSummary(false); }
  }, [currency]);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  const acctBtnCls = "flex items-center gap-1 text-[9px] px-2 py-1 font-bold border transition-all";

  const TopTabBar = () => (
    <div className="flex items-center gap-px px-2 py-1 border-b overflow-x-auto" style={{ borderColor: colors.border }}>
      {TOP_TABS.map((t, i) => (
        <button key={t.id}
          className="flex items-center gap-1 text-[9px] px-2.5 py-0.5 font-bold hover:opacity-80 whitespace-nowrap"
          style={{
            color: topTab === t.id ? colors.accent : colors.textSecondary,
            borderBottom: topTab === t.id ? `2px solid ${colors.accent}` : "2px solid transparent",
          }}
          onClick={() => setTopTab(t.id)}
          title={`Alt+${i + 1}`}>
          <span className="text-[7px] opacity-35 hidden sm:inline mr-0.5" style={{ color: topTab === t.id ? colors.accent : colors.textSecondary }}>
            ⌥{i + 1}
          </span>
          {t.icon}{t.label}
        </button>
      ))}
    </div>
  );

  function SubTabBar<T extends string>({
    tabs, active, setActive,
  }: {
    tabs: { id: T; label: string; icon: React.ReactNode }[];
    active: T;
    setActive: (id: T) => void;
  }) {
    return (
      <div className="flex items-center gap-px px-3 py-0.5 border-b" style={{ borderColor: colors.border, background: "#050505" }}>
        {tabs.map(t => (
          <button key={t.id}
            className="flex items-center gap-1 text-[8px] px-2 py-0.5 font-bold hover:opacity-80 whitespace-nowrap"
            style={{
              color: active === t.id ? colors.accent : colors.textSecondary,
              borderBottom: active === t.id ? `1px solid ${colors.accent}` : "1px solid transparent",
            }}
            onClick={() => setActive(t.id)}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" style={{ background: "#000", color: colors.text }}>

      {/* Account row */}
      <div className="flex items-center gap-px px-2 pt-1.5 border-b overflow-x-auto" style={{ borderColor: colors.border, background: "#080808" }}>
        <button className={acctBtnCls}
          style={{
            borderColor: activeAccount === "all" ? colors.accent : colors.border,
            color: activeAccount === "all" ? colors.accent : colors.textSecondary,
            background: activeAccount === "all" ? `${colors.accent}22` : "transparent",
          }}
          onClick={() => setActiveAccount("all")}>
          🌐 ALL
        </button>
        {accounts.map(acc => (
          <button key={acc.id} className={acctBtnCls}
            style={{
              borderColor: activeAccount === acc.id ? colors.accent : colors.border,
              color: activeAccount === acc.id ? colors.accent : colors.textSecondary,
              background: activeAccount === acc.id ? `${colors.accent}22` : "transparent",
            }}
            onClick={() => setActiveAccount(acc.id)}>
            {FLAG[acc.country] ?? "🌐"} {acc.name.toUpperCase()}
            <span className="ml-1 text-[8px] opacity-50">{acc.currency}</span>
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1 pb-0.5">
          {loadingSummary && <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: colors.textSecondary }} />}
          <button onClick={loadSummary} disabled={loadingSummary} className="p-0.5 hover:opacity-70">
            <RefreshCw className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
          </button>
        </div>
      </div>

      {/* Summary bar */}
      <SummaryBar summary={summary} currency={currency} colors={colors} />

      {/* Top tab bar */}
      <TopTabBar />

      {/* Sub-tab bar (context-sensitive) */}
      {topTab === "portfolio" && (
        <SubTabBar tabs={PORTFOLIO_SUBS} active={portfolioSub} setActive={setPortfolioSub} />
      )}
      {topTab === "analytics" && (
        <SubTabBar tabs={ANALYTICS_SUBS} active={analyticsSub} setActive={setAnalyticsSub} />
      )}
      {topTab === "tools" && (
        <SubTabBar tabs={TOOLS_SUBS} active={toolsSub} setActive={setToolsSub} />
      )}
      {topTab === "paper" && (
        <SubTabBar tabs={PAPER_SUBS} active={paperSub} setActive={setPaperSub} />
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
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

        {topTab === "analytics" && analyticsSub === "analytics" && (
          <AnalyticsTab accountId={activeAccount} currency={currency} summary={summary} colors={colors} />
        )}
        {topTab === "analytics" && analyticsSub === "backtest" && (
          <BacktestTab colors={colors} accountId={activeAccount} currency={currency} />
        )}

        {topTab === "risk" && (
          <RiskTab accountId={activeAccount} currency={currency} colors={colors} />
        )}

        {topTab === "tools" && toolsSub === "theses" && (
          <ThesesTab colors={colors} />
        )}
        {topTab === "tools" && toolsSub === "import" && (
          <ImportTab colors={colors} />
        )}

        {topTab === "paper" && paperSub === "dashboard" && (
          <PaperDashboardTab colors={colors} />
        )}
        {topTab === "paper" && paperSub === "trade" && (
          <PaperTradeTab colors={colors} />
        )}
        {topTab === "paper" && paperSub === "positions" && (
          <PaperPositionsTab colors={colors} />
        )}
        {topTab === "paper" && paperSub === "options" && (
          <PaperOptionsTab colors={colors} />
        )}
        {topTab === "paper" && paperSub === "history" && (
          <PaperHistoryTab colors={colors} />
        )}
      </div>
    </div>
  );
}

export default PortfolioView;
