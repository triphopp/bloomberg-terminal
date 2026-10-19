"use client";

// The bank transfer slip a deposit is made with: attach the picture, the
// machine reads it (OCR on this computer), and the fields are shown beside the
// picture to be checked and corrected. What is saved is what the user left in
// the fields, with the picture kept as evidence. A reading is a suggestion —
// names in particular are often a letter off. A broker ORDER slip (Dime) is
// told apart by the reader and not attached: it belongs in ENTRY.
// Ctrl+V a screenshot anywhere on the page works as well as drag / attach.

import { useEffect, useRef, useState } from "react";
import type { Colors } from "../portfolio/helpers";
import { type SlipFields, type SlipRead, fundApi } from "./api";

export interface AttachedSlip {
  sha256: string;
  bank: string | null;
  fields: SlipFields;
  unread: (keyof SlipFields)[];
  duplicates: SlipRead["duplicates"];
  saysComplete: boolean;
  readError?: string;
}

/** What a freshly read slip puts into the deposit form. */
export interface SlipFill {
  amount: string | null;
  date: string | null;
  ref: string | null;
}

const LABELS: { key: keyof SlipFields; label: string; width: string }[] = [
  { key: "transferred_at", label: "วันเวลาที่โอน", width: "w-40" },
  { key: "ref_code", label: "รหัสอ้างอิง", width: "w-56" },
  { key: "amount", label: "จำนวนเงิน (บาท)", width: "w-28" },
  { key: "from_name", label: "ผู้โอน", width: "w-44" },
  { key: "from_account", label: "บัญชีผู้โอน", width: "w-32" },
  { key: "to_name", label: "ผู้รับ", width: "w-44" },
  { key: "to_account", label: "บัญชีผู้รับ", width: "w-32" },
  { key: "memo", label: "บันทึกช่วยจำ", width: "w-40" },
];

export function SlipBox({
  colors,
  fundId,
  slip,
  onChange,
  onOpenEntry,
}: {
  colors: Colors;
  fundId: string;
  slip: AttachedSlip | null;
  onChange: (slip: AttachedSlip | null, filled?: SlipFill) => void;
  /** A broker order slip was dropped here: open the fund's ENTRY page. */
  onOpenEntry?: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [orderSlip, setOrderSlip] = useState(false);
  const [over, setOver] = useState(false);

  const read = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErr("ไม่ใช่รูปภาพ — ใช้ PNG / JPG / WEBP");
      return;
    }
    setBusy(true);
    setErr("");
    setOrderSlip(false);
    try {
      const out = await fundApi.readSlip(fundId, file);
      const r = out.reading;
      if (r.kind === "trade") {
        setOrderSlip(true);
        return;
      }
      const fields: SlipFields = {
        transferred_at: r.transferred_at,
        ref_code: r.ref_code,
        from_name: r.from_name,
        from_account: r.from_account,
        to_name: r.to_name,
        to_account: r.to_account,
        amount: r.amount,
        memo: r.memo,
      };
      onChange(
        {
          sha256: out.sha256,
          bank: r.bank,
          fields,
          unread: r.unread ?? [],
          duplicates: out.duplicates ?? [],
          saysComplete: !!r.says_complete,
          readError: r.error,
        },
        {
          amount: r.amount,
          date: r.transferred_at ? r.transferred_at.slice(0, 10) : null,
          ref: r.ref_code,
        }
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const readRef = useRef(read);
  readRef.current = read;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // Ctrl+V a screenshot anywhere while DEPOSITS is open, as on PORT → ENTRY.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (busyRef.current) return;
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith("image/")
      );
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        void readRef.current(file);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const dim = { color: colors.textSecondary };
  const input = "px-2 py-1 text-[11px] border bg-transparent";

  return (
    <div
      className="mb-2 p-2 border"
      style={{
        borderColor: over ? colors.accent : colors.border,
        borderStyle: slip ? "solid" : "dashed",
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        read(e.dataTransfer.files?.[0]);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => read(e.target.files?.[0])}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="px-2 py-1 text-[10px] font-bold border disabled:opacity-40"
          style={{ borderColor: colors.accent, color: colors.accent }}
        >
          {slip ? "เปลี่ยนสลิป" : "แนบสลิปโอนเงิน"}
        </button>
        {slip && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="px-2 py-1 text-[10px] border"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            เอาสลิปออก
          </button>
        )}
        <span className="text-[10px]" style={dim}>
          {busy
            ? "กำลังอ่านสลิป… (ครั้งแรกอาจใช้เวลาสักครู่)"
            : slip
              ? "ระบบอ่านให้แล้ว — ตรวจทุกช่องเทียบกับรูปก่อนบันทึก แก้ได้ทุกช่อง"
              : "ลากรูปมาวาง · Ctrl+V · หรือกดแนบ · อ่านบนเครื่องนี้ ไม่ส่งออกไปที่ใด · ไม่แนบก็บันทึกเงินเข้าได้"}
        </span>
      </div>
      {err && (
        <div className="mt-1 text-[11px]" style={{ color: colors.negative }}>
          {err}
        </div>
      )}
      {orderSlip && (
        <div className="mt-1 text-[11px]" style={{ color: "#fbbf24" }}>
          รูปนี้เป็นสลิปคำสั่งซื้อขาย ไม่ใช่สลิปโอนเงิน — ไม่ได้แนบกับเงินเข้า
          {onOpenEntry && (
            <button
              type="button"
              className="ml-2 font-bold hover:opacity-75"
              style={{ color: colors.accent }}
              onClick={onOpenEntry}
            >
              → บันทึกที่ ENTRY
            </button>
          )}
        </div>
      )}

      {slip && (
        <div className="mt-2 flex flex-wrap gap-3">
          <a
            href={fundApi.slipImage(fundId, slip.sha256)}
            target="_blank"
            rel="noreferrer"
            title="เปิดรูปเต็ม"
            className="shrink-0"
          >
            <img
              src={fundApi.slipImage(fundId, slip.sha256)}
              alt="สลิปโอนเงิน"
              className="h-44 w-auto border"
              style={{ borderColor: colors.border }}
            />
          </a>
          <div className="flex-1 min-w-[320px]">
            <div className="flex flex-wrap items-end gap-2">
              {LABELS.map(({ key, label, width }) => {
                const missing = slip.unread.includes(key) && !slip.fields[key];
                return (
                  <label key={key} className="flex flex-col gap-1 text-[11px]">
                    <span style={{ color: missing ? colors.accentWarn : colors.textSecondary }}>
                      {label}
                      {missing ? " — อ่านไม่ได้" : ""}
                    </span>
                    <input
                      value={slip.fields[key] ?? ""}
                      onChange={(e) =>
                        onChange({
                          ...slip,
                          fields: { ...slip.fields, [key]: e.target.value || null },
                        })
                      }
                      className={`${input} ${width}`}
                      style={{
                        borderColor: missing ? colors.accentWarn : colors.border,
                        color: colors.text,
                      }}
                    />
                  </label>
                );
              })}
            </div>
            <div className="mt-1 text-[10px]" style={dim}>
              {slip.bank ? `ธนาคารบนสลิป: ${slip.bank} · ` : ""}
              ผู้รับบันทึกตามที่สลิประบุ ระบบไม่ตัดสินว่าต้องเป็นบัญชีใด
            </div>
            {!slip.saysComplete && !slip.readError && (
              <div className="mt-1 text-[10px]" style={{ color: colors.accentWarn }}>
                ไม่พบคำว่า "โอนเงินสำเร็จ" บนรูปนี้ — ตรวจว่าเป็นสลิปที่โอนสำเร็จแล้ว
              </div>
            )}
            {slip.readError && (
              <div className="mt-1 text-[10px]" style={{ color: colors.accentWarn }}>
                อ่านรูปอัตโนมัติไม่ได้ ({slip.readError}) — รูปถูกเก็บแล้ว กรอกช่องเองได้
              </div>
            )}
            {slip.duplicates.length > 0 && (
              <div className="mt-1 text-[11px]" style={{ color: colors.negative }}>
                สลิปนี้ถูกใช้กับรายการเงินเข้าแล้ว:{" "}
                {slip.duplicates.map((d) => `${d.date} ${d.amount} ${d.currency}`).join(", ")} —
                หนึ่งการโอนคือหนึ่งรายการ ระบบจะไม่ให้บันทึกซ้ำ
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
