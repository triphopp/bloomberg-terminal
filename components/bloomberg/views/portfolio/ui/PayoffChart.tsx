"use client";
import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type Colors, fmt, fmtK, pnlColor } from "../helpers";

// Two lines that mean different things, drawn together on purpose:
//
//   EXPIRY (solid)  — arithmetic. max(S−K,0) and a subtraction. No model, no
//                     volatility, no assumptions. Breakeven, max profit and max
//                     loss are all defined on this line.
//   TODAY  (dashed) — Black-Scholes at the current implied vol. A model, and
//                     the reason a position can be far from its expiry payoff
//                     while there is still time on the clock.
//
// POP rests on more assumptions still, so it is labelled rather than featured.

export interface PayoffPoint {
  s: number;
  expiry: number;
  t0: number | null;
}

export interface PayoffResult {
  spot: number;
  currency?: string;
  range: { min: number; max: number };
  curve: PayoffPoint[];
  breakevens: { price: number; move_pct: number }[];
  max_profit: { value: number | null; unbounded: boolean; at: number | null; note?: string };
  max_loss: { value: number | null; unbounded: boolean; at: number | null; note?: string };
  current: { pnl_if_expired_now: number; pnl_today: number | null };
  pop: number | null;
  dte_days: number;
  iv_used: number | null;
  legs_missing_iv: number[];
  model_note?: string;
  error?: string;
}

const money = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v >= 0 ? "+" : "-"}$${fmtK(Math.abs(v))}`;

export function PayoffChart({
  data,
  colors,
  height = 220,
  compact = false,
}: { data: PayoffResult | null; colors: Colors; height?: number; compact?: boolean }) {
  if (!data || data.error || data.curve.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-[10px]"
        style={{ height, color: colors.textSecondary }}
      >
        {data?.error ?? "Fill in underlying, expiry, strike and premium to see the payoff"}
      </div>
    );
  }

  const hasT0 = data.curve.some((p) => p.t0 !== null);
  // Split the expiry line at zero so profit and loss shade differently — the
  // shape of a payoff is easier to read as two regions than as one line.
  const rows = data.curve.map((p) => ({
    ...p,
    gain: p.expiry >= 0 ? p.expiry : 0,
    loss: p.expiry < 0 ? p.expiry : 0,
  }));

  const stat = (label: string, value: string, color: string, title?: string) => (
    <div key={label} title={title}>
      <div className="text-[8px]" style={{ color: colors.textSecondary }}>
        {label}
      </div>
      <div className="font-bold text-[10px]" style={{ color }}>
        {value}
      </div>
    </div>
  );

  return (
    <div>
      <div
        className={`grid gap-2 mb-2 font-mono ${compact ? "grid-cols-3" : "grid-cols-3 md:grid-cols-6"}`}
      >
        {stat(
          "BREAKEVEN",
          data.breakevens.length === 0
            ? "none"
            : data.breakevens.map((b) => fmt(b.price, 2)).join(" / "),
          colors.accent,
          data.breakevens.length === 0
            ? "This position never crosses zero at expiry — it is a guaranteed profit or a guaranteed loss over every price."
            : `Underlying must move ${data.breakevens
                .map((b) => `${b.move_pct >= 0 ? "+" : ""}${fmt(b.move_pct, 1)}%`)
                .join(" or ")} to break even at expiry. Fees are included.`
        )}
        {stat(
          "TO BE",
          data.breakevens.length === 0
            ? "—"
            : data.breakevens
                .map((b) => `${b.move_pct >= 0 ? "+" : ""}${fmt(b.move_pct, 1)}%`)
                .join(" / "),
          colors.text,
          "Move in the underlying needed to reach breakeven"
        )}
        {stat(
          "MAX PROFIT",
          data.max_profit.unbounded ? "unlimited" : money(data.max_profit.value),
          data.max_profit.unbounded ? "#4ade80" : pnlColor(data.max_profit.value ?? 0),
          data.max_profit.note ?? "Best case at expiry"
        )}
        {stat(
          "MAX LOSS",
          data.max_loss.unbounded ? "UNLIMITED" : money(data.max_loss.value),
          data.max_loss.unbounded ? "#FF4444" : pnlColor(data.max_loss.value ?? 0),
          data.max_loss.note ?? "Worst case at expiry"
        )}
        {!compact &&
          stat(
            "POP",
            data.pop === null ? "—" : `${fmt(data.pop * 100, 1)}%`,
            colors.textSecondary,
            "Probability of finishing profitable, under a lognormal terminal price at today's " +
              "implied vol with a risk-neutral drift. A rough ordering device, not odds — and " +
              "note it FALLS as vol rises for an out-of-the-money option, because the median " +
              "outcome drops even as the tails widen."
          )}
        {!compact &&
          stat(
            "DTE",
            `${data.dte_days}d`,
            colors.textSecondary,
            data.iv_used ? `IV used: ${fmt(data.iv_used * 100, 1)}%` : "No implied vol available"
          )}
      </div>

      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="s"
              type="number"
              domain={["dataMin", "dataMax"]}
              tick={{ fontSize: 8, fill: colors.textSecondary }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => fmt(v, 0)}
            />
            <YAxis
              tick={{ fontSize: 8, fill: colors.textSecondary }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => fmtK(v)}
            />
            <Tooltip
              contentStyle={{
                background: "#0a0a0a",
                border: `1px solid ${colors.border}`,
                fontSize: 10,
              }}
              labelStyle={{ color: colors.textSecondary, fontSize: 9 }}
              itemStyle={{ fontSize: 9 }}
              labelFormatter={(v) => `underlying ${fmt(Number(v), 2)}`}
              // biome-ignore lint/suspicious/noExplicitAny: recharts formatter
              formatter={(v: any, name: any) =>
                name === "gain" || name === "loss" ? [null, null] : [money(Number(v)), name]
              }
            />
            <Area
              dataKey="gain"
              stroke="none"
              fill="#4ade80"
              fillOpacity={0.13}
              isAnimationActive={false}
            />
            <Area
              dataKey="loss"
              stroke="none"
              fill="#FF4444"
              fillOpacity={0.13}
              isAnimationActive={false}
            />
            <ReferenceLine y={0} stroke={colors.textSecondary} strokeWidth={1} />
            <ReferenceLine
              x={data.spot}
              stroke="#facc15"
              strokeDasharray="3 3"
              label={{ value: "spot", fontSize: 8, fill: "#facc15", position: "insideTopRight" }}
            />
            {data.breakevens.map((b) => (
              <ReferenceLine
                key={b.price}
                x={b.price}
                stroke={colors.accent}
                strokeDasharray="2 4"
                label={{
                  value: `BE ${fmt(b.price, 2)}`,
                  fontSize: 8,
                  fill: colors.accent,
                  position: "insideBottomLeft",
                }}
              />
            ))}
            <Line
              dataKey="expiry"
              name="at expiry"
              stroke={colors.text}
              strokeWidth={1.6}
              dot={false}
              isAnimationActive={false}
            />
            {hasT0 && (
              <Line
                dataKey="t0"
                name="today"
                stroke="#38bdf8"
                strokeWidth={1.3}
                strokeDasharray="4 3"
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap items-center gap-3 mt-1 text-[8px]">
        <span style={{ color: colors.text }}>
          ▬ at expiry <span style={{ color: colors.textSecondary }}>(arithmetic)</span>
        </span>
        {hasT0 ? (
          <span style={{ color: "#38bdf8" }}>
            ▬ ▬ today{" "}
            <span style={{ color: colors.textSecondary }}>(Black-Scholes at live IV)</span>
          </span>
        ) : (
          <span style={{ color: "#f59e0b" }}>
            no implied vol for {data.legs_missing_iv.length > 1 ? "some legs" : "this contract"} —
            the "today" line and POP need one, so only the expiry payoff is shown
          </span>
        )}
        <span style={{ color: colors.textSecondary }}>
          P&amp;L in {data.currency ?? "USD"}, fees included
        </span>
      </div>
    </div>
  );
}
