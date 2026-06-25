"use client";
import { AlertTriangle, CheckCircle, Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import {
  BLANK_FORM,
  SECTORS_BY_ACCOUNT,
  SECTORS_BY_CURRENCY,
  STRATEGIES,
  TH_SECTORS,
} from "../constants";
import type { Colors } from "../helpers";

export function ImportTab({ colors }: { colors: Colors }) {
  const [mode, setMode] = useState<"excel" | "manual">("excel");

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

  const iField = "text-[10px] font-mono px-2 py-1 border outline-none w-full";
  const iStyle = { background: "#0a0a0a", color: colors.text, borderColor: colors.border };

  const set =
    (k: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const toggleOption = (checked: boolean) =>
    setForm((f) => ({
      ...f,
      is_option: checked,
      sector: checked ? `Option — ${f.option_direction} ${f.option_type}` : "",
    }));

  const setOptionAttr = (key: "option_type" | "option_direction", val: string) =>
    setForm((f) => {
      const next = { ...f, [key]: val };
      next.sector = `Option — ${next.option_direction} ${next.option_type}`;
      return next;
    });

  const autoVat = () => {
    const pe = Number.parseFloat(form.price_entry);
    const vol = Number.parseFloat(form.volume);
    if (!Number.isNaN(pe) && !Number.isNaN(vol) && pe > 0 && vol > 0)
      setForm((f) => ({ ...f, vat_amount: (pe * vol * 0.07).toFixed(2) }));
  };

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

  const handleSymbolBlur = async () => {
    const sym = form.symbol.trim().toUpperCase();
    if (!sym || form.is_option) return;
    try {
      const r = await fetch(`/api/stock/sector/${encodeURIComponent(sym)}`);
      if (!r.ok) return;
      const d = await r.json();
      const rawSector: string = d.sector ?? "";
      if (!rawSector) return;
      const sectorList = SECTORS_BY_ACCOUNT[form.account_id] ?? TH_SECTORS;
      const match = sectorList.find((s) =>
        s.toLowerCase().includes(rawSector.toLowerCase().split(" ")[0])
      );
      if (match) setForm((f) => ({ ...f, sector: match }));
    } catch {
      /* silent */
    }
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
    setSaving(true);
    setSaveOk(false);
    setSaveErr("");
    try {
      const body: Record<string, unknown> = {
        account_id: form.account_id,
        symbol: form.symbol.toUpperCase(),
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
        note: [
          form.note,
          form.vat_amount ? `VAT: ${Number.parseFloat(form.vat_amount).toFixed(2)}` : "",
        ]
          .filter(Boolean)
          .join(" | "),
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
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  const inputCls = `${iField} border`;

  return (
    <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 200px)" }}>
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
        <div className="p-3 space-y-3">
          <div className="text-[9px]" style={{ color: colors.textSecondary }}>
            กรอกข้อมูล trade ทีละรายการ — P&amp;L คำนวณอัตโนมัติเมื่อกรอก Entry/Exit/Volume
          </div>

          <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr 1fr 80px" }}>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                ACCOUNT *
              </div>
              <select
                className={inputCls}
                style={iStyle}
                value={form.account_id}
                onChange={set("account_id")}
              >
                <option value="finansia">🇹🇭 FINANSIA</option>
                <option value="dime">🇺🇸 DIME</option>
                <option value="innovestx">₿ INNOVESTX</option>
              </select>
            </div>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                SYMBOL *
              </div>
              <input
                className={inputCls}
                style={iStyle}
                placeholder="e.g. SCB, AAPL, BTCTHB"
                value={form.symbol}
                onChange={set("symbol")}
                onBlur={handleSymbolBlur}
              />
            </div>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                SECTOR
              </div>
              {form.is_option ? (
                <div
                  className="text-[9px] px-2 py-1 border font-mono"
                  style={{ ...iStyle, border: `1px solid ${colors.border}`, color: "#ff9900" }}
                >
                  {form.sector || "Option — ?"}
                </div>
              ) : (
                <select
                  className={inputCls}
                  style={iStyle}
                  value={form.sector}
                  onChange={set("sector")}
                >
                  <option value="">— select —</option>
                  {(SECTORS_BY_ACCOUNT[form.account_id] ?? []).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                {form.is_option ? "STATUS *" : "W/L/P *"}
              </div>
              <select
                className={inputCls}
                style={iStyle}
                value={form.win_loss}
                onChange={set("win_loss")}
              >
                {form.is_option ? (
                  <>
                    <option value="P">Open</option>
                    <option value="W">Exercised</option>
                    <option value="L">Expired</option>
                  </>
                ) : (
                  <>
                    <option value="P">P — Open</option>
                    <option value="W">W — Win</option>
                    <option value="L">L — Loss</option>
                  </>
                )}
              </select>
            </div>
          </div>

          {/* Option toggle + attributes */}
          <div className="flex items-center gap-3 flex-wrap">
            <label
              className="flex items-center gap-1.5 cursor-pointer text-[9px] font-bold select-none"
              style={{ color: form.is_option ? "#ff9900" : colors.textSecondary }}
            >
              <input
                type="checkbox"
                className="w-3 h-3 accent-orange-400"
                checked={form.is_option}
                onChange={(e) => toggleOption(e.target.checked)}
              />
              IS OPTION?
            </label>

            {form.is_option && (
              <>
                {/* Direction: Long / Short */}
                <div className="flex items-center gap-1">
                  <span className="text-[8px]" style={{ color: colors.textSecondary }}>
                    DIR:
                  </span>
                  {(["Long", "Short"] as const).map((d) => (
                    <button
                      type="button"
                      key={d}
                      className="text-[8px] px-2 py-0.5 border font-bold"
                      style={{
                        borderColor:
                          form.option_direction === d
                            ? d === "Long"
                              ? "#60a5fa"
                              : "#c084fc"
                            : colors.border,
                        color:
                          form.option_direction === d
                            ? d === "Long"
                              ? "#60a5fa"
                              : "#c084fc"
                            : colors.textSecondary,
                        background:
                          form.option_direction === d
                            ? d === "Long"
                              ? "#60a5fa18"
                              : "#c084fc18"
                            : "transparent",
                      }}
                      onClick={() => setOptionAttr("option_direction", d)}
                    >
                      {d}
                    </button>
                  ))}
                </div>

                {/* Type: Call / Put */}
                <div className="flex items-center gap-1">
                  <span className="text-[8px]" style={{ color: colors.textSecondary }}>
                    TYPE:
                  </span>
                  {(["Call", "Put"] as const).map((t) => (
                    <button
                      type="button"
                      key={t}
                      className="text-[8px] px-2 py-0.5 border font-bold"
                      style={{
                        borderColor:
                          form.option_type === t
                            ? t === "Call"
                              ? "#4ade80"
                              : "#f87171"
                            : colors.border,
                        color:
                          form.option_type === t
                            ? t === "Call"
                              ? "#4ade80"
                              : "#f87171"
                            : colors.textSecondary,
                        background:
                          form.option_type === t
                            ? t === "Call"
                              ? "#4ade8018"
                              : "#f8717118"
                            : "transparent",
                      }}
                      onClick={() => setOptionAttr("option_type", t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>

                {/* Sector preview */}
                <span
                  className="text-[8px] font-mono px-2 py-0.5 rounded"
                  style={{
                    background: "#ff990015",
                    color: "#ff9900",
                    border: "1px solid #ff990033",
                  }}
                >
                  {form.sector || "Option — ?"}
                </span>
              </>
            )}
          </div>

          <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr" }}>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                DATE ENTRY *
              </div>
              <input
                type="date"
                className={inputCls}
                style={iStyle}
                value={form.date_entry}
                onChange={set("date_entry")}
              />
            </div>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                DATE EXIT
              </div>
              <input
                type="date"
                className={inputCls}
                style={iStyle}
                value={form.date_exit}
                onChange={set("date_exit")}
              />
            </div>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                PRICE ENTRY *
              </div>
              <input
                className={inputCls}
                style={iStyle}
                placeholder="0.00"
                type="number"
                step="any"
                value={form.price_entry}
                onChange={set("price_entry")}
                onBlur={handleNumBlur}
              />
            </div>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                PRICE EXIT
              </div>
              <input
                className={inputCls}
                style={iStyle}
                placeholder="0.00"
                type="number"
                step="any"
                value={form.price_exit}
                onChange={set("price_exit")}
                onBlur={handleNumBlur}
              />
            </div>
          </div>

          <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr" }}>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                VOLUME *
              </div>
              <input
                className={inputCls}
                style={iStyle}
                placeholder="0"
                type="number"
                step="any"
                value={form.volume}
                onChange={set("volume")}
                onBlur={handleNumBlur}
              />
            </div>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                P&L AMOUNT
              </div>
              <input
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
                type="number"
                step="any"
                value={form.pnl_amount}
                onChange={set("pnl_amount")}
              />
            </div>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                STOP LOSS
              </div>
              <input
                className={inputCls}
                style={{ ...iStyle, color: "#f87171" }}
                placeholder="0.00"
                type="number"
                step="any"
                value={form.price_stoploss}
                onChange={set("price_stoploss")}
              />
            </div>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                TARGET
              </div>
              <input
                className={inputCls}
                style={{ ...iStyle, color: "#4ade80" }}
                placeholder="0.00"
                type="number"
                step="any"
                value={form.price_target}
                onChange={set("price_target")}
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[8px] font-bold tracking-wider" style={{ color: "#facc15" }}>
                  VAT
                </span>
                <button
                  type="button"
                  className="text-[7px] px-1 py-0 border font-bold hover:opacity-80"
                  style={{ borderColor: "#facc1544", color: "#facc15", background: "#facc1510" }}
                  onClick={autoVat}
                  title="Auto 7%"
                >
                  7%
                </button>
              </div>
              <input
                className={inputCls}
                style={{ ...iStyle, color: "#facc15" }}
                placeholder="0.00"
                type="number"
                step="any"
                value={form.vat_amount}
                onChange={set("vat_amount")}
              />
            </div>
          </div>

          <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                STRATEGY
              </div>
              <select
                className={inputCls}
                style={iStyle}
                value={form.strategy_name}
                onChange={set("strategy_name")}
              >
                <option value="">— select —</option>
                {STRATEGIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                ENTRY TRIGGER
              </div>
              <input
                className={inputCls}
                style={iStyle}
                placeholder="e.g. Breakout above 52W high"
                value={form.entry_trigger}
                onChange={set("entry_trigger")}
              />
            </div>
            <div>
              <div
                className="text-[8px] mb-0.5 font-bold tracking-wider"
                style={{ color: colors.textSecondary }}
              >
                EXIT TRIGGER
              </div>
              <input
                className={inputCls}
                style={iStyle}
                placeholder="e.g. Target hit, SL hit"
                value={form.exit_trigger}
                onChange={set("exit_trigger")}
              />
            </div>
          </div>

          <div>
            <div
              className="text-[8px] mb-0.5 font-bold tracking-wider"
              style={{ color: colors.textSecondary }}
            >
              NOTE
            </div>
            <textarea
              className="text-[10px] font-mono px-2 py-1 border outline-none w-full resize-none"
              style={{ ...iStyle, height: 48 }}
              placeholder="บันทึกเพิ่มเติม…"
              value={form.note}
              onChange={set("note")}
            />
          </div>

          {form.pnl_amount && (
            <div
              className="text-[10px] font-mono text-right"
              style={{ color: Number.parseFloat(form.pnl_amount) >= 0 ? "#4ade80" : "#f87171" }}
            >
              P&L: {Number.parseFloat(form.pnl_amount) >= 0 ? "+" : ""}
              {Number.parseFloat(form.pnl_amount).toFixed(2)}
              {form.pnl_percent &&
                ` (${Number.parseFloat(form.pnl_percent) >= 0 ? "+" : ""}${Number.parseFloat(form.pnl_percent).toFixed(2)}%)`}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
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
              {saving ? "SAVING…" : "SAVE TRADE"}
            </button>
            <button
              type="button"
              onClick={() => {
                setForm({ ...BLANK_FORM, account_id: form.account_id });
                setSaveOk(false);
                setSaveErr("");
              }}
              className="text-[9px] px-3 py-1.5 border hover:opacity-80"
              style={{ borderColor: colors.border, color: colors.textSecondary }}
            >
              CLEAR
            </button>
            {saveOk && (
              <span
                className="text-[10px] font-bold flex items-center gap-1"
                style={{ color: "#4ade80" }}
              >
                <CheckCircle className="h-3 w-3" /> Saved!
              </span>
            )}
            {saveErr && (
              <span className="text-[9px] flex items-center gap-1" style={{ color: "#f87171" }}>
                <AlertTriangle className="h-3 w-3" /> {saveErr}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
