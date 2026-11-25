"use client";
import { useCallback, useEffect, useState } from "react";
import { type Colors, fmtAmt, fmtPx, fmtQty } from "../helpers";

/**
 * AUTO DIV — status of backend/dividend_auto.py: an ex-date that passed while a
 * stock was held is booked into DIVIDENDS by itself (gross = units held on the
 * ex-date × the market's per-unit). Not held on that day → nothing is booked.
 * This strip only says what the pass did / would do and lets the user run it now.
 */
interface AutoRow {
  account_id: string;
  asset: string;
  ex_date: string;
  amount_per_unit: number;
  held_units: number;
  total_received: number;
  currency: string;
  pay_date?: string;
  pay_date_estimated?: boolean;
  error?: string;
}
interface AutoStatus {
  enabled: boolean;
  interval_s: number;
  lookback_days: number;
  last_run: { at: string | null; booked: AutoRow[]; errors: AutoRow[] };
  preview: { to_book: AutoRow[]; error?: string };
}

const sym = (ccy: string) => (ccy === "THB" ? "฿" : "$");
const fmtTotal = (r: AutoRow) => `${sym(r.currency)}${fmtAmt(r.total_received)}`;

export function AutoDividendStrip({ colors, onBooked }: { colors: Colors; onBooked: () => void }) {
  const [st, setSt] = useState<AutoStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await fetch("/api/v2/portfolio/dividends/auto", { signal });
      if (r.ok) setSt(await r.json());
    } catch {
      /* status is optional — the list still works */
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const runNow = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/v2/portfolio/dividends/auto/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: false }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.detail || "run failed");
      const booked: AutoRow[] = d.booked ?? [];
      const errors: AutoRow[] = d.errors ?? [];
      setMsg(
        booked.length
          ? `BOOKED ${booked.map((b) => `${b.asset} ${fmtTotal(b)}`).join(" · ")}`
          : `NOTHING TO BOOK${errors.length ? ` · ${errors.length} REFUSED` : ""}`
      );
      if (booked.length) onBooked();
      load();
    } catch (e) {
      setMsg(`ERROR ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!st) return null;
  const pending = st.preview?.to_book ?? [];
  const last = st.last_run?.at ? new Date(st.last_run.at) : null;
  const hours = Math.round(st.interval_s / 3600);

  return (
    <div
      className="px-3 py-1 border-b flex items-center gap-3 flex-wrap text-[8px] font-mono"
      style={{ borderColor: colors.border, background: "#050505" }}
      title={
        `Ex-date passed + units held on it → booked automatically (gross = held × per-unit, instrument currency). Not held on the ex-date → nothing. A row already booked by hand (XD ±10 days) is never doubled; a deleted AUTO row is not re-created. Lookback ${st.lookback_days} days. Pay date = Yahoo's declared date, else the ex-date (≈) — check against the broker statement.`
      }
    >
      <span style={{ color: "#a78bfa" }}>AUTO DIV</span>
      <span style={{ color: st.enabled ? "#4ade80" : colors.textSecondary }}>
        {st.enabled ? `ON · EVERY ${hours}H` : "OFF (DIVIDEND_AUTO_INTERVAL=0)"}
      </span>
      {last && (
        <span style={{ color: colors.textSecondary }}>
          LAST {last.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
          {st.last_run.booked.length > 0 && ` · BOOKED ${st.last_run.booked.length}`}
          {st.last_run.errors.length > 0 && (
            <span style={{ color: "#f87171" }}> · REFUSED {st.last_run.errors.length}</span>
          )}
        </span>
      )}
      {pending.length > 0 ? (
        <span style={{ color: "#fbbf24" }}>
          WAITING:{" "}
          {pending
            .map(
              (p) =>
                `${p.asset} XD ${p.ex_date} ${fmtQty(p.held_units)}×${fmtPx(p.amount_per_unit)} = ${fmtTotal(p)}`
            )
            .join(" · ")}
        </span>
      ) : (
        <span style={{ color: colors.textSecondary }}>NOTHING WAITING</span>
      )}
      {msg && <span style={{ color: msg.startsWith("ERROR") ? "#f87171" : "#4ade80" }}>{msg}</span>}
      <button
        type="button"
        onClick={runNow}
        disabled={busy}
        className="ml-auto hover:opacity-70 disabled:opacity-40"
        style={{ color: "#a78bfa" }}
      >
        {busy ? "RUNNING…" : "RUN NOW"}
      </button>
    </div>
  );
}
