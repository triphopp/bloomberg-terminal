"use client";
import { whenText } from "../../alerts/calendar-alert";
import type { Colors } from "../portfolio/helpers";
import { NOTE_KIND_COLOR, type NoteKind } from "../portfolio/tabs/theses/types";
import { type AddDraft, AddEventForm } from "./AddEventForm";
import { dayTitle, kindLabel } from "./month";
import type { CalCategory, CalEvent, CalThesis } from "./types";

export const CAT_COLOR: Record<CalCategory, string> = {
  MACRO: "#FF8800",
  COMPANY: "#4FA3FF",
  THESIS: "#4ade80",
  PORT: "#a78bfa",
};

export const CAT_LABEL: Record<CalCategory, string> = {
  MACRO: "มหภาค",
  COMPANY: "บริษัท",
  THESIS: "THESIS",
  PORT: "พอร์ต",
};

/** The panel reads top-down from what is the user's own to what is everyone's. */
const SECTIONS: { cat: CalCategory; title: string }[] = [
  { cat: "THESIS", title: "ที่ thesis รออยู่" },
  { cat: "COMPANY", title: "บริษัท — งบ · ปันผล" },
  { cat: "PORT", title: "พอร์ต" },
  { cat: "MACRO", title: "มหภาค" },
];

const VIA: Record<NonNullable<CalThesis["via"]>, string> = {
  note: "โน้ตของ thesis นี้",
  question: "คำถามของ thesis นี้รอวันนี้",
  metric: "ตัวเลขที่ thesis นี้ติดตาม",
  symbol: "symbol เดียวกัน",
};

export type OpenThesis = (thesisId: string, sub: "thesis" | "notes", noteId?: string) => void;
export type OpenQuestion = (thesisId: string | null, questionId: string) => void;

function EventRow({
  e,
  colors,
  onOpenThesis,
  onOpenQuestion,
  onAdd,
}: {
  e: CalEvent;
  colors: Colors;
  onOpenThesis: OpenThesis;
  onOpenQuestion: OpenQuestion;
  onAdd: (d: AddDraft) => void;
}) {
  const dim = { color: colors.textSecondary };
  const color = CAT_COLOR[e.category];
  const noteId = e.ref?.type === "note" ? e.ref.id : undefined;
  const tagColor =
    e.kind === "NOTE" && e.tag ? (NOTE_KIND_COLOR[e.tag as NoteKind] ?? color) : color;
  // A macro or company date becomes a thesis's own by writing a dated note there.
  const canTie = e.ref == null;

  return (
    <div
      className="px-2 py-1.5 border-b leading-relaxed"
      style={{
        borderColor: colors.border,
        background: e.due ? "#0a1628" : "transparent",
        opacity: e.done ? 0.6 : 1,
      }}
    >
      <div className="flex items-baseline gap-1.5 flex-wrap">
        <span className="text-[8px] font-bold" style={{ color: tagColor }}>
          {e.kind === "NOTE" || e.kind === "QDATE"
            ? (e.tag ?? kindLabel(e.kind))
            : kindLabel(e.kind)}
        </span>
        {e.symbol && (
          <span className="font-mono font-bold text-[10px]" style={{ color: colors.accent }}>
            {e.symbol}
          </span>
        )}
        <span className="text-[10px] font-bold" style={{ color: colors.text }}>
          {e.title}
        </span>
        {e.impact === "high" && (
          <span className="text-[8px] font-bold" style={{ color: "#FF8800" }}>
            HIGH
          </span>
        )}
        {e.estimated && (
          <span
            className="text-[8px]"
            style={{ color: "#fbbf24" }}
            title="ยังไม่มีการประกาศวันนี้ — เป็นช่วงวัน กฎปฏิทิน หรือประมาณจากรอบก่อน"
          >
            ≈ วันประมาณ
          </span>
        )}
        {e.due && (
          <span className="text-[8px] font-bold" style={{ color: "#60a5fa" }}>
            ถึงวันแล้ว ยังไม่ได้ตรวจ
          </span>
        )}
        {e.done && (
          <span className="text-[8px]" style={dim}>
            ผ่านแล้ว
          </span>
        )}
      </div>

      {e.detail && (
        <div className="text-[9px]" style={{ color: colors.text }}>
          {e.detail}
        </div>
      )}

      {e.source && (
        <div className="text-[8px]" style={dim}>
          ที่มา: {e.source}
          {e.source_url && (
            <a href={e.source_url} target="_blank" rel="noreferrer" className="ml-1 underline">
              เปิด
            </a>
          )}
        </div>
      )}

      {e.ref?.type === "question_date" &&
        e.ref.questions.map((q) => (
          <button
            type="button"
            key={q.id}
            onClick={() => onOpenQuestion(q.thesis_id, q.id)}
            className="block text-left w-full text-[9px] hover:opacity-80"
            title="เปิดคำถามนี้ใน QUESTIONS"
          >
            <span className="font-mono" style={{ color: "#a78bfa" }}>
              {q.ref}
            </span>{" "}
            <span style={{ color: colors.text }}>{q.title}</span>
            {q.reads && <span style={dim}> — ดู: {q.reads}</span>} <span style={dim}>→</span>
          </button>
        ))}

      <div className="flex gap-x-3 gap-y-0.5 flex-wrap items-baseline">
        {e.theses.map((t) => (
          <button
            type="button"
            key={t.id}
            onClick={() => onOpenThesis(t.id, noteId ? "notes" : "thesis", noteId)}
            className="text-[9px] font-bold hover:opacity-80"
            style={{ color: CAT_COLOR.THESIS }}
            title={`เปิด thesis — ${t.title}${t.via ? ` (${VIA[t.via]})` : ""}`}
          >
            thesis {t.symbol} →
          </button>
        ))}
        {canTie && (
          <button
            type="button"
            onClick={() =>
              onAdd({
                date: e.date,
                title: e.category === "MACRO" ? e.title : `${e.symbol ?? ""} ${e.title}`.trim(),
                thesisId: e.theses[0]?.id ?? "",
              })
            }
            className="text-[9px] hover:opacity-80"
            style={dim}
            title="เขียนโน้ตลงวันนี้ใน thesis ที่เลือก — เหตุการณ์นี้กับ thesis จะอยู่ใต้วันเดียวกัน"
          >
            + ผูกกับ thesis
          </button>
        )}
      </div>
    </div>
  );
}

/** Everything on one day, the user's own first, and the way to add to it. */
export function DayPanel({
  day,
  today,
  events,
  hiddenCount,
  theses,
  colors,
  adding,
  onAdd,
  onCancelAdd,
  onSaved,
  onOpenThesis,
  onOpenQuestion,
}: {
  day: string;
  today: string;
  /** This day's events after the filter. */
  events: CalEvent[];
  /** How many more this day has that the filter is hiding. */
  hiddenCount: number;
  theses: CalThesis[];
  colors: Colors;
  adding: AddDraft | null;
  onAdd: (d: AddDraft) => void;
  onCancelAdd: () => void;
  onSaved: (date: string) => void;
  onOpenThesis: OpenThesis;
  onOpenQuestion: OpenQuestion;
}) {
  const dim = { color: colors.textSecondary };
  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        className="shrink-0 px-2 py-1.5 border-b flex items-baseline gap-2 flex-wrap"
        style={{ borderColor: colors.border }}
      >
        <span className="text-[11px] font-bold" style={{ color: colors.text }}>
          {dayTitle(day)}
        </span>
        <span className="text-[9px]" style={{ color: day === today ? colors.accent : dim.color }}>
          {whenText(day, today)}
        </span>
        <button
          type="button"
          onClick={() => onAdd({ date: day, title: "", thesisId: "" })}
          className="ml-auto text-[9px] font-bold hover:opacity-80"
          style={{ color: colors.accent }}
        >
          + เพิ่มเหตุการณ์
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {adding && (
          <div className="p-2 border-b" style={{ borderColor: colors.border }}>
            <AddEventForm
              // A different event tied, or another day picked: start the form over.
              key={`${adding.date}|${adding.title}|${adding.thesisId}`}
              initial={adding}
              theses={theses}
              colors={colors}
              onSaved={onSaved}
              onCancel={onCancelAdd}
            />
          </div>
        )}

        {SECTIONS.map(({ cat, title }) => {
          const rows = events.filter((e) => e.category === cat);
          if (rows.length === 0) return null;
          return (
            <div key={cat}>
              <div
                className="px-2 py-0.5 text-[8px] font-bold tracking-widest border-b"
                style={{ borderColor: colors.border, color: CAT_COLOR[cat], background: "#080808" }}
              >
                {title} ({rows.length})
              </div>
              {rows.map((e) => (
                <EventRow
                  key={e.id}
                  e={e}
                  colors={colors}
                  onOpenThesis={onOpenThesis}
                  onOpenQuestion={onOpenQuestion}
                  onAdd={onAdd}
                />
              ))}
            </div>
          );
        })}

        {events.length === 0 && !adding && (
          <div className="p-3 text-[9px]" style={dim}>
            ไม่มีเหตุการณ์วันนี้{hiddenCount > 0 ? "ตามตัวกรองที่เลือก" : ""}
          </div>
        )}
        {hiddenCount > 0 && (
          <div className="px-2 py-1 text-[8px]" style={dim}>
            ตัวกรองซ่อนอยู่อีก {hiddenCount} รายการของวันนี้
          </div>
        )}
      </div>
    </div>
  );
}
