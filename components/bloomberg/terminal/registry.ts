import {
  ArgValue,
  type CommandDef,
  type CommandResult,
  type ResolvedArgs,
  type RowData,
} from "./types";

// ── Response shapes ───────────────────────────────────────────────────────────

interface DiagTest {
  stat: number;
  p_value: number;
  verdict: string;
  lags?: number;
}

interface AdfTest {
  stat: number;
  lag: number;
  nobs: number;
  crit_1pct: number;
  crit_5pct: number;
  crit_10pct: number;
  verdict: string;
}

interface StatResponse {
  symbol: string;
  period: string;
  start_date: string;
  end_date: string;
  total_return: number;
  last_price: number;
  descriptive: {
    n: number;
    mean_daily: number;
    mean_annual: number;
    std_daily: number;
    vol_annual: number;
    skew: number;
    excess_kurtosis: number;
    min: number;
    p25: number;
    median: number;
    p75: number;
    max: number;
  };
  risk: {
    var_95: number;
    cvar_95: number;
    max_drawdown: number;
    trough_date: string;
    sharpe: number;
    sortino: number;
    downside_dev: number;
  };
  diagnostics: {
    jarque_bera?: DiagTest;
    adf?: AdfTest | null;
    ljung_box?: DiagTest | null;
    arch_lm?: DiagTest | null;
  };
  diag_note: string | null;
}

// ── Arg helpers ───────────────────────────────────────────────────────────────

function sym(args: ResolvedArgs, idx: number): string | undefined {
  return args.positional.filter((a) => a.type === "symbol")[idx]?.value;
}

function period(args: ResolvedArgs, fallback = "1y"): string {
  return args.positional.find((a) => a.type === "period")?.value ?? fallback;
}

function num(args: ResolvedArgs, idx: number): number | undefined {
  return (
    args.positional.filter((a) => a.type === "number")[idx] as
      | { type: "number"; value: number }
      | undefined
  )?.value;
}

function allSymbols(args: ResolvedArgs): string[] {
  return args.positional.filter((a) => a.type === "symbol").map((a) => a.value);
}

// ── Analytics fetch helper ────────────────────────────────────────────────────

async function analytics(
  fn: string,
  params: Record<string, string | number>,
  signal: AbortSignal
): Promise<Response> {
  const q = new URLSearchParams({
    fn,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  return fetch(`/api/analytics?${q}`, { signal });
}

async function analyticsJson<T>(
  fn: string,
  params: Record<string, string | number>,
  signal: AbortSignal
): Promise<T> {
  const res = await analytics(fn, params, signal);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Error ${res.status}`);
  return data as T;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtPct(v: number): string {
  const s = (v * 100).toFixed(2);
  return v >= 0 ? `+${s}%` : `${s}%`;
}

function fmtNum(v: number, dp = 4): string {
  return v.toFixed(dp);
}

function rowColor(v: number | string): string {
  const n = typeof v === "number" ? v : Number.parseFloat(v.replace(/[^0-9.\-]/g, ""));
  if (Number.isNaN(n)) return "";
  return n > 0 ? "pos" : n < 0 ? "neg" : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// NAV commands (single-word, navigate to view)
// ─────────────────────────────────────────────────────────────────────────────

const NAV: CommandDef[] = [
  {
    name: "MKT",
    group: "nav",
    description: "Go to Market view",
    handler: (_, ctx) => {
      ctx.setView("market");
      return { kind: "navigate", view: "market" };
    },
  },
  {
    name: "NEWS",
    group: "nav",
    description: "Go to News view",
    handler: (_, ctx) => {
      ctx.setView("news");
      return { kind: "navigate", view: "news" };
    },
  },
  {
    name: "GMOV",
    group: "nav",
    description: "Go to Market Movers",
    handler: (_, ctx) => {
      ctx.setView("movers");
      return { kind: "navigate", view: "movers" };
    },
  },
  {
    name: "CLIP",
    group: "nav",
    description: "Go to Clippings / AI",
    handler: (_, ctx) => {
      ctx.setView("clippings");
      return { kind: "navigate", view: "clippings" };
    },
  },
  {
    name: "MACRO",
    group: "nav",
    description: "Go to Macro Economics",
    handler: (_, ctx) => {
      ctx.setView("macro");
      return { kind: "navigate", view: "macro" };
    },
  },
  {
    name: "CRDT",
    group: "nav",
    description: "Go to Credit view",
    handler: (_, ctx) => {
      ctx.setView("credit");
      return { kind: "navigate", view: "credit" };
    },
  },
  {
    name: "PORT",
    group: "nav",
    description: "Go to Portfolio",
    handler: (_, ctx) => {
      ctx.setView("portfolio");
      return { kind: "navigate", view: "portfolio" };
    },
  },
  {
    name: "CRYP",
    group: "nav",
    description: "Go to Crypto view",
    handler: (_, ctx) => {
      ctx.setView("crypto");
      return { kind: "navigate", view: "crypto" };
    },
  },
  {
    name: "FX",
    group: "nav",
    description: "Go to FX / Forex view",
    handler: (_, ctx) => {
      ctx.setView("fx");
      return { kind: "navigate", view: "fx" };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// SETTING commands (multi-word)
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS: CommandDef[] = [
  {
    name: "ALERT ON",
    group: "setting",
    description: "Show Bloomberg ticker crawl",
    handler: (_, ctx) => {
      ctx.setTickerEnabled(true);
      return { kind: "action" };
    },
  },
  {
    name: "ALERT OFF",
    group: "setting",
    description: "Hide Bloomberg ticker crawl",
    handler: (_, ctx) => {
      ctx.setTickerEnabled(false);
      return { kind: "action" };
    },
  },
  {
    name: "ALERT CLEAR",
    group: "setting",
    description: "Clear regime change alert events",
    handler: async (_, ctx, signal) => {
      await fetch("/api/alerts/regime/clear", { method: "DELETE", signal });
      ctx.invalidate(["ticker"]);
      return { kind: "action" };
    },
  },
  {
    name: "DARK",
    group: "setting",
    description: "Switch to dark mode",
    handler: (_, ctx) => {
      ctx.setDarkMode(true);
      return { kind: "action" };
    },
  },
  {
    name: "LIGHT",
    group: "setting",
    description: "Switch to light mode",
    handler: (_, ctx) => {
      ctx.setDarkMode(false);
      return { kind: "action" };
    },
  },
  {
    name: "YTD ON",
    group: "setting",
    description: "Show YTD % column",
    handler: (_, ctx) => {
      ctx.setShowYTD(true);
      return { kind: "action" };
    },
  },
  {
    name: "YTD OFF",
    group: "setting",
    description: "Show Daily % column",
    handler: (_, ctx) => {
      ctx.setShowYTD(false);
      return { kind: "action" };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// INFO commands
// ─────────────────────────────────────────────────────────────────────────────

const INFO: CommandDef[] = [
  {
    name: "REGIME",
    group: "info",
    description: "Show current correlation regime",
    handler: async (_, _ctx, signal) => {
      const res = await fetch("/api/regime/calibrated?period=3m", { signal });
      const d = await res.json().catch(() => ({}));
      const corr = d?.corr ?? {};
      return {
        kind: "display",
        content: {
          type: "scalar",
          label: "REGIME  CORR [3m]",
          value: corr.label ?? "N/A",
          sub: corr.score != null ? `score=${corr.score?.toFixed(3)}` : "",
        },
      };
    },
  },
  {
    name: "HELP",
    group: "info",
    description: "List all terminal commands",
    handler: () => ({ kind: "stay" }) as CommandResult,
  },
  {
    name: "PING",
    group: "info",
    description: "Check backend status",
    handler: async (_, _ctx, signal) => {
      const t0 = Date.now();
      const res = await fetch("/api/health", { signal }).catch(() => null);
      const ms = Date.now() - t0;
      return {
        kind: "display",
        content: {
          type: "scalar",
          label: "PING  backend",
          value: res?.ok ? `OK  ${ms}ms` : "UNREACHABLE",
          sub: res?.ok ? "backend is healthy" : "Python server may be down",
        },
      };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// ANALYSIS function commands
// ─────────────────────────────────────────────────────────────────────────────

const ANALYSIS: CommandDef[] = [
  // ── corr(A, B, period?) ────────────────────────────────────────────────────
  {
    name: "CORR",
    aliases: ["COR"],
    group: "analysis",
    args: [
      { name: "a", type: "symbol", optional: false },
      { name: "b", type: "symbol", optional: false },
      { name: "period", type: "period", optional: true, default: "3m" },
    ],
    description: "Pearson correlation of returns between two symbols",
    handler: async (args, _, signal) => {
      const a = sym(args, 0);
      const b = sym(args, 1);
      const p = period(args, "3m");
      if (!a || !b) return { kind: "error", message: "Usage: corr(SYMBOL_A, SYMBOL_B, period?)" };
      try {
        const d = await analyticsJson<{ correlation: number; p_value: number; n: number }>(
          "corr",
          { a, b, period: p },
          signal
        );
        return {
          kind: "display",
          content: {
            type: "scalar",
            label: `CORR  ${a} / ${b}  [${p}]`,
            value: fmtNum(d.correlation, 4),
            sub: `n=${d.n}  p-value=${fmtNum(d.p_value, 4)}`,
          },
        };
      } catch (e) {
        return { kind: "error", message: (e as Error).message };
      }
    },
  },

  // ── beta(asset, benchmark?, period?) ──────────────────────────────────────
  {
    name: "BETA",
    group: "analysis",
    args: [
      { name: "asset", type: "symbol", optional: false },
      { name: "benchmark", type: "symbol", optional: true, default: "^GSPC" },
      { name: "period", type: "period", optional: true, default: "1y" },
    ],
    description: "Beta vs benchmark (default: S&P 500)",
    handler: async (args, _, signal) => {
      const asset = sym(args, 0);
      const bench = sym(args, 1) ?? "^GSPC";
      const p = period(args, "1y");
      if (!asset) return { kind: "error", message: "Usage: beta(SYMBOL, benchmark?, period?)" };
      try {
        const d = await analyticsJson<{ beta: number; alpha: number; r2: number; n: number }>(
          "beta",
          { asset, benchmark: bench, period: p },
          signal
        );
        return {
          kind: "display",
          content: {
            type: "scalar",
            label: `BETA  ${asset} vs ${bench}  [${p}]`,
            value: fmtNum(d.beta, 4),
            sub: `α=${fmtNum(d.alpha, 5)}  R²=${fmtNum(d.r2, 3)}  n=${d.n}`,
          },
        };
      } catch (e) {
        return { kind: "error", message: (e as Error).message };
      }
    },
  },

  // ── vol(symbol, period?) ──────────────────────────────────────────────────
  {
    name: "VOL",
    group: "analysis",
    args: [
      { name: "symbol", type: "symbol", optional: false },
      { name: "period", type: "period", optional: true, default: "1y" },
    ],
    description: "Annualised historical volatility",
    handler: async (args, _, signal) => {
      const s = sym(args, 0);
      const p = period(args, "1y");
      if (!s) return { kind: "error", message: "Usage: vol(SYMBOL, period?)" };
      try {
        const d = await analyticsJson<{ annualised_vol: number; daily_std: number; n: number }>(
          "vol",
          { symbol: s, period: p },
          signal
        );
        return {
          kind: "display",
          content: {
            type: "scalar",
            label: `VOL  ${s}  [${p}]`,
            value: fmtPct(d.annualised_vol),
            sub: `daily_σ=${fmtPct(d.daily_std)}  n=${d.n}`,
          },
        };
      } catch (e) {
        return { kind: "error", message: (e as Error).message };
      }
    },
  },

  // ── return(symbol, period?) ───────────────────────────────────────────────
  {
    name: "RETURN",
    aliases: ["RET"],
    group: "analysis",
    args: [
      { name: "symbol", type: "symbol", optional: false },
      { name: "period", type: "period", optional: true, default: "1y" },
    ],
    description: "Total return for period",
    handler: async (args, _, signal) => {
      const s = sym(args, 0);
      const p = period(args, "1y");
      if (!s) return { kind: "error", message: "Usage: return(SYMBOL, period?)" };
      try {
        const d = await analyticsJson<{
          return: number;
          start_price: number;
          end_price: number;
          start_date: string;
          end_date: string;
        }>("return", { symbol: s, period: p }, signal);
        return {
          kind: "display",
          content: {
            type: "scalar",
            label: `RETURN  ${s}  [${p}]`,
            value: fmtPct(d.return),
            sub: `${d.start_date} → ${d.end_date}  (${d.start_price.toFixed(2)} → ${d.end_price.toFixed(2)})`,
          },
        };
      } catch (e) {
        return { kind: "error", message: (e as Error).message };
      }
    },
  },

  // ── drawdown(symbol, period?) ─────────────────────────────────────────────
  {
    name: "DRAWDOWN",
    aliases: ["DD"],
    group: "analysis",
    args: [
      { name: "symbol", type: "symbol", optional: false },
      { name: "period", type: "period", optional: true, default: "1y" },
    ],
    description: "Maximum drawdown (peak-to-trough)",
    handler: async (args, _, signal) => {
      const s = sym(args, 0);
      const p = period(args, "1y");
      if (!s) return { kind: "error", message: "Usage: drawdown(SYMBOL, period?)" };
      try {
        const d = await analyticsJson<{ max_drawdown: number; trough_date: string }>(
          "drawdown",
          { symbol: s, period: p },
          signal
        );
        return {
          kind: "display",
          content: {
            type: "scalar",
            label: `DRAWDOWN  ${s}  [${p}]`,
            value: fmtPct(d.max_drawdown),
            sub: d.trough_date ? `trough: ${d.trough_date}` : "",
          },
        };
      } catch (e) {
        return { kind: "error", message: (e as Error).message };
      }
    },
  },

  // ── sharpe(symbol, period?) ───────────────────────────────────────────────
  {
    name: "SHARPE",
    group: "analysis",
    args: [
      { name: "symbol", type: "symbol", optional: false },
      { name: "period", type: "period", optional: true, default: "1y" },
    ],
    description: "Annualised Sharpe ratio  (rf = 4.3 %)",
    handler: async (args, _, signal) => {
      const s = sym(args, 0);
      const p = period(args, "1y");
      if (!s) return { kind: "error", message: "Usage: sharpe(SYMBOL, period?)" };
      try {
        const d = await analyticsJson<{
          sharpe: number;
          annualised_return: number;
          annualised_vol: number;
        }>("sharpe", { symbol: s, period: p }, signal);
        return {
          kind: "display",
          content: {
            type: "scalar",
            label: `SHARPE  ${s}  [${p}]`,
            value: fmtNum(d.sharpe, 3),
            sub: `ann_ret=${fmtPct(d.annualised_return)}  ann_vol=${fmtPct(d.annualised_vol)}  rf=4.3%`,
          },
        };
      } catch (e) {
        return { kind: "error", message: (e as Error).message };
      }
    },
  },

  // ── zscore(symbol, period?) ───────────────────────────────────────────────
  {
    name: "ZSCORE",
    aliases: ["ZS"],
    group: "analysis",
    args: [
      { name: "symbol", type: "symbol", optional: false },
      { name: "period", type: "period", optional: true, default: "1y" },
    ],
    description: "Z-score of current price vs period mean",
    handler: async (args, _, signal) => {
      const s = sym(args, 0);
      const p = period(args, "1y");
      if (!s) return { kind: "error", message: "Usage: zscore(SYMBOL, period?)" };
      try {
        const d = await analyticsJson<{
          zscore: number;
          current: number;
          mean: number;
          std: number;
        }>("zscore", { symbol: s, period: p }, signal);
        const label = d.zscore > 2 ? "EXTENDED" : d.zscore < -2 ? "DEPRESSED" : "NORMAL";
        return {
          kind: "display",
          content: {
            type: "scalar",
            label: `ZSCORE  ${s}  [${p}]`,
            value: `${fmtNum(d.zscore, 2)}σ  (${label})`,
            sub: `cur=${d.current.toFixed(2)}  μ=${d.mean.toFixed(2)}  σ=${d.std.toFixed(2)}`,
          },
        };
      } catch (e) {
        return { kind: "error", message: (e as Error).message };
      }
    },
  },

  // ── rsi(symbol, window?) ──────────────────────────────────────────────────
  {
    name: "RSI",
    group: "analysis",
    args: [
      { name: "symbol", type: "symbol", optional: false },
      { name: "window", type: "number", optional: true, default: 14 },
    ],
    description: "RSI (Wilder smoothing, default window=14)",
    handler: async (args, _, signal) => {
      const s = sym(args, 0);
      const w = num(args, 0) ?? 14;
      if (!s) return { kind: "error", message: "Usage: rsi(SYMBOL, window?)" };
      try {
        const d = await analyticsJson<{ rsi: number; label: string }>(
          "rsi",
          { symbol: s, window: w },
          signal
        );
        return {
          kind: "display",
          content: {
            type: "scalar",
            label: `RSI  ${s}  [${w}]`,
            value: `${d.rsi.toFixed(1)}  (${d.label})`,
            sub: d.rsi >= 70 ? "Overbought zone" : d.rsi <= 30 ? "Oversold zone" : "Neutral zone",
          },
        };
      } catch (e) {
        return { kind: "error", message: (e as Error).message };
      }
    },
  },

  // ── stat(symbol, period?) ─────────────────────────────────────────────────
  {
    name: "STAT",
    aliases: ["STATS"],
    group: "analysis",
    args: [
      { name: "symbol", type: "symbol", optional: false },
      { name: "period", type: "period", optional: true, default: "1y" },
    ],
    description: "Full statistics: descriptive, risk, and diagnostic tests",
    handler: async (args, _, signal) => {
      const s = sym(args, 0);
      const p = period(args, "1y");
      if (!s) return { kind: "error", message: "Usage: stat(SYMBOL, period?)" };
      try {
        const d = await analyticsJson<StatResponse>("stat", { symbol: s, period: p }, signal);
        const { descriptive: de, risk: rk, diagnostics: dg } = d;

        // Section headers are rendered as a label row with blank values.
        const head = (t: string): RowData => ({ cells: [t, "", ""], colors: ["accent", "", ""] });
        const row = (k: string, v: string, note = "", color = ""): RowData => ({
          cells: [k, v, note],
          colors: ["", color, ""],
        });

        const rows: RowData[] = [
          head("── DESCRIPTIVE (log returns) ──"),
          row("Observations", String(de.n)),
          row("Mean (daily)", fmtPct(de.mean_daily), "", rowColor(de.mean_daily)),
          row("Mean (annual)", fmtPct(de.mean_annual), "", rowColor(de.mean_annual)),
          row("Std dev (daily)", fmtPct(de.std_daily)),
          row("Volatility (ann)", fmtPct(de.vol_annual)),
          row(
            "Skewness",
            fmtNum(de.skew, 3),
            de.skew < 0 ? "left tail — crash-prone" : de.skew > 0 ? "right tail" : "symmetric",
            rowColor(de.skew)
          ),
          row(
            "Excess kurtosis",
            fmtNum(de.excess_kurtosis, 3),
            de.excess_kurtosis > 1 ? "fat tails vs normal" : "near-normal tails"
          ),
          row("Min / Max", `${fmtPct(de.min)} / ${fmtPct(de.max)}`),
          row("P25 / Med / P75", `${fmtPct(de.p25)} / ${fmtPct(de.median)} / ${fmtPct(de.p75)}`),

          head("── RISK ──"),
          row("VaR 95% (daily)", fmtPct(rk.var_95), "worst 5% threshold", "neg"),
          row("CVaR 95% (daily)", fmtPct(rk.cvar_95), "mean loss beyond VaR", "neg"),
          row("Max drawdown", fmtPct(rk.max_drawdown), rk.trough_date, "neg"),
          row("Sharpe (ann)", fmtNum(rk.sharpe, 3), "", rowColor(rk.sharpe)),
          row("Sortino (ann)", fmtNum(rk.sortino, 3), "", rowColor(rk.sortino)),
          row("Downside dev", fmtPct(rk.downside_dev)),
        ];

        if (d.diag_note) {
          rows.push(head("── DIAGNOSTICS ──"), row("", "n/a", d.diag_note));
        } else {
          const verdictColor = (bad: boolean) => (bad ? "neg" : "pos");
          rows.push(head("── DIAGNOSTICS (on returns) ──"));
          if (dg.jarque_bera) {
            const t = dg.jarque_bera;
            rows.push(
              row(
                "Jarque-Bera",
                t.verdict,
                `JB=${fmtNum(t.stat, 1)} p=${fmtNum(t.p_value, 4)} — normality`,
                verdictColor(t.verdict === "NON-NORMAL")
              )
            );
          }
          if (dg.adf) {
            const t = dg.adf;
            rows.push(
              row(
                "ADF",
                t.verdict,
                `t=${fmtNum(t.stat, 3)} lag=${t.lag} crit5%=${fmtNum(t.crit_5pct, 3)} — stationarity`,
                verdictColor(t.verdict === "NON-STATIONARY")
              )
            );
          }
          if (dg.ljung_box) {
            const t = dg.ljung_box;
            rows.push(
              row(
                "Ljung-Box",
                t.verdict,
                `Q=${fmtNum(t.stat, 1)} p=${fmtNum(t.p_value, 4)} lags=${t.lags} — autocorrelation`,
                verdictColor(t.verdict === "AUTOCORRELATED")
              )
            );
          }
          if (dg.arch_lm) {
            const t = dg.arch_lm;
            rows.push(
              row(
                "ARCH-LM",
                t.verdict,
                `LM=${fmtNum(t.stat, 1)} p=${fmtNum(t.p_value, 4)} lags=${t.lags} — vol clustering`,
                verdictColor(t.verdict === "VOL CLUSTERING")
              )
            );
          }
        }

        return {
          kind: "display",
          content: {
            type: "table",
            label: `STAT  ${d.symbol}  [${p}]   ${d.start_date} → ${d.end_date}   last=${d.last_price}  ret=${fmtPct(d.total_return)}`,
            cols: ["METRIC", "VALUE", "NOTE"],
            rows,
          },
        };
      } catch (e) {
        return { kind: "error", message: (e as Error).message };
      }
    },
  },

  // ── compare(A, B, C, ..., period?) ────────────────────────────────────────
  {
    name: "COMPARE",
    aliases: ["CMP"],
    group: "analysis",
    args: [
      { name: "symbols...", type: "symbol", optional: false },
      { name: "period", type: "period", optional: true, default: "1y" },
    ],
    description: "Side-by-side metrics: return / vol / sharpe / drawdown",
    handler: async (args, _, signal) => {
      const syms = allSymbols(args);
      const p = period(args, "1y");
      if (syms.length < 1) return { kind: "error", message: "Usage: compare(A, B, C, period?)" };
      try {
        const d = await analyticsJson<{
          rows: Array<{
            symbol: string;
            return: number;
            vol: number;
            sharpe: number;
            drawdown: number;
          }>;
        }>("compare", { symbols: syms.join(","), period: p }, signal);
        return {
          kind: "display",
          content: {
            type: "table",
            label: `COMPARE  [${p}]`,
            cols: ["SYMBOL", "RETURN", "VOL", "SHARPE", "DRAWDOWN"],
            rows: d.rows.map((r) => ({
              cells: [
                r.symbol,
                fmtPct(r.return),
                fmtPct(r.vol),
                fmtNum(r.sharpe, 2),
                fmtPct(r.drawdown),
              ],
              colors: ["accent", rowColor(r.return), "", rowColor(r.sharpe), rowColor(r.drawdown)],
            })),
          },
        };
      } catch (e) {
        return { kind: "error", message: (e as Error).message };
      }
    },
  },

  // ── rank(A, B, C, by=return, period?) ────────────────────────────────────
  {
    name: "RANK",
    group: "analysis",
    args: [
      { name: "symbols...", type: "symbol", optional: false },
      { name: "period", type: "period", optional: true, default: "1y" },
    ],
    description: "Rank symbols by return (default) | vol | sharpe | drawdown",
    handler: async (args, _, signal) => {
      const syms = allSymbols(args);
      const p = period(args, "1y");
      // detect "by=metric" encoded as last symbol arg like "BY=SHARPE" or plain "SHARPE"
      const metricArg = syms.find((s) => ["RETURN", "VOL", "SHARPE", "DRAWDOWN"].includes(s));
      const by = metricArg?.toLowerCase() ?? "return";
      const filterSym = syms.filter((s) => s !== metricArg);
      if (filterSym.length < 1)
        return { kind: "error", message: "Usage: rank(A, B, C, SHARPE, period?)" };
      try {
        const d = await analyticsJson<{
          rows: Array<{
            symbol: string;
            return: number;
            vol: number;
            sharpe: number;
            drawdown: number;
          }>;
          by: string;
        }>("rank", { symbols: filterSym.join(","), by, period: p }, signal);
        return {
          kind: "display",
          content: {
            type: "table",
            label: `RANK by ${d.by.toUpperCase()}  [${p}]`,
            cols: ["#", "SYMBOL", "RETURN", "VOL", "SHARPE", "DRAWDOWN"],
            rows: d.rows.map((r, i) => ({
              cells: [
                `${i + 1}`,
                r.symbol,
                fmtPct(r.return),
                fmtPct(r.vol),
                fmtNum(r.sharpe, 2),
                fmtPct(r.drawdown),
              ],
              colors: [
                "",
                "accent",
                rowColor(r.return),
                "",
                rowColor(r.sharpe),
                rowColor(r.drawdown),
              ],
            })),
          },
        };
      } catch (e) {
        return { kind: "error", message: (e as Error).message };
      }
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export const ALL_COMMANDS: CommandDef[] = [...NAV, ...SETTINGS, ...INFO, ...ANALYSIS];

/** Canonical names of nav commands (single-word) */
export const NAV_NAMES = new Set(NAV.map((c) => c.name));

/** Canonical names of setting commands (multi-word) */
export const SETTING_NAMES = new Set(SETTINGS.map((c) => c.name));

/** Canonical names of analysis functions */
export const FUNC_NAMES = new Set(ANALYSIS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));

/** Master lookup map: name/alias → CommandDef */
export const CMD_MAP = new Map<string, CommandDef>(
  ALL_COMMANDS.flatMap((c) => [
    [c.name, c] as [string, CommandDef],
    ...(c.aliases ?? []).map((a) => [a, c] as [string, CommandDef]),
  ])
);
