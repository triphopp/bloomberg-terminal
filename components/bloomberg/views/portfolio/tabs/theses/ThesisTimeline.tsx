"use client";
import { useState } from "react";
import type { Colors } from "../../helpers";
import type { ThesisEvent } from "./types";

const KIND_COLOR: Record<string, string> = {
  CREATED: "#4ade80",
  EDITED: "#ff9900",
  STATUS_CHANGED: "#60a5fa",
  TARGET_CHANGED: "#60a5fa",
  INVALIDATED: "#f87171",
  DELETED: "#f87171",
  RESTORED: "#4ade80",
  NOTE: "#888",
  TRADE_LINKED: "#a78bfa",
  TRADE_UNLINKED: "#a78bfa",
  EXPORTED: "#666",
};

const fmtVal = (v: unknown) =>
  v === null || v === undefined || v === "" ? "—" : String(v).slice(0, 60);

export function ThesisTimeline({
  events,
  onAddNote,
  onDeleteNote,
  colors,
}: {
  events: ThesisEvent[];
  onAddNote: (note: string, occurredAt: string) => Promise<void>;
  onDeleteNote: (id: string) => Promise<void>;
  colors: Colors;
}) {
  const [note, setNote] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!note.trim()) return;
    setBusy(true);
    try {
      await onAddNote(note.trim(), when);
      setNote("");
      setWhen("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="flex gap-1 mb-3">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="add a note to the record — what changed in your thinking"
          className="flex-1 border px-1.5 py-1 text-[9px] font-mono outline-none"
          style={{ borderColor: colors.border, color: colors.text, background: "#0a0a0a" }}
        />
        <input
          type="date"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          title="back-date this note"
          className="border px-1 py-1 text-[9px] font-mono outline-none"
          style={{ borderColor: colors.border, color: colors.textSecondary, background: "#0a0a0a" }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || !note.trim()}
          className="text-[8px] px-2 border font-bold disabled:opacity-40"
          style={{ borderColor: colors.accent, color: colors.accent }}
        >
          ADD
        </button>
      </div>

      <div className="space-y-1">
        {events.map((ev) => (
          <div
            key={ev.id}
            className="border-l-2 pl-2 py-1"
            style={{ borderColor: KIND_COLOR[ev.event_type] ?? "#333" }}
          >
            <div className="flex items-center gap-2">
              <span
                className="text-[8px] font-bold tracking-widest"
                style={{ color: KIND_COLOR[ev.event_type] ?? colors.textSecondary }}
              >
                {ev.event_type}
              </span>
              <span className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
                {ev.occurred_at.slice(0, 16).replace("T", " ")}
              </span>
              {ev.device_id && (
                <span className="text-[7px]" style={{ color: "#444" }}>
                  {ev.device_id}
                </span>
              )}
              {ev.event_type === "NOTE" && (
                <button
                  type="button"
                  onClick={() => onDeleteNote(ev.id)}
                  className="ml-auto text-[7px]"
                  style={{ color: "#f87171" }}
                >
                  DEL
                </button>
              )}
            </div>
            {ev.note && (
              <div className="text-[9px] mt-0.5" style={{ color: colors.text }}>
                {ev.note}
              </div>
            )}
            {ev.payload && typeof ev.payload === "object" && (
              <div className="mt-0.5 space-y-px">
                {Object.entries(ev.payload as Record<string, unknown>).map(([field, val]) => {
                  const diff = val as { from?: unknown; to?: unknown };
                  const isDiff = diff && typeof diff === "object" && "to" in diff;
                  return (
                    <div key={field} className="text-[8px] font-mono">
                      <span style={{ color: colors.textSecondary }}>{field}: </span>
                      {isDiff ? (
                        <>
                          <span style={{ color: "#f87171" }}>{fmtVal(diff.from)}</span>
                          <span style={{ color: "#444" }}> → </span>
                          <span style={{ color: "#4ade80" }}>{fmtVal(diff.to)}</span>
                        </>
                      ) : (
                        <span style={{ color: colors.text }}>{fmtVal(val)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {events.length === 0 && (
          <div className="text-[9px]" style={{ color: colors.textSecondary }}>
            No history yet
          </div>
        )}
      </div>
    </div>
  );
}
