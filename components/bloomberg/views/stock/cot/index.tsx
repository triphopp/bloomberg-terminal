"use client";

/**
 * stock-view → COT: who holds the futures behind this symbol.
 *
 * Shown only for symbols that map to a CFTC contract (ES=F / ^GSPC / SPY → E-mini
 * S&P, ^VIX, JPY=X, BTC-USD, CL=F, GC=F, ^TNX …; see COT_KEY_BY_SYMBOL). An
 * ETF or index maps to the futures that trade against it — the positions are
 * the futures', not the ETF's holders'.
 *
 * Net per trader group on one chart, positioning stats in a table. Weekly,
 * as of Tuesday, released Friday 15:30 ET — in the header.
 */

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  COT_GROUP_LABEL,
  type CotGroup,
  cotExtreme,
  cotKeyFor,
  fmtContracts,
  useCotHistory,
  useCotSnapshot,
} from "../../../hooks/useCot";
import type { bloombergColors } from "../../../lib/theme-config";

const GROUP_COLOR: Record<CotGroup, string> = {
  dealer: "#A3A3A3",
  am: "#60A5FA",
  lev: "#FF6B6B",
  other: "#C084FC",
  nonrept: "#666666",
  prod: "#A3A3A3",
  swap: "#60A5FA",
  mm: "#FF6B6B",
};

const RANGES = { "1Y": 52, "3Y": 156, "5Y": 260, "10Y": 520 } as const;
type RangeKey = keyof typeof RANGES;

export function CotTab({
  symbol,
  colors,
}: {
  symbol: string;
  colors: typeof bloombergColors.dark;
}) {
  const key = cotKeyFor(symbol);
  const [range, setRange] = useState<RangeKey>("3Y");
  const [mode, setMode] = useState<"net" | "netoi">("netoi");
  const hist = useCotHistory(key, RANGES[range]);
  const snap = useCotSnapshot(!!key);
  const contract = snap.data?.contracts.find((c) => c.key === key);
  const flags = (snap.data?.flags ?? []).filter((f) => f.contract === key);

  const groups = useMemo(
    () => Object.keys(contract?.groups ?? {}).filter((g) => g !== "nonrept") as CotGroup[],
    [contract]
  );
  const rows = useMemo(
    () =>
      (hist.data?.rows ?? []).map((r) => {
        const o: Record<string, number | string> = { date: r.date };
        for (const g of groups) {
          const v = r.groups[g];
          if (v) o[g] = mode === "net" ? v.net : (100 * v.net) / r.oi;
        }
        return o;
      }),
    [hist.data, groups, mode]
  );

  if (!key) {
    return (
      <div className="p-4 font-mono" style={{ color: colors.textSecondary, fontSize: 11 }}>
        {symbol} ไม่มีสัญญา futures ใน CFTC COT ที่ map ไว้
      </div>
    );
  }

  const box = { border: `1px solid ${colors.border}` };
  const label = { color: colors.textSecondary, fontSize: 10, letterSpacing: "0.12em" };

  return (
    <div className="flex flex-col gap-2 font-mono">
      <div className="flex items-baseline gap-3 flex-wrap">
        <span style={{ color: colors.accent, fontSize: 12, fontWeight: "bold" }}>
          {contract?.label ?? key} FUTURES · CFTC{" "}
          {contract?.dataset === "DIS" ? "DISAGGREGATED" : "TFF"}
        </span>
        {contract && (
          <span style={{ color: colors.textSecondary, fontSize: 10 }}>
            as of Tue {contract.as_of} · released Fri {contract.released} · OI{" "}
            {fmtContracts(contract.oi)} (Δ {fmtContracts(contract.d_oi)})
          </span>
        )}
        <span className="ml-auto flex gap-2">
          {(Object.keys(RANGES) as RangeKey[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              style={{ color: range === r ? colors.accent : colors.textSecondary, fontSize: 10 }}
            >
              {r}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setMode((m) => (m === "net" ? "netoi" : "net"))}
            style={{ color: colors.accent, fontSize: 10 }}
            title="สลับ net เป็นจำนวนสัญญา กับ net เป็น % ของ open interest"
          >
            {mode === "net" ? "CONTRACTS" : "% OF OI"}
          </button>
        </span>
      </div>

      {flags.length > 0 && (
        <div className="flex flex-col gap-0.5 p-2" style={box}>
          {flags.map((f) => (
            <span key={f.id} style={{ color: "#FFCC44", fontSize: 10.5 }} title={f.why}>
              {f.label} — {COT_GROUP_LABEL[f.group]} z {f.z >= 0 ? "+" : ""}
              {f.z.toFixed(1)} · p{Math.round(f.pct)}
              <span style={{ color: colors.textSecondary }}> · {f.why}</span>
            </span>
          ))}
        </div>
      )}

      <div className="p-2" style={box}>
        <span style={label}>
          NET POSITION BY TRADER GROUP ({mode === "net" ? "contracts" : "% OI"})
        </span>
        {hist.isLoading ? (
          <div style={{ color: colors.textSecondary, fontSize: 10, padding: 8 }}>loading…</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#141414" />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#666" }} minTickGap={50} />
              <YAxis
                tick={{ fontSize: 9, fill: "#666" }}
                width={48}
                tickFormatter={(v) => (mode === "net" ? fmtContracts(v) : `${v}%`)}
              />
              <ReferenceLine y={0} stroke="#333" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#0a0a0a",
                  border: "1px solid #2a2a2a",
                  fontSize: 10,
                }}
                formatter={(v: number, name: string) => [
                  mode === "net" ? fmtContracts(v) : `${v.toFixed(1)}%`,
                  COT_GROUP_LABEL[name as CotGroup] ?? name,
                ]}
              />
              {groups.map((g) => (
                <Line
                  key={g}
                  dataKey={g}
                  stroke={GROUP_COLOR[g]}
                  dot={false}
                  strokeWidth={g === contract?.focus ? 1.8 : 1.1}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
        <div className="flex gap-3 flex-wrap" style={{ fontSize: 9.5 }}>
          {groups.map((g) => (
            <span key={g} style={{ color: GROUP_COLOR[g] }}>
              ■ {COT_GROUP_LABEL[g]}
            </span>
          ))}
        </div>
      </div>

      {contract && (
        <div className="p-2" style={box}>
          <div
            className="grid gap-x-4 gap-y-0.5 items-baseline"
            style={{ gridTemplateColumns: "minmax(90px,1fr) repeat(7, auto)", fontSize: 10.5 }}
          >
            {["GROUP", "LONG", "SHORT", "NET", "% OI", "Δ 1W", "z 3Y", "pct 3Y"].map((h, i) => (
              <span
                key={h}
                style={{
                  color: colors.textSecondary,
                  fontSize: 9,
                  textAlign: i ? "right" : "left",
                }}
              >
                {h}
              </span>
            ))}
            {(Object.keys(contract.groups) as CotGroup[]).map((g) => {
              const s = contract.groups[g];
              if (!s) return null;
              const ex = cotExtreme(s);
              const hi = ex === "short" ? "#FF5252" : ex === "long" ? "#4CAF50" : colors.text;
              return (
                <div key={g} className="contents tabular-nums">
                  <span style={{ color: GROUP_COLOR[g] }}>
                    {COT_GROUP_LABEL[g]}
                    {s.traders_long != null && (
                      <span style={{ color: colors.textSecondary, fontSize: 9 }}>
                        {" "}
                        ({s.traders_long ?? "—"}/{s.traders_short ?? "—"})
                      </span>
                    )}
                  </span>
                  <span style={{ textAlign: "right", color: colors.text }}>
                    {fmtContracts(s.long).replace("+", "")}
                  </span>
                  <span style={{ textAlign: "right", color: colors.text }}>
                    {fmtContracts(s.short).replace("+", "")}
                  </span>
                  <span style={{ textAlign: "right", color: colors.text }}>
                    {fmtContracts(s.net)}
                  </span>
                  <span style={{ textAlign: "right", color: colors.text }}>
                    {s.net_oi.toFixed(1)}%
                  </span>
                  <span style={{ textAlign: "right", color: colors.textSecondary }}>
                    {fmtContracts(s.d_net)}
                  </span>
                  <span style={{ textAlign: "right", color: hi }}>
                    {s.z == null ? "—" : s.z.toFixed(2)}
                  </span>
                  <span style={{ textAlign: "right", color: hi }}>
                    {s.pct == null ? "—" : Math.round(s.pct)}
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ color: colors.textSecondary, fontSize: 9, marginTop: 4, lineHeight: 1.5 }}>
            (traders L/S) = จำนวนผู้ถือ · top-4 gross L/S {contract.conc4_long ?? "—"}% /{" "}
            {contract.conc4_short ?? "—"}% · top-8 {contract.conc8_long ?? "—"}% /{" "}
            {contract.conc8_short ?? "—"}% of OI. z/pct คิดบน net/OI เทียบ 3 ปี; pct ต่ำ = net short
            มากสุดในช่วง. ข้อมูลเป็นของ futures ที่ map กับ {symbol} ไม่ใช่ผู้ถือ {symbol} เอง.
          </div>
        </div>
      )}
    </div>
  );
}
