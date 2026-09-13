"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { bloombergColors } from "../../../lib/theme-config";
import type { DcfModel, DcfResponse, DcfScenario } from "./types";

type Colors = typeof bloombergColors.dark;
type SubTab = "overview" | "forecast" | "assumptions" | "sensitivity" | "audit";

const SUB_TABS: Array<{ id: SubTab; label: string }> = [
  { id: "overview", label: "OVERVIEW" },
  { id: "forecast", label: "FORECAST" },
  { id: "assumptions", label: "ASSUMPTIONS" },
  { id: "sensitivity", label: "SENSITIVITY" },
  { id: "audit", label: "AUDIT" },
];

const MODELS: Array<{ id: DcfModel; label: string }> = [
  { id: "auto", label: "AUTO — INDUSTRY ROUTER" },
  { id: "fcff", label: "3-STAGE FCFF" },
  { id: "growth", label: "REVENUE → FCFF" },
  { id: "fcfe", label: "FCFE" },
  { id: "excess_return", label: "EXCESS RETURN — FINANCIALS" },
  { id: "affo", label: "AFFO DCF — REIT" },
  { id: "normalized_cycle", label: "NORMALIZED CYCLE" },
];

const ASSUMPTION_META: Record<
  string,
  { label: string; unit: "%" | "x" | "years"; step: number; hint: string }
> = {
  forecast_years: { label: "Explicit forecast", unit: "years", step: 1, hint: "3–15 years" },
  revenue_growth: { label: "Revenue growth", unit: "%", step: 0.1, hint: "High-growth stage" },
  target_margin: { label: "Target EBIT margin", unit: "%", step: 0.1, hint: "End of transition" },
  tax_rate: { label: "Normalized tax rate", unit: "%", step: 0.1, hint: "Cash tax assumption" },
  sales_to_capital: {
    label: "Sales / invested capital",
    unit: "x",
    step: 0.1,
    hint: "Reinvestment efficiency",
  },
  wacc: { label: "WACC", unit: "%", step: 0.1, hint: "FCFF discount rate" },
  cost_of_equity: {
    label: "Cost of equity",
    unit: "%",
    step: 0.1,
    hint: "Equity-model discount rate",
  },
  terminal_growth: {
    label: "Terminal growth",
    unit: "%",
    step: 0.1,
    hint: "Must remain below discount rate",
  },
  terminal_roic: {
    label: "Terminal ROIC",
    unit: "%",
    step: 0.1,
    hint: "Drives stable reinvestment",
  },
  roe: { label: "Starting ROE", unit: "%", step: 0.1, hint: "Excess-return model" },
  stable_roe: { label: "Stable ROE", unit: "%", step: 0.1, hint: "Fades toward cost of equity" },
  payout_ratio: { label: "Payout ratio", unit: "%", step: 0.1, hint: "Financial/FCFE retention" },
  affo_growth: { label: "AFFO growth", unit: "%", step: 0.1, hint: "REIT cash-flow growth" },
};

function fmtPct(value: number | null | undefined, digits = 1) {
  return value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

function fmtRate(value: number | null | undefined, digits = 1) {
  return value == null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function fmtValue(value: number | null | undefined, currency?: string | null, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  const prefix = currency === "USD" ? "$" : currency ? `${currency} ` : "";
  return `${prefix}${value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
}

function fmtLarge(value: number | null | undefined, currency?: string | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  const prefix = currency === "USD" ? "$" : currency ? `${currency} ` : "";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${prefix}${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${prefix}${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${prefix}${(value / 1e6).toFixed(1)}M`;
  return `${prefix}${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

async function fetchDcf(
  symbol: string,
  request: { model: DcfModel; scenario: DcfScenario; assumptions: Record<string, number> }
): Promise<DcfResponse> {
  const hasCustomRun =
    request.model !== "auto" ||
    request.scenario !== "base" ||
    Object.keys(request.assumptions).length > 0;
  const response = await fetch(`/api/dcf/${encodeURIComponent(symbol)}`, {
    method: hasCustomRun ? "POST" : "GET",
    headers: hasCustomRun ? { "Content-Type": "application/json" } : undefined,
    body: hasCustomRun ? JSON.stringify(request) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail ?? "DCF calculation failed");
  return body as DcfResponse;
}

function TabButton({
  active,
  label,
  onClick,
  colors,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  colors: Colors;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2 py-1 text-[10px] font-mono border tracking-wide"
      style={{
        borderColor: active ? colors.accent : colors.border,
        backgroundColor: active ? colors.accent : "transparent",
        color: active ? "#000" : colors.text,
      }}
    >
      {label}
    </button>
  );
}

function SummaryTile({
  label,
  value,
  detail,
  color,
  colors,
}: {
  label: string;
  value: string;
  detail?: string;
  color?: string;
  colors: Colors;
}) {
  return (
    <div className="min-w-0 border p-2 flex-1 basis-[135px]" style={{ borderColor: colors.border }}>
      <div className="text-[9px] tracking-widest" style={{ color: colors.textDimmed }}>
        {label}
      </div>
      <div
        className="text-base font-bold font-mono truncate"
        style={{ color: color ?? colors.text }}
      >
        {value}
      </div>
      {detail && (
        <div className="text-[9px] truncate" style={{ color: colors.textSecondary }}>
          {detail}
        </div>
      )}
    </div>
  );
}

function ForecastBars({ data, colors }: { data: DcfResponse; colors: Colors }) {
  const maximum = Math.max(1, ...data.forecast.map((row) => Math.abs(row.cash_flow ?? 0)));
  return (
    <div
      className="h-40 flex items-end gap-1 border-y px-1 py-2"
      style={{ borderColor: colors.border }}
    >
      {data.forecast.map((row) => {
        const height = Math.max(3, (Math.abs(row.cash_flow) / maximum) * 105);
        const positive = row.cash_flow >= 0;
        return (
          <div
            key={row.year}
            className="h-full flex-1 min-w-0 flex flex-col justify-end items-center gap-1"
          >
            <span
              className="text-[8px] font-mono truncate max-w-full"
              style={{ color: colors.textSecondary }}
            >
              {fmtLarge(row.cash_flow)}
            </span>
            <div
              className="w-3/5 min-w-[8px] max-w-[34px]"
              style={{ height, backgroundColor: positive ? colors.accent : colors.negative }}
              title={`Year ${row.year}: ${fmtLarge(row.cash_flow, data.currency)}`}
            />
            <span className="text-[8px]" style={{ color: colors.textDimmed }}>
              Y{row.year}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Overview({ data, colors }: { data: DcfResponse; colors: Colors }) {
  const summary = data.summary;
  const upsideColor =
    summary.upside_downside == null
      ? colors.textDimmed
      : summary.upside_downside >= 0
        ? colors.positive
        : colors.negative;
  return (
    <div className="space-y-3 min-w-0">
      <div className="flex flex-wrap gap-2">
        <SummaryTile
          label="INTRINSIC / SHARE"
          value={fmtValue(summary.intrinsic_value_per_share, data.currency)}
          colors={colors}
        />
        <SummaryTile
          label="MARKET PRICE"
          value={fmtValue(summary.market_price, data.currency)}
          colors={colors}
        />
        <SummaryTile
          label="UPSIDE / DOWNSIDE"
          value={fmtPct(summary.upside_downside)}
          color={upsideColor}
          colors={colors}
        />
        <SummaryTile
          label="TERMINAL VALUE / PV"
          value={fmtRate(summary.terminal_value_share)}
          colors={colors}
        />
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 mb-1">
          <span
            className="text-[10px] font-bold tracking-widest"
            style={{ color: colors.textSecondary }}
          >
            DISCOUNTED CASH FLOW · EXPLICIT PERIOD
          </span>
          <span className="text-[9px]" style={{ color: colors.textDimmed }}>
            orange = positive · red = negative
          </span>
        </div>
        <ForecastBars data={data} colors={colors} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div className="border p-2" style={{ borderColor: colors.border }}>
          <div className="text-[9px] tracking-widest mb-1" style={{ color: colors.textDimmed }}>
            MODEL ROUTER
          </div>
          <div className="text-xs font-bold" style={{ color: colors.accent }}>
            {data.model_label}
          </div>
          <p className="text-[10px] mt-1 leading-relaxed" style={{ color: colors.textSecondary }}>
            {data.model_router.reason}
          </p>
        </div>
        <div className="border p-2" style={{ borderColor: colors.border }}>
          <div className="text-[9px] tracking-widest mb-1" style={{ color: colors.textDimmed }}>
            VALUE BRIDGE
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] font-mono">
            <span style={{ color: colors.textSecondary }}>Enterprise value</span>
            <span className="text-right">{fmtLarge(summary.enterprise_value, data.currency)}</span>
            <span style={{ color: colors.textSecondary }}>+ Cash</span>
            <span className="text-right">{fmtLarge(data.bridge.cash, data.currency)}</span>
            <span style={{ color: colors.textSecondary }}>− Debt</span>
            <span className="text-right">{fmtLarge(data.bridge.debt, data.currency)}</span>
            <span style={{ color: colors.textSecondary }}>Equity value</span>
            <span className="text-right" style={{ color: colors.accent }}>
              {fmtLarge(summary.equity_value, data.currency)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ForecastTable({ data, colors }: { data: DcfResponse; colors: Colors }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px] font-mono border-collapse min-w-[760px]">
        <thead>
          <tr style={{ color: colors.textDimmed }}>
            {[
              "YEAR",
              "STAGE",
              "REVENUE",
              "GROWTH",
              "MARGIN / ROE",
              "NOPAT / EARNINGS",
              "REINVEST",
              "CASH FLOW",
              "DISCOUNT",
              "PV",
            ].map((label) => (
              <th
                key={label}
                className="text-right first:text-left p-1 border-b"
                style={{ borderColor: colors.border }}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.forecast.map((row) => (
            <tr key={row.year} className="border-b" style={{ borderColor: colors.border }}>
              <td className="p-1">Y{row.year}</td>
              <td className="p-1 text-right" style={{ color: colors.textSecondary }}>
                {row.stage}
              </td>
              <td className="p-1 text-right">{fmtLarge(row.revenue, data.currency)}</td>
              <td className="p-1 text-right">{fmtRate(row.growth)}</td>
              <td className="p-1 text-right">{fmtRate(row.ebit_margin ?? row.roe)}</td>
              <td className="p-1 text-right">
                {fmtLarge(row.nopat ?? row.earnings, data.currency)}
              </td>
              <td className="p-1 text-right">{fmtLarge(row.reinvestment, data.currency)}</td>
              <td
                className="p-1 text-right font-bold"
                style={{ color: row.cash_flow >= 0 ? colors.accent : colors.negative }}
              >
                {fmtLarge(row.cash_flow, data.currency)}
              </td>
              <td className="p-1 text-right">{fmtRate(row.discount_rate)}</td>
              <td className="p-1 text-right">{fmtLarge(row.present_value, data.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-[9px]" style={{ color: colors.textDimmed }}>
        Terminal: {data.terminal.method} · next cash flow{" "}
        {fmtLarge(data.terminal.cash_flow, data.currency)} · undiscounted{" "}
        {fmtLarge(data.terminal.undiscounted_value, data.currency)}
      </div>
    </div>
  );
}

function AssumptionsEditor({
  data,
  draft,
  onChange,
  colors,
}: {
  data: DcfResponse;
  draft: Record<string, number>;
  onChange: (key: string, value: number) => void;
  colors: Colors;
}) {
  const common = [
    "forecast_years",
    "revenue_growth",
    "target_margin",
    "tax_rate",
    "sales_to_capital",
    "terminal_growth",
  ];
  const keys =
    data.model === "excess_return"
      ? ["forecast_years", "roe", "stable_roe", "payout_ratio", "cost_of_equity", "terminal_growth"]
      : data.model === "affo"
        ? ["forecast_years", "affo_growth", "cost_of_equity", "terminal_growth"]
        : data.model === "fcfe"
          ? [
              "forecast_years",
              "revenue_growth",
              "cost_of_equity",
              "terminal_growth",
              "payout_ratio",
            ]
          : [...common, "wacc", "terminal_roic"];

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
        {keys.map((key) => {
          const meta = ASSUMPTION_META[key];
          const raw =
            draft[key] ??
            (typeof data.assumptions[key] === "number" ? (data.assumptions[key] as number) : 0);
          const shown = meta.unit === "%" ? raw * 100 : raw;
          return (
            <label key={key} className="border p-2" style={{ borderColor: colors.border }}>
              <span
                className="flex justify-between gap-2 text-[9px]"
                style={{ color: colors.textSecondary }}
              >
                <span>{meta.label}</span>
                <span>{meta.hint}</span>
              </span>
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="number"
                  value={Number(shown.toFixed(meta.unit === "years" ? 0 : 2))}
                  step={meta.step}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) onChange(key, meta.unit === "%" ? next / 100 : next);
                  }}
                  className="w-full bg-transparent border px-2 py-1 text-xs font-mono"
                  style={{ borderColor: colors.border, color: colors.text }}
                />
                <span className="w-10 text-[9px]" style={{ color: colors.textDimmed }}>
                  {meta.unit}
                </span>
              </div>
            </label>
          );
        })}
      </div>
      <div
        className="mt-3 border p-2 text-[10px] leading-relaxed"
        style={{ borderColor: colors.border, color: colors.textSecondary }}
      >
        Overrides are sent as decimals to the Python engine and applied before the selected
        Bear/Base/Bull transformation. Terminal growth is automatically capped below the applicable
        discount rate.
      </div>
    </div>
  );
}

function SensitivityTable({ data, colors }: { data: DcfResponse; colors: Colors }) {
  const sensitivity = data.sensitivity;
  return (
    <div className="overflow-x-auto">
      <div className="text-[10px] mb-2" style={{ color: colors.textSecondary }}>
        Rows vary {sensitivity.discount_rate_key === "wacc" ? "WACC" : "cost of equity"}; columns
        vary terminal growth. The highlighted center is the active run.
      </div>
      <table className="w-full text-[10px] font-mono border-collapse min-w-[480px]">
        <thead>
          <tr>
            <th
              className="p-2 text-left border-b"
              style={{ color: colors.textDimmed, borderColor: colors.border }}
            >
              RATE \ g
            </th>
            {sensitivity.terminal_growth_rates.map((growth) => (
              <th
                key={growth}
                className="p-2 text-right border-b"
                style={{ color: colors.textDimmed, borderColor: colors.border }}
              >
                {fmtRate(growth)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sensitivity.discount_rates.map((rate, rowIndex) => (
            <tr key={rate}>
              <td
                className="p-2 border-b"
                style={{ borderColor: colors.border, color: colors.textSecondary }}
              >
                {fmtRate(rate)}
              </td>
              {sensitivity.values_per_share[rowIndex].map((value, colIndex) => {
                const center = rowIndex === 2 && colIndex === 2;
                const favorable =
                  value != null &&
                  data.summary.market_price != null &&
                  value >= data.summary.market_price;
                const growth = sensitivity.terminal_growth_rates[colIndex];
                return (
                  <td
                    key={`${rate}:${growth}`}
                    className="p-2 text-right border-b"
                    style={{
                      borderColor: colors.border,
                      backgroundColor: center ? colors.accent : "transparent",
                      color: center ? "#000" : favorable ? colors.positive : colors.negative,
                    }}
                  >
                    {fmtValue(value, data.currency)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Audit({ data, colors }: { data: DcfResponse; colors: Colors }) {
  const statusColor = (status: string) =>
    status === "MISSING" ? colors.negative : status === "DERIVED" ? colors.accent : colors.positive;
  return (
    <div className="space-y-3">
      <div
        className="border p-2 text-[10px] font-mono space-y-1"
        style={{ borderColor: colors.border }}
      >
        <div>FCFF = EBIT × (1−tax) + D&amp;A − CapEx − ΔNWC</div>
        <div>Terminal FCFF = NOPAT × (1−g / ROIC)</div>
        <div>Equity = EV + cash − debt − minority interest − preferred stock</div>
        <div style={{ color: colors.textSecondary }}>
          Model result is deterministic for the same input document and assumptions.
        </div>
      </div>

      {data.data_quality.warnings.length > 0 && (
        <div className="border p-2" style={{ borderColor: colors.accent }}>
          <div
            className="flex items-center gap-1 text-[10px] font-bold"
            style={{ color: colors.accent }}
          >
            <AlertTriangle className="h-3 w-3" /> WARNINGS
          </div>
          {data.data_quality.warnings.map((warning) => (
            <div key={warning} className="text-[10px] mt-1" style={{ color: colors.textSecondary }}>
              • {warning}
            </div>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-[9px] font-mono border-collapse">
          <thead>
            <tr style={{ color: colors.textDimmed }}>
              {["INPUT", "VALUE", "STATUS", "SOURCE / TAG", "PERIOD"].map((label) => (
                <th
                  key={label}
                  className="text-left p-1 border-b"
                  style={{ borderColor: colors.border }}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.data_quality.lineage.map((row, index) => (
              <tr
                key={`${row.key}:${index}`}
                className="border-b"
                style={{ borderColor: colors.border }}
              >
                <td className="p-1">{row.key}</td>
                <td className="p-1">{fmtLarge(row.value, data.currency)}</td>
                <td className="p-1" style={{ color: statusColor(row.status) }}>
                  {row.status}
                </td>
                <td className="p-1" style={{ color: colors.textSecondary }}>
                  {row.source}
                  {row.tag ? ` · ${row.tag}` : ""}
                </td>
                <td className="p-1" style={{ color: colors.textSecondary }}>
                  {row.period ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DcfTab({ symbol, colors }: { symbol: string; colors: Colors }) {
  const [subTab, setSubTab] = useState<SubTab>("overview");
  const [draftModel, setDraftModel] = useState<DcfModel>("auto");
  const [draftScenario, setDraftScenario] = useState<DcfScenario>("base");
  const [draftAssumptions, setDraftAssumptions] = useState<Record<string, number>>({});
  const [request, setRequest] = useState<{
    symbol: string;
    model: DcfModel;
    scenario: DcfScenario;
    assumptions: Record<string, number>;
  }>({ symbol, model: "auto", scenario: "base", assumptions: {} });
  const initializedFor = useRef("");

  useEffect(() => {
    setSubTab("overview");
    setDraftModel("auto");
    setDraftScenario("base");
    setDraftAssumptions({});
    setRequest({ symbol, model: "auto", scenario: "base", assumptions: {} });
    initializedFor.current = `reset:${symbol}`;
  }, [symbol]);

  const effectiveRequest =
    request.symbol === symbol
      ? request
      : { symbol, model: "auto" as const, scenario: "base" as const, assumptions: {} };

  const { data, isLoading, isFetching, error } = useQuery<DcfResponse>({
    queryKey: ["dcf", symbol, effectiveRequest],
    queryFn: () => fetchDcf(symbol, effectiveRequest),
    enabled: Boolean(symbol),
    staleTime: 15 * 60_000,
    retry: false,
  });

  useEffect(() => {
    if (!data || initializedFor.current === `ready:${symbol}`) return;
    const initial: Record<string, number> = {};
    for (const [key, value] of Object.entries(data.assumptions)) {
      if (typeof value === "number") initial[key] = value;
    }
    setDraftAssumptions(initial);
    initializedFor.current = `ready:${symbol}`;
  }, [data, symbol]);

  const completeness = data?.data_quality.completeness;
  const runLabel = useMemo(() => {
    if (isFetching) return "RUNNING…";
    return effectiveRequest.model === "auto" ? "RE-RUN VALUATION" : "RUN CUSTOM MODEL";
  }, [effectiveRequest.model, isFetching]);

  const run = () => {
    setRequest({
      symbol,
      model: draftModel,
      scenario: draftScenario,
      assumptions: { ...draftAssumptions },
    });
  };

  return (
    <div
      className="p-3 border min-w-0"
      style={{ backgroundColor: colors.surface, borderColor: colors.border }}
    >
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <h3 className="text-xs font-bold tracking-widest" style={{ color: colors.accent }}>
          DCF LAB · {symbol}
        </h3>
        {data && (
          <span
            className="text-[9px] px-1 py-0.5 border"
            style={{ color: colors.text, borderColor: colors.border }}
          >
            {data.model_label}
          </span>
        )}
        <span
          className="text-[9px] font-mono"
          style={{
            color: completeness != null && completeness >= 0.7 ? colors.positive : colors.accent,
          }}
        >
          {completeness == null ? "" : `DATA ${(completeness * 100).toFixed(0)}%`}
        </span>
        <span className="ml-auto text-[9px] font-mono" style={{ color: colors.textDimmed }}>
          {data?.as_of ? `AS OF ${data.as_of}` : "FILINGS + MARKET INPUTS"}
          {data?.currency ? ` · ${data.currency}` : ""}
        </span>
      </div>

      <div
        className="flex flex-wrap items-end gap-2 mb-3 border-y py-2"
        style={{ borderColor: colors.border }}
      >
        <label className="text-[9px] min-w-[210px]" style={{ color: colors.textSecondary }}>
          MODEL
          <select
            value={draftModel}
            onChange={(event) => setDraftModel(event.target.value as DcfModel)}
            className="block w-full mt-1 bg-transparent border px-2 py-1 text-[10px]"
            style={{ borderColor: colors.border, color: colors.text }}
          >
            {MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
        <div>
          <div className="text-[9px] mb-1" style={{ color: colors.textSecondary }}>
            SCENARIO
          </div>
          <div className="flex gap-1">
            {(["bear", "base", "bull"] as DcfScenario[]).map((scenario) => (
              <button
                key={scenario}
                type="button"
                onClick={() => setDraftScenario(scenario)}
                className="px-2 py-1 text-[10px] border uppercase"
                style={{
                  borderColor: draftScenario === scenario ? colors.text : colors.border,
                  backgroundColor: draftScenario === scenario ? colors.text : "transparent",
                  color: draftScenario === scenario ? colors.bg : colors.textSecondary,
                }}
              >
                {scenario}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={isFetching}
          className="px-3 py-1 text-[10px] font-bold border flex items-center gap-1"
          style={{
            borderColor: colors.accent,
            backgroundColor: colors.accent,
            color: "#000",
            opacity: isFetching ? 0.65 : 1,
          }}
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} /> {runLabel}
        </button>
      </div>

      <div className="flex gap-1 flex-wrap mb-3">
        {SUB_TABS.map((tab) => (
          <TabButton
            key={tab.id}
            active={subTab === tab.id}
            label={tab.label}
            onClick={() => setSubTab(tab.id)}
            colors={colors}
          />
        ))}
      </div>

      {isLoading && (
        <div className="py-12 text-center text-xs font-mono" style={{ color: colors.textDimmed }}>
          Loading statements, market inputs and valuation model…
        </div>
      )}
      {error && (
        <div className="py-12 text-center text-xs font-mono" style={{ color: colors.negative }}>
          {error instanceof Error ? error.message : `DCF unavailable for ${symbol}`}
        </div>
      )}

      {data?.status === "ok" && (
        <>
          {subTab === "overview" && <Overview data={data} colors={colors} />}
          {subTab === "forecast" && <ForecastTable data={data} colors={colors} />}
          {subTab === "assumptions" && (
            <AssumptionsEditor
              data={data}
              draft={draftAssumptions}
              onChange={(key, value) =>
                setDraftAssumptions((current) => ({ ...current, [key]: value }))
              }
              colors={colors}
            />
          )}
          {subTab === "sensitivity" && <SensitivityTable data={data} colors={colors} />}
          {subTab === "audit" && <Audit data={data} colors={colors} />}
        </>
      )}
    </div>
  );
}
