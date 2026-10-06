"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type Colors, fmtAmt, fmtPx, fmtQty, pnlColor } from "../helpers";
import { portfolioQueries } from "../queries";
import type { OptionLot } from "../tabs/OptionsTab";
import type { Account } from "../types";
import { NumInput } from "./NumInput";
import type { OptionSlipForm } from "./SlipReader";

// One option fill → POST /api/options/fills (backend option_fills.py). Every
// field the book keeps for a fill is here: fill time, settle date, order
// number, each fee line, and for a close the lots it consumes. The same
// endpoint previews (dry_run) what SAVE would book, so the P&L shown before
// saving is the one the book will hold.

export interface OptionEntryPrefill {
  /** Empty = the form's default account. */
  account_id: string;
  underlying?: string;
  expiry?: string;
  strike?: number;
  option_type?: "call" | "put";
  multiplier?: number;
  action: "OPEN" | "CLOSE";
  side: "BUY" | "SELL";
  /** Close exactly this lot (OPTIONS → CLOSE on one lot). */
  lot_id?: string;
  quantity?: number;
  price?: number | null;
}

const FEES: { key: string; label: string; hint: string }[] = [
  { key: "COMMISSION", label: "ค่าคอมมิชชัน", hint: "ตามสลิป" },
  { key: "COMMISSION_DISCOUNT", label: "ส่วนลด / คูปอง", hint: "ติดลบ เช่น -5.50" },
  { key: "VAT", label: "VAT 7%", hint: "" },
  { key: "OCC", label: "OCC", hint: "ค่าธรรมเนียมซื้อขายออปชัน" },
  { key: "ORF", label: "ORF", hint: "ค่าธรรมเนียมกำกับดูแล" },
  { key: "TAF", label: "TAF", hint: "ฝั่งขายเท่านั้น" },
];

const today = () => new Date().toISOString().slice(0, 10);
const BKK = "+07:00";

type Form = {
  account_id: string;
  action: "OPEN" | "CLOSE";
  side: "BUY" | "SELL";
  underlying: string;
  option_type: "call" | "put";
  strike: string;
  expiry: string;
  multiplier: string;
  contracts: string;
  price: string;
  trade_date: string;
  executed_local: string; // YYYY-MM-DDTHH:MM, Bangkok
  submitted_local: string;
  settle_date: string;
  order_ref: string;
  close_reason: "TRADE" | "EXPIRED" | "EXERCISED" | "ASSIGNED";
  note: string;
  fees: Record<string, string>;
  pick: boolean; // choose lots instead of FIFO
  picks: Record<string, string>;
};

const blank = (account_id: string): Form => ({
  account_id,
  action: "OPEN",
  side: "BUY",
  underlying: "",
  option_type: "call",
  strike: "",
  expiry: "",
  multiplier: "100",
  contracts: "",
  price: "",
  trade_date: today(),
  executed_local: "",
  submitted_local: "",
  settle_date: "",
  order_ref: "",
  close_reason: "TRADE",
  note: "",
  fees: {},
  pick: false,
  picks: {},
});

const toLocal = (iso: string | null | undefined) => (iso ? iso.slice(0, 16) : "");

interface Preview {
  matches: {
    open_trade_id: string;
    entry_date: string;
    entry_price: number;
    quantity: number;
    fees_alloc: number;
    realized_pnl: number | null;
  }[];
  gross: number;
  fees: number;
  cash_effect: number;
  realized_total: number | null;
}

function Label({
  children,
  color,
  colors,
}: { children: React.ReactNode; color?: string; colors: Colors }) {
  return (
    <div
      className="text-[8px] mb-0.5 font-bold tracking-wider"
      style={{ color: color ?? colors.textSecondary }}
    >
      {children}
    </div>
  );
}

function Toggle<T extends string>({
  value,
  options,
  onPick,
  colors,
}: {
  value: T;
  options: { v: T; label: string; color: string }[];
  onPick: (v: T) => void;
  colors: Colors;
}) {
  return (
    <div className="flex items-center gap-1">
      {options.map((o) => (
        <button
          aria-pressed={value === o.v}
          type="button"
          key={o.v}
          onClick={() => onPick(o.v)}
          className="text-[10px] px-3 py-1 font-bold tracking-widest"
          style={{
            color: value === o.v ? o.color : colors.textSecondary,
            textDecoration: value === o.v ? "underline" : "none",
            textUnderlineOffset: 3,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function OptionEntryForm({
  colors,
  accounts,
  defaultAccountId,
  slip,
  prefill,
  onSaved,
}: {
  colors: Colors;
  accounts: Account[];
  defaultAccountId: string;
  slip: { form: OptionSlipForm; shas: string[]; seq: number } | null;
  prefill: (OptionEntryPrefill & { seq: number }) | null;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(() => blank(defaultAccountId));
  const [shas, setShas] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string>("");
  const [saveErr, setSaveErr] = useState("");

  const lotsQ = useQuery(portfolioQueries.openPositions("USD", f.account_id));
  const allLots: OptionLot[] = lotsQ.data?.options ?? [];
  const lots = useMemo(
    () =>
      allLots.filter(
        (l) =>
          l.underlying === f.underlying.trim().toUpperCase() &&
          l.expiry === f.expiry &&
          Math.abs(l.strike - Number.parseFloat(f.strike)) < 1e-9 &&
          l.option_type === f.option_type &&
          // a SELL closes long lots, a BUY closes short ones
          Math.sign(l.quantity) === (f.side === "SELL" ? 1 : -1)
      ),
    [allLots, f.underlying, f.expiry, f.strike, f.option_type, f.side]
  );

  // Slip → form. Whether it opens or closes is the book's call, not the slip's:
  // a sale of a contract held long is a close.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on slip.seq — a new reading refills the form; typing must not
  useEffect(() => {
    if (!slip) return;
    const s = slip.form;
    const acct =
      s.account_hint && accounts.some((a) => a.id === s.account_hint)
        ? s.account_hint
        : defaultAccountId;
    setF({
      ...blank(acct),
      side: s.side === "sell" ? "SELL" : "BUY",
      underlying: s.underlying,
      option_type: s.option_type === "put" ? "put" : "call",
      strike: s.strike,
      expiry: s.expiry,
      multiplier: s.multiplier || "100",
      contracts: s.contracts,
      price: s.price,
      trade_date: s.trade_date || today(),
      executed_local: toLocal(s.executed_at),
      submitted_local: toLocal(s.submitted_at),
      settle_date: s.settle_date ?? "",
      order_ref: s.broker_order_ref ?? "",
      note: s.note,
      fees: Object.fromEntries(s.fee_items.map((i) => [i.component, i.amount])),
    });
    setShas(slip.shas);
    setSaved("");
    setSaveErr("");
    // slip.seq is the trigger: the same slip read twice fills twice.
  }, [slip?.seq]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on prefill.seq — each OPTIONS click refills once
  useEffect(() => {
    if (!prefill) return;
    setF({
      ...blank(prefill.account_id || defaultAccountId),
      action: prefill.action,
      side: prefill.side,
      underlying: prefill.underlying ?? "",
      option_type: prefill.option_type ?? "call",
      strike: prefill.strike != null ? String(prefill.strike) : "",
      expiry: prefill.expiry ?? "",
      multiplier: String(prefill.multiplier ?? 100),
      contracts: prefill.quantity != null ? String(prefill.quantity) : "",
      price: prefill.price != null ? String(prefill.price) : "",
      pick: !!prefill.lot_id,
      picks: prefill.lot_id ? { [prefill.lot_id]: String(prefill.quantity ?? "") } : {},
    });
    setShas([]);
    setSaved("");
    setSaveErr("");
  }, [prefill?.seq]);

  // Once lots load for a slip-filled sale/buy, decide open vs close.
  const [autoAction, setAutoAction] = useState(true);
  useEffect(() => {
    if (!autoAction || !lotsQ.data) return;
    setF((x) => ({ ...x, action: lots.length ? "CLOSE" : "OPEN" }));
  }, [lots.length, lotsQ.data, autoAction]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a slip lets the book decide open vs close
  useEffect(() => setAutoAction(true), [slip?.seq]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a prefill already says what it is
  useEffect(() => setAutoAction(false), [prefill?.seq]);

  const body = useMemo(() => {
    const expired = f.action === "CLOSE" && f.close_reason === "EXPIRED";
    const fee_items = Object.entries(f.fees)
      .filter(([, v]) => v !== "" && Number.isFinite(Number.parseFloat(v)))
      .map(([component, amount]) => ({ component, amount }));
    const allocations =
      f.action === "CLOSE" && f.pick
        ? Object.entries(f.picks)
            .filter(([, q]) => Number.parseFloat(q) > 0)
            .map(([open_trade_id, q]) => ({ open_trade_id, quantity: Number.parseFloat(q) }))
        : [];
    return {
      account_id: f.account_id,
      underlying: f.underlying.trim().toUpperCase(),
      expiry: f.expiry,
      strike: Number.parseFloat(f.strike),
      option_type: f.option_type,
      multiplier: Number.parseFloat(f.multiplier) || 100,
      action: f.action,
      side: f.side,
      quantity: Number.parseFloat(f.contracts),
      price: expired ? 0 : f.price === "" ? null : Number.parseFloat(f.price),
      trade_date: f.trade_date,
      executed_at: f.executed_local ? `${f.executed_local}:00${BKK}` : null,
      submitted_at: f.submitted_local ? `${f.submitted_local}:00${BKK}` : null,
      settle_date: f.settle_date || null,
      broker_order_ref: f.order_ref.trim() || null,
      close_reason: f.action === "CLOSE" ? f.close_reason : null,
      fee_items,
      allocations,
      slip_sha256s: shas,
      note: f.note,
    };
  }, [f, shas]);

  const ready =
    !!body.underlying &&
    !!body.expiry &&
    body.strike > 0 &&
    body.quantity > 0 &&
    !!body.trade_date &&
    (body.price != null || f.close_reason === "EXPIRED");

  useEffect(() => {
    if (!ready) {
      setPreview(null);
      setPreviewErr("");
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch("/api/options/fills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, dry_run: true }),
          signal: ctl.signal,
        });
        const d = await r.json();
        if (ctl.signal.aborted) return;
        if (!r.ok) {
          setPreview(null);
          setPreviewErr(d.detail || "Preview failed");
        } else {
          setPreview(d as Preview);
          setPreviewErr("");
        }
      } catch {
        /* aborted or offline — SAVE reports it */
      }
    }, 400);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [body, ready]);

  const save = async () => {
    setSaving(true);
    setSaveErr("");
    setSaved("");
    try {
      const r = await fetch("/api/options/fills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) {
        setSaveErr(d.detail || d.error || "Save failed");
        return;
      }
      const realized = d.realized_total != null ? ` · realized ${fmtAmt(d.realized_total)}` : "";
      setSaved(
        `${d.occ_symbol} ${f.action === "OPEN" ? "เปิด" : "ปิด"} ${fmtQty(body.quantity)} สัญญา${realized}`
      );
      setF(blank(f.account_id));
      setShas([]);
      qc.invalidateQueries({ queryKey: ["portfolio"] });
      onSaved?.();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  const set = (k: keyof Form) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const iField = "text-[10px] font-mono px-2 py-1 border outline-none w-full";
  const iStyle = { background: "#0a0a0a", color: colors.text, borderColor: colors.border };
  const feeTotal = Object.values(f.fees).reduce((s, v) => s + (Number.parseFloat(v) || 0), 0);
  const expired = f.action === "CLOSE" && f.close_reason === "EXPIRED";
  const matchedIds = new Set(preview?.matches.map((m) => m.open_trade_id) ?? []);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 flex-wrap">
        <Toggle
          colors={colors}
          value={f.side}
          options={[
            { v: "BUY", label: "▲ ซื้อ", color: "#4ade80" },
            { v: "SELL", label: "▼ ขาย", color: "#f87171" },
          ]}
          onPick={(v) => {
            setAutoAction(false);
            setF((x) => ({ ...x, side: v, picks: {} }));
          }}
        />
        <Toggle
          colors={colors}
          value={f.action}
          options={[
            { v: "OPEN", label: "เปิดสถานะ", color: colors.accent },
            { v: "CLOSE", label: "ปิดสถานะ", color: "#fbbf24" },
          ]}
          onPick={(v) => {
            setAutoAction(false);
            setF((x) => ({ ...x, action: v }));
          }}
        />
        <span className="text-[8px]" style={{ color: colors.textSecondary }}>
          {f.action === "OPEN"
            ? f.side === "BUY"
              ? "ซื้อเปิด — long"
              : "ขายเปิด (write) — short, ได้ premium"
            : f.side === "SELL"
              ? "ขายปิด long ที่ถืออยู่"
              : "ซื้อคืนปิด short"}
          {autoAction && lotsQ.data && " · เลือกให้ตามล็อตที่ถืออยู่"}
        </span>
      </div>

      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
        <div>
          <Label colors={colors}>ACCOUNT *</Label>
          <select
            className={iField}
            style={iStyle}
            value={f.account_id}
            onChange={set("account_id")}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label colors={colors}>UNDERLYING *</Label>
          <input
            className={iField}
            style={iStyle}
            placeholder="INTC"
            value={f.underlying}
            onChange={set("underlying")}
          />
        </div>
        <div>
          <Label colors={colors}>TYPE *</Label>
          <select
            className={iField}
            style={iStyle}
            value={f.option_type}
            onChange={set("option_type")}
          >
            <option value="call">CALL</option>
            <option value="put">PUT</option>
          </select>
        </div>
        <div>
          <Label colors={colors}>STRIKE *</Label>
          <NumInput
            className={iField}
            style={iStyle}
            step="any"
            placeholder="40.00"
            value={f.strike}
            onChange={set("strike")}
          />
        </div>
        <div>
          <Label colors={colors}>EXPIRY *</Label>
          <input
            className={iField}
            style={iStyle}
            type="date"
            value={f.expiry}
            onChange={set("expiry")}
          />
        </div>
        <div>
          <Label colors={colors}>MULTIPLIER</Label>
          <NumInput
            className={iField}
            style={iStyle}
            step="any"
            value={f.multiplier}
            onChange={set("multiplier")}
          />
        </div>
      </div>

      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
        <div>
          <Label colors={colors}>CONTRACTS *</Label>
          <NumInput
            className={iField}
            style={iStyle}
            step="any"
            placeholder="10"
            value={f.contracts}
            onChange={set("contracts")}
          />
        </div>
        <div>
          <Label colors={colors}>PREMIUM / หุ้น {expired ? "" : "*"}</Label>
          <NumInput
            className={iField}
            style={iStyle}
            step="any"
            placeholder={expired ? "0 — หมดอายุ" : "0.29"}
            disabled={expired}
            value={expired ? "" : f.price}
            onChange={set("price")}
          />
        </div>
        <div>
          <Label colors={colors}>TRADE DATE (US) *</Label>
          <input
            className={iField}
            style={iStyle}
            type="date"
            value={f.trade_date}
            onChange={set("trade_date")}
          />
        </div>
        <div>
          <Label colors={colors}>FILL TIME (เวลาไทย)</Label>
          <input
            className={iField}
            style={iStyle}
            type="datetime-local"
            value={f.executed_local}
            onChange={set("executed_local")}
          />
        </div>
        <div>
          <Label colors={colors}>SETTLE DATE</Label>
          <input
            className={iField}
            style={iStyle}
            type="date"
            value={f.settle_date}
            onChange={set("settle_date")}
          />
        </div>
        <div>
          <Label colors={colors}>ORDER NO.</Label>
          <input
            className={iField}
            style={iStyle}
            placeholder="OPTBLO…"
            value={f.order_ref}
            onChange={set("order_ref")}
          />
        </div>
      </div>

      {f.action === "CLOSE" && (
        <div className="space-y-1">
          <div className="flex items-center gap-3 flex-wrap">
            <Label colors={colors}>เหตุผลการปิด</Label>
            <Toggle
              colors={colors}
              value={f.close_reason}
              options={[
                { v: "TRADE", label: f.side === "SELL" ? "ขาย" : "ซื้อคืน", color: colors.accent },
                { v: "EXPIRED", label: "หมดอายุ", color: "#f87171" },
                { v: "EXERCISED", label: "ใช้สิทธิ์", color: "#c084fc" },
                { v: "ASSIGNED", label: "ถูก assign", color: "#c084fc" },
              ]}
              onPick={(v) => setF((x) => ({ ...x, close_reason: v }))}
            />
          </div>
          <div className="flex items-center gap-3 text-[9px]">
            <span style={{ color: colors.textSecondary }}>ล็อตที่จะปิด:</span>
            {(["fifo", "pick"] as const).map((m) => (
              <button
                type="button"
                key={m}
                onClick={() => setF((x) => ({ ...x, pick: m === "pick" }))}
                style={{ color: f.pick === (m === "pick") ? colors.accent : colors.textSecondary }}
              >
                {m === "fifo" ? "FIFO ตามเวลา fill" : "เลือกเอง"}
              </button>
            ))}
          </div>
          {lots.length === 0 ? (
            <div className="text-[9px]" style={{ color: "#fbbf24" }}>
              ไม่มีล็อต {f.side === "SELL" ? "long" : "short"} ของสัญญานี้ในบัญชี — ตรวจ strike / expiry
            </div>
          ) : (
            <table className="text-[9px] font-mono">
              <tbody>
                {lots.map((l) => (
                  <tr
                    key={l.id}
                    style={{ color: matchedIds.has(l.id) ? colors.text : colors.textSecondary }}
                  >
                    <td className="pr-3">{l.entry_date}</td>
                    <td className="pr-3">@{fmtPx(l.entry_price)}</td>
                    <td className="pr-3">คงเหลือ {fmtQty(Math.abs(l.quantity))}</td>
                    <td>
                      {f.pick ? (
                        <NumInput
                          className="text-[9px] font-mono px-1 border outline-none w-16"
                          style={iStyle}
                          step="any"
                          placeholder="0"
                          value={f.picks[l.id] ?? ""}
                          onChange={(e) =>
                            setF((x) => ({ ...x, picks: { ...x.picks, [l.id]: e.target.value } }))
                          }
                        />
                      ) : matchedIds.has(l.id) ? (
                        "← ปิด"
                      ) : (
                        ""
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div>
        <Label colors={colors} color="#facc15">
          ค่าธรรมเนียม (ต่อคำสั่ง, USD) — รวม {fmtAmt(feeTotal)}
        </Label>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
          {FEES.map((fe) => (
            <div key={fe.key} title={fe.hint}>
              <div className="text-[8px]" style={{ color: colors.textSecondary }}>
                {fe.label}
              </div>
              <NumInput
                className={iField}
                style={{ ...iStyle, color: "#facc15" }}
                step="any"
                placeholder="0.00"
                value={f.fees[fe.key] ?? ""}
                onChange={(e) =>
                  setF((x) => ({ ...x, fees: { ...x.fees, [fe.key]: e.target.value } }))
                }
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <Label colors={colors}>NOTE</Label>
        <input className={iField} style={iStyle} value={f.note} onChange={set("note")} />
      </div>

      {/* What SAVE will book — computed by the same code that books it */}
      {(preview || previewErr) && (
        <div className="text-[9px] font-mono space-y-0.5">
          {previewErr ? (
            <div style={{ color: "#f87171" }}>✗ {previewErr}</div>
          ) : (
            preview && (
              <>
                <div style={{ color: colors.textSecondary }}>
                  มูลค่าสัญญา {fmtAmt(preview.gross)} · ค่าธรรมเนียม {fmtAmt(preview.fees)} · เงินสด{" "}
                  <span style={{ color: pnlColor(preview.cash_effect) }}>
                    {preview.cash_effect >= 0 ? "+" : ""}
                    {fmtAmt(preview.cash_effect)}
                  </span>
                </div>
                {preview.matches.map((m) => (
                  <div key={m.open_trade_id} style={{ color: colors.textSecondary }}>
                    ปิดล็อต {m.entry_date} @{fmtPx(m.entry_price)} × {fmtQty(m.quantity)} · fees{" "}
                    {fmtAmt(m.fees_alloc)} · P&L{" "}
                    <span style={{ color: pnlColor(m.realized_pnl) }}>
                      {m.realized_pnl == null ? "ไม่ทราบราคา" : fmtAmt(m.realized_pnl)}
                    </span>
                  </div>
                ))}
                {preview.realized_total != null && (
                  <div className="font-bold" style={{ color: pnlColor(preview.realized_total) }}>
                    REALIZED {preview.realized_total >= 0 ? "+" : ""}
                    {fmtAmt(preview.realized_total)} (หักค่าธรรมเนียมทั้งขาเปิดและขาปิด)
                  </div>
                )}
              </>
            )
          )}
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={saving || !ready || !!previewErr}
          className="flex items-center gap-1.5 text-[10px] px-4 py-1.5 font-bold hover:opacity-80 disabled:opacity-40"
          style={{ color: colors.accent }}
        >
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <CheckCircle className="h-3 w-3" />
          )}
          {saving ? "SAVING…" : "SAVE OPTION FILL"}
        </button>
        <button
          type="button"
          onClick={() => {
            setF(blank(f.account_id));
            setShas([]);
            setSaved("");
            setSaveErr("");
          }}
          className="text-[9px] hover:opacity-80"
          style={{ color: colors.textSecondary }}
        >
          CLEAR
        </button>
        {shas.length > 0 && (
          <span className="text-[8px]" style={{ color: colors.textSecondary }}>
            หลักฐาน: สลิป {shas.length} ภาพ
          </span>
        )}
        {saved && (
          <span
            className="text-[10px] font-bold flex items-center gap-1"
            style={{ color: "#4ade80" }}
          >
            <CheckCircle className="h-3 w-3" /> {saved}
          </span>
        )}
        {saveErr && (
          <span className="text-[9px] flex items-center gap-1" style={{ color: "#f87171" }}>
            <AlertTriangle className="h-3 w-3" /> {saveErr}
          </span>
        )}
      </div>
    </div>
  );
}
