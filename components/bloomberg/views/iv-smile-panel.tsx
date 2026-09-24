"use client";

import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { useIvSmile } from "../hooks/useIvSmile";
import {
  SMILE_TENOR_MONTHS,
  type SmileFitMode,
  type SmileSide,
  buildIvSmileOi,
  expiryDays,
  smilePlotRows,
  smileWingMetrics,
} from "../lib/iv-smile";
import type { bloombergColors } from "../lib/theme-config";

export interface IvSmilePanelProps {
  model: ReturnType<typeof useIvSmile>;
  colors: typeof bloombergColors.dark;
  compact?: boolean;
}

const TENOR_COLORS = ["#4CC9F0", "#FFB347", "#DC88EF", "#62D9A2", "#929BFF"];
const tenorColor = (months: number[], index: number) =>
  TENOR_COLORS[
    months.length
      ? SMILE_TENOR_MONTHS.findIndex((m) => m === months[0])
      : index % TENOR_COLORS.length
  ] ?? TENOR_COLORS[0];

export function IvSmilePanel({ model, colors, compact = false }: IvSmilePanelProps) {
  const {
    symbol,
    expiry,
    loading,
    error,
    noOptions,
    rangePercent,
    quotedOnly,
    fitMode,
    compare,
    side,
  } = model;
  const fitted = fitMode === "raw_svi";
  const oiSlice = model.slices.find((slice) => slice.expiry === model.oiExpiry);
  const oi = model.showOi && oiSlice?.data ? buildIvSmileOi(oiSlice.data, rangePercent) : null;
  const oiVisible = model.showOi && !!oi?.available;
  const contracts = (value: number | null | undefined) =>
    value == null
      ? "—"
      : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
          value
        );
  const curves = model.slices.flatMap((slice, index) =>
    slice.samples.map((sample) => ({
      ...sample,
      id: `e${index}_${sample.name}`,
      label: `${compare ? `${slice.expiry} ` : ""}${sample.name.toUpperCase()}`,
      color: compare
        ? tenorColor(slice.months, index)
        : sample.name === "put"
          ? TENOR_COLORS[1]
          : TENOR_COLORS[0],
      fit: slice.fit?.series[sample.name],
    }))
  );
  const plotRows = useMemo(
    () => smilePlotRows(curves, fitted, oi?.points),
    [curves, fitted, oi?.points]
  );
  const wingMetrics = model.slices.map((slice) => ({
    expiry: slice.expiry,
    months: slice.months,
    values: smileWingMetrics(slice.prepared?.points ?? [], slice.data?.spot ?? 0, slice.timeYears),
  }));
  const formatPp = (value: number | null) =>
    value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}pp`;
  const distinctStrikes = new Set(curves.flatMap((c) => c.points.map((p) => p.strike))).size;
  const fontSize = compact ? 8 : 11;
  const muted = { color: colors.textSecondary };
  const control = { background: "#101010", color: colors.text, borderColor: colors.border };
  const expirations = model.expirations.filter((value) => expiryDays(value) >= 0);
  const firstData = model.slices.find((s) => s.data)?.data;
  const message = !symbol
    ? "Select a symbol on the MKT chart."
    : loading
      ? `Loading ${symbol} options…`
      : noOptions
        ? `Yahoo Finance has no options chain for ${symbol}.`
        : error && !firstData
          ? `Could not load ${symbol} IV. ${error.message}`
          : distinctStrikes < 3 && !oiVisible
            ? model.slices.some((s) => s.loading)
              ? "Loading selected expiries…"
              : "Insufficient IV points. Try another expiry, side or strike range."
            : null;
  const spot =
    firstData && Number.isFinite(firstData.spot) && firstData.spot > 0 ? firstData.spot : null;
  const spotVisible =
    spot != null &&
    spot >= (plotRows[0]?.strike ?? Number.POSITIVE_INFINITY) &&
    spot <= (plotRows.at(-1)?.strike ?? Number.NEGATIVE_INFINITY);
  return (
    <div
      className="h-full flex flex-col overflow-hidden font-mono"
      style={{ fontSize, background: "#000" }}
    >
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 shrink-0 border-b"
        style={{ borderColor: colors.border }}
      >
        <span className="font-bold" style={{ color: "#FF9800" }}>
          {symbol ?? "IV SMILE"}
        </span>
        <button
          type="button"
          aria-label="Compare IV smile expiries"
          aria-pressed={compare}
          title="Compare actual expiries nearest the selected calendar months"
          className="border px-1 py-0.5"
          style={control}
          onClick={() => model.setCompare(!compare)}
        >
          {compare ? "MULTI" : "1 EXP"}
        </button>
        {!compare && (
          <label className="flex items-center gap-1" style={muted}>
            EXP
            <select
              aria-label="IV smile expiry"
              className="border px-1 py-0.5 min-w-0"
              style={control}
              value={expiry ?? ""}
              disabled={!expirations.length}
              onChange={(e) => model.selectExpiry(e.target.value)}
            >
              {!expirations.length && <option value="">—</option>}
              {expirations.map((value) => (
                <option key={value} value={value}>
                  {value} · {expiryDays(value)}D
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          aria-label="Refresh IV smile"
          className="ml-auto hover:opacity-70 disabled:opacity-40"
          style={muted}
          disabled={!symbol || model.fetching}
          onClick={() => model.refresh()}
        >
          ↻
        </button>
      </div>
      {compare && (
        <div className="flex flex-wrap items-center gap-1 px-2 py-1 shrink-0" style={muted}>
          <span>NEAR</span>
          {SMILE_TENOR_MONTHS.map((month, index) => (
            <button
              type="button"
              key={month}
              aria-label={`IV tenor ${month} months`}
              aria-pressed={model.months.includes(month)}
              className="border px-1.5 py-0.5"
              onClick={() => model.toggleMonth(month)}
              style={{
                ...control,
                color: model.months.includes(month) ? TENOR_COLORS[index] : colors.textSecondary,
                borderColor: model.months.includes(month) ? TENOR_COLORS[index] : colors.border,
              }}
            >
              {month}M
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 shrink-0" style={muted}>
        <label className="flex items-center gap-1">
          FIT
          <select
            aria-label="IV smile fit model"
            value={fitMode}
            onChange={(e) => model.setFitMode(e.target.value as SmileFitMode)}
            className="border px-1 py-0.5"
            style={control}
          >
            <option value="observed">OFF · Observed</option>
            <option value="raw_svi">Raw SVI</option>
          </select>
        </label>
        <select
          aria-label="IV smile side"
          value={side}
          onChange={(e) => model.setSide(e.target.value as SmileSide)}
          title="OTM uses puts below spot and calls at/above spot; no ITM substitution."
          className="border px-1 py-0.5"
          style={control}
        >
          <option value="both">Call + Put</option>
          <option value="otm">OTM smile</option>
          <option value="call">Call</option>
          <option value="put">Put</option>
        </select>
        {fitted && (
          <button
            type="button"
            aria-label="Show observed IV points"
            aria-pressed={model.showPoints}
            className="border px-1 py-0.5"
            style={control}
            onClick={() => model.setShowPoints(!model.showPoints)}
          >
            {model.showPoints ? "● POINTS" : "POINTS OFF"}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 shrink-0" style={muted}>
        <span title={compare ? "Color = expiry; solid = Call, dashed = Put" : undefined}>
          {side === "both" ? "— CALL · ┄ PUT" : side.toUpperCase()}
        </span>
        <select
          aria-label="IV smile strike range"
          value={rangePercent}
          onChange={(e) => model.setRangePercent(Number(e.target.value))}
          className="border px-1 py-0.5"
          style={control}
        >
          <option value={25}>K ±25%</option>
          <option value={50}>K ±50%</option>
          <option value={0}>ALL K</option>
        </select>
        <button
          type="button"
          aria-pressed={quotedOnly}
          title="Quoted: finite IV, positive bid and ask ≥ bid. All IV includes unquoted contracts."
          className="border px-1 py-0.5"
          style={control}
          onClick={() => model.setQuotedOnly(!quotedOnly)}
        >
          {quotedOnly ? "QUOTED" : "ALL IV"}
        </button>
        <button
          type="button"
          aria-label="Show open interest"
          aria-pressed={model.showOi}
          title="Latest reported Call/Put open interest by strike. Independent of IV and quote filters."
          className="border px-1 py-0.5"
          style={{ ...control, color: model.showOi ? "#FFB347" : colors.textSecondary }}
          onClick={() => model.setShowOi(!model.showOi)}
        >
          OI {model.showOi ? "ON" : "OFF"}
        </button>
        {fitted && (
          <span title="Root mean square IV error in percentage points; fit minimizes robust total-variance residuals.">
            RMSE (pp)
          </span>
        )}
      </div>
      {model.showOi && (
        <div
          className="px-2 pb-1 shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1"
          style={muted}
        >
          <span title="Stacked bars: contracts on the right axis; one expiry. OI does not imply buying/selling direction.">
            OI · {compare ? "" : (model.oiExpiry ?? "—")}
          </span>
          {compare && (
            <select
              aria-label="Open interest expiry"
              className="border px-1 py-0.5"
              style={control}
              value={model.oiExpiry ?? ""}
              disabled={!model.slices.some((s) => s.expiry)}
              onChange={(e) => model.selectOiExpiry(e.target.value)}
            >
              {!model.slices.some((s) => s.expiry) && <option value="">—</option>}
              {model.slices
                .filter((s) => s.expiry)
                .map((s) => (
                  <option key={s.expiry} value={s.expiry ?? ""}>
                    {s.expiry} · {s.months.join("/")}M ≈
                  </option>
                ))}
            </select>
          )}
          {oiSlice?.loading || loading ? (
            <span>LOADING OI…</span>
          ) : oiSlice?.error ? (
            <span title={oiSlice.error.message}>OI LOAD ERROR</span>
          ) : !oi?.available ? (
            <span>OI UNAVAILABLE</span>
          ) : (
            <span
              title={`Reported OI in selected K range only; includes contracts without usable IV/bid/ask. Call ${oi.callTotal?.toLocaleString() ?? "unavailable"}; Put ${oi.putTotal?.toLocaleString() ?? "unavailable"}.${oi.missing ? ` ${oi.missing} contracts have unknown OI; sums are partial.` : ""}`}
            >
              <span style={{ color: TENOR_COLORS[0] }}>C {contracts(oi.callTotal)}</span>
              {" · "}
              <span style={{ color: TENOR_COLORS[1] }}>P {contracts(oi.putTotal)}</span>
              {" · "}P/C {oi.putCallRatio?.toFixed(2) ?? "—"}
              {oi.missing ? " · PARTIAL" : ""}
              {" · K range"}
            </span>
          )}
          {oiVisible && distinctStrikes < 3 && <span>Insufficient IV · OI available</span>}
        </div>
      )}
      {!loading && model.slices.length > 0 && (
        <div className="shrink-0 max-h-24 overflow-y-auto px-2 pb-1" style={muted}>
          {model.slices.map((slice, index) => {
            const details = slice.samples
              .map((s) => {
                const fit = slice.fit?.series[s.name];
                return fit?.status === "ok"
                  ? `${s.name.toUpperCase()} ${fit.rmseIvPct?.toFixed(2)}`
                  : `${s.name.toUpperCase()} N/A`;
              })
              .join(" · ");
            const status = !slice.expiry
              ? "No expiry within ±45D"
              : slice.loading
                ? "LOADING…"
                : slice.error
                  ? "CHAIN ERROR"
                  : fitted && slice.timeYears <= 0
                    ? "0DTE · OBSERVED ONLY"
                    : fitted && slice.data && !(slice.data.spot > 0)
                      ? "NO SPOT · OBSERVED ONLY"
                      : fitted && slice.fitLoading
                        ? "FITTING…"
                        : slice.fitError
                          ? "FIT ERROR"
                          : fitted && slice.fit
                            ? details
                            : slice.samples
                                .map(
                                  (s) =>
                                    `${s.points.length}${s.name === "otm" ? " OTM" : s.name[0].toUpperCase()}`
                                )
                                .join(" / ");
            const explanation =
              slice.error?.message ??
              slice.fitError?.message ??
              slice.samples
                .map((s) => {
                  const fit = slice.fit?.series[s.name];
                  return `${s.name}: ${fit?.reason ?? `${fit?.usedPoints ?? s.points.length} points`}`;
                })
                .join("; ");
            return (
              <div
                key={slice.expiry ?? slice.months.join("-")}
                className="flex items-center gap-1 leading-4"
                title={explanation}
              >
                {compare && (
                  <span style={{ color: tenorColor(slice.months, index) }}>
                    ● {slice.months.join("/")}M ≈
                  </span>
                )}
                <span>
                  {slice.expiry ?? "—"}
                  {slice.days != null ? ` · ${slice.days}D` : ""}
                </span>
                <span className="ml-auto text-right">{status}</span>
              </div>
            );
          })}
        </div>
      )}
      <div
        className="flex-1 min-h-0 px-1"
        role="img"
        aria-label={`IV smile for ${symbol ?? "selected symbol"}; ${compare ? "multiple expiries" : (expiry ?? "unavailable")}; ${fitted ? "Raw SVI fit" : "observed"}; K strike versus IV percent${oiVisible ? `; open interest contracts for ${model.oiExpiry} on right axis` : ""}`}
      >
        {message ? (
          <output
            className="h-full flex items-center justify-center text-center px-4"
            style={muted}
          >
            {message}
          </output>
        ) : (
          <ResponsiveContainer width="100%" height="100%" minHeight={50}>
            <ComposedChart
              data={plotRows}
              barSize={compact ? 3 : 5}
              margin={{ top: 20, right: 15, bottom: 18, left: 0 }}
            >
              <CartesianGrid stroke="#20252a" strokeDasharray="2 3" vertical={false} />
              <XAxis
                dataKey="strike"
                type="number"
                domain={
                  plotRows.length === 1 && plotRows[0].strike != null
                    ? [plotRows[0].strike - 1, plotRows[0].strike + 1]
                    : ["dataMin", "dataMax"]
                }
                tickCount={compact ? 4 : 7}
                tick={{ fontSize, fill: colors.textSecondary }}
                tickLine={false}
                axisLine={{ stroke: colors.border }}
                tickFormatter={(value: number) => Number(value.toFixed(2)).toLocaleString()}
                label={{
                  value: "K (strike)",
                  position: "bottom",
                  offset: 0,
                  fill: colors.textSecondary,
                  fontSize,
                }}
              />
              <YAxis
                yAxisId="iv"
                width={compact ? 36 : 48}
                tick={{ fontSize, fill: colors.textSecondary }}
                tickLine={false}
                axisLine={false}
                domain={["auto", "auto"]}
                tickCount={4}
                tickFormatter={(value: number) => `${Number(value.toFixed(1))}`}
                label={{
                  value: "IV (%)",
                  position: "insideTopLeft",
                  dy: -19,
                  fill: colors.textSecondary,
                  fontSize,
                }}
              />
              {oiVisible && (
                <YAxis
                  yAxisId="oi"
                  orientation="right"
                  width={compact ? 36 : 52}
                  domain={[0, "auto"]}
                  allowDecimals={false}
                  tickCount={4}
                  tick={{ fontSize, fill: colors.textSecondary }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={contracts}
                  label={{
                    value: "OI (ct)",
                    position: "insideTopRight",
                    dy: -19,
                    fill: colors.textSecondary,
                    fontSize,
                  }}
                />
              )}
              {spotVisible && (
                <ReferenceLine
                  yAxisId="iv"
                  x={spot ?? undefined}
                  stroke="#9BA8B3"
                  strokeDasharray="3 3"
                  label={{
                    value: "S",
                    position: "insideTopRight",
                    fill: colors.textSecondary,
                    fontSize,
                  }}
                />
              )}
              <Tooltip
                contentStyle={{ background: "#10151a", borderColor: colors.border, fontSize: 10 }}
                labelFormatter={(value) =>
                  `K = ${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                }
                formatter={(value: number, name: string, item) => [
                  item.dataKey === "callOI" || item.dataKey === "putOI"
                    ? `${value.toLocaleString()} contracts`
                    : `${value.toFixed(2)}%`,
                  name,
                ]}
              />
              {oiVisible &&
                ["callOI", "putOI"].map((key, index) => (
                  <Bar
                    key={key}
                    yAxisId="oi"
                    dataKey={key}
                    name={`${index === 0 ? "Call" : "Put"} OI · ${model.oiExpiry}`}
                    stackId="oi"
                    fill={TENOR_COLORS[index]}
                    fillOpacity={0.35}
                    shape={(props: unknown) => {
                      const { x, y, width, height } = props as {
                        x: number;
                        y: number;
                        width: number;
                        height: number;
                      };
                      if (![x, y, width, height].every(Number.isFinite) || height <= 0)
                        return <g />;
                      // Dense SVI sample spacing must not shrink real OI bars below a pixel.
                      const visibleWidth = compact ? 3 : 5;
                      return (
                        <rect
                          x={x + width / 2 - visibleWidth / 2}
                          y={y}
                          width={visibleWidth}
                          height={height}
                          fill={TENOR_COLORS[index]}
                          fillOpacity={0.4}
                        />
                      );
                    }}
                    isAnimationActive={false}
                  />
                ))}
              {curves.map((curve) =>
                fitted && curve.fit?.status === "ok" ? (
                  <Line
                    yAxisId="iv"
                    key={`${curve.id}_fit`}
                    name={`${curve.label} SVI`}
                    type="linear"
                    dataKey={`${curve.id}_fit`}
                    stroke={curve.color}
                    strokeWidth={1.8}
                    strokeDasharray={curve.name === "put" ? "4 3" : undefined}
                    dot={false}
                    activeDot={{ r: 3 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ) : null
              )}
              {curves.map((curve) =>
                !fitted || model.showPoints || curve.fit?.status !== "ok" ? (
                  <Line
                    yAxisId="iv"
                    key={`${curve.id}_observed`}
                    name={`${curve.label} observed`}
                    type="linear"
                    dataKey={`${curve.id}_observed`}
                    stroke={curve.color}
                    strokeOpacity={fitted ? 0 : 1}
                    strokeWidth={1}
                    strokeDasharray={curve.name === "put" ? "4 3" : undefined}
                    dot={{
                      r: compact ? 1.3 : 2,
                      fill: curve.color,
                      stroke: curve.color,
                      opacity: fitted ? 0.5 : 1,
                    }}
                    activeDot={{ r: 3, fill: curve.color }}
                    connectNulls
                    isAnimationActive={false}
                  />
                ) : null
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
      <div
        className="shrink-0 max-h-24 overflow-y-auto border-t px-2 py-1 leading-4"
        style={{ ...muted, borderColor: colors.border }}
        title="Observed, filtered quotes. 25Δ uses Black-Scholes spot delta with zero carry and linear interpolation between OTM strikes; no extrapolation. SKEW = C25Δ − P25Δ. CURV = (C25Δ + P25Δ)/2 − ATM IV. Values are IV percentage points; — means the required quotes are unavailable."
      >
        {wingMetrics.map((row, index) => (
          <div key={row.expiry ?? row.months.join("-")} className="flex flex-wrap gap-x-2">
            {compare && (
              <span style={{ color: tenorColor(row.months, index) }}>{row.expiry ?? "—"}</span>
            )}
            <span>OBS</span>
            <span>
              SKEW 25Δ <strong style={{ color: colors.text }}>{formatPp(row.values.skew)}</strong>
            </span>
            <span>
              CURV 25Δ{" "}
              <strong style={{ color: colors.text }}>{formatPp(row.values.curvature)}</strong>
            </span>
          </div>
        ))}
        {!wingMetrics.length && <span>OBS · SKEW 25Δ — · CURV 25Δ —</span>}
      </div>
      {fitted && (
        <details
          className="shrink-0 px-2 py-1 border-t"
          style={{ ...muted, borderColor: colors.border }}
        >
          <summary className="cursor-pointer">SVI DETAILS · independent expiry fits</summary>
          <div className="max-h-24 overflow-y-auto leading-4">
            <div>Robust total variance fit · k=ln(K/S) · ACT/365 days · no wing extrapolation.</div>
            <div>Positive variance constrained; not an arbitrage-free surface.</div>
            {curves.map((curve) => (
              <div key={curve.id} style={{ color: curve.color }}>
                {curve.label}:{" "}
                {curve.fit?.parameters
                  ? Object.entries(curve.fit.parameters)
                      .map(([k, v]) => `${k}=${v.toPrecision(4)}`)
                      .join(" ")
                  : (curve.fit?.reason ?? "Fit pending/unavailable; observed points shown.")}
              </div>
            ))}
          </div>
        </details>
      )}
      <div
        className="px-2 py-1 shrink-0 border-t flex flex-wrap gap-x-2"
        style={{ ...muted, borderColor: colors.border }}
      >
        <span
          title={
            firstData?.freshness?.fetched_at
              ? `Fetched ${firstData.freshness.fetched_at}; provider quote delay is approximate.`
              : undefined
          }
        >
          YF ·{" "}
          {firstData?.freshness?.is_realtime
            ? "REALTIME"
            : firstData?.freshness?.delay_minutes
              ? `~${firstData.freshness.delay_minutes}m DELAY`
              : "DELAYED"}
        </span>
        {spot != null && (
          <span>S {spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
        )}
        {model.showOi && (
          <span title="Latest reported chain OI, generally updated after clearing. The fetch timestamp is not the OI observation date; no daily OI history is stored.">
            OI · latest reported
          </span>
        )}
      </div>
    </div>
  );
}
