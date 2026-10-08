"use client";
import { useIsMobile } from "@/hooks/use-mobile";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { todayIso, whenText } from "../../alerts/calendar-alert";
import { useOpenTools } from "../../alerts/useOpenTools";
import { calendarRequestAtom, isDarkModeAtom } from "../../atoms";
import { bloombergColors } from "../../lib/theme-config";
import type { Colors } from "../portfolio/helpers";
import type { AddDraft } from "./AddEventForm";
import { CAT_COLOR, CAT_LABEL, DayPanel } from "./DayPanel";
import {
  CATEGORIES,
  type CalFilter,
  FILTER_DEFAULT,
  WEEKDAYS,
  byDay,
  cellLabel,
  dayTitle,
  gridRange,
  inMonth,
  kindCounts,
  kindLabel,
  matches,
  monthGrid,
  monthTitle,
  parts,
  shiftMonth,
  toggleCategory,
  weekdayMon0,
} from "./month";
import type { CalCategory, CalEvent, CalPayload } from "./types";

const FILTER_KEY = "bloomberg_calendar_filter";
const VIEW_KEY = "bloomberg_calendar_view";
/** Lines a grid cell shows before "+N" — the rest is in the day panel. */
const CELL_LINES = 4;

type ViewMode = "month" | "agenda";

function loadFilter(): CalFilter {
  if (typeof window === "undefined") return FILTER_DEFAULT;
  try {
    const s = localStorage.getItem(FILTER_KEY);
    // The thesis filter is not restored: a forgotten one reads as "my dates are gone".
    if (s) return { ...FILTER_DEFAULT, ...(JSON.parse(s) as Partial<CalFilter>), thesisId: "" };
  } catch {
    /* ignore */
  }
  return FILTER_DEFAULT;
}

/** In a cell the user's own dates come first; a macro print can wait for "+N". */
const RANK: Record<CalCategory, number> = { THESIS: 0, PORT: 1, COMPANY: 2, MACRO: 3 };
const IMPACT_RANK = { high: 0, medium: 1, low: 2 } as const;
function cellOrder(a: CalEvent, b: CalEvent): number {
  return (
    Number(b.due) - Number(a.due) ||
    RANK[a.category] - RANK[b.category] ||
    (a.impact ? IMPACT_RANK[a.impact] : 3) - (b.impact ? IMPACT_RANK[b.impact] : 3)
  );
}

function EventLine({ e, colors, wide }: { e: CalEvent; colors: Colors; wide?: boolean }) {
  const strong = e.category !== "MACRO" || e.impact === "high";
  return (
    <span
      className="flex items-center gap-1 min-w-0 text-[8px] leading-tight"
      style={{ opacity: e.done ? 0.45 : 1 }}
    >
      {/* empty on purpose: the fill is the category (text-only controls rule) */}
      <span
        className="shrink-0 h-1.5 w-1.5 rounded-full"
        style={{ background: CAT_COLOR[e.category] }}
      />
      <span
        className="truncate"
        style={{
          color: e.due ? "#60a5fa" : strong ? colors.text : colors.textSecondary,
          fontWeight: e.impact === "high" || e.due ? 700 : 400,
        }}
      >
        {e.estimated ? "≈ " : ""}
        {wide && e.category !== "THESIS"
          ? `${cellLabel(e)}${e.category === "MACRO" ? ` — ${e.title}` : e.detail ? ` — ${e.detail}` : ""}`
          : cellLabel(e)}
      </span>
    </span>
  );
}

/**
 * CAL (`6`) — the one calendar: macro releases, company dates, what the theses
 * are waiting on and the book's own dates on one month grid (GET /api/calendar).
 * A day opens beside it with everything on it and the thesis each item belongs
 * to — one click to that thesis in PORT → TOOLS; adding one writes a thesis
 * note or a question calendar date.
 */
export function CalendarView() {
  const [isDarkMode] = useAtom(isDarkModeAtom);
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;
  // A day (and category) another screen asked to open — an alert, TAIL's strip.
  const [request, setRequest] = useAtom(calendarRequestAtom);
  const openTools = useOpenTools();
  const onOpenThesis = useCallback(
    (thesisId: string, sub: "thesis" | "notes", noteId?: string) =>
      openTools({ sub: "theses", thesisId, thesisSub: sub, noteId }),
    [openTools]
  );
  const onOpenQuestion = useCallback(
    (thesisId: string | null, questionId: string) =>
      openTools({ sub: "questions", thesisId, questionId }),
    [openTools]
  );
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const today = todayIso();
  const [cursor, setCursor] = useState(() => {
    const p = parts(request?.date ?? today);
    return { y: p.y, m0: p.m0 };
  });
  const [selected, setSelected] = useState(request?.date ?? today);
  const [filter, setFilter] = useState<CalFilter>(loadFilter);
  const [view, setView] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "month";
    try {
      return localStorage.getItem(VIEW_KEY) === "agenda" ? "agenda" : "month";
    } catch {
      return "month";
    }
  });
  const [adding, setAdding] = useState<AddDraft | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify({ ...filter, thesisId: "" }));
    } catch {
      /* ignore */
    }
  }, [filter]);
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* ignore */
    }
  }, [view]);

  const goTo = useCallback((day: string) => {
    const p = parts(day);
    setCursor({ y: p.y, m0: p.m0 });
    setSelected(day);
  }, []);

  // A hand-off that arrives while the tab is already open (a second alert).
  useEffect(() => {
    if (!request) return;
    if (request.date) goTo(request.date);
    const cat = CATEGORIES.find((c) => c === request.category);
    if (cat) setFilter((f) => ({ ...f, categories: [cat], thesisId: "" }));
    setRequest(null);
  }, [request, goTo, setRequest]);

  const range = useMemo(() => gridRange(cursor.y, cursor.m0), [cursor]);
  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ["calendar", range.start, range.end],
    queryFn: async ({ signal }) => {
      const r = await fetch(`/api/calendar?start=${range.start}&end=${range.end}`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as CalPayload;
    },
    staleTime: 60_000,
    placeholderData: (prev) => prev,
    // Company dates load behind the request: ask again while some are still out.
    refetchInterval: (q) => (q.state.data?.sources.company?.pending.length ? 6_000 : 5 * 60_000),
  });

  const events = data?.events ?? [];
  const theses = data?.theses ?? [];
  const shown = useMemo(() => events.filter((e) => matches(e, filter)), [events, filter]);
  const days = useMemo(() => byDay(shown), [shown]);
  const kinds = useMemo(() => kindCounts(events, filter), [events, filter]);
  const grid = useMemo(() => monthGrid(cursor.y, cursor.m0), [cursor]);
  const dayEvents = days.get(selected) ?? [];
  const dayHidden = events.filter((e) => e.date === selected).length - dayEvents.length;

  const move = (delta: number) => setCursor((c) => shiftMonth(c.y, c.m0, delta));
  const reload = async () => {
    // refresh=1 asks Yahoo again for every company date, then the grid re-reads.
    await fetch(`/api/calendar?start=${range.start}&end=${range.end}&refresh=1`).catch(() => {});
    void refetch();
  };
  const saved = (date: string) => {
    setAdding(null);
    goTo(date);
    // The same rows show in THESES → NOTES and QUESTIONS → CALENDAR.
    for (const key of ["calendar", "theses", "questions", "reads"])
      void qc.invalidateQueries({ queryKey: [key] });
  };

  const src = data?.sources;
  const notices: { text: string; color: string; title?: string }[] = [];
  if (isError) notices.push({ text: "backend ไม่ตอบ — แสดงข้อมูลล่าสุดที่มี", color: "#f87171" });
  if (src?.company?.pending.length)
    notices.push({
      text: `กำลังอ่านวันงบ/ปันผล ${src.company.loaded}/${src.company.symbols} บริษัท…`,
      color: colors.textSecondary,
      title: src.company.pending.join(", "),
    });
  const failed = Object.keys(src?.company?.failed ?? {});
  if (failed.length)
    notices.push({
      text: `Yahoo อ่านไม่ได้ ${failed.length} บริษัท: ${failed.slice(0, 6).join(", ")}${failed.length > 6 ? "…" : ""} — แสดงวันล่าสุดที่เคยอ่านได้ ลองใหม่เอง`,
      color: "#B06000",
    });
  if (src?.macro && src.macro.releases_ok === false)
    notices.push({ text: "FRED ไม่ตอบ — มหภาคเหลือ FOMC กับวันตามกฎ", color: "#B06000" });
  if (src?.macro?.fomc_missing)
    notices.push({
      text: `FOMC ใส่ไว้ถึง ${src.macro.fomc_through} — หลังจากนั้น "ไม่มี FOMC" แปลว่ายังไม่ได้ใส่`,
      color: "#B06000",
    });
  for (const [key, label] of [
    ["notes", "โน้ตของ thesis"],
    ["dates", "ปฏิทินคำถาม"],
    ["port", "วันของพอร์ต"],
  ] as const)
    if (src?.[key] && !src[key]?.ok)
      notices.push({ text: `อ่าน${label}ไม่ได้ (${src[key]?.error ?? "?"})`, color: "#f87171" });

  const dim = { color: colors.textSecondary };
  const chip = "text-[9px] px-1.5 py-1 font-bold whitespace-nowrap hover:opacity-80";
  const on = (active: boolean, color = colors.accent) => ({
    color: active ? color : colors.textSecondary,
  });

  const monthBody = (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 grid grid-cols-7 border-b" style={{ borderColor: colors.border }}>
        {WEEKDAYS.map((w, i) => (
          <div
            key={w}
            className="px-1 py-0.5 text-[8px] font-bold"
            style={{ color: i >= 5 ? colors.textDimmed : colors.textSecondary }}
          >
            {w}
          </div>
        ))}
      </div>
      <div className="flex-1 min-h-0 grid grid-cols-7 grid-rows-6">
        {grid.flat().map((day) => {
          const list = [...(days.get(day) ?? [])].sort(cellOrder);
          const isToday = day === today;
          const isSel = day === selected;
          const inside = inMonth(day, cursor.y, cursor.m0);
          const weekend = weekdayMon0(day) >= 5;
          return (
            <button
              type="button"
              // The frame is the calendar: opt out of the text-only control rule.
              data-frame
              key={day}
              aria-pressed={isSel}
              aria-label={`${dayTitle(day)} — ${list.length} เหตุการณ์`}
              onClick={() => setSelected(day)}
              className="min-h-0 min-w-0 overflow-hidden border-r border-b px-1 pt-0.5 text-left flex flex-col gap-px"
              style={{
                borderColor: colors.border,
                background: isSel ? colors.bgSelected : isToday ? "#140c00" : "transparent",
                boxShadow: isSel ? `inset 0 0 0 1px ${colors.accent}` : undefined,
                opacity: inside ? 1 : 0.4,
              }}
            >
              <span
                className="text-[9px] font-mono leading-tight"
                style={{
                  color: isToday
                    ? colors.accent
                    : weekend
                      ? colors.textDimmed
                      : colors.textSecondary,
                  fontWeight: isToday ? 700 : 400,
                }}
              >
                {parts(day).d}
                {isToday ? " วันนี้" : ""}
              </span>
              {list.slice(0, CELL_LINES).map((e) => (
                <EventLine key={e.id} e={e} colors={colors} />
              ))}
              {list.length > CELL_LINES && (
                <span className="text-[8px] leading-tight" style={dim}>
                  +{list.length - CELL_LINES} อีก
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );

  // The agenda reads forward: from today in the current month, else the month.
  const agendaFrom = inMonth(today, cursor.y, cursor.m0) ? today : range.start;
  const agendaDays = [...days.keys()].filter((d) => d >= agendaFrom).sort();
  const agendaBody = (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {agendaDays.map((day) => (
        <button
          type="button"
          data-frame
          key={day}
          aria-pressed={day === selected}
          onClick={() => setSelected(day)}
          className="w-full text-left px-2 py-1 border-b flex gap-3"
          style={{
            borderColor: colors.border,
            background: day === selected ? colors.bgSelected : "transparent",
          }}
        >
          <span className="shrink-0 w-[150px]">
            <span
              className="block text-[9px] font-bold"
              style={{ color: day === today ? colors.accent : colors.text }}
            >
              {dayTitle(day)}
            </span>
            <span className="block text-[8px]" style={dim}>
              {whenText(day, today)}
            </span>
          </span>
          <span className="flex-1 min-w-0 flex flex-col gap-0.5">
            {[...(days.get(day) ?? [])].sort(cellOrder).map((e) => (
              <EventLine key={e.id} e={e} colors={colors} wide />
            ))}
          </span>
        </button>
      ))}
      {agendaDays.length === 0 && (
        <div className="p-3 text-[9px]" style={dim}>
          ไม่มีเหตุการณ์ในช่วงนี้ตามตัวกรองที่เลือก
        </div>
      )}
    </div>
  );

  return (
    <div
      className="reading flex flex-col h-full"
      style={{ background: "#000", color: colors.text }}
    >
      {/* Month, view, what to show */}
      <div
        className="shrink-0 flex items-center flex-wrap gap-x-1 px-1 border-b"
        style={{ borderColor: colors.border }}
      >
        <button type="button" className={chip} style={dim} onClick={() => move(-1)} title="เดือนก่อน">
          ◀
        </button>
        <span
          className="text-[11px] font-bold px-1 min-w-[120px] text-center"
          style={{ color: colors.text }}
        >
          {monthTitle(cursor.y, cursor.m0)}
        </span>
        <button type="button" className={chip} style={dim} onClick={() => move(1)} title="เดือนถัดไป">
          ▶
        </button>
        <button
          type="button"
          className={chip}
          style={{ color: colors.accent }}
          onClick={() => goTo(today)}
        >
          วันนี้
        </button>
        <span style={{ color: colors.border }}>│</span>
        {(
          [
            ["month", "เดือน"],
            ["agenda", "รายการ"],
          ] as const
        ).map(([id, text]) => (
          <button
            type="button"
            key={id}
            aria-pressed={view === id}
            className={chip}
            style={on(view === id)}
            onClick={() => setView(id)}
          >
            {text}
          </button>
        ))}
        <span style={{ color: colors.border }}>│</span>
        <button
          type="button"
          aria-pressed={filter.categories.length === 0}
          className={chip}
          style={on(filter.categories.length === 0)}
          onClick={() => setFilter((f) => ({ ...f, categories: [] }))}
        >
          ทั้งหมด
        </button>
        {CATEGORIES.map((c) => {
          const active = filter.categories.includes(c);
          return (
            <button
              type="button"
              key={c}
              aria-pressed={active}
              className={`${chip} flex items-center gap-1`}
              style={on(active, CAT_COLOR[c])}
              onClick={() =>
                setFilter((f) => ({ ...f, categories: toggleCategory(f.categories, c) }))
              }
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: CAT_COLOR[c] }} />
              {CAT_LABEL[c]}
            </button>
          );
        })}
        <span style={{ color: colors.border }}>│</span>
        <select
          value={filter.thesisId}
          onChange={(e) => setFilter((f) => ({ ...f, thesisId: e.target.value }))}
          aria-label="กรองตาม thesis"
          className="border px-1 py-0.5 text-[9px] outline-none max-w-[200px]"
          style={{
            background: "#0a0a0a",
            borderColor: colors.border,
            color: filter.thesisId ? colors.accent : colors.textSecondary,
          }}
        >
          <option value="">ทุก thesis</option>
          {theses.map((t) => (
            <option key={t.id} value={t.id}>
              {t.symbol} — {t.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-pressed={filter.linkedOnly}
          className={chip}
          style={on(filter.linkedOnly)}
          title="เฉพาะเหตุการณ์ที่ผูกกับ thesis ใด thesis หนึ่ง"
          onClick={() => setFilter((f) => ({ ...f, linkedOnly: !f.linkedOnly }))}
        >
          ผูก thesis
        </button>
        <button
          type="button"
          aria-pressed={filter.lowImpact}
          className={chip}
          style={on(filter.lowImpact)}
          title="ตัวเลขรายสัปดาห์ / ผลกระทบต่ำ (jobless claims, EIA)"
          onClick={() => setFilter((f) => ({ ...f, lowImpact: !f.lowImpact }))}
        >
          รายสัปดาห์
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className={chip}
          style={{ color: colors.accent }}
          onClick={() => setAdding({ date: selected, title: "", thesisId: filter.thesisId })}
        >
          + เพิ่มเหตุการณ์
        </button>
        <button
          type="button"
          className={chip}
          style={dim}
          disabled={isFetching}
          title="อ่านวันงบ/ปันผลจาก Yahoo ใหม่ทั้งหมด"
          onClick={() => void reload()}
        >
          {isFetching ? "…" : "↻"}
        </button>
      </div>

      {/* Kinds under the chosen scope — switch one off to drop it from the grid */}
      {kinds.length > 0 && (
        <div
          className="shrink-0 flex items-center flex-wrap gap-x-1 px-1 border-b"
          style={{ borderColor: colors.border }}
        >
          <span className="text-[8px] px-1" style={dim}>
            ชนิด
          </span>
          {kinds.map(({ kind, n }) => {
            const active = !filter.hiddenKinds.includes(kind);
            return (
              <button
                type="button"
                key={kind}
                aria-pressed={active}
                className="text-[8px] px-1 py-0.5 whitespace-nowrap hover:opacity-80"
                style={{
                  color: active ? colors.text : colors.textDimmed,
                  textDecoration: active ? "none" : "line-through",
                }}
                onClick={() =>
                  setFilter((f) => ({
                    ...f,
                    hiddenKinds: active
                      ? [...f.hiddenKinds, kind]
                      : f.hiddenKinds.filter((k) => k !== kind),
                  }))
                }
              >
                {kindLabel(kind)} {n}
              </button>
            );
          })}
          {filter.hiddenKinds.length > 0 && (
            <button
              type="button"
              className="text-[8px] px-1 py-0.5 hover:opacity-80"
              style={{ color: colors.accent }}
              onClick={() => setFilter((f) => ({ ...f, hiddenKinds: [] }))}
            >
              แสดงทุกชนิด
            </button>
          )}
        </div>
      )}

      {notices.length > 0 && (
        <div
          className="shrink-0 px-2 py-0.5 border-b flex flex-wrap gap-x-4 text-[8px]"
          style={{ borderColor: colors.border }}
        >
          {notices.map((n) => (
            <span key={n.text} style={{ color: n.color }} title={n.title}>
              {n.text}
            </span>
          ))}
        </div>
      )}

      <div className={`flex-1 min-h-0 flex ${isMobile ? "flex-col overflow-y-auto" : ""}`}>
        <div
          className={`flex flex-col min-w-0 ${isMobile ? "h-[420px] shrink-0" : "flex-1 min-h-0"}`}
        >
          {view === "month" ? monthBody : agendaBody}
        </div>
        <div
          className={isMobile ? "border-t min-h-[240px]" : "w-[380px] shrink-0 border-l min-h-0"}
          style={{ borderColor: colors.border }}
        >
          <DayPanel
            day={selected}
            today={today}
            events={dayEvents}
            hiddenCount={dayHidden}
            theses={theses}
            colors={colors}
            adding={adding}
            onAdd={setAdding}
            onCancelAdd={() => setAdding(null)}
            onSaved={saved}
            onOpenThesis={onOpenThesis}
            onOpenQuestion={onOpenQuestion}
          />
        </div>
      </div>
    </div>
  );
}
