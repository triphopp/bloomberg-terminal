"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Colors, fmtAmt } from "../helpers";
import {
  type LedgerAccount,
  type LedgerBalance,
  type LedgerWallet,
  WalletMoveForm,
  localDay,
} from "./ledger-client";

// Ledger v2 (backend/ledger.py, plans/port-ledger-v2.md). Cash here is the sum
// of posted events per wallet — never derived — and nothing posted is edited:
// a mistake is reversed. SHADOW mirrors every legacy PORT write in the same
// transaction; a write into a closed period asks for a reason and is booked today.

type Wallet = LedgerWallet;
type Balance = LedgerBalance;
type Finding = {
  code: string;
  severity: "error" | "warn" | "info";
  account_id: string;
  wallet: string | null;
  message: string;
};
type LedgerEvent = {
  id: string;
  wallet: string;
  trade_date: string;
  book_date: string;
  type: string;
  symbol: string | null;
  qty: string | null;
  price: string | null;
  net_cash: string;
  currency: string;
  source: string;
  note: string;
  reversed: boolean;
};
type PilotWallet = Balance & {
  statement_as_of?: string;
  statement_cash?: string;
  ledger_on_statement_day?: string;
  difference?: string;
};

const SEV: Record<Finding["severity"], string> = {
  error: "#f87171",
  warn: "#facc15",
  info: "#94a3b8",
};
const today = () => localDay();
const amt = (s: string | null | undefined) => (s == null || s === "" ? "—" : fmtAmt(Number(s)));

async function call(path: string, method = "GET", body?: unknown) {
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

type FormKind = "move" | "fx" | "close" | "opening" | "adjust" | "wallet" | "rule";
const FORMS: { id: FormKind; label: string }[] = [
  { id: "move", label: "MOVE" },
  { id: "fx", label: "FX CONVERT" },
  { id: "close", label: "CLOSE PERIOD" },
  { id: "opening", label: "OPENING" },
  { id: "adjust", label: "ADJUST" },
  { id: "wallet", label: "WALLET" },
  { id: "rule", label: "ROUTING RULE" },
];

export function LedgerPanel({ accountId, colors }: { accountId: string; colors: Colors }) {
  const qc = useQueryClient();
  const accounts = useQuery<{ accounts: LedgerAccount[] }>({
    queryKey: ["ledger-accounts"],
    queryFn: () => call("/accounts"),
    staleTime: 10_000,
  });
  const list = accounts.data?.accounts ?? [];
  const [picked, setPicked] = useState<string>("");
  const acc = list.find((a) => a.id === (accountId !== "all" ? accountId : picked)) ?? list[0];
  const aid = acc?.id ?? "";

  const check = useQuery<{ findings: Finding[] }>({
    queryKey: ["ledger-check", aid],
    queryFn: () => call(`/check?account_id=${encodeURIComponent(aid)}`),
    enabled: !!aid && acc?.ledger_mode !== "LEGACY",
    staleTime: 30_000,
  });
  const pilot = useQuery<{ wallets: PilotWallet[]; matched: boolean; adjust_events: number }>({
    queryKey: ["ledger-pilot", aid],
    queryFn: () => call(`/pilot/${encodeURIComponent(aid)}`),
    enabled: !!aid && acc?.ledger_mode !== "LEGACY",
    staleTime: 30_000,
  });
  const events = useQuery<{ events: LedgerEvent[] }>({
    queryKey: ["ledger-events", aid],
    queryFn: () => call(`/events?account_id=${encodeURIComponent(aid)}&limit=200`),
    enabled: !!aid && acc?.ledger_mode !== "LEGACY",
    staleTime: 10_000,
  });

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState<FormKind | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const refresh = () => {
    for (const k of ["ledger-accounts", "ledger-check", "ledger-pilot", "ledger-events"])
      void qc.invalidateQueries({ queryKey: [k] });
  };
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: `${label} — done` });
      setForm(null);
      setF({});
      refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const setMode = (mode: string) => {
    if (!acc || mode === acc.ledger_mode) return;
    if (mode === "LEGACY") {
      if (!window.confirm("กลับเป็น LEGACY: หยุดลง ledger ต่อ (รายการที่ลงแล้วยังอยู่)")) return;
      void run("mode LEGACY", () => call(`/accounts/${aid}/mode`, "PUT", { mode }));
      return;
    }
    // Start from a statement day: history up to it becomes OPENING balances.
    const cut = window.prompt(
      `เปิด SHADOW ให้ ${acc.name}\nวันเริ่ม ledger (YYYY-MM-DD) — ประวัติถึงวันนี้จะไม่ถูกลาก แต่ต้องลง OPENING ตาม statement\nเว้นว่าง = ลากประวัติเดิมทั้งหมด`,
      acc.ledger_cutover ?? today()
    );
    if (cut === null) return;
    void run(`mode ${mode}`, () =>
      call(`/accounts/${aid}/mode`, "PUT", { mode, cutover: cut.trim() || null })
    );
  };

  const reverse = (e: LedgerEvent) => {
    const reason = window.prompt(
      `Reverse ${e.type} ${e.symbol ?? ""} ${e.net_cash} ${e.currency} — reason:`
    );
    if (!reason?.trim()) return;
    void run("reverse", () => call(`/events/${e.id}/reverse`, "POST", { reason }));
  };

  const submit = () => {
    if (!acc) return;
    const base = { account_id: aid, trade_date: f.trade_date || today() };
    if (form === "fx")
      return run("FX convert", () =>
        call("/events/fx-convert", "POST", {
          ...base,
          from_currency: f.from_currency || "THB",
          from_amount: f.from_amount,
          to_currency: f.to_currency || "USD",
          to_amount: f.to_amount,
          from_wallet: f.from_wallet || null,
          to_wallet: f.to_wallet || null,
          fee: f.fee || 0,
          evidence_ref: f.evidence_ref || null,
          note: f.note || "",
        })
      );
    if (form === "close")
      return run("close", () =>
        call("/close", "POST", {
          account_id: aid,
          wallet: f.wallet,
          as_of: f.as_of || today(),
          statement_balance: f.statement_balance,
          source_ref: f.source_ref,
          note: f.note || "",
        })
      );
    if (form === "opening")
      return run("opening", () =>
        call("/events/opening", "POST", {
          ...base,
          currency: f.currency || acc.currency,
          wallet: f.wallet || null,
          amount: f.symbol ? null : f.amount,
          symbol: f.symbol || null,
          qty: f.qty || null,
          price: f.price || null,
          evidence_ref: f.evidence_ref,
          note: f.note || "",
        })
      );
    if (form === "adjust")
      return run("adjust", () =>
        call("/events/adjust", "POST", {
          ...base,
          currency: f.currency || acc.currency,
          wallet: f.wallet || null,
          amount: f.amount,
          category: f.category || "DATA_FIX",
          note: f.note || "",
          evidence_ref: f.evidence_ref || null,
        })
      );
    if (form === "wallet")
      return run("wallet", () =>
        call("/wallets", "PUT", {
          account_id: aid,
          wallet: f.wallet,
          currency: f.currency || acc.currency,
          is_default: f.is_default === "1",
          note: f.note || "",
          broker_label: f.broker_label || null,
        })
      );
    if (form === "rule")
      return run("rule", () =>
        call("/wallet-rules", "PUT", {
          account_id: aid,
          symbol_pattern: f.symbol_pattern,
          wallet: f.wallet,
          note: f.note || "",
        })
      );
  };

  const input = (k: string, ph: string, w = "w-28") => (
    <input
      value={f[k] ?? ""}
      onChange={set(k)}
      placeholder={ph}
      className={`${w} bg-transparent border px-1.5 py-0.5`}
      style={{ borderColor: colors.border, color: colors.text }}
    />
  );

  const selStyle = {
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
  };
  const walletNames = [
    ...new Set([
      ...(acc?.wallets ?? []).map((w) => w.wallet),
      ...(acc?.balances ?? []).map((b) => b.wallet),
    ]),
  ];
  const ccyOf = (w?: string) =>
    w
      ? (acc?.wallets.find((x) => x.wallet === w)?.currency ??
        acc?.balances.find((b) => b.wallet === w)?.currency)
      : undefined;
  const walletSelect = (k: string, label: string) => (
    <select value={f[k] ?? ""} onChange={set(k)} className="border px-1 py-0.5" style={selStyle}>
      <option value="">{label} wallet</option>
      {walletNames.map((w) => (
        <option key={w} value={w}>
          {w} ({ccyOf(w)})
        </option>
      ))}
    </select>
  );
  const btn = (active = false) => ({
    borderColor: active ? colors.accent : colors.border,
    color: active ? colors.accent : colors.textSecondary,
  });

  if (accounts.isLoading) return <p className="p-3 text-[10px]">Loading ledger…</p>;
  if (accounts.error)
    return (
      <p role="alert" className="p-3 text-[10px] text-red-400">
        {(accounts.error as Error).message}
      </p>
    );
  if (!acc) return <p className="p-3 text-[10px]">No accounts.</p>;

  const findings = check.data?.findings ?? [];
  const pw = new Map((pilot.data?.wallets ?? []).map((w) => [w.wallet, w]));

  return (
    <div className="h-full flex flex-col overflow-hidden text-[10px]">
      <div
        className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b"
        style={{ borderColor: colors.border }}
      >
        {accountId === "all" && (
          <select
            value={aid}
            onChange={(e) => setPicked(e.target.value)}
            className="border px-1.5 py-0.5"
            style={selStyle}
          >
            {list.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        <span style={{ color: colors.textSecondary }}>MODE</span>
        {(["LEGACY", "SHADOW"] as const).map((m) => (
          <button
            aria-pressed={acc.ledger_mode === m}
            key={m}
            type="button"
            disabled={busy}
            onClick={() => setMode(m)}
            className="border px-2 py-1"
            style={btn(acc.ledger_mode === m)}
          >
            {m}
          </button>
        ))}
        {acc.ledger_mode === "SHADOW" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("project", () => call(`/project/${aid}`, "POST", {}))}
            className="border px-2 py-1"
            style={btn()}
            title="Post what the legacy rows say and the journal does not yet"
          >
            PROJECT
          </button>
        )}
        {acc.ledger_cutover && (
          <span style={{ color: colors.textSecondary }}>start {acc.ledger_cutover}</span>
        )}
        {pilot.data && (
          <span style={{ color: pilot.data.matched ? "#4ade80" : "#facc15" }}>
            {pilot.data.matched ? "● matches broker" : "● not agreed with broker"} · ADJUST{" "}
            {pilot.data.adjust_events}
          </span>
        )}
        <button
          type="button"
          onClick={refresh}
          className="ml-auto border px-2 py-1"
          style={btn()}
          disabled={busy}
        >
          {check.isFetching || busy ? "…" : "RECHECK"}
        </button>
      </div>

      {msg && (
        <p
          role={msg.ok ? "status" : "alert"}
          className="shrink-0 px-3 py-1.5"
          style={{ color: msg.ok ? "#4ade80" : "#f87171" }}
        >
          {msg.text}
        </p>
      )}

      {acc.ledger_mode === "LEGACY" ? (
        <p className="p-3" style={{ color: colors.textSecondary }}>
          {acc.name} ยังไม่ลง ledger — เงินสดใน PORT ยังเป็นค่าที่คำนวณย้อนจาก trades
          (เพี้ยนได้เมื่อแก้ข้อมูลย้อนหลัง). เปิด SHADOW เพื่อเริ่มบันทึกแบบ append-only คู่กัน โดยไม่เปลี่ยนตัวเลขบนหน้าจออื่น
        </p>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <table className="w-full">
            <thead style={{ color: colors.textSecondary }}>
              <tr className="text-left">
                <th className="px-3 py-1">WALLET</th>
                <th className="px-2">CCY</th>
                <th className="px-2 text-right">LEDGER</th>
                <th className="px-2">CLOSED THROUGH</th>
                <th className="px-2">BROKER (DATE)</th>
                <th className="px-2 text-right">DIFF</th>
              </tr>
            </thead>
            <tbody>
              {acc.balances.map((b) => {
                const p = pw.get(b.wallet);
                return (
                  <tr key={b.wallet} className="border-t" style={{ borderColor: colors.border }}>
                    <td className="px-3 py-1">{b.wallet}</td>
                    <td className="px-2">{b.currency}</td>
                    <td
                      className="px-2 text-right tabular-nums"
                      style={{ color: Number(b.balance) < 0 ? "#f87171" : colors.text }}
                    >
                      {amt(b.balance)}
                    </td>
                    <td className="px-2">{b.closed_through ?? "open"}</td>
                    <td className="px-2">
                      {p?.statement_cash
                        ? `${amt(p.statement_cash)} (${p.statement_as_of})`
                        : "no statement"}
                    </td>
                    <td
                      className="px-2 text-right tabular-nums"
                      style={{ color: p?.difference === "0" ? "#4ade80" : "#facc15" }}
                    >
                      {p?.difference != null ? amt(p.difference) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div
            className="px-3 py-2 border-t flex flex-wrap gap-1"
            style={{ borderColor: colors.border }}
          >
            {FORMS.map((x) => (
              <button
                key={x.id}
                type="button"
                onClick={() => setForm(form === x.id ? null : x.id)}
                className="border px-2 py-0.5"
                style={btn(form === x.id)}
              >
                {x.label}
              </button>
            ))}
          </div>
          {form === "move" && (
            <div className="px-3 pb-2">
              <WalletMoveForm account={acc} colors={colors} onDone={refresh} />
            </div>
          )}
          {form && form !== "move" && (
            <div className="px-3 pb-2 flex flex-wrap items-center gap-1.5">
              {form === "fx" && (
                <>
                  {input("trade_date", "date YYYY-MM-DD")}
                  {input("from_amount", "from amount")}
                  {input("from_currency", "from ccy (THB)", "w-20")}
                  {input("from_wallet", "from wallet", "w-24")}
                  <span>→</span>
                  {input("to_amount", "to amount")}
                  {input("to_currency", "to ccy (USD)", "w-20")}
                  {input("to_wallet", "to wallet", "w-24")}
                  {input("fee", "fee", "w-16")}
                  {input("evidence_ref", "slip / statement ref", "w-40")}
                </>
              )}
              {form === "close" && (
                <>
                  {input("wallet", "wallet", "w-24")}
                  {input("as_of", "as of YYYY-MM-DD")}
                  {input("statement_balance", "broker cash")}
                  {input("source_ref", "statement / app screen ref", "w-48")}
                </>
              )}
              {form === "opening" && (
                <>
                  {input("trade_date", "date YYYY-MM-DD")}
                  {input("currency", `ccy (${acc.currency})`, "w-20")}
                  {input("wallet", "wallet", "w-24")}
                  {input("amount", "cash (or blank)")}
                  {input("symbol", "symbol (position)", "w-24")}
                  {input("qty", "qty", "w-20")}
                  {input("price", "cost/unit", "w-20")}
                  {input("evidence_ref", "statement ref (required)", "w-44")}
                </>
              )}
              {form === "adjust" && (
                <>
                  {input("trade_date", "date YYYY-MM-DD")}
                  {input("currency", `ccy (${acc.currency})`, "w-20")}
                  {input("wallet", "wallet", "w-24")}
                  {input("amount", "± amount")}
                  <select
                    value={f.category ?? "DATA_FIX"}
                    onChange={set("category")}
                    className="border px-1 py-0.5"
                    style={selStyle}
                  >
                    {[
                      "DATA_FIX",
                      "FEE",
                      "FX_REVALUATION",
                      "INTEREST",
                      "BROKER_CORRECTION",
                      "OPENING_DIFF",
                      "OTHER",
                    ].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </>
              )}
              {form === "wallet" && (
                <>
                  {input("wallet", "wallet name (e.g. FCD)", "w-32")}
                  {input("currency", `ccy (${acc.currency})`, "w-20")}
                  <select
                    value={f.is_default ?? "0"}
                    onChange={set("is_default")}
                    className="border px-1 py-0.5"
                    style={selStyle}
                  >
                    <option value="0">not default</option>
                    <option value="1">default for ccy</option>
                  </select>
                  {input("broker_label", "name on slips (Dime! FCD)", "w-40")}
                </>
              )}
              {form === "rule" && (
                <>
                  {input("symbol_pattern", "symbol / pattern (GC=F, MTS-*)", "w-44")}
                  {walletSelect("wallet", "settles in")}
                </>
              )}
              {input("note", form === "adjust" ? "reason (required)" : "note", "w-48")}
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit()}
                className="border px-2 py-0.5"
                style={btn(true)}
              >
                {busy ? "…" : "POST"}
              </button>
            </div>
          )}

          {(acc.rules ?? []).length > 0 && (
            <div className="px-3 pb-2 flex flex-wrap gap-3" style={{ color: colors.textSecondary }}>
              <span>ROUTING</span>
              {acc.rules.map((r) => (
                <span key={r.id} title={r.note}>
                  <span style={{ color: colors.text }}>{r.symbol_pattern}</span> → {r.wallet}{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      if (window.confirm(`Remove rule ${r.symbol_pattern} → ${r.wallet}?`))
                        void run("remove rule", () => call(`/wallet-rules/${r.id}`, "DELETE"));
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
              {acc.wallets
                .filter((w) => w.broker_label)
                .map((w) => (
                  <span key={w.wallet}>
                    {w.wallet} = “{w.broker_label}”
                  </span>
                ))}
            </div>
          )}

          <div
            className="px-3 py-1 border-t"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            CHECKS {check.isFetching ? "…" : findings.length === 0 ? "— clean" : ""}
          </div>
          {findings.map((x, i) => (
            <div key={`${x.code}-${i}`} className="px-3 py-0.5 flex gap-2">
              <span className="shrink-0 w-40" style={{ color: SEV[x.severity] }}>
                {x.code}
              </span>
              <span>{x.message}</span>
            </div>
          ))}

          <div
            className="px-3 py-1 mt-2 border-t"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            EVENTS (newest booked first)
          </div>
          <table className="w-full">
            <tbody>
              {(events.data?.events ?? []).map((e) => (
                <tr
                  key={e.id}
                  className="border-t"
                  style={{ borderColor: colors.border, opacity: e.reversed ? 0.45 : 1 }}
                >
                  <td className="px-3 py-0.5 whitespace-nowrap">
                    {e.book_date}
                    {e.book_date !== e.trade_date ? ` (${e.trade_date})` : ""}
                  </td>
                  <td className="px-2">{e.wallet}</td>
                  <td className="px-2">{e.type}</td>
                  <td className="px-2">{e.symbol ?? ""}</td>
                  <td
                    className="px-2 text-right tabular-nums"
                    style={{ color: Number(e.net_cash) < 0 ? "#f87171" : "#4ade80" }}
                  >
                    {amt(e.net_cash)}
                  </td>
                  <td className="px-2" style={{ color: colors.textSecondary }}>
                    {e.source}
                  </td>
                  <td
                    className="px-2 truncate max-w-[280px]"
                    title={e.note}
                    style={{ color: colors.textSecondary }}
                  >
                    {e.note}
                  </td>
                  <td className="px-2 text-right">
                    {!e.reversed && e.type !== "REVERSAL" && e.source === "MANUAL" && (
                      <button type="button" onClick={() => reverse(e)} className="underline">
                        reverse
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
