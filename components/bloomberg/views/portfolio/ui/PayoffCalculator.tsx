"use client";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Colors } from "../helpers";
import { fmtAmt, fmtPx, pnlColor } from "../helpers";
import { PayoffChart } from "./PayoffChart";
import { type PayoffLeg, usePayoff } from "./usePayoff";

// PAYOFF CALCULATOR — type in an option (or a few legs) and see its payoff
// before trading it. Nothing is booked; fills are still entered in
// PORTFOLIO → ENTRY. The expiry curve is drawn locally on every keystroke;
// the T+0 line and POP arrive from `/api/options/payoff` when the contract
// is quoted on the chain.

interface LegInput {
  id: string;
  side: "BUY" | "SELL";
  option_type: "call" | "put";
  strike: string;
  expiry: string;
  premium: string;
  contracts: string;
  multiplier: string;
}

interface CalcState {
  underlying: string;
  spot: string;
  legs: LegInput[];
}

const STORAGE_KEY = "bloomberg_payoff_calc";

const newLeg = (from?: LegInput): LegInput => ({
  id: `l${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
  side: "BUY",
  option_type: from?.option_type ?? "call",
  strike: "",
  expiry: from?.expiry ?? "",
  premium: "",
  contracts: from?.contracts ?? "1",
  multiplier: from?.multiplier ?? "100",
});

const DEFAULT_STATE: CalcState = { underlying: "", spot: "", legs: [newLeg()] };

const num = (v: string) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export function PayoffCalculator({ colors }: { colors: Colors }) {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return localStorage.getItem(`${STORAGE_KEY}_open`) !== "0";
    } catch {
      return true;
    }
  });
  const [st, setSt] = useState<CalcState>(() => {
    if (typeof window === "undefined") return DEFAULT_STATE;
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s) {
        const parsed = JSON.parse(s) as CalcState;
        if (Array.isArray(parsed.legs) && parsed.legs.length) return parsed;
      }
    } catch {
      /* ignore */
    }
    return DEFAULT_STATE;
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
    } catch {
      /* ignore */
    }
  }, [st]);
  useEffect(() => {
    try {
      localStorage.setItem(`${STORAGE_KEY}_open`, open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [open]);

  const underlying = st.underlying.trim().toUpperCase();
  const setLeg = (id: string, patch: Partial<LegInput>) =>
    setSt((s) => ({ ...s, legs: s.legs.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));

  // Only complete legs are priced; a half-typed row is skipped, not zeroed.
  const legs: PayoffLeg[] = useMemo(
    () =>
      underlying
        ? st.legs.flatMap((l) => {
            const strike = num(l.strike);
            const premium = num(l.premium);
            const contracts = num(l.contracts);
            const mult = num(l.multiplier) ?? 100;
            if (!strike || strike <= 0 || premium === null || premium < 0) return [];
            if (!contracts || contracts <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(l.expiry)) return [];
            return [
              {
                underlying,
                expiry: l.expiry,
                strike,
                option_type: l.option_type,
                quantity: l.side === "BUY" ? contracts : -contracts, // signed
                entry_price: premium,
                multiplier: mult > 0 ? mult : 100,
                fees: 0,
              },
            ];
          })
        : [],
    [underlying, st.legs]
  );

  const spotOverride = num(st.spot);
  const { payoff, loading, spot, error, retry } = usePayoff(legs.length ? legs : null, {
    spot: spotOverride && spotOverride > 0 ? spotOverride : null,
  });

  // Premium paid (−) or received (+) to open the whole set.
  const netPremium = legs.reduce((a, l) => a - l.quantity * l.entry_price * l.multiplier, 0);

  const iField = "text-[10px] font-mono px-1.5 py-0.5 border outline-none w-full";
  const iStyle = { background: "#0a0a0a", color: colors.text, borderColor: colors.border };
  const head = (h: string) => (
    <th key={h} className="text-left py-0.5 pr-1 font-normal" style={{ color: colors.textSecondary }}>
      {h}
    </th>
  );

  return (
    <div className="border rounded mb-2" style={{ borderColor: colors.border }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1 px-2 py-1 text-[10px] font-bold"
        style={{ color: colors.accent }}
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        PAYOFF CALCULATOR
        <span className="font-normal text-[9px]" style={{ color: colors.textSecondary }}>
          · กรอกข้อมูล option แล้วดู payoff ก่อนเทรด — ไม่บันทึกเป็นเทรด
        </span>
      </button>

      {open && (
        <div className="grid gap-3 px-2 pb-2 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* Inputs */}
          <div className="min-w-0">
            <div className="flex items-end gap-2 mb-2">
              <label className="text-[8px]" style={{ color: colors.textSecondary }}>
                UNDERLYING *
                <input
                  className={`${iField} uppercase font-bold`}
                  style={iStyle}
                  placeholder="AAPL"
                  value={st.underlying}
                  onChange={(e) => setSt((s) => ({ ...s, underlying: e.target.value.toUpperCase() }))}
                />
              </label>
              <label
                className="text-[8px]"
                style={{ color: colors.textSecondary }}
                title="Leave blank to use the live price. Type one to see the payoff around a price of your own."
              >
                SPOT (ว่าง = ราคาล่าสุด)
                <input
                  className={iField}
                  style={iStyle}
                  type="number"
                  step="any"
                  placeholder={spot ? fmtPx(spot) : "auto"}
                  value={st.spot}
                  onChange={(e) => setSt((s) => ({ ...s, spot: e.target.value }))}
                />
              </label>
              <button
                type="button"
                onClick={() => setSt(DEFAULT_STATE)}
                className="px-2 py-0.5 text-[8px] font-bold border rounded shrink-0"
                style={{ borderColor: colors.border, color: colors.textSecondary }}
              >
                CLEAR
              </button>
            </div>

            <div className="overflow-x-auto">
            <table className="w-full text-[9px] font-mono">
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {["SIDE", "TYPE", "STRIKE *", "EXPIRY *", "PREMIUM *", "CONTRACTS", "MULT", ""].map(head)}
                </tr>
              </thead>
              <tbody>
                {st.legs.map((l) => (
                  <tr key={l.id}>
                    <td className="py-0.5 pr-1">
                      <select
                        className={`${iField} min-w-[3.9rem]`}
                        style={{ ...iStyle, color: l.side === "BUY" ? "#4ade80" : "#FF4444" }}
                        value={l.side}
                        onChange={(e) => setLeg(l.id, { side: e.target.value as LegInput["side"] })}
                      >
                        <option value="BUY">BUY</option>
                        <option value="SELL">SELL</option>
                      </select>
                    </td>
                    <td className="py-0.5 pr-1">
                      <select
                        className={`${iField} min-w-[3.9rem]`}
                        style={iStyle}
                        value={l.option_type}
                        onChange={(e) =>
                          setLeg(l.id, { option_type: e.target.value as LegInput["option_type"] })
                        }
                      >
                        <option value="call">CALL</option>
                        <option value="put">PUT</option>
                      </select>
                    </td>
                    <td className="py-0.5 pr-1">
                      <input
                        className={`${iField} min-w-[3.8rem]`}
                        style={iStyle}
                        type="number"
                        step="any"
                        placeholder="150"
                        value={l.strike}
                        onChange={(e) => setLeg(l.id, { strike: e.target.value })}
                      />
                    </td>
                    <td className="py-0.5 pr-1">
                      <input
                        className={`${iField} min-w-[6.8rem]`}
                        style={iStyle}
                        type="date"
                        min="2000-01-01"
                        value={l.expiry}
                        onChange={(e) => setLeg(l.id, { expiry: e.target.value })}
                      />
                    </td>
                    <td className="py-0.5 pr-1">
                      <input
                        className={`${iField} min-w-[3.8rem]`}
                        style={iStyle}
                        type="number"
                        step="any"
                        min={0}
                        placeholder="5.20"
                        title="Price per share (the quoted premium), not per contract"
                        value={l.premium}
                        onChange={(e) => setLeg(l.id, { premium: e.target.value })}
                      />
                    </td>
                    <td className="py-0.5 pr-1">
                      <input
                        className={`${iField} min-w-[2.8rem]`}
                        style={iStyle}
                        type="number"
                        step="any"
                        min={0}
                        value={l.contracts}
                        onChange={(e) => setLeg(l.id, { contracts: e.target.value })}
                      />
                    </td>
                    <td className="py-0.5 pr-1">
                      <input
                        className={`${iField} min-w-[2.8rem]`}
                        style={iStyle}
                        type="number"
                        step="any"
                        value={l.multiplier}
                        onChange={(e) => setLeg(l.id, { multiplier: e.target.value })}
                      />
                    </td>
                    <td className="py-0.5">
                      {st.legs.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setSt((s) => ({ ...s, legs: s.legs.filter((x) => x.id !== l.id) }))
                          }
                          className="opacity-50 hover:opacity-100"
                          title="Remove leg"
                        >
                          <X className="w-3 h-3" style={{ color: colors.textSecondary }} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            <div className="flex items-center justify-between mt-1.5">
              <button
                type="button"
                onClick={() =>
                  setSt((s) => ({ ...s, legs: [...s.legs, newLeg(s.legs[s.legs.length - 1])] }))
                }
                className="flex items-center gap-1 px-2 py-0.5 text-[8px] font-bold border rounded"
                style={{ borderColor: colors.accent, color: colors.accent }}
                title="Add another leg — spreads, straddles, collars"
              >
                <Plus className="w-2.5 h-2.5" />
                LEG
              </button>
              {legs.length > 0 && (
                <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
                  {netPremium >= 0 ? "NET CREDIT " : "NET DEBIT "}
                  <span className="font-bold" style={{ color: pnlColor(netPremium) }}>
                    ${fmtAmt(Math.abs(netPremium))}
                  </span>
                  {loading && " · loading"}
                </span>
              )}
            </div>
            {legs.length < st.legs.length && underlying && (
              <div className="text-[8px] mt-1" style={{ color: "#f59e0b" }}>
                {st.legs.length - legs.length} leg ยังกรอกไม่ครบ (strike, expiry, premium) — ยังไม่นับในกราฟ
              </div>
            )}
          </div>

          {/* Payoff */}
          <div className="min-w-0">
            <PayoffChart data={payoff} colors={colors} height={200} />
            {error && !loading && (
              <div className="text-[9px] mt-1" style={{ color: "#f59e0b" }}>
                {payoff
                  ? "โหลดเส้น today / POP ไม่สำเร็จ — เส้น at expiry ยังถูกต้อง"
                  : "ดึงราคา spot ไม่ได้ — กรอก SPOT เอง หรือ"}{" "}
                <button type="button" onClick={retry} className="underline font-bold">
                  RETRY
                </button>
                <span className="ml-1" style={{ color: colors.textSecondary }}>
                  ({error.slice(0, 120)})
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
