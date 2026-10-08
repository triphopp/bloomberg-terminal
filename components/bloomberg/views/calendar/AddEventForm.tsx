"use client";
import { useState } from "react";
import type { Colors } from "../portfolio/helpers";
import { NOTE_KINDS, NOTE_KIND_COLOR, type NoteKind } from "../portfolio/tabs/theses/types";
import type { CalThesis } from "./types";

/** What a new event starts from — the day clicked, or a macro / company event
 *  the user is tying to a thesis. */
export interface AddDraft {
  date: string;
  title: string;
  thesisId: string;
  body?: string;
  symbol?: string;
}

const DATE_KINDS = [
  ["EVENT", "เหตุการณ์"],
  ["EARNINGS", "งบ"],
  ["FILING", "filing"],
  ["DATA_RELEASE", "ข้อมูล"],
  ["OTHER", "อื่น ๆ"],
] as const;

const IMPACTS = [
  ["", "—"],
  ["bull", "bull"],
  ["bear", "bear"],
  ["mixed", "mixed"],
] as const;

function problem(d: unknown, status: number): string {
  const detail = (d as { detail?: unknown })?.detail;
  if (typeof detail === "string") return detail;
  const missing = (detail as { missing?: unknown })?.missing;
  if (Array.isArray(missing)) return missing.join(" · ");
  return `บันทึกไม่ได้ (HTTP ${status})`;
}

/**
 * Add a date from the calendar. Nothing new is invented to hold it: with a
 * thesis chosen it is a dated note on that thesis (THESES → NOTES shows the
 * same row); without one it is a row of the question calendar, which asks where
 * the date came from.
 */
export function AddEventForm({
  initial,
  theses,
  colors,
  onSaved,
  onCancel,
}: {
  initial: AddDraft;
  theses: CalThesis[];
  colors: Colors;
  onSaved: (date: string) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(initial.date);
  const [title, setTitle] = useState(initial.title);
  const [thesisId, setThesisId] = useState(initial.thesisId);
  const [body, setBody] = useState(initial.body ?? "");
  const [noteKind, setNoteKind] = useState<NoteKind>("CATALYST");
  const [impact, setImpact] = useState("");
  const [dateKind, setDateKind] = useState("EVENT");
  const [symbol, setSymbol] = useState(initial.symbol ?? "");
  const [source, setSource] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input = { background: "#0a0a0a", color: colors.text, borderColor: colors.border } as const;
  const cls = "border px-1.5 py-1 text-[9px] outline-none";
  const label = "text-[8px]";
  const dim = { color: colors.textSecondary };
  const can = title.trim().length > 0 && date.length === 10 && !busy;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = thesisId
        ? await fetch(`/api/v2/theses/${thesisId}/notes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: noteKind,
              title: title.trim(),
              body,
              impact: impact || null,
              watch_date: date,
              status: "open",
            }),
          })
        : await fetch("/api/v2/questions/calendar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: title.trim(),
              date,
              status: confirmed ? "CONFIRMED" : "ESTIMATED",
              source: source.trim() || "บันทึกเอง",
              source_url: sourceUrl.trim(),
              symbol: symbol.trim() || null,
              kind: dateKind,
              note: body,
            }),
          });
      if (!r.ok) {
        setError(problem(await r.json().catch(() => ({})), r.status));
        return;
      }
      onSaved(date);
    } catch {
      setError("เชื่อมต่อ backend ไม่ได้");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border p-2 space-y-1.5" style={{ borderColor: colors.accent }}>
      <div className="flex gap-1">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="วันที่"
          className={cls}
          style={input}
        />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="เกิดอะไรขึ้นวันนั้น — บรรทัดเดียว"
          aria-label="หัวข้อ"
          className={`${cls} flex-1 min-w-0`}
          style={input}
        />
      </div>

      <div className="flex flex-col gap-0.5">
        <span className={label} style={dim}>
          ผูกกับ thesis
        </span>
        <select
          value={thesisId}
          onChange={(e) => setThesisId(e.target.value)}
          className={cls}
          style={input}
        >
          <option value="">— ไม่ผูก (วันที่ในปฏิทินรวม) —</option>
          {theses.map((t) => (
            <option key={t.id} value={t.id}>
              {t.symbol} — {t.title}
            </option>
          ))}
        </select>
      </div>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          thesisId ? "ทำไมวันนี้สำคัญกับ thesis นี้ จะดูอะไร และถ้าออกมาแบบไหนจะทำอะไร" : "หมายเหตุ (ไม่บังคับ)"
        }
        rows={3}
        className={`${cls} w-full resize-y`}
        style={input}
      />

      {thesisId ? (
        <div className="flex gap-2 flex-wrap items-end">
          <div className="flex flex-col gap-0.5">
            <span className={label} style={dim}>
              ชนิดโน้ต
            </span>
            <select
              value={noteKind}
              onChange={(e) => setNoteKind(e.target.value as NoteKind)}
              className={cls}
              style={{ ...input, color: NOTE_KIND_COLOR[noteKind] }}
            >
              {NOTE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className={label} style={dim}>
              ผลต่อ thesis
            </span>
            <select
              value={impact}
              onChange={(e) => setImpact(e.target.value)}
              className={cls}
              style={input}
            >
              {IMPACTS.map(([v, text]) => (
                <option key={v} value={v}>
                  {text}
                </option>
              ))}
            </select>
          </div>
          <span className={label} style={dim}>
            บันทึกเป็นโน้ตของ thesis (THESES → NOTES)
          </span>
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="flex gap-1 flex-wrap">
            <select
              value={dateKind}
              onChange={(e) => setDateKind(e.target.value)}
              aria-label="ชนิดเหตุการณ์"
              className={cls}
              style={input}
            >
              {DATE_KINDS.map(([v, text]) => (
                <option key={v} value={v}>
                  {text}
                </option>
              ))}
            </select>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="SYMBOL (ถ้ามี)"
              aria-label="symbol"
              className={`${cls} w-[120px] font-mono`}
              style={input}
            />
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="วันนี้มาจากไหน เช่น ประกาศบริษัท / ประมาณจากรอบก่อน"
              aria-label="ที่มาของวันที่"
              className={`${cls} flex-1 min-w-[160px]`}
              style={input}
            />
          </div>
          <div className="flex gap-1 items-center flex-wrap">
            <input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="ลิงก์ประกาศ (จำเป็นถ้ายืนยันแล้ว)"
              aria-label="ลิงก์ที่มา"
              className={`${cls} flex-1 min-w-[160px]`}
              style={input}
            />
            <button
              type="button"
              aria-pressed={confirmed}
              onClick={() => setConfirmed((v) => !v)}
              title="ยืนยัน = ผู้เผยแพร่ประกาศวันนี้เอง (ต้องมีลิงก์) · ประมาณ = ยังไม่มีใครประกาศ"
              className="text-[9px] px-1.5 py-1 font-bold"
              style={{ color: confirmed ? "#4ade80" : "#fbbf24" }}
            >
              {confirmed ? "ยืนยันแล้ว" : "วันประมาณ"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="text-[9px]" style={{ color: "#f87171" }}>
          {error}
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="text-[9px] px-2 py-1 font-bold"
          style={dim}
        >
          ยกเลิก
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!can}
          className="text-[9px] px-2 py-1 font-bold disabled:opacity-40"
          style={{ color: colors.accent }}
        >
          {busy ? "กำลังบันทึก…" : "บันทึก"}
        </button>
      </div>
    </div>
  );
}
