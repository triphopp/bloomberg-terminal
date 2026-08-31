"use client";
import { Pin, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Colors } from "../../helpers";
import {
  NOTE_IMPACT_COLOR,
  NOTE_KINDS,
  NOTE_KIND_COLOR,
  NOTE_STATUSES,
  NOTE_STATUS_COLOR,
  type NoteImpact,
  type NoteKind,
  type NoteStatus,
  type ThesisNote,
} from "./types";

/** The payload both the create form and an inline edit send. Everything is a
 *  string here, exactly like ThesisDraft — the numeric fields are parsed once,
 *  on submit, instead of fighting a controlled input on every keystroke. */
export interface NoteDraft {
  kind: NoteKind;
  title: string;
  body: string;
  impact: string;
  likelihood: string;
  severity: string;
  status: NoteStatus;
  watch_date: string;
  pinned: boolean;
}

export const emptyNoteDraft = (): NoteDraft => ({
  kind: "SCENARIO",
  title: "",
  body: "",
  impact: "",
  likelihood: "",
  severity: "",
  status: "open",
  watch_date: "",
  pinned: false,
});

const draftFromNote = (n: ThesisNote): NoteDraft => ({
  kind: n.kind,
  title: n.title ?? "",
  body: n.body ?? "",
  impact: n.impact ?? "",
  likelihood: n.likelihood == null ? "" : String(n.likelihood),
  severity: n.severity == null ? "" : String(n.severity),
  status: n.status,
  watch_date: n.watch_date ?? "",
  pinned: !!n.pinned,
});

const IMPACTS: NoteImpact[] = ["bull", "bear", "mixed"];

const today = () => new Date().toISOString().slice(0, 10);

/** Likelihood × severity, 1–25. Not shown when either half is missing: a score
 *  built from one guessed factor reads as precision the note does not have. */
const riskScore = (n: ThesisNote) =>
  n.likelihood != null && n.severity != null ? n.likelihood * n.severity : null;

function Field({
  label,
  children,
  colors,
}: {
  label: string;
  children: React.ReactNode;
  colors: Colors;
}) {
  // A div, not a <label>: the control is passed in as children, so the label
  // cannot name it and a wrapping <label> would only be decoration.
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[7px] tracking-widest" style={{ color: colors.textSecondary }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function NoteForm({
  draft,
  setDraft,
  onSubmit,
  onCancel,
  busy,
  isNew,
  colors,
}: {
  draft: NoteDraft;
  setDraft: (d: NoteDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  isNew: boolean;
  colors: Colors;
}) {
  const inputStyle = {
    background: "#0a0a0a",
    color: colors.text,
    borderColor: colors.border,
  } as const;
  const can = draft.title.trim().length > 0 || draft.body.trim().length > 0;

  return (
    <div className="border p-2 mb-2 space-y-1.5" style={{ borderColor: colors.accent }}>
      <div className="flex gap-1">
        <select
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value as NoteKind })}
          className="border px-1 py-1 text-[9px] font-mono outline-none"
          style={{ ...inputStyle, color: NOTE_KIND_COLOR[draft.kind] }}
        >
          {NOTE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="what could happen — one line"
          className="flex-1 border px-1.5 py-1 text-[9px] font-mono outline-none"
          style={inputStyle}
        />
      </div>

      <textarea
        value={draft.body}
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        placeholder="why it matters to this thesis, what you would watch for, what you would do about it"
        rows={3}
        className="w-full border px-1.5 py-1 text-[9px] font-mono outline-none resize-y"
        style={inputStyle}
      />

      <div className="flex gap-2 flex-wrap items-end">
        <Field label="IMPACT" colors={colors}>
          <select
            value={draft.impact}
            onChange={(e) => setDraft({ ...draft, impact: e.target.value })}
            className="border px-1 py-0.5 text-[9px] font-mono outline-none"
            style={{
              ...inputStyle,
              color: draft.impact
                ? NOTE_IMPACT_COLOR[draft.impact as NoteImpact]
                : colors.textSecondary,
            }}
          >
            <option value="">—</option>
            {IMPACTS.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </Field>

        <Field label="LIKELIHOOD" colors={colors}>
          <select
            value={draft.likelihood}
            onChange={(e) => setDraft({ ...draft, likelihood: e.target.value })}
            className="border px-1 py-0.5 text-[9px] font-mono outline-none"
            style={inputStyle}
          >
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>

        <Field label="SEVERITY" colors={colors}>
          <select
            value={draft.severity}
            onChange={(e) => setDraft({ ...draft, severity: e.target.value })}
            className="border px-1 py-0.5 text-[9px] font-mono outline-none"
            style={inputStyle}
          >
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>

        <Field label="WATCH DATE" colors={colors}>
          <input
            type="date"
            value={draft.watch_date}
            onChange={(e) => setDraft({ ...draft, watch_date: e.target.value })}
            className="border px-1 py-0.5 text-[9px] font-mono outline-none"
            style={inputStyle}
          />
        </Field>

        <Field label="STATUS" colors={colors}>
          <select
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value as NoteStatus })}
            className="border px-1 py-0.5 text-[9px] font-mono outline-none"
            style={{ ...inputStyle, color: NOTE_STATUS_COLOR[draft.status] }}
          >
            {NOTE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>

        <button
          type="button"
          onClick={() => setDraft({ ...draft, pinned: !draft.pinned })}
          className="flex items-center gap-0.5 text-[8px] px-1.5 py-1 border font-bold"
          style={{
            borderColor: draft.pinned ? colors.accent : colors.border,
            color: draft.pinned ? colors.accent : colors.textSecondary,
          }}
        >
          <Pin className="h-2.5 w-2.5" />
          {draft.pinned ? "PINNED" : "PIN"}
        </button>

        <div className="ml-auto flex gap-1">
          <button
            type="button"
            onClick={onCancel}
            className="text-[8px] px-2 py-1 border font-bold"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            CANCEL
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !can}
            className="text-[8px] px-2 py-1 border font-bold disabled:opacity-40"
            style={{ borderColor: colors.accent, color: colors.accent }}
          >
            {isNew ? "ADD NOTE" : "SAVE"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ThesisNotes({
  notes,
  onCreate,
  onPatch,
  onDelete,
  colors,
}: {
  notes: ThesisNote[];
  onCreate: (d: NoteDraft) => Promise<void>;
  onPatch: (id: string, patch: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  colors: Colors;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft>(emptyNoteDraft());
  const [busy, setBusy] = useState(false);
  const [kindFilter, setKindFilter] = useState<NoteKind | "ALL">("ALL");
  const [showResolved, setShowResolved] = useState(false);

  const visible = useMemo(
    () =>
      notes.filter(
        (n) =>
          (kindFilter === "ALL" || n.kind === kindFilter) &&
          (showResolved || n.status === "open" || n.status === "watching")
      ),
    [notes, kindFilter, showResolved]
  );

  const openCount = notes.filter((n) => n.status === "open" || n.status === "watching").length;
  const resolvedCount = notes.length - openCount;

  const startAdd = () => {
    setDraft(emptyNoteDraft());
    setEditingId(null);
    setAdding(true);
  };

  const startEdit = (n: ThesisNote) => {
    setDraft(draftFromNote(n));
    setAdding(false);
    setEditingId(n.id);
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (editingId) {
        await onPatch(editingId, {
          kind: draft.kind,
          title: draft.title.trim(),
          body: draft.body,
          // "" clears the column server-side; undefined would leave the old value.
          impact: draft.impact,
          likelihood: draft.likelihood === "" ? null : Number(draft.likelihood),
          severity: draft.severity === "" ? null : Number(draft.severity),
          status: draft.status,
          watch_date: draft.watch_date,
          pinned: draft.pinned,
        });
        setEditingId(null);
      } else {
        await onCreate(draft);
        setAdding(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const chipStyle = (active: boolean, color: string) => ({
    borderColor: active ? color : colors.border,
    color: active ? color : colors.textSecondary,
    background: active ? `${color}15` : "transparent",
  });

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="flex items-center gap-1 flex-wrap mb-2">
        <button
          type="button"
          onClick={() => setKindFilter("ALL")}
          className="text-[8px] px-1.5 py-0.5 border font-bold"
          style={chipStyle(kindFilter === "ALL", colors.accent)}
        >
          ALL ({notes.length})
        </button>
        {NOTE_KINDS.map((k) => {
          const n = notes.filter((x) => x.kind === k).length;
          if (n === 0 && kindFilter !== k) return null;
          return (
            <button
              type="button"
              key={k}
              onClick={() => setKindFilter(k)}
              className="text-[8px] px-1.5 py-0.5 border font-bold"
              style={chipStyle(kindFilter === k, NOTE_KIND_COLOR[k])}
            >
              {k} ({n})
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setShowResolved((v) => !v)}
          title="confirmed and dismissed notes"
          className="text-[8px] px-1.5 py-0.5 border font-bold"
          style={chipStyle(showResolved, "#666")}
        >
          {showResolved ? "HIDE" : "SHOW"} RESOLVED ({resolvedCount})
        </button>

        <button
          type="button"
          onClick={startAdd}
          className="ml-auto flex items-center gap-0.5 text-[8px] px-2 py-0.5 border font-bold"
          style={{ borderColor: colors.accent, color: colors.accent }}
        >
          <Plus className="h-2.5 w-2.5" />
          NOTE
        </button>
      </div>

      {adding && (
        <NoteForm
          draft={draft}
          setDraft={setDraft}
          onSubmit={submit}
          onCancel={() => setAdding(false)}
          busy={busy}
          isNew
          colors={colors}
        />
      )}

      <div className="space-y-1">
        {visible.map((n) =>
          editingId === n.id ? (
            <NoteForm
              key={n.id}
              draft={draft}
              setDraft={setDraft}
              onSubmit={submit}
              onCancel={() => setEditingId(null)}
              busy={busy}
              isNew={false}
              colors={colors}
            />
          ) : (
            <NoteCard
              key={n.id}
              note={n}
              colors={colors}
              onEdit={() => startEdit(n)}
              onPatch={onPatch}
              onDelete={onDelete}
            />
          )
        )}

        {visible.length === 0 && (
          <div className="text-[9px]" style={{ color: colors.textSecondary }}>
            {notes.length === 0
              ? "No notes yet. Use these for the things that are not the thesis itself — the scenario that would break it, the catalyst you are waiting on, the question you have not answered."
              : "Nothing matches this filter."}
          </div>
        )}
      </div>
    </div>
  );
}

function NoteCard({
  note,
  colors,
  onEdit,
  onPatch,
  onDelete,
}: {
  note: ThesisNote;
  colors: Colors;
  onEdit: () => void;
  onPatch: (id: string, patch: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const kindColor = NOTE_KIND_COLOR[note.kind] ?? "#888";
  const resolved = note.status === "confirmed" || note.status === "dismissed";
  const due = !!note.watch_date && note.watch_date <= today() && !resolved;
  const score = riskScore(note);

  return (
    <div
      className="border-l-2 pl-2 py-1"
      style={{ borderColor: kindColor, opacity: resolved ? 0.55 : 1 }}
    >
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[8px] font-bold tracking-widest" style={{ color: kindColor }}>
          {note.kind}
        </span>
        <span
          className="text-[7px] px-1 font-bold"
          style={{
            color: NOTE_STATUS_COLOR[note.status],
            border: `1px solid ${NOTE_STATUS_COLOR[note.status]}`,
          }}
        >
          {note.status.toUpperCase()}
        </span>
        {note.impact && (
          <span className="text-[7px] font-bold" style={{ color: NOTE_IMPACT_COLOR[note.impact] }}>
            {note.impact.toUpperCase()}
          </span>
        )}
        {score != null && (
          <span
            className="text-[7px] font-mono"
            title={`likelihood ${note.likelihood} × severity ${note.severity}`}
            style={{ color: colors.textSecondary }}
          >
            L{note.likelihood}×S{note.severity} = {score}
          </span>
        )}
        {note.watch_date && (
          <span
            className="text-[7px] font-mono"
            title={due ? "watch date has passed" : "watch date"}
            style={{ color: due ? "#f87171" : colors.textSecondary }}
          >
            {due ? "DUE " : "WATCH "}
            {note.watch_date}
          </span>
        )}
        {!!note.pinned && <Pin className="h-2 w-2" style={{ color: colors.accent }} />}

        <div className="ml-auto flex items-center gap-1">
          {!resolved &&
            (["watching", "confirmed", "dismissed"] as const).map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => onPatch(note.id, { status: s })}
                title={
                  s === "confirmed"
                    ? "it happened"
                    : s === "dismissed"
                      ? "it will not happen / no longer relevant"
                      : "actively watching this one"
                }
                className="text-[7px] px-1 border"
                style={{ borderColor: colors.border, color: NOTE_STATUS_COLOR[s] }}
              >
                {s.toUpperCase()}
              </button>
            ))}
          {resolved && (
            <button
              type="button"
              onClick={() => onPatch(note.id, { status: "open" })}
              className="text-[7px] px-1 border"
              style={{ borderColor: colors.border, color: NOTE_STATUS_COLOR.open }}
            >
              REOPEN
            </button>
          )}
          <button
            type="button"
            onClick={() => onPatch(note.id, { pinned: !note.pinned })}
            title={note.pinned ? "unpin" : "pin to the top"}
            className="text-[7px] px-1 border"
            style={{
              borderColor: colors.border,
              color: note.pinned ? colors.accent : colors.textSecondary,
            }}
          >
            <Pin className="h-2 w-2" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="text-[7px] px-1 border"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            EDIT
          </button>
          <button
            type="button"
            onClick={() => onDelete(note.id)}
            title="delete (kept in the database, restorable)"
            className="text-[7px] px-1 border"
            style={{ borderColor: "#f8717155", color: "#f87171" }}
          >
            <X className="h-2 w-2" />
          </button>
        </div>
      </div>

      {note.title && (
        <div className="text-[10px] font-bold mt-0.5" style={{ color: colors.text }}>
          {note.title}
        </div>
      )}
      {note.body && (
        <div
          className="text-[9px] mt-0.5 whitespace-pre-wrap"
          style={{ color: colors.textSecondary }}
        >
          {note.body}
        </div>
      )}
      <div className="text-[7px] mt-0.5" style={{ color: "#444" }}>
        {(note.updated_at ?? note.created_at ?? "").slice(0, 16).replace("T", " ")}
      </div>
    </div>
  );
}
