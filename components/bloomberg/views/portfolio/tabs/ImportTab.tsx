"use client";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, Loader2, Upload } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type FeeEstimate, feeBreakdown, fetchFeeEstimate } from "../accounting-types";
import {
  BLANK_FORM,
  SECTORS_BY_ACCOUNT,
  SECTORS_BY_CURRENCY,
  STRATEGIES,
  TH_SECTORS,
} from "../constants";
import { type Colors, composeNote, fmtQty, splitNote } from "../helpers";
import { SellModal } from "../modals/SellModal";
import { portfolioQueries } from "../queries";
import type { Account, Trade } from "../types";
import { EntryValueCheck } from "../ui/EntryValueCheck";
import { GuardSizePicker } from "../ui/GuardSizePicker";
import { NumInput } from "../ui/NumInput";
import { OptionEntryForm, type OptionEntryPrefill } from "../ui/OptionEntryForm";
import {
  type OptionSlipForm,
  type SlipForm,
  SlipReader,
  type SlipResult,
  isOptionSlip,
} from "../ui/SlipReader";
import { SubPortSelect } from "../ui/SubPortSelect";
import { WalletSelect, useInvalidateLedger } from "../ui/ledger-client";
import { type ExtraField, type ExtraState, useEntryExtras } from "../ui/useEntryExtras";

const FALLBACK_ACCOUNTS: Account[] = [
  {
    id: "finansia",
    name: "FINANSIA",
    broker: "",
    country: "TH",
    currency: "THB",
    account_type: "equity",
  },
  { id: "dime", name: "DIME", broker: "", country: "US", currency: "USD", account_type: "equity" },
  {
    id: "innovestx",
    name: "INNOVESTX",
    broker: "",
    country: "CRYPTO",
    currency: "THB",
    account_type: "crypto",
  },
];

const COUNTRY_FLAG: Record<string, string> = { TH: "🇹🇭", US: "🇺🇸", CRYPTO: "₿" };

interface ResolveMatch {
  resolved_symbol: string;
  market: string;
  currency: string | null;
  name: string;
  exchange: string;
}

type ResolveState =
  | { status: "idle" | "loading" }
  | { status: "resolved"; picked: ResolveMatch; matches: ResolveMatch[] }
  | { status: "multi"; matches: ResolveMatch[] }
  | { status: "none"; override: boolean };

export function ImportTab({
  colors,
  variant = "full",
  optionPrefill = null,
}: {
  colors: Colors;
  variant?: "full" | "manual" | "excel";
  /** OPTIONS → ADD / CLOSE lands here with the contract filled in. */
  optionPrefill?: (OptionEntryPrefill & { seq: number }) | null;
}) {
  const [mode, setMode] = useState<"excel" | "manual">(variant === "manual" ? "manual" : "excel");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  // ENTRY is the one place a fill is typed in: a stock trade or an option fill.
  const [instrument, setInstrument] = useState<"stock" | "option">(
    optionPrefill ? "option" : "stock"
  );
  const [optionSlip, setOptionSlip] = useState<{
    form: OptionSlipForm;
    shas: string[];
    seq: number;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on seq — each OPTIONS click switches once
  useEffect(() => {
    if (optionPrefill) setInstrument("option");
  }, [optionPrefill?.seq]);
  const [accounts, setAccounts] = useState<Account[]>(FALLBACK_ACCOUNTS);

  useEffect(() => {
    fetch("/api/v2/portfolio/accounts")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d) && d.length) setAccounts(d);
      })
      .catch(() => {});
  }, []);

  // ── Excel state ──
  const [dragOver, setDragOver] = useState(false);
  const [xlLoading, setXlLoading] = useState(false);
  const [xlResult, setXlResult] = useState<{
    inserted: Record<string, number>;
    parsed?: Record<string, number>;
  } | null>(null);
  const [xlError, setXlError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Manual state ──
  const [form, setForm] = useState({ ...BLANK_FORM });
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [resolve, setResolve] = useState<ResolveState>({ status: "idle" });
  // Line items of the slip that filled the form; sent only while the fee the
  // slip filled is still the one in the field.
  const [slipFees, setSlipFees] = useState<{
    fee: string;
    side: "buy" | "sell";
    items: Record<string, string>;
  } | null>(null);
  // The slip the form came from: saved with the trade as its evidence (order
  // number, fill time, image) while the symbol is still the slip's.
  const [slipSrc, setSlipSrc] = useState<{ sha: string; symbol: string } | null>(null);
  // Ledger v2: the wallet this fill settles in ("" = auto: slip → rule → default)
  // and the account the slip printed, which the auto choice reads.
  const [wallet, setWallet] = useState("");
  const [slipWallet, setSlipWallet] = useState<string | null>(null);
  const invalidateLedger = useInvalidateLedger();
  // Optional fields start hidden: a trade needs account, symbol, date, price,
  // volume and strategy, and showing the other seven at once buries those six.
  const { extras, toggleExtra, showExtra } = useEntryExtras();

  // Keep form.account_id valid once real accounts load
  useEffect(() => {
    if (accounts.length && !accounts.some((a) => a.id === form.account_id)) {
      setForm((f) => ({ ...f, account_id: accounts[0].id }));
    }
  }, [accounts, form.account_id]);

  const activeAccount = accounts.find((a) => a.id === form.account_id);
  // TRADE GUARD: every new long carries a stop. It is filled for the user from
  // the guard's auto stop (GuardSizePicker) and stays editable; a DRIP buy is
  // not a trade and is exempt.
  const stopRequired = side === "buy" && instrument === "stock" && !form.is_reinvest;
  const showStop = extras.stop_loss || stopRequired;
  // Last value the guard wrote into STOP LOSS — while the field still holds it,
  // a new auto stop (price or symbol changed) replaces it; a typed stop is kept.
  const autoStop = useRef<string | null>(null);
  // Same for VOLUME: the RISK budget fills it until the user (or a slip) types one.
  const autoVolume = useRef<string | null>(null);
  // Per account, not per render: a slip switches the account and then looks the
  // sector up in the same tick — the render-time list was still the previous
  // account's (a Dime slip over FINANSIA got the SET code ETRON).
  const sectorListFor = (accountId: string) =>
    SECTORS_BY_ACCOUNT[accountId] ??
    SECTORS_BY_CURRENCY[accounts.find((a) => a.id === accountId)?.currency ?? ""] ??
    TH_SECTORS;
  const sectorList = sectorListFor(form.account_id);

  // The slip screenshots, shown large beside the form while they are being checked.
  const [slipPages, setSlipPages] = useState<File[]>([]);
  const [slipResetSeq, setSlipResetSeq] = useState(0);
  const [slipZoom, setSlipZoom] = useState(false);
  const slipUrls = useMemo(() => slipPages.map((f) => URL.createObjectURL(f)), [slipPages]);
  useEffect(
    () => () => {
      for (const u of slipUrls) URL.revokeObjectURL(u);
    },
    [slipUrls]
  );

  const switchSide = (s: "buy" | "sell") => {
    setSide(s);
    if (s === "buy")
      setForm((f) => ({
        ...f,
        date_exit: "",
        price_exit: "",
        pnl_amount: "",
        pnl_percent: "",
        exit_trigger: "",
        win_loss: "P",
      }));
  };

  const iField = "text-[10px] font-mono px-2 py-1 border outline-none w-full";
  const iStyle = { background: "#0a0a0a", color: colors.text, borderColor: colors.border };

  const set =
    (k: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  // Broker fee estimate for what is typed. The backend applies the same
  // estimate when a fee field is left blank, so the placeholder is exactly
  // what will be charged; a typed number (from the confirmation) wins.
  const [feeEst, setFeeEst] = useState<{ buy: FeeEstimate | null; sell: FeeEstimate | null }>({
    buy: null,
    sell: null,
  });
  const pickedMarket = resolve.status === "resolved" ? (resolve.picked?.market ?? "") : "";
  const pickedCcy = resolve.status === "resolved" ? (resolve.picked?.currency ?? "") : "";
  useEffect(() => {
    const vol = Number.parseFloat(form.volume);
    const pe = Number.parseFloat(form.price_entry);
    const px = Number.parseFloat(form.price_exit);
    if (!form.account_id || !form.symbol || !(vol > 0)) {
      setFeeEst({ buy: null, sell: null });
      return;
    }
    const ctl = new AbortController();
    const base = {
      account_id: form.account_id,
      symbol: form.symbol.toUpperCase(),
      qty: vol,
      ...(pickedMarket ? { market: pickedMarket } : {}),
      ...(pickedCcy ? { currency: pickedCcy } : {}),
    };
    const t = setTimeout(async () => {
      const [buy, sell] = await Promise.all([
        pe > 0 ? fetchFeeEstimate({ ...base, side: "BUY", price: pe }, ctl.signal) : null,
        side === "sell" && px > 0
          ? fetchFeeEstimate({ ...base, side: "SELL", price: px }, ctl.signal)
          : null,
      ]);
      if (!ctl.signal.aborted) setFeeEst({ buy, sell });
    }, 300);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [
    form.account_id,
    form.symbol,
    form.volume,
    form.price_entry,
    form.price_exit,
    side,
    pickedMarket,
    pickedCcy,
  ]);
  const feePlaceholder = (f: FeeEstimate | null) =>
    f?.total != null ? `auto ${f.total.toFixed(2)}` : "0.00";

  const calcPnl = (f: typeof BLANK_FORM) => {
    const pe = Number.parseFloat(f.price_entry);
    const px = Number.parseFloat(f.price_exit);
    const vol = Number.parseFloat(f.volume);
    if (!Number.isNaN(pe) && !Number.isNaN(px) && !Number.isNaN(vol) && pe > 0) {
      const pnl = (px - pe) * vol;
      const pct = ((px - pe) / pe) * 100;
      const autoWL = f.win_loss === "P" ? (pnl >= 0 ? "W" : "L") : f.win_loss;
      return { ...f, pnl_amount: pnl.toFixed(2), pnl_percent: pct.toFixed(4), win_loss: autoWL };
    }
    if (!f.price_exit && f.win_loss !== "P") return { ...f, win_loss: "P" };
    return f;
  };

  const handleNumBlur = () => setForm((f) => calcPnl(f));

  const autoFillSector = async (sym: string, accountId: string) => {
    const list = sectorListFor(accountId);
    try {
      const r = await fetch(`/api/stock/sector/${encodeURIComponent(sym)}`);
      if (!r.ok) return;
      const d = await r.json();
      // The backend answers in both vocabularies (SET codes and GICS labels)
      // plus the asset class, because a symbol alone cannot say which list the
      // account uses. Whichever candidate this account offers is the answer —
      // the two lists share only ETF and Other, so there is no ambiguity.
      const candidates: string[] = [d.set_sector, d.us_sector].filter(
        (x): x is string => typeof x === "string" && x.length > 0
      );
      const match = candidates.find((c) => list.includes(c));
      // Nothing decisive → leave it blank for the user rather than filing the
      // trade under a sector nobody chose.
      setForm((f) => ({ ...f, sector: match && match !== "Other" ? match : "" }));
    } catch {
      /* the picker stays on screen either way */
    }
  };

  const handleSymbolBlur = () => {
    resolveSymbol(form.symbol, form.account_id);
  };

  /** `fromSlip`: the broker printed the exact ticker, so among several
   *  listings (MU · MUY · MUU) the one that IS that ticker is taken — the
   *  sector can then fill without a click. Typed symbols still ask. */
  const resolveSymbol = async (raw: string, accountId: string, fromSlip = false) => {
    const sym = raw.trim().toUpperCase();
    if (!sym) return;
    setResolve({ status: "loading" });
    try {
      const r = await fetch(
        `/api/v2/portfolio/resolve-symbol?q=${encodeURIComponent(sym)}&account_id=${encodeURIComponent(accountId)}`
      );
      const d = await r.json();
      const matches: ResolveMatch[] = Array.isArray(d.matches) ? d.matches : [];
      if (matches.length === 1) {
        setResolve({ status: "resolved", picked: matches[0], matches });
        autoFillSector(matches[0].resolved_symbol, accountId);
      } else if (matches.length > 1) {
        const exact = fromSlip
          ? matches.filter((m) => m.resolved_symbol.toUpperCase() === sym)
          : [];
        if (exact.length === 1) {
          setResolve({ status: "resolved", picked: exact[0], matches });
          autoFillSector(exact[0].resolved_symbol, accountId);
        } else {
          setResolve({ status: "multi", matches });
        }
      } else {
        setResolve({ status: "none", override: false });
      }
    } catch {
      // resolver down → don't block the form, behave like before
      setResolve({ status: "none", override: true });
      autoFillSector(sym, accountId);
    }
  };

  const fillFromSlip = (res: SlipResult) => {
    if (isOptionSlip(res.form)) {
      setInstrument("option");
      setOptionSlip({
        form: res.form,
        shas: res.image_sha256s ?? (res.image_sha256 ? [res.image_sha256] : []),
        seq: Date.now(),
      });
      return;
    }
    const s = res.form as SlipForm | null;
    if (!s) return;
    setInstrument("stock");
    const accountId =
      s.account_hint && accounts.some((a) => a.id === s.account_hint)
        ? s.account_hint
        : form.account_id;
    setSide(s.side);
    setForm({
      ...BLANK_FORM,
      account_id: accountId,
      symbol: s.symbol,
      volume: s.volume,
      note: s.note,
      date_entry: s.date_entry ?? "",
      price_entry: s.price_entry ?? "",
      fee_entry: s.fee_entry ?? "",
      date_exit: s.date_exit ?? "",
      price_exit: s.price_exit ?? "",
      fee_exit: s.fee_exit ?? "",
    });
    const fee = (s.side === "buy" ? s.fee_entry : s.fee_exit) ?? "";
    setSlipFees(s.fee_breakdown && fee ? { fee, side: s.side, items: s.fee_breakdown } : null);
    setSlipSrc(res.image_sha256 ? { sha: res.image_sha256, symbol: s.symbol } : null);
    setSlipWallet(s.settlement_wallet ?? null);
    setWallet("");
    setSaveOk(false);
    setSaveErr("");
    // What the slip filled is on screen to be checked, not behind a toggle.
    if (fee) showExtra("vat");
    if (s.note) showExtra("note");
    if (s.symbol) resolveSymbol(s.symbol, accountId, true);
  };

  // A stock SELL of something the account holds is a sale from its lots —
  // the same /sell path as POSITIONS, so average cost and the lot history stay
  // one story. Typing the whole round trip is only for a position the book
  // never had.
  const heldQ = useQuery({
    ...portfolioQueries.openPositions("USD", form.account_id),
    enabled: instrument === "stock" && side === "sell" && !!form.symbol,
  });
  const heldLots: Trade[] = (heldQ.data?.positions ?? []).filter(
    (t) => t.symbol.toUpperCase() === form.symbol.trim().toUpperCase()
  );
  const heldQty = heldLots.reduce((s, l) => s + l.volume, 0);
  const heldAvg = heldQty
    ? heldLots.reduce((s, l) => s + l.volume * l.price_entry, 0) / heldQty
    : undefined;
  const [sellFromLots, setSellFromLots] = useState(false);

  const pickMatch = (m: ResolveMatch) => {
    setResolve((r) => ({
      status: "resolved",
      picked: m,
      matches: r.status === "multi" || r.status === "resolved" ? r.matches : [m],
    }));
    autoFillSector(m.resolved_symbol, form.account_id);
  };

  const doImport = async (file: File) => {
    if (!file.name.endsWith(".xlsx")) {
      setXlError("Please upload an .xlsx file");
      return;
    }
    setXlLoading(true);
    setXlResult(null);
    setXlError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/v2/portfolio/import/excel", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) setXlError(d.detail || d.error || "Import failed");
      else setXlResult(d);
    } catch (e: unknown) {
      setXlError(e instanceof Error ? e.message : "Network error");
    } finally {
      setXlLoading(false);
    }
  };

  const doSave = async () => {
    if (!form.symbol || !form.date_entry || !form.price_entry || !form.volume) {
      setSaveErr("Symbol, Date Entry, Price Entry and Volume are required");
      return;
    }
    if (stopRequired && !form.strategy_name) {
      // TRADE GUARD report: untagged buys held 18 of 21 rule breaks, and the
      // time stop needs the tag to know a Value/Core hold from a swing trade.
      setSaveErr("ไม้ซื้อต้องเลือก STRATEGY — ถือยาวให้เลือก Value หรือ Core");
      return;
    }
    if (stopRequired) {
      const sl = Number.parseFloat(form.price_stoploss);
      const px = Number.parseFloat(form.price_entry);
      if (!(sl > 0)) {
        setSaveErr("ไม้ซื้อต้องมี STOP LOSS — เลือกหุ้นให้ระบบกรอกให้ หรือพิมพ์เอง");
        return;
      }
      if (px > 0 && sl >= px) {
        setSaveErr("STOP LOSS ต้องต่ำกว่า PRICE ENTRY");
        return;
      }
    }
    if (side === "sell" && (!form.date_exit || !form.price_exit)) {
      setSaveErr("SELL trade requires Date Exit and Price Exit");
      return;
    }
    if (resolve.status === "multi") {
      setSaveErr("Symbol พบหลายตลาด — เลือกตัวที่ถูกต้องก่อนบันทึก");
      return;
    }
    if (resolve.status === "none" && !resolve.override) {
      setSaveErr("Symbol ไม่พบในตลาดของบัญชี — กด 'ใช้ตามที่พิมพ์' เพื่อยืนยัน");
      return;
    }
    setSaving(true);
    setSaveOk(false);
    setSaveErr("");
    try {
      const picked = resolve.status === "resolved" ? resolve.picked : null;
      const body: Record<string, unknown> = {
        account_id: form.account_id,
        symbol: form.symbol.toUpperCase(),
        resolved_symbol: picked?.resolved_symbol ?? null,
        market: picked?.market ?? null,
        currency: picked?.currency ?? null,
        sector: form.sector,
        date_entry: form.date_entry,
        date_exit: form.date_exit || null,
        price_entry: Number.parseFloat(form.price_entry) || 0,
        price_exit: form.price_exit ? Number.parseFloat(form.price_exit) : null,
        price_stoploss: form.price_stoploss ? Number.parseFloat(form.price_stoploss) : null,
        price_target: form.price_target ? Number.parseFloat(form.price_target) : null,
        volume: Number.parseFloat(form.volume) || 0,
        pnl_amount: form.pnl_amount ? Number.parseFloat(form.pnl_amount) : null,
        win_loss: form.win_loss,
        pnl_percent: form.pnl_percent ? Number.parseFloat(form.pnl_percent) : null,
        strategy_name: form.strategy_name,
        entry_trigger: form.entry_trigger,
        exit_trigger: form.exit_trigger,
        is_reinvest: form.is_reinvest,
        note: form.note,
        // Blank → the backend applies the broker estimate shown as placeholder.
        ...(form.fee_entry !== "" ? { fee_entry: Number.parseFloat(form.fee_entry) || 0 } : {}),
        ...(side === "sell" && form.fee_exit !== ""
          ? { fee_exit: Number.parseFloat(form.fee_exit) || 0 }
          : {}),
        ...(slipFees?.side === "buy" && slipFees.fee === form.fee_entry
          ? { fee_entry_breakdown: slipFees.items }
          : {}),
        ...(slipFees?.side === "sell" && side === "sell" && slipFees.fee === form.fee_exit
          ? { fee_exit_breakdown: slipFees.items }
          : {}),
        ...(slipSrc && slipSrc.symbol === form.symbol.toUpperCase()
          ? { slip_sha256: slipSrc.sha }
          : {}),
        ...(wallet ? { [side === "sell" ? "wallet_exit" : "wallet_entry"]: wallet } : {}),
        ...(slipWallet ? { settlement_label: slipWallet } : {}),
      };
      const r = await fetch("/api/v2/portfolio/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) {
        setSaveErr(d.detail || d.error || "Save failed");
        return;
      }
      setSaveOk(true);
      setForm({ ...BLANK_FORM, account_id: form.account_id });
      setResolve({ status: "idle" });
      setSlipFees(null);
      setSlipSrc(null);
      setWallet("");
      setSlipWallet(null);
      setSlipResetSeq((n) => n + 1);
      autoVolume.current = null;
      invalidateLedger();
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  const inputCls = `${iField} border`;

  return (
    // Fills the PORT content box and scrolls inside it. A fixed
    // `calc(100vh - 200px)` cut SAVE off on a phone, where the header rows are
    // taller than 200px and 100vh counts the browser's own toolbar; the bottom
    // pad keeps SAVE clear of the home indicator.
    <div
      className="h-full overflow-y-auto overscroll-contain"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 64px)" }}
    >
      {variant === "full" && (
        <div
          className="flex items-center gap-px px-3 pt-2 pb-0 border-b"
          style={{ borderColor: colors.border }}
        >
          {(["excel", "manual"] as const).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => setMode(m)}
              className="text-[9px] px-3 py-1 font-bold uppercase tracking-widest"
              style={{
                color: mode === m ? colors.accent : colors.textSecondary,
                borderBottom: mode === m ? `2px solid ${colors.accent}` : "2px solid transparent",
              }}
            >
              {m === "excel" ? "📥 EXCEL" : "✏️ MANUAL"}
            </button>
          ))}
        </div>
      )}

      {/* ── EXCEL MODE ── */}
      {mode === "excel" && (
        <div className="p-4 space-y-3">
          <div className="text-[9px]" style={{ color: colors.textSecondary }}>
            Supports:{" "}
            <span style={{ color: colors.text }}>
              Finansia · Dime · InnovestX · Income&amp;expenses
            </span>
            <span className="ml-2 opacity-60">— Idempotent, safe to re-run</span>
          </div>
          <button
            type="button"
            className="border-2 border-dashed flex flex-col items-center justify-center py-10 w-full cursor-pointer transition-all"
            style={{
              borderColor: dragOver ? colors.accent : colors.border,
              background: dragOver ? `${colors.accent}08` : "transparent",
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) doImport(f);
            }}
            onClick={() => fileRef.current?.click()}
          >
            {xlLoading ? (
              <Loader2 className="h-8 w-8 animate-spin mb-2" style={{ color: colors.accent }} />
            ) : (
              <Upload
                className="h-8 w-8 mb-2"
                style={{ color: dragOver ? colors.accent : colors.textSecondary }}
              />
            )}
            <div
              className="text-[11px] font-bold"
              style={{ color: dragOver ? colors.accent : colors.text }}
            >
              {xlLoading ? "Importing…" : "Drop Portfolio Performance.xlsx here"}
            </div>
            <div className="text-[9px] mt-1" style={{ color: colors.textSecondary }}>
              {xlLoading ? "Parsing sheets, please wait…" : "or click to browse"}
            </div>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) doImport(f);
            }}
          />
          {xlResult && (
            <div
              className="border p-3"
              style={{ borderColor: "#22c55e44", background: "#22c55e08" }}
            >
              <div
                className="flex items-center gap-1.5 text-[10px] font-bold mb-1"
                style={{ color: "#4ade80" }}
              >
                <CheckCircle className="h-3.5 w-3.5" /> Import successful
              </div>
              <div className="text-[9px] font-mono grid grid-cols-2 gap-x-4">
                {Object.entries(xlResult.inserted as Record<string, number>).map(([k, v]) => (
                  <span key={k} style={{ color: colors.textSecondary }}>
                    {k}: <span style={{ color: colors.text }}>{v} new</span>
                    {xlResult.parsed?.[k] !== undefined && (
                      <span> / {xlResult.parsed[k]} parsed</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}
          {xlError && (
            <div
              className="border p-3"
              style={{ borderColor: "#ef444444", background: "#ef444408" }}
            >
              <div className="flex items-center gap-1.5 text-[10px]" style={{ color: "#f87171" }}>
                <AlertTriangle className="h-3 w-3" /> {xlError}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── MANUAL MODE ── */}
      {mode === "manual" && (
        <div
          className={`p-3 gap-4 ${
            slipUrls.length
              ? "grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,44%)] items-start"
              : ""
          }`}
        >
          <div className="space-y-3 min-w-0">
            <SlipReader
              colors={colors}
              onFill={fillFromSlip}
              onPages={setSlipPages}
              resetSeq={slipResetSeq}
            />

            {/* What is being entered: instrument, then side */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-3">
                {(["stock", "option"] as const).map((k) => (
                  <button
                    type="button"
                    key={k}
                    onClick={() => setInstrument(k)}
                    className="text-[10px] font-bold tracking-widest"
                    style={{
                      color: instrument === k ? colors.accent : colors.textSecondary,
                      textDecoration: instrument === k ? "underline" : "none",
                      textUnderlineOffset: 3,
                    }}
                  >
                    {k === "stock" ? "หุ้น / ETF / CRYPTO" : "ออปชัน"}
                  </button>
                ))}
              </div>
              {instrument === "stock" && (
                <div className="flex items-center gap-1">
                  {(["buy", "sell"] as const).map((s) => {
                    const active = side === s;
                    const c = s === "buy" ? "#4ade80" : "#f87171";
                    return (
                      <button
                        type="button"
                        key={s}
                        onClick={() => switchSide(s)}
                        className="text-[10px] px-4 py-1 border font-bold tracking-widest"
                        style={{
                          borderColor: active ? c : colors.border,
                          color: active ? c : colors.textSecondary,
                          background: active ? `${c}18` : "transparent",
                        }}
                      >
                        {s === "buy" ? "▲ ซื้อ (BUY)" : "▼ ขาย (SELL)"}
                      </button>
                    );
                  })}
                  <span className="text-[8px] ml-2" style={{ color: colors.textSecondary }}>
                    {side === "buy"
                      ? "เปิดสถานะใหม่"
                      : heldQty > 0
                        ? "ขายจากล็อตที่ถืออยู่ — หรือบันทึกรอบเทรดย้อนหลังด้านล่าง"
                        : "บันทึกรอบเทรดที่ปิดแล้ว — ต้องมีวันและราคาขาย"}
                  </span>
                </div>
              )}
            </div>

            {instrument === "option" && (
              <OptionEntryForm
                colors={colors}
                accounts={accounts}
                defaultAccountId={accounts.find((a) => a.currency === "USD")?.id ?? form.account_id}
                slip={optionSlip}
                prefill={optionPrefill}
              />
            )}

            {instrument === "stock" && (
              <>
                {side === "sell" && heldQty > 0 && (
                  <div className="flex items-center gap-3 text-[9px] font-mono">
                    <span style={{ color: colors.text }}>
                      ถือ {form.symbol.toUpperCase()} อยู่ {fmtQty(heldQty)} หน่วย · {heldLots.length}{" "}
                      ล็อต
                    </span>
                    <button
                      type="button"
                      className="font-bold hover:opacity-80"
                      style={{ color: "#f87171" }}
                      onClick={() => setSellFromLots(true)}
                    >
                      ▼ ขายจากล็อตที่ถืออยู่
                    </button>
                  </div>
                )}
                {sellFromLots && heldLots.length > 0 && (
                  <SellModal
                    target={heldLots[0]}
                    avgEntry={heldAvg}
                    allLots={heldLots}
                    settlementLabel={slipWallet}
                    colors={colors}
                    onClose={() => setSellFromLots(false)}
                    onSold={() => {
                      setSellFromLots(false);
                      heldQ.refetch();
                      setSaveOk(true);
                    }}
                  />
                )}

                {/* 1 · WHAT */}
                <Section
                  n={1}
                  title="หุ้นและบัญชี"
                  hint="เลือกบัญชี พิมพ์ symbol แล้วกด Tab — sector เติมให้เอง"
                  colors={colors}
                  right={
                    <AddToggles
                      ids={["sub_port"]}
                      extras={extras}
                      onToggle={toggleExtra}
                      colors={colors}
                    />
                  }
                >
                  <div className="grid gap-2 grid-cols-1 sm:grid-cols-3">
                    <Field label="บัญชี" required colors={colors}>
                      <select
                        className={inputCls}
                        style={iStyle}
                        value={form.account_id}
                        onChange={(e) => {
                          const acc = e.target.value;
                          // The sector came from the old account's list (ETRON vs
                          // Information Technology): drop it if the new list lacks
                          // it, and look the symbol up again in the new market.
                          setForm((f) => ({
                            ...f,
                            account_id: acc,
                            sector: sectorListFor(acc).includes(f.sector) ? f.sector : "",
                          }));
                          setResolve({ status: "idle" });
                          if (form.symbol.trim()) resolveSymbol(form.symbol, acc);
                        }}
                      >
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {COUNTRY_FLAG[a.country] ?? "🌐"} {a.name.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="SYMBOL" required colors={colors}>
                      <input
                        className={inputCls}
                        style={iStyle}
                        placeholder="เช่น SCB, AAPL, BTCTHB"
                        value={form.symbol}
                        onChange={(e) => {
                          setResolve({ status: "idle" });
                          set("symbol")(e);
                        }}
                        onBlur={handleSymbolBlur}
                      />
                    </Field>
                    <Field label="SECTOR" note="auto" colors={colors}>
                      <select
                        className={inputCls}
                        style={iStyle}
                        value={form.sector}
                        onChange={set("sector")}
                      >
                        <option value="">— เลือก —</option>
                        {sectorList.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>

                  {/* Symbol resolver status */}
                  {resolve.status !== "idle" && (
                    <div className="space-y-1">
                      {resolve.status === "loading" && (
                        <span
                          className="inline-flex items-center gap-1 text-[9px]"
                          style={{ color: colors.textSecondary }}
                        >
                          <Loader2 className="h-3 w-3 animate-spin" /> กำลังค้นหา symbol…
                        </span>
                      )}
                      {resolve.status === "resolved" && (
                        <span
                          className="inline-flex items-center gap-1.5 text-[9px] font-mono px-2 py-0.5 border"
                          style={{
                            borderColor: "#22c55e44",
                            background: "#22c55e10",
                            color: "#4ade80",
                          }}
                        >
                          <CheckCircle className="h-3 w-3" />
                          {resolve.picked.resolved_symbol} · {resolve.picked.market}
                          {resolve.picked.currency ? ` · ${resolve.picked.currency}` : ""}
                          {resolve.picked.name ? ` — ${resolve.picked.name}` : ""}
                        </span>
                      )}
                      {resolve.status === "multi" && (
                        <div
                          className="border"
                          style={{ borderColor: colors.border, maxWidth: 420 }}
                        >
                          <div
                            className="text-[8px] px-2 py-1 font-bold"
                            style={{ color: "#facc15", borderBottom: `1px solid ${colors.border}` }}
                          >
                            พบ {resolve.matches.length} ตลาด — เลือกตัวที่ถูกต้อง
                          </div>
                          {resolve.matches.map((m) => (
                            <button
                              type="button"
                              key={m.resolved_symbol}
                              onClick={() => pickMatch(m)}
                              className="flex w-full items-center justify-between px-2 py-1 text-[9px] font-mono hover:opacity-70"
                              style={{
                                color: colors.text,
                                borderBottom: `1px solid ${colors.border}`,
                              }}
                            >
                              <span>
                                {m.resolved_symbol}
                                <span className="ml-2" style={{ color: colors.textSecondary }}>
                                  {m.name}
                                </span>
                              </span>
                              <span style={{ color: colors.textSecondary }}>
                                {m.exchange || m.market}
                                {m.currency ? ` · ${m.currency}` : ""}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                      {resolve.status === "none" && (
                        <span className="inline-flex items-center gap-2 text-[9px]">
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 border"
                            style={{
                              borderColor: "#facc1544",
                              background: "#facc1510",
                              color: "#facc15",
                            }}
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {resolve.override
                              ? `จะบันทึกเป็น "${form.symbol.toUpperCase()}" ตามที่พิมพ์`
                              : "ไม่พบ symbol ในตลาดของบัญชีนี้"}
                          </span>
                          {!resolve.override && (
                            <button
                              type="button"
                              className="px-2 py-0.5 border text-[9px] hover:opacity-80"
                              style={{ borderColor: colors.border, color: colors.textSecondary }}
                              onClick={() => setResolve({ status: "none", override: true })}
                            >
                              ใช้ตามที่พิมพ์
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap items-end gap-3">
                    {form.account_id && (
                      <div className="w-full max-w-xs">
                        <WalletSelect
                          accountId={form.account_id}
                          currency={
                            (resolve.status === "resolved" ? resolve.picked.currency : null) ??
                            activeAccount?.currency
                          }
                          symbol={form.symbol}
                          label={slipWallet}
                          value={wallet}
                          onChange={setWallet}
                          colors={colors}
                          caption={side === "sell" ? "WALLET (เงินขายเข้า)" : "WALLET (ตัดเงินจาก)"}
                        />
                      </div>
                    )}
                    {extras.sub_port && (
                      <div style={{ width: 220 }}>
                        <Field label="SUB-PORT" colors={colors}>
                          <SubPortSelect
                            accountId={form.account_id}
                            value={splitNote(form.note).subPort}
                            onChange={(v) =>
                              setForm((f) => ({
                                ...f,
                                note: composeNote(v, splitNote(f.note).rest),
                              }))
                            }
                            colors={colors}
                            inputStyle={{
                              ...iStyle,
                              padding: "3px 6px",
                              fontSize: 10,
                              width: "100%",
                              border: `1px solid ${colors.border}`,
                            }}
                          />
                        </Field>
                      </div>
                    )}
                    <label
                      className="flex items-center gap-1.5 cursor-pointer text-[9px] font-bold select-none pb-1"
                      style={{ color: form.is_reinvest ? "#c084fc" : colors.textSecondary }}
                      title="ซื้อจากปันผล (DRIP) — แสดงใน CASH → REINVEST และไม่ต้องมี stop"
                    >
                      <input
                        type="checkbox"
                        className="w-3 h-3 accent-purple-400"
                        checked={form.is_reinvest}
                        onChange={(e) => setForm((f) => ({ ...f, is_reinvest: e.target.checked }))}
                      />
                      ซื้อจากปันผล (REINVEST)
                    </label>
                  </div>
                </Section>

                {/* 2 · PRICE & SIZE */}
                <Section
                  n={2}
                  title={side === "sell" ? "ราคา จำนวน และผล" : "ราคาและจำนวน"}
                  hint="ค่าธรรมเนียมเว้นว่าง = ใช้ประมาณการของโบรก"
                  colors={colors}
                  right={
                    <AddToggles
                      ids={["vat"]}
                      extras={extras}
                      onToggle={toggleExtra}
                      colors={colors}
                    />
                  }
                >
                  <div className="grid gap-2 grid-cols-1 sm:grid-cols-3">
                    <Field label="วันที่ซื้อ" required colors={colors}>
                      <input
                        type="date"
                        className={inputCls}
                        style={iStyle}
                        value={form.date_entry}
                        onChange={set("date_entry")}
                      />
                    </Field>
                    <Field label="ราคาซื้อ" required colors={colors}>
                      <NumInput
                        className={inputCls}
                        style={iStyle}
                        placeholder="0.00"
                        step="any"
                        value={form.price_entry}
                        onChange={set("price_entry")}
                        onBlur={handleNumBlur}
                      />
                    </Field>
                    <Field
                      label="จำนวน (VOLUME)"
                      required
                      note={
                        autoVolume.current != null && form.volume === autoVolume.current
                          ? "จาก SIZE / RISK"
                          : undefined
                      }
                      colors={colors}
                    >
                      <NumInput
                        className={inputCls}
                        style={iStyle}
                        placeholder="0"
                        step="any"
                        value={form.volume}
                        onChange={set("volume")}
                        onBlur={handleNumBlur}
                      />
                    </Field>
                  </div>
                  {side === "sell" && (
                    <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
                      <Field label="วันที่ขาย" required colors={colors}>
                        <input
                          type="date"
                          className={inputCls}
                          style={iStyle}
                          value={form.date_exit}
                          onChange={set("date_exit")}
                        />
                      </Field>
                      <Field label="ราคาขาย" required colors={colors}>
                        <NumInput
                          className={inputCls}
                          style={iStyle}
                          placeholder="0.00"
                          step="any"
                          value={form.price_exit}
                          onChange={set("price_exit")}
                          onBlur={handleNumBlur}
                        />
                      </Field>
                      <Field label="กำไร/ขาดทุน" note="auto" colors={colors}>
                        <NumInput
                          allowNegative
                          className={inputCls}
                          style={{
                            ...iStyle,
                            color: form.pnl_amount
                              ? Number.parseFloat(form.pnl_amount) >= 0
                                ? "#4ade80"
                                : "#f87171"
                              : colors.text,
                          }}
                          placeholder="auto"
                          step="any"
                          value={form.pnl_amount}
                          onChange={set("pnl_amount")}
                        />
                      </Field>
                      <Field label="ผล" required colors={colors}>
                        <select
                          className={inputCls}
                          style={iStyle}
                          value={form.win_loss}
                          onChange={set("win_loss")}
                        >
                          <option value="P">P — ยังถือ</option>
                          <option value="W">W — กำไร</option>
                          <option value="L">L — ขาดทุน</option>
                        </select>
                      </Field>
                    </div>
                  )}
                  {extras.vat && (
                    <div className="grid gap-2 grid-cols-2 sm:grid-cols-3">
                      <Field
                        label="ค่าธรรมเนียมซื้อ"
                        title={feeBreakdown(feeEst.buy)}
                        color="#facc15"
                        colors={colors}
                      >
                        <NumInput
                          className={inputCls}
                          style={{ ...iStyle, color: "#facc15" }}
                          placeholder={feePlaceholder(feeEst.buy)}
                          step="any"
                          value={form.fee_entry}
                          onChange={set("fee_entry")}
                        />
                      </Field>
                      {side === "sell" && (
                        <Field
                          label="ค่าธรรมเนียมขาย"
                          title={feeBreakdown(feeEst.sell)}
                          color="#facc15"
                          colors={colors}
                        >
                          <NumInput
                            className={inputCls}
                            style={{ ...iStyle, color: "#facc15" }}
                            placeholder={feePlaceholder(feeEst.sell)}
                            step="any"
                            value={form.fee_exit}
                            onChange={set("fee_exit")}
                          />
                        </Field>
                      )}
                    </div>
                  )}
                  {(feeEst.buy?.total != null || feeEst.sell?.total != null) && (
                    <div className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
                      FEES · {feeEst.buy?.basis ?? feeEst.sell?.basis}
                      {feeEst.buy?.total != null &&
                        ` · ซื้อ ${(form.fee_entry !== "" ? Number.parseFloat(form.fee_entry) || 0 : feeEst.buy.total).toFixed(2)} (${form.fee_entry !== "" ? "พิมพ์เอง" : feeBreakdown(feeEst.buy)})`}
                      {side === "sell" &&
                        feeEst.sell?.total != null &&
                        ` · ขาย ${(form.fee_exit !== "" ? Number.parseFloat(form.fee_exit) || 0 : feeEst.sell.total).toFixed(2)} (${form.fee_exit !== "" ? "พิมพ์เอง" : feeBreakdown(feeEst.sell)})`}
                      {" · "}ไม่รวมในต้นทุน; P&amp;L หักค่าธรรมเนียมขายแล้ว
                    </div>
                  )}
                  {form.pnl_amount && (
                    <div
                      className="text-[10px] font-mono text-right"
                      style={{
                        color: Number.parseFloat(form.pnl_amount) >= 0 ? "#4ade80" : "#f87171",
                      }}
                    >
                      P&L: {Number.parseFloat(form.pnl_amount) >= 0 ? "+" : ""}
                      {Number.parseFloat(form.pnl_amount).toFixed(2)}
                      {form.pnl_percent &&
                        ` (${Number.parseFloat(form.pnl_percent) >= 0 ? "+" : ""}${Number.parseFloat(form.pnl_percent).toFixed(2)}%)`}
                    </div>
                  )}
                </Section>

                {/* 3 · RISK */}
                {(side === "buy" || showStop || extras.target) && (
                  <Section
                    n={3}
                    title="ความเสี่ยงและขนาด"
                    hint={
                      stopRequired
                        ? "ไม้ซื้อต้องมี stop — ระบบเติมให้ (2×ATR) แก้เองได้ · ใส่ 'เสียได้ ฿' เพื่อให้คำนวณจำนวนหุ้น"
                        : undefined
                    }
                    colors={colors}
                    right={
                      <AddToggles
                        ids={stopRequired ? ["target"] : ["stop_loss", "target"]}
                        extras={extras}
                        onToggle={toggleExtra}
                        colors={colors}
                      />
                    }
                  >
                    {(showStop || extras.target) && (
                      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3">
                        {showStop && (
                          <Field
                            label="STOP LOSS"
                            required={stopRequired}
                            note={
                              stopRequired &&
                              autoStop.current != null &&
                              form.price_stoploss === autoStop.current
                                ? "auto"
                                : undefined
                            }
                            color="#f87171"
                            colors={colors}
                          >
                            <NumInput
                              className={inputCls}
                              style={{ ...iStyle, color: "#f87171" }}
                              placeholder="0.00"
                              step="any"
                              value={form.price_stoploss}
                              onChange={set("price_stoploss")}
                            />
                          </Field>
                        )}
                        {extras.target && (
                          <Field label="เป้าหมาย (TARGET)" color="#4ade80" colors={colors}>
                            <NumInput
                              className={inputCls}
                              style={{ ...iStyle, color: "#4ade80" }}
                              placeholder="0.00"
                              step="any"
                              value={form.price_target}
                              onChange={set("price_target")}
                            />
                          </Field>
                        )}
                      </div>
                    )}
                    {side === "buy" && resolve.status !== "resolved" && (
                      <div className="text-[9px]" style={{ color: colors.textSecondary }}>
                        เลือก symbol ให้ระบบหาเจอก่อน (กรอบเขียว ✓) แล้ว SIZE / RISK จะขึ้นตรงนี้
                      </div>
                    )}
                    {side === "buy" && resolve.status === "resolved" && (
                      <GuardSizePicker
                        symbol={resolve.picked.resolved_symbol}
                        price={Number.parseFloat(form.price_entry) || null}
                        currency={pickedCcy || activeAccount?.currency || null}
                        accountId={form.account_id}
                        manualStop={
                          form.price_stoploss !== autoStop.current
                            ? Number.parseFloat(form.price_stoploss) || null
                            : null
                        }
                        formStop={Number.parseFloat(form.price_stoploss) || null}
                        colors={colors}
                        onVolume={(v) => {
                          // A picked volume (S/M/L, a RISK row) is still the picker's, not
                          // typed — so a later RISK answer may replace it.
                          const val = String(Number(v.toFixed(7)));
                          autoVolume.current = val;
                          setForm((f) => calcPnl({ ...f, volume: val }));
                        }}
                        onAutoVolume={(v) => {
                          const val = String(Number(v.toFixed(7)));
                          setForm((f) => {
                            const typed =
                              f.volume !== "" &&
                              f.volume !== "0" &&
                              f.volume !== autoVolume.current;
                            if (typed) return f;
                            autoVolume.current = val;
                            return calcPnl({ ...f, volume: val });
                          });
                        }}
                        onStop={(stop) => {
                          showExtra("stop_loss");
                          const v = String(Number(stop.toFixed(4)));
                          autoStop.current = v;
                          setForm((f) => ({ ...f, price_stoploss: v }));
                        }}
                        onAutoStop={(stop) => {
                          const v = String(Number(stop.toFixed(4)));
                          setForm((f) => {
                            if (f.price_stoploss !== "" && f.price_stoploss !== autoStop.current)
                              return f;
                            autoStop.current = v;
                            return { ...f, price_stoploss: v };
                          });
                        }}
                      />
                    )}
                  </Section>
                )}

                {/* 4 · WHY */}
                <Section
                  n={side === "buy" || showStop || extras.target ? 4 : 3}
                  title="เหตุผล"
                  colors={colors}
                  right={
                    <AddToggles
                      ids={["entry_trigger", "note"]}
                      extras={extras}
                      onToggle={toggleExtra}
                      colors={colors}
                    />
                  }
                >
                  <div className="grid gap-2 grid-cols-1 sm:grid-cols-3">
                    <Field
                      label="STRATEGY"
                      required={stopRequired}
                      note={stopRequired ? "ถือยาว = Value / Core" : undefined}
                      colors={colors}
                    >
                      <select
                        className={inputCls}
                        style={iStyle}
                        value={form.strategy_name}
                        onChange={set("strategy_name")}
                      >
                        <option value="">— เลือก —</option>
                        {STRATEGIES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {extras.entry_trigger && (
                      <Field label="เหตุผลที่ซื้อ (ENTRY TRIGGER)" colors={colors}>
                        <input
                          className={inputCls}
                          style={iStyle}
                          placeholder="เช่น ทะลุ high 52 สัปดาห์"
                          value={form.entry_trigger}
                          onChange={set("entry_trigger")}
                        />
                      </Field>
                    )}
                    {side === "sell" && (
                      <Field label="เหตุผลที่ขาย (EXIT TRIGGER)" colors={colors}>
                        <input
                          className={inputCls}
                          style={iStyle}
                          placeholder="เช่น ถึงเป้า, โดน stop"
                          value={form.exit_trigger}
                          onChange={set("exit_trigger")}
                        />
                      </Field>
                    )}
                  </div>
                  {extras.note && (
                    <Field label="NOTE" colors={colors}>
                      <textarea
                        className="text-[10px] font-mono px-2 py-1 border outline-none w-full resize-none"
                        style={{ ...iStyle, height: 48 }}
                        placeholder="บันทึกเพิ่มเติม…"
                        value={splitNote(form.note).rest}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            note: composeNote(splitNote(f.note).subPort, e.target.value),
                          }))
                        }
                      />
                    </Field>
                  )}
                </Section>

                <EntryValueCheck
                  side={side}
                  symbol={form.symbol}
                  price={side === "sell" ? form.price_exit : form.price_entry}
                  qty={form.volume}
                  fee={side === "sell" ? form.fee_exit : form.fee_entry}
                  estimate={side === "sell" ? feeEst.sell : feeEst.buy}
                  slipItems={
                    slipFees &&
                    slipFees.side === side &&
                    slipFees.fee === (side === "sell" ? form.fee_exit : form.fee_entry)
                      ? slipFees.items
                      : null
                  }
                  currency={pickedCcy || activeAccount?.currency || ""}
                  colors={colors}
                />

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={doSave}
                    disabled={saving}
                    className="flex items-center gap-1.5 text-[10px] px-4 py-1.5 border font-bold hover:opacity-80 disabled:opacity-40"
                    style={{
                      borderColor: colors.accent,
                      color: colors.accent,
                      background: `${colors.accent}18`,
                    }}
                  >
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle className="h-3 w-3" />
                    )}
                    {saving ? "กำลังบันทึก…" : "บันทึก (SAVE TRADE)"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setForm({ ...BLANK_FORM, account_id: form.account_id });
                      setResolve({ status: "idle" });
                      setSlipFees(null);
                      setSlipSrc(null);
                      setSlipWallet(null);
                      setWallet("");
                      setSlipResetSeq((n) => n + 1);
                      autoVolume.current = null;
                      setSaveOk(false);
                      setSaveErr("");
                    }}
                    className="text-[9px] px-3 py-1.5 border hover:opacity-80"
                    style={{ borderColor: colors.border, color: colors.textSecondary }}
                    title="ล้างฟอร์มและสลิป — ภาพถัดไปเริ่มรายการใหม่"
                  >
                    ล้าง (CLEAR)
                  </button>
                  {saveOk && (
                    <span
                      className="text-[10px] font-bold flex items-center gap-1"
                      style={{ color: "#4ade80" }}
                    >
                      <CheckCircle className="h-3 w-3" /> บันทึกแล้ว — วางสลิปถัดไปได้เลย
                    </span>
                  )}
                  {saveErr && (
                    <span
                      className="text-[9px] flex items-center gap-1"
                      style={{ color: "#f87171" }}
                    >
                      <AlertTriangle className="h-3 w-3" /> {saveErr}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>

          {/* The slip, large, beside the form — only while one is loaded */}
          {slipUrls.length > 0 && (
            <aside
              className="lg:sticky lg:top-0 border min-w-0"
              style={{ borderColor: colors.border, background: "#050505" }}
            >
              <div
                className="flex items-center justify-between gap-2 px-2 py-1 border-b text-[9px]"
                style={{ borderColor: colors.border }}
              >
                <span className="font-bold tracking-widest" style={{ color: colors.accent }}>
                  สลิป{slipUrls.length > 1 ? ` · ${slipUrls.length} ภาพ` : ""}
                </span>
                <span style={{ color: colors.textSecondary }}>เทียบตัวเลขกับฟอร์มด้านซ้าย</span>
                <button
                  type="button"
                  onClick={() => setSlipZoom((z) => !z)}
                  className="hover:opacity-80"
                  style={{ color: colors.accent }}
                >
                  {slipZoom ? "พอดีจอ" : "ขยาย 100%"}
                </button>
              </div>
              <div
                className="overflow-auto p-2 space-y-2"
                style={{ maxHeight: "calc(100vh - 160px)" }}
              >
                {slipUrls.map((u, i) => (
                  <img
                    key={u}
                    src={u}
                    alt={`สลิปภาพที่ ${i + 1}`}
                    className={slipZoom ? "max-w-none" : "w-full h-auto object-contain"}
                  />
                ))}
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

/** One numbered block of the ENTRY form: what it is for, then its fields. */
function Section({
  n,
  title,
  hint,
  right,
  colors,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  right?: ReactNode;
  colors: Colors;
  children: ReactNode;
}) {
  return (
    <section className="border" style={{ borderColor: colors.border }}>
      <header
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 py-1 border-b"
        style={{ borderColor: colors.border, background: "#0d0d0d" }}
      >
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
            {n} · {title}
          </span>
          {hint && (
            <span className="text-[8px]" style={{ color: colors.textSecondary }}>
              {hint}
            </span>
          )}
        </div>
        {right}
      </header>
      <div className="p-2 space-y-2">{children}</div>
    </section>
  );
}

/** A labelled input. `required` adds the red star; `note` a dim remark. */
function Field({
  label,
  required,
  note,
  title,
  color,
  colors,
  children,
}: {
  label: string;
  required?: boolean;
  note?: string;
  title?: string;
  color?: string;
  colors: Colors;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div
        className="text-[8px] mb-0.5 font-bold tracking-wider"
        style={{ color: color ?? colors.textSecondary }}
        title={title}
      >
        {label}
        {required && <span style={{ color: "#f87171" }}> *</span>}
        {note && (
          <span className="font-normal" style={{ color: colors.textDimmed }}>
            {" "}
            · {note}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

const EXTRA_LABEL: Partial<Record<ExtraField, string>> = {
  stop_loss: "STOP LOSS",
  target: "TARGET",
  entry_trigger: "ENTRY TRIGGER",
  vat: "ค่าธรรมเนียม",
  sub_port: "SUB-PORT",
  note: "NOTE",
};

/** The optional fields that belong to one section, as + / − switches. */
function AddToggles({
  ids,
  extras,
  onToggle,
  colors,
}: {
  ids: ExtraField[];
  extras: ExtraState;
  onToggle: (id: ExtraField) => void;
  colors: Colors;
}) {
  return (
    <div className="flex items-center gap-3">
      {ids.map((id) => (
        <button
          type="button"
          key={id}
          onClick={() => onToggle(id)}
          className="text-[8px] font-bold tracking-wider hover:opacity-80"
          style={{ color: extras[id] ? colors.accent : colors.textSecondary }}
        >
          {extras[id] ? "−" : "+"} {EXTRA_LABEL[id] ?? id}
        </button>
      ))}
    </div>
  );
}
