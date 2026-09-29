"use client";

/**
 * PORT → RISK: is the VaR number any good?
 *
 * Two tests, both out-of-sample:
 *   ROLLING  — the current basket replayed: each past day vs the VaR of the
 *              days before it (/risk/metrics var_backtest_*). Immediate, but
 *              it is today's holdings, not the book that was actually held.
 *   LIVE LOG — one forecast written per day by the guard notifier
 *              (`var_forecasts`), scored against the next trading day's return
 *              of exactly those holdings (/risk/var-backtest). The real test;
 *              needs ~30 trading days before Kupiec says anything.
 * Also shows what the VaR now covers: NAV incl. cash, shorts, option delta.
 */

import { useQuery } from "@tanstack/react-query";

import type { Colors } from "../helpers";
import { fmtAmt } from "../helpers";

interface MethodSummary {
  n: number;
  exceptions: number;
  rate_pct: number;
  expected_pct: number;
  kupiec_p: number | null;
  signal: "GREEN" | "YELLOW" | "RED" | "INSUFFICIENT_DATA";
}

interface LiveRow {
  forecast_date: string;
  return_date: string;
  realized_pct: number;
  coverage_pct: number;
  hist: number | null;
  hist_exception: boolean;
  cvar: number | null;
  cvar_exception: boolean;
}

interface LiveData {
  rows: LiveRow[];
  summary: Record<string, MethodSummary>;
  pending: number;
  first_forecast: string | null;
  note?: string;
}

const SIGNAL_COLOR: Record<string, string> = {
  GREEN: "#00C853",
  YELLOW: "#FFB300",
  RED: "#FF4444",
  INSUFFICIENT_DATA: "#888888",
};

export function VarValidationCard({
  accountId,
  colors,
  sym,
  rolling,
  nav,
}: {
  accountId: string;
  colors: Colors;
  sym: string;
  rolling: {
    exceptions: number;
    obs: number | undefined;
    rate: number;
    signal: string;
    kupiec: number;
  };
  nav: {
    nav_value?: number;
    cash_value?: number;
    gross_exposure_pct?: number | null;
    net_exposure_pct?: number | null;
    short_value?: number;
    option_delta_value?: number;
  };
}) {
  const { data } = useQuery<LiveData>({
    queryKey: ["var-backtest", accountId],
    queryFn: async () => {
      const r = await fetch(
        `/api/v2/portfolio/risk/var-backtest?account_id=${encodeURIComponent(accountId)}`
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 30 * 60_000,
  });
  const hist = data?.summary?.hist;
  const cvar = data?.summary?.cvar;
  const evaluated = data?.rows.length ?? 0;

  return (
    <div
      className="rounded p-2 mb-2 flex flex-col gap-1 font-mono"
      style={{ border: `1px solid ${colors.border}`, fontSize: 10 }}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span style={{ color: colors.textSecondary, letterSpacing: "0.12em" }}>VAR VALIDATION</span>
        {nav.nav_value != null && (
          <span
            className="ml-auto tabular-nums"
            style={{ color: colors.textSecondary, fontSize: 9 }}
          >
            NAV {sym}
            {fmtAmt(nav.nav_value)} · cash {sym}
            {fmtAmt(nav.cash_value ?? 0)} · net {nav.net_exposure_pct?.toFixed(1) ?? "—"}% · gross{" "}
            {nav.gross_exposure_pct?.toFixed(1) ?? "—"}%
            {nav.short_value ? ` · short ${sym}${fmtAmt(nav.short_value)}` : ""}
            {nav.option_delta_value ? ` · options Δ ${sym}${fmtAmt(nav.option_delta_value)}` : ""}
          </span>
        )}
      </div>

      <div className="flex gap-6 flex-wrap">
        <div className="flex flex-col">
          <span style={{ color: colors.textSecondary, fontSize: 8.5 }}>
            ROLLING OOS (พอร์ตวันนี้ย้อนหลัง)
          </span>
          <span className="tabular-nums">
            <span style={{ color: SIGNAL_COLOR[rolling.signal] ?? colors.text, fontWeight: 700 }}>
              ● {rolling.signal}
            </span>{" "}
            <span style={{ color: colors.text }}>
              {rolling.exceptions}/{rolling.obs ?? "—"} วันเกิน VaR ({rolling.rate.toFixed(1)}% · คาด
              5%)
            </span>{" "}
            <span style={{ color: colors.textSecondary }}>
              Kupiec p {rolling.kupiec.toFixed(3)}
            </span>
          </span>
        </div>
        <div className="flex flex-col">
          <span style={{ color: colors.textSecondary, fontSize: 8.5 }}>
            LIVE LOG (พยากรณ์จริงรายวัน vs วันถัดไป)
          </span>
          {!data ? (
            <span style={{ color: colors.textSecondary }}>loading…</span>
          ) : !data.first_forecast ? (
            <span style={{ color: colors.textSecondary }}>
              ยังไม่มีบันทึก — ระบบเขียนวันละ 1 ครั้ง (guard notifier)
            </span>
          ) : (
            <span className="tabular-nums">
              {hist && (
                <span style={{ color: SIGNAL_COLOR[hist.signal], fontWeight: 700 }}>
                  ● {hist.signal}
                </span>
              )}{" "}
              <span style={{ color: colors.text }}>
                VaR {hist?.exceptions ?? 0}/{hist?.n ?? 0} · CVaR {cvar?.exceptions ?? 0}/
                {cvar?.n ?? 0} วันเกิน
              </span>{" "}
              <span style={{ color: colors.textSecondary }}>
                เริ่ม {data.first_forecast} · รอผล {data.pending}
                {evaluated < 30 && ` · ต้องมี ≥30 วันถึงสรุปได้ (มี ${evaluated})`}
              </span>
            </span>
          )}
        </div>
      </div>

      {data && data.rows.length > 0 && (
        <div
          className="grid gap-x-3 items-baseline"
          style={{ gridTemplateColumns: "repeat(5, auto)", justifyContent: "start", fontSize: 9 }}
        >
          {["FORECAST", "JUDGED ON", "VaR", "REALIZED", ""].map((h) => (
            <span key={h} style={{ color: colors.textSecondary, fontSize: 8.5 }}>
              {h}
            </span>
          ))}
          {data.rows.slice(0, 8).map((r) => (
            <div key={r.forecast_date} className="contents">
              <span>{r.forecast_date}</span>
              <span style={{ color: colors.textSecondary }}>{r.return_date}</span>
              <span className="tabular-nums">−{(r.hist ?? 0).toFixed(2)}%</span>
              <span
                className="tabular-nums"
                style={{ color: r.realized_pct >= 0 ? colors.positive : colors.negative }}
              >
                {r.realized_pct >= 0 ? "+" : ""}
                {r.realized_pct.toFixed(2)}%
              </span>
              <span style={{ color: r.hist_exception ? "#FF4444" : colors.textSecondary }}>
                {r.hist_exception ? "เกิน VaR" : ""}
                {r.coverage_pct < 99 ? ` (ข้อมูล ${r.coverage_pct}%)` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
