"use client";
import { Loader2, Upload } from "lucide-react";
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
  const busyRef = useRef(busy);
  busyRef.current = busy;
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

  // ENTRY is the drop target while this reader is mounted. The full-screen
  // hint appears only during a file drag; the resting control stays compact.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = busyRef.current ? "none" : "copy";
      setOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setOver(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setOver(false);
      if (busyRef.current) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void readRef.current(files, files.length > 1 ? "new" : "auto");
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
    };
  }, []);

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
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-[9px]" style={{ color: colors.textSecondary }}>
          กรอกข้อมูล trade ทีละรายการ — P&amp;L คำนวณอัตโนมัติเมื่อกรอก Entry/Exit/Volume
        </span>
        <button
          type="button"
          disabled={busy}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-[9px] font-bold hover:opacity-75 disabled:cursor-not-allowed disabled:opacity-60"
          style={{ color: colors.accent }}
          title="ลากภาพสลิปมาวางที่หน้า ENTRY หรือคลิกเลือกไฟล์; Ctrl+V เพื่อวางภาพ รองรับหลายภาพของคำสั่งเดียวกัน"
          onClick={() => fileRef.current?.click()}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
          <span>{busy ? `อ่านสลิป… ${elapsed}s` : "SLIP · ลากวาง / คลิกเลือก"}</span>
        </button>
      </div>
      {busy && warm === false && (
        <div className="text-[9px]" style={{ color: colors.textSecondary }}>
          กำลังโหลดโมเดล OCR ครั้งแรก
        </div>
      )}
      {over && (
        <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-black/75">
          <div
            className="m-4 flex h-[calc(100%-2rem)] w-full items-center justify-center border-2 border-dashed text-sm font-bold"
            style={{ borderColor: colors.accent, color: colors.accent }}
          >
            {busy ? "กำลังอ่านสลิป" : "ปล่อยภาพสลิปเพื่อเติมข้อมูล"}
          </div>
        </div>
      )}
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
