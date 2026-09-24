"use client";

/**
 * MARKET EVENTS — what is happening, named.
 *
 * Each card: formal name · severity, one short Thai line, and the three or
 * four numbers that raised it. Everything longer — the full reading, the
 * definition, the readings that did NOT confirm, the rule — opens on click.
 * The first version printed all of it at 6.5–8.5px and was unreadable.
 *
 * Source: `events` / `event_log` / `risk_basis` on /api/tail-risk/signals,
 * built by `backend/tail_events.py`. Unvalidated rules — no backtest.
 */

import { useState } from "react";

export type EventSeverity = "WATCH" | "ACTIVE" | "SEVERE";

export interface EventEvidence {
  key: string;
  label: string;
  short?: string;
  role: "trigger" | "confirm" | "context";
  value: number | null;
  change: number | null;
  unit: string;
  horizon: number;
  z: number | null;
  note: string;
  date: string | null;
}

export interface MarketEvent {
  id: string;
  name: string;
  headline?: string;
  definition: string;
  summary: string;
  channel: string;
  channel_label: string;
  direction: string | null;
  severity: EventSeverity;
  score: number;
  rule: string;
  evidence: EventEvidence[];
  catalyst: string | null;
}

export interface EventLogEntry {
  date: string;
  catalyst: string | null;
  events: { id: string; name: string; severity: EventSeverity; channel: string }[];
}

export interface RiskBasis {
  dimensions: string;
  events: string;
  events_rule: string;
  final: string;
  driver: "events" | "dimensions" | null;
}

export const SEVERITY_COLOR: Record<EventSeverity, string> = {
  SEVERE: "#FF4D4D",
  ACTIVE: "#FF9A33",
  WATCH: "#E6C34D",
};

const MUTED = "#8a8a8a";
const DIM = "#5a5a5a";

/** "10Y +15.1bp 3.7σ" — label, move, and how unusual the move is. */
function chip(e: EventEvidence): string {
  const lbl = e.short ?? e.key;
  if (e.change == null) return e.value != null ? `${lbl} ${e.value}` : lbl;
  const d = e.unit === "bp" ? 1 : e.unit === "$" ? 2 : 1;
  const unit = e.unit === "$" ? "$" : e.unit;
  const mv = `${e.change >= 0 ? "+" : ""}${e.change.toFixed(d)}${unit}`;
  const z = e.z == null ? "" : ` ${Math.abs(e.z).toFixed(1)}σ`;
  return `${lbl} ${mv}${e.horizon > 1 ? ` ${e.horizon}d` : ""}${z}`;
}

function EventCard({ ev }: { ev: MarketEvent }) {
  const [open, setOpen] = useState(false);
  const c = SEVERITY_COLOR[ev.severity];
  const main = ev.evidence.filter((e) => e.role !== "context" && e.change != null).slice(0, 4);
  const checked = ev.evidence.filter((e) => e.role === "context");

  return (
    <div
      className="flex flex-col gap-1 py-1.5 pl-2.5 pr-2"
      style={{ borderLeft: `2px solid ${c}`, backgroundColor: "#0b0b0b" }}
      title={open ? undefined : ev.summary}
    >
      {/* The header is the toggle: a real <button>, so it works from the
          keyboard too. Text-only styling per the app-wide control rule. */}
      <button
        type="button"
        className="flex items-baseline gap-2 flex-wrap w-full text-left cursor-pointer"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span style={{ color: c, fontSize: 12, fontWeight: "bold" }}>{ev.name}</span>
        <span style={{ color: c, fontSize: 9 }}>{ev.severity}</span>
        {ev.catalyst && <span style={{ color: "#C08040", fontSize: 9 }}>· {ev.catalyst}</span>}
        <span className="ml-auto" style={{ color: DIM, fontSize: 9 }}>
          {ev.channel_label} {open ? "▾" : "▸"}
        </span>
      </button>

      <span style={{ color: "#C8C8C8", fontSize: 11 }}>{ev.headline || ev.summary}</span>

      {main.length > 0 && (
        <div className="flex flex-wrap gap-x-3" style={{ fontSize: 10, color: MUTED }}>
          {main.map((e, i) => (
            <span key={`${e.key}-${i}`} title={e.note}>
              {chip(e)}
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="flex flex-col gap-1 pt-1" style={{ fontSize: 10, color: MUTED }}>
          <span style={{ color: "#AAAAAA", lineHeight: 1.5 }}>{ev.summary}</span>
          {checked.length > 0 && (
            <span>
              <span style={{ color: DIM }}>ตรวจแล้ว: </span>
              {checked.map((e) => e.note || chip(e)).join(" · ")}
            </span>
          )}
          <span style={{ color: DIM }}>{ev.definition}</span>
          <span style={{ color: "#444", fontSize: 9 }}>{ev.rule}</span>
        </div>
      )}
    </div>
  );
}

export function MarketEventsPanel({
  events,
  log,
  asof,
  basis,
  ok,
  staleHours,
  partial,
}: {
  events: MarketEvent[] | undefined;
  log: EventLogEntry[] | undefined;
  asof: string | null | undefined;
  basis: RiskBasis | undefined;
  ok: boolean | undefined;
  staleHours?: number | null;
  partial?: boolean;
}) {
  const list = events ?? [];
  const past = (log ?? []).filter((l) => l.date !== asof).slice(0, 5);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3" style={{ fontSize: 10, color: DIM }}>
        <span>{asof ?? "--"}</span>
        {partial && (
          <span style={{ color: "#C08040" }} title="ตลาดสหรัฐยังเปิดอยู่ — ตัวเลขวันนี้ยังไม่ปิดแท่ง อาจเปลี่ยน">
            ระหว่างวัน
          </span>
        )}
        {basis?.driver === "events" && (
          <span style={{ color: "#C08040" }} title={basis.events_rule}>
            ระดับ {basis.final} มาจากเหตุการณ์
          </span>
        )}
        {staleHours != null && (
          <span style={{ color: "#C08040" }} title="Yahoo ไม่ตอบ ใช้ข้อมูลชุดล่าสุดที่ดึงได้">
            ข้อมูลเก่า {staleHours} ชม.
          </span>
        )}
        <span
          className="ml-auto"
          title="z ของการเปลี่ยนแปลง 1/5 วัน เทียบการเปลี่ยนแปลงปกติของตัวเองย้อนหลัง 1 ปี · ยังไม่มี backtest"
        >
          UNVALIDATED
        </span>
      </div>

      {ok === false ? (
        <span style={{ color: "#C08040", fontSize: 11 }}>
          ไม่มีข้อมูลข้ามสินทรัพย์ (Yahoo ไม่ตอบ) — ลองใหม่ทุก ~5 นาที
        </span>
      ) : list.length === 0 ? (
        <span style={{ color: "#4f8f63", fontSize: 11 }}>ไม่มีเหตุการณ์ผิดปกติ</span>
      ) : (
        <div
          className="grid gap-2 content-start items-start"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}
        >
          {list.map((ev) => (
            <EventCard key={ev.id} ev={ev} />
          ))}
        </div>
      )}

      {past.length > 0 && (
        <div className="flex flex-col gap-0.5 pt-1" style={{ fontSize: 10 }}>
          <span style={{ color: DIM, fontSize: 9, letterSpacing: "0.12em" }}>ก่อนหน้า</span>
          {past.map((l) => (
            <div key={l.date} className="flex items-baseline gap-2 flex-wrap">
              <span style={{ color: DIM, width: 36 }}>{l.date.slice(5)}</span>
              {l.events.map((e, i) => (
                <span key={e.id} style={{ color: "#8a8a8a" }} title={e.severity}>
                  <span style={{ color: SEVERITY_COLOR[e.severity] }}>● </span>
                  {e.name}
                  {i < l.events.length - 1 && <span style={{ color: "#444" }}> </span>}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
