"use client";
import { useEffect, useRef, useState } from "react";
import type { Colors } from "../helpers";

// Broker order-slip screenshot → ENTRY fields (backend/slip_ocr/). It only
// fills the form; the person still reads it over and presses SAVE.

export interface SlipCheck {
  id: string;
  level: "ok" | "warn" | "error";
  message: string;
}

export interface SlipForm {
  instrument?: "stock";
  side: "buy" | "sell";
  account_hint: string | null;
  symbol: string;
  volume: string;
  note: string;
  broker_order_ref: string | null;
  executed_at: string | null;
  fee_breakdown: Record<string, string> | null;
  date_entry?: string;
  price_entry?: string;
  fee_entry?: string;
  date_exit?: string;
  price_exit?: string;
  fee_exit?: string;
}

/** An option order slip (slip_ocr/parsers/dime_option.py). */
export interface OptionSlipForm {
  instrument: "option";
  side: "buy" | "sell" | "";
  account_hint: string | null;
  underlying: string;
  option_type: "call" | "put" | "";
  strike: string;
  expiry: string;
  contracts: string;
  multiplier: string;
  price: string;
  limit_price: string | null;
  trade_date: string;
  executed_at: string | null;
  submitted_at: string | null;
  settle_date: string | null;
  broker_order_ref: string | null;
  order_type: string | null;
  fee_items: { component: string; amount: string }[];
  fee_total: string;
  note: string;
}

export interface SlipResult {
  engine: string;
  broker: string | null;
  status: "ok" | "review" | "fail";
  form: SlipForm | OptionSlipForm | null;
  checks: SlipCheck[];
  warnings: string[];
  duplicates?: { id: string; symbol: string; date_entry: string; volume: number }[];
  image_sha256?: string;
  /** Every screenshot of the order, top to bottom. */
  image_sha256s?: string[];
}

export const isOptionSlip = (f: SlipResult["form"]): f is OptionSlipForm =>
  !!f && (f as OptionSlipForm).instrument === "option";

const LEVEL = {
  ok: { mark: "✓", color: "#4ade80" },
  warn: { mark: "!", color: "#fbbf24" },
  error: { mark: "✗", color: "#f87171" },
} as const;

export function SlipReader({
  colors,
  onFill,
}: {
  colors: Colors;
  onFill: (r: SlipResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [warm, setWarm] = useState<boolean | null>(null);
  const [result, setResult] = useState<SlipResult | null>(null);
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const onFillRef = useRef(onFill);
  onFillRef.current = onFill;

  useEffect(() => {
    fetch("/api/v2/portfolio/slip/status")
      .then((r) => r.json())
      .then((d) => {
        setWarm(Boolean(d.ocr_loaded));
        // Load the model while the person finds the screenshot.
        if (!d.ocr_loaded) fetch("/api/v2/portfolio/slip/warm", { method: "POST" }).catch(() => {});
      })
      .catch(() => setWarm(null));
  }, []);

  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  // Screenshots of the order being read. A long option slip needs its top and
  // bottom half: after a result that is not "ok", the next image is taken as
  // the rest of the SAME order and all of them are read together.
  const [pages, setPages] = useState<File[]>([]);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const resultRef = useRef(result);
  resultRef.current = result;

  const read = async (incoming: File[], mode: "auto" | "append" | "new" = "auto") => {
    const files = incoming.filter((f) => f.type.startsWith("image/"));
    if (!files.length) {
      setError("Not an image — drop a PNG / JPG / WEBP screenshot");
      return;
    }
    const append =
      mode === "append" ||
      (mode === "auto" && pagesRef.current.length > 0 && resultRef.current?.status !== "ok");
    const all = (append ? [...pagesRef.current, ...files] : files).slice(0, 4);
    setPages(all);
    setBusy(true);
    setElapsed(0);
    setError("");
    setResult(null);
    try {
      const fd = new FormData();
      for (const f of all) fd.append("files", f);
      const r = await fetch("/api/v2/portfolio/slip/read", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) {
        setError(d.detail || d.error || "Slip read failed");
        return;
      }
      const res = d as SlipResult;
      setResult(res);
      setWarm(true);
      if (res.form) onFillRef.current(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  };
  const readRef = useRef(read);
  readRef.current = read;

  // Ctrl+V a screenshot anywhere on the tab — unless the caret is in a field.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith("image/")
      );
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        readRef.current([file]);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const statusColor =
    result?.status === "ok" ? "#4ade80" : result?.status === "review" ? "#fbbf24" : "#f87171";

  return (
    <div className="space-y-1.5">
      {/* biome-ignore lint/a11y/useSemanticElements: drop zone, not a control */}
      <div
        role="button"
        tabIndex={0}
        className="border border-dashed px-3 py-2 cursor-pointer flex items-center gap-3"
        style={{ borderColor: over ? colors.accent : colors.border }}
        onClick={() => !busy && fileRef.current?.click()}
        onKeyDown={(e) => e.key === "Enter" && !busy && fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const fs = Array.from(e.dataTransfer.files);
          if (fs.length && !busy) read(fs, fs.length > 1 ? "new" : "auto");
        }}
      >
        <span className="text-[10px] font-bold tracking-widest" style={{ color: colors.accent }}>
          SLIP → FILL
        </span>
        <span className="text-[9px]" style={{ color: colors.textSecondary }}>
          {busy
            ? `อ่านสลิป… ${elapsed}s${warm === false ? " (ครั้งแรกโหลดโมเดล OCR)" : ""}`
            : "วางภาพ (Ctrl+V) · ลากไฟล์มาวาง · คลิกเลือก — Dime order detail หุ้น / ออปชัน · สลิปยาวส่งได้ 2 ภาพ (บน+ล่าง) · OCR ในเครื่อง"}
        </span>
      </div>
      {pages.length > 0 && !busy && (
        <div className="flex items-center gap-3 text-[9px]" style={{ color: colors.textSecondary }}>
          <span>
            {pages.length} ภาพของคำสั่งนี้
            {result?.status !== "ok" && " — ภาพถัดไปจะรวมเป็นคำสั่งเดียวกัน"}
          </span>
          <button
            type="button"
            className="hover:opacity-70"
            style={{ color: colors.accent }}
            onClick={() => {
              setPages([]);
              setResult(null);
              setError("");
            }}
          >
            เริ่มสลิปใหม่
          </button>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? []);
          if (fs.length) read(fs, fs.length > 1 ? "new" : "auto");
          e.target.value = "";
        }}
      />

      {error && (
        <div className="text-[9px]" style={{ color: "#f87171" }}>
          ✗ {error}
        </div>
      )}

      {result && (
        <div className="text-[9px] font-mono space-y-0.5">
          <div>
            <span style={{ color: statusColor }} className="font-bold">
              {result.status === "ok"
                ? "READ OK — ตรวจแล้ว ตัวเลขสอดคล้องกันทุกข้อ"
                : result.status === "review"
                  ? "REVIEW — เติมแล้ว แต่ต้องตรวจช่องที่เตือน"
                  : "FAIL — อ่านไม่ได้พอจะเติมฟอร์ม"}
            </span>
            {result.broker && (
              <span style={{ color: colors.textSecondary }}> · {result.broker}</span>
            )}
          </div>
          {result.checks.map((c) => (
            <div key={c.id} style={{ color: colors.textSecondary }}>
              <span style={{ color: LEVEL[c.level].color }}>{LEVEL[c.level].mark}</span> {c.message}
            </div>
          ))}
          {result.warnings.map((w) => (
            <div key={w} style={{ color: "#fbbf24" }}>
              ! {w}
            </div>
          ))}
          {!!result.duplicates?.length && (
            <div style={{ color: "#f87171" }} className="font-bold">
              ✗ เลขที่คำสั่งนี้บันทึกไปแล้ว:{" "}
              {result.duplicates
                .map((d) => `${d.symbol} ${d.date_entry} × ${d.volume}`)
                .join(" · ")}{" "}
              — อย่าบันทึกซ้ำ
            </div>
          )}
        </div>
      )}
    </div>
  );
}
