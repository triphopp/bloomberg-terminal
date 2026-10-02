"use client";
import { useQuery } from "@tanstack/react-query";
import type { Colors } from "../../helpers";
import { type TList, type TMetric, T_STATUS, T_VERDICT, band } from "../tracking/types";
import { type QCalendar, type QDate, STATUS_COLOR } from "./types";

const KIND_LABEL: Record<string, string> = {
  EARNINGS: "งบ",
  FILING: "filing",
  DATA_RELEASE: "ข้อมูล",
  EVENT: "เหตุการณ์",
  OTHER: "อื่น ๆ",
};

function when(d: QDate): string {
  if (d.days_until === 0) return "วันนี้";
  return d.days_until > 0 ? `อีก ${d.days_until} วัน` : `ผ่านมา ${-d.days_until} วัน`;
}

/** Every dated thing a question is waiting on, across all theses, soonest
 *  first. A date here is a claim with a source: "ประมาณ" means nobody has
 *  announced it and it was inferred from a past schedule. */
export function CalendarView({
  colors,
  onOpenQuestion,
}: {
  colors: Colors;
  onOpenQuestion: (thesisId: string | null, questionId: string) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["questions", "calendar"],
    queryFn: async ({ signal }) => {
      const r = await fetch("/api/v2/questions/calendar", { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as QCalendar;
    },
    staleTime: 30_000,
  });
  // Tracked numbers (TOOLS → TRACK) whose forecast waits on one of these dates.
  // Same key as the TRACK tab's "all theses" list, so the two share one fetch.
  const { data: tracked } = useQuery({
    queryKey: ["tracking", "list", ""],
    queryFn: async ({ signal }) => {
      const r = await fetch("/api/v2/tracking", { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as TList;
    },
    staleTime: 30_000,
  });
  type Wait = { m: TMetric; w: TMetric["state"]["waits"][number] };
  const reads = new Map<string, Wait[]>();
  for (const m of tracked?.metrics ?? [])
    for (const w of m.state.waits)
      reads.set(w.date_id, [...(reads.get(w.date_id) ?? []), { m, w }]);
  const dim = { color: colors.textSecondary };
  const dates = data?.dates ?? [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-2 py-1 border-b flex gap-3" style={{ borderColor: colors.border, ...dim }}>
        <span>{dates.length} วันที่</span>
        <span style={{ color: "#60a5fa" }}>{data?.due ?? 0} ถึงวันแล้วยังไม่ได้ตรวจ</span>
        <span>{data?.estimated ?? 0} เป็นวันประมาณ</span>
      </div>
      {dates.map((d) => (
        <div
          key={d.id}
          className="px-2 py-1.5 border-b leading-relaxed"
          style={{ borderColor: colors.border, background: d.due ? "#0a1628" : "transparent" }}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-bold" style={{ color: colors.text }}>
              {d.date}
            </span>
            <span style={{ color: d.due ? "#60a5fa" : colors.textSecondary }}>{when(d)}</span>
            <span
              className="text-[8px] px-1 border"
              title={
                d.status === "CONFIRMED"
                  ? "ผู้เผยแพร่ประกาศวันนี้เอง"
                  : "ยังไม่มีการประกาศ — ประมาณจากรอบก่อน"
              }
              style={
                d.status === "CONFIRMED"
                  ? { color: "#4ade80", borderColor: "#4ade8066" }
                  : { color: "#fbbf24", borderColor: "#fbbf2466" }
              }
            >
              {d.status === "CONFIRMED" ? "ยืนยัน" : "ประมาณ"}
            </span>
            <span className="text-[8px]" style={dim}>
              {KIND_LABEL[d.kind] ?? d.kind}
              {d.symbol ? ` · ${d.symbol}` : ""}
            </span>
            <span className="font-bold" style={{ color: colors.accent }}>
              {d.title}
            </span>
            <span className="font-mono text-[8px]" style={dim}>
              {d.ref}
            </span>
          </div>
          <div style={dim}>
            ที่มาของวันที่: {d.source}
            {d.source_url && (
              <a href={d.source_url} target="_blank" rel="noreferrer" className="ml-1 underline">
                เปิด
              </a>
            )}
          </div>
          {d.changes.map((c) => (
            <div key={c.id} style={dim}>
              แก้ {c.created_at.slice(0, 10)}: {c.old_date}
              {c.old_date !== c.new_date ? ` → ${c.new_date}` : ""}
              {c.old_status !== c.new_status ? ` (${c.old_status} → ${c.new_status})` : ""} —{" "}
              {c.reason}
            </div>
          ))}
          {d.questions.map((q) => (
            <button
              type="button"
              key={q.link_id}
              onClick={() => onOpenQuestion(q.thesis_id, q.id)}
              className="block text-left w-full hover:opacity-80"
            >
              <span className="font-mono" style={{ color: STATUS_COLOR[q.status] }}>
                {q.ref}
              </span>{" "}
              <span style={{ color: colors.text }}>{q.title}</span>
              {q.reads && <span style={dim}> — ดู: {q.reads}</span>}
            </button>
          ))}
          {(reads.get(d.id) ?? []).map(({ m, w }) => (
            <div key={`${m.id}-${w.period}`}>
              <span className="font-mono" style={{ color: T_STATUS[m.state.status].color }}>
                {m.ref}
              </span>{" "}
              <span style={{ color: colors.text }}>
                {m.symbol} {m.title}
              </span>
              <span style={dim}>
                {" "}
                — คาด: {w.expected}
                {band(w.low, w.high)
                  ? ` [${band(w.low, w.high)}${m.unit ? ` ${m.unit}` : ""}]`
                  : ""}
              </span>
              {w.reading && (
                <span style={{ color: T_VERDICT[w.reading.verdict].color }}>
                  {" "}
                  → {w.reading.value_text} ({T_VERDICT[w.reading.verdict].text}
                  {w.reading.kill ? " · แตะเส้น killer" : ""})
                </span>
              )}
            </div>
          ))}
          {d.questions.length === 0 && !reads.has(d.id) && (
            <div style={dim}>ยังไม่ผูกกับคำถามหรือตัวเลขใด</div>
          )}
        </div>
      ))}
      {!isLoading && dates.length === 0 && (
        <div className="p-3" style={dim}>
          ยังไม่มีวันที่ในปฏิทิน เพิ่มผ่าน MCP `question_date_add` พร้อมที่มาของวันที่
        </div>
      )}
    </div>
  );
}
