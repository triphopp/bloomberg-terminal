"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type Colors, fmtAmt } from "../helpers";
import { NumInput } from "./NumInput";

// Shared pieces of the ledger v2 UI (backend/ledger.py): which wallet an entry
// settles in, moving cash between wallets, and each wallet's balance next to
// the legacy CASH figure. Amounts arrive as decimal strings.

export type LedgerWallet = {
  wallet: string;
  currency: string;
  is_default: number;
  note: string;
  broker_label?: string | null;
  implicit?: boolean;
};
export type LedgerBalance = {
  account_id: string;
  wallet: string;
  currency: string;
  balance: string;
  events: number;
  closed_through: string | null;
};
export type LedgerRule = { id: string; symbol_pattern: string; wallet: string; note: string };
export type LedgerAccount = {
  id: string;
  name: string;
  currency: string;
  ledger_mode: "LEGACY" | "SHADOW" | "PRIMARY";
  ledger_cutover: string | null;
  wallets: LedgerWallet[];
  balances: LedgerBalance[];
  rules: LedgerRule[];
  matched?: boolean;
  agreed?: Record<string, { as_of: string | null; difference: string | null }>;
};

/** Today on the user's clock (toISOString is UTC: 02:00 in Bangkok is still yesterday). */
export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function ledgerCall(path: string, method = "GET", body?: unknown) {
  const r = await fetch(`/api/v2/ledger${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const diff = d?.evidence?.difference ? ` (difference ${d.evidence.difference})` : "";
    throw new Error(`${d.detail || d.error || `HTTP ${r.status}`}${diff}`);
  }
  return d;
}

export const LEDGER_QUERY_KEYS = [
  "ledger-accounts",
  "ledger-check",
  "ledger-pilot",
  "ledger-events",
];

export function useLedgerAccounts() {
  return useQuery<{ accounts: LedgerAccount[] }>({
    queryKey: ["ledger-accounts"],
    queryFn: () => ledgerCall("/accounts"),
    staleTime: 15_000,
  });
}

export function useInvalidateLedger() {
  const qc = useQueryClient();
  return () => {
    for (const k of LEDGER_QUERY_KEYS) void qc.invalidateQueries({ queryKey: [k] });
  };
}

const selStyle = (colors: Colors) => ({
  borderColor: colors.border,
  backgroundColor: colors.surface,
  color: colors.text,
});

type Route = {
  mode: string;
  wallet: string | null;
  reason: string;
  choices: LedgerWallet[];
};

/**
 * Which wallet a trade pays from / is paid into. Shows nothing for an account
 * that is not on the ledger. "" = automatic (slip's account → rule → default),
 * shown with the wallet it resolves to; picking one sends it explicitly.
 */
export function WalletSelect({
  accountId,
  currency,
  symbol,
  label,
  value,
  onChange,
  colors,
  caption = "WALLET",
}: {
  accountId: string;
  currency: string | null | undefined;
  symbol?: string;
  label?: string | null;
  value: string;
  onChange: (wallet: string) => void;
  colors: Colors;
  caption?: string;
}) {
  const ccy = (currency || "").toUpperCase();
  const route = useQuery<Route>({
    queryKey: ["ledger-route", accountId, ccy, symbol ?? "", label ?? ""],
    queryFn: () => {
      const qs = new URLSearchParams({ account_id: accountId, currency: ccy });
      if (symbol) qs.set("symbol", symbol.toUpperCase());
      if (label) qs.set("label", label);
      return ledgerCall(`/route?${qs}`);
    },
    enabled: !!accountId && !!ccy,
    staleTime: 30_000,
  });
  const r = route.data;
  // A picked wallet that the account/currency no longer offers is dropped.
  useEffect(() => {
    if (value && r && !r.choices.some((c) => c.wallet === value)) onChange("");
  }, [value, r, onChange]);
  if (!r || r.mode === "LEGACY") return null;
  return (
    <div>
      <div
        className="text-[8px] mb-0.5 font-bold tracking-wider"
        style={{ color: colors.textSecondary }}
      >
        {caption}
      </div>
      <select
        className="w-full border px-1.5 py-1 text-[10px]"
        style={selStyle(colors)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title={`auto = ${r.wallet ?? "—"} (${r.reason})`}
      >
        <option value="">
          auto → {r.wallet ?? "—"} ({r.reason})
        </option>
        {r.choices.map((c) => (
          <option key={c.wallet} value={c.wallet}>
            {c.wallet}
            {c.broker_label ? ` · ${c.broker_label}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Wallet → wallet. Same currency: a transfer; different: an FX conversion
 *  that needs the amount that actually arrived (the slip's rate, not a quote). */
export function WalletMoveForm({
  account,
  colors,
  onDone,
}: {
  account: LedgerAccount;
  colors: Colors;
  onDone?: () => void;
}) {
  const invalidate = useInvalidateLedger();
  const names = [
    ...new Set([...account.wallets.map((w) => w.wallet), ...account.balances.map((b) => b.wallet)]),
  ];
  const ccyOf = (w: string) =>
    account.wallets.find((x) => x.wallet === w)?.currency ??
    account.balances.find((b) => b.wallet === w)?.currency;
  const [f, setF] = useState({
    trade_date: localDay(),
    from_wallet: "",
    to_wallet: "",
    amount: "",
    to_amount: "",
    fee: "",
    evidence_ref: "",
    note: "",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));
  const fx = !!f.from_wallet && !!f.to_wallet && ccyOf(f.from_wallet) !== ccyOf(f.to_wallet);
  const rate =
    fx && Number(f.amount) > 0 && Number(f.to_amount) > 0
      ? Number(f.amount) / Number(f.to_amount)
      : null;

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const d = await ledgerCall("/events/move", "POST", {
        account_id: account.id,
        trade_date: f.trade_date,
        from_wallet: f.from_wallet,
        to_wallet: f.to_wallet,
        amount: f.amount,
        to_amount: fx ? f.to_amount : null,
        fee: f.fee || 0,
        evidence_ref: f.evidence_ref || null,
        note: f.note,
      });
      setMsg({ ok: true, text: `posted ${d.events.length} events` });
      setF((p) => ({ ...p, amount: "", to_amount: "", fee: "", evidence_ref: "", note: "" }));
      invalidate();
      onDone?.();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const inp = (k: keyof typeof f, ph: string, w = "w-28") => {
    const Field = k === "amount" || k === "to_amount" || k === "fee" ? NumInput : "input";
    return (
      <Field
        value={f[k]}
        onChange={set(k)}
        placeholder={ph}
        min={0}
        className={`${w} bg-transparent border px-1.5 py-0.5`}
        style={{ borderColor: colors.border, color: colors.text }}
      />
    );
  };
  const walletPick = (k: "from_wallet" | "to_wallet", ph: string) => (
    <select value={f[k]} onChange={set(k)} className="border px-1 py-0.5" style={selStyle(colors)}>
      <option value="">{ph}</option>
      {names.map((w) => (
        <option key={w} value={w}>
          {w} ({ccyOf(w)})
        </option>
      ))}
    </select>
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
      {inp("trade_date", "YYYY-MM-DD")}
      {walletPick("from_wallet", "from wallet")}
      {inp("amount", `amount out${f.from_wallet ? ` (${ccyOf(f.from_wallet)})` : ""}`)}
      <span>→</span>
      {walletPick("to_wallet", "to wallet")}
      {fx && inp("to_amount", `${ccyOf(f.to_wallet)} arrived (slip)`, "w-36")}
      {rate && (
        <span style={{ color: colors.textSecondary }}>
          rate {rate.toFixed(4)} {ccyOf(f.from_wallet)}/{ccyOf(f.to_wallet)}
        </span>
      )}
      {inp("fee", "fee", "w-16")}
      {inp("evidence_ref", "slip ref", "w-28")}
      {inp("note", "note", "w-36")}
      <button
        type="button"
        disabled={busy || !f.from_wallet || !f.to_wallet || !f.amount}
        onClick={() => void submit()}
        className="border px-2 py-0.5 disabled:opacity-40"
        style={{ borderColor: colors.accent, color: colors.accent }}
      >
        {busy ? "…" : fx ? "CONVERT" : "MOVE"}
      </button>
      {msg && <span style={{ color: msg.ok ? "#4ade80" : "#f87171" }}>{msg.text}</span>}
    </div>
  );
}

/** Each SHADOW account's wallets — the reconciled figure beside the derived CASH. */
export function LedgerWalletStrip({
  accountId,
  thbPerUsd,
  colors,
}: {
  accountId: string;
  thbPerUsd?: number;
  colors: Colors;
}) {
  const q = useLedgerAccounts();
  const [moving, setMoving] = useState<string | null>(null);
  const accs = (q.data?.accounts ?? []).filter(
    (a) => a.ledger_mode !== "LEGACY" && (accountId === "all" || a.id === accountId)
  );
  if (!accs.length) return null;
  return (
    <div className="border-b text-[10px]" style={{ borderColor: colors.border }}>
      {accs.map((a) => {
        const thb = a.balances.reduce(
          (s, b) =>
            s +
            Number(b.balance) *
              (b.currency === "THB" ? 1 : b.currency === "USD" ? (thbPerUsd ?? 0) : 0),
          0
        );
        return (
          <div key={a.id} className="px-3 py-1.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-bold" style={{ color: colors.textSecondary }}>
                LEDGER · {a.name.toUpperCase()}
              </span>
              <span
                style={{ color: a.matched ? "#4ade80" : "#facc15" }}
                title={
                  a.matched ? "every wallet agrees with the broker on its last close" : "not agreed"
                }
              >
                ● {a.matched ? "agreed" : "not agreed"}
              </span>
              {a.balances.map((b) => (
                <span
                  key={b.wallet}
                  title={b.closed_through ? `closed through ${b.closed_through}` : "open"}
                >
                  <span style={{ color: colors.textSecondary }}>{b.wallet} </span>
                  <span
                    className="tabular-nums"
                    style={{ color: Number(b.balance) < 0 ? "#f87171" : colors.text }}
                  >
                    {fmtAmt(Number(b.balance))} {b.currency}
                  </span>
                </span>
              ))}
              {thbPerUsd ? (
                <span
                  style={{ color: colors.textSecondary }}
                  title={`USD wallets valued at ${thbPerUsd.toFixed(2)} — a valuation, not a cash difference`}
                >
                  ≈ ฿{fmtAmt(thb)} @ {thbPerUsd.toFixed(2)}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => setMoving(moving === a.id ? null : a.id)}
                className="border px-2 py-0.5"
                style={{
                  borderColor: moving === a.id ? colors.accent : colors.border,
                  color: moving === a.id ? colors.accent : colors.textSecondary,
                }}
              >
                MOVE / FX
              </button>
            </div>
            {moving === a.id && (
              <div className="mt-1.5">
                <WalletMoveForm account={a} colors={colors} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
