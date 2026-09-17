"use client";
import { useState } from "react";
import type { Colors } from "../../../helpers";
import { STANCE_COLOR, type ZettelConflict } from "../types";

/** Open contradictions, both sides side by side.
 *
 *  The panel deliberately does not pick a winner: it puts the two claims, their
 *  dates and who wrote them next to each other, and asks for a sentence saying
 *  what settled it. An unresolved conflict is a better record than a wrong
 *  resolution, so RESOLVE stays disabled until that sentence exists. */
export function ConflictPanel({
  conflicts,
  onResolve,
  onOpen,
  colors,
}: {
  conflicts: ZettelConflict[];
  onResolve: (edgeId: string, resolution: string, supersededId?: string) => Promise<void>;
  onOpen: (zettelId: string) => void;
  colors: Colors;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loser, setLoser] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const side = (c: ZettelConflict, which: "src" | "dst") => {
    const id = which === "src" ? c.src_id : c.dst_id;
    const ref = which === "src" ? c.src_ref : c.dst_ref;
    const title = which === "src" ? c.src_title : c.dst_title;
    const stance = which === "src" ? c.src_stance : c.dst_stance;
    const when = (which === "src" ? c.src_occurred_at : c.dst_occurred_at) ?? "";
    const actor = which === "src" ? c.src_actor : c.dst_actor;
    const picked = loser[c.id] === id;
    return (
      <div className="flex-1 min-w-0 p-1.5" style={{ background: "#0a0a0a" }}>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onOpen(id)}
            className="text-[8px] font-mono font-bold"
            style={{ color: colors.accent }}
          >
            {ref}
          </button>
          <span className="text-[7px] font-mono" style={{ color: colors.textSecondary }}>
            {String(when).slice(0, 10)}
          </span>
          {stance && (
            <span className="text-[7px] font-bold" style={{ color: STANCE_COLOR[stance] }}>
              {stance.toUpperCase()}
            </span>
          )}
          {actor !== "user" && (
            <span className="text-[7px] font-bold" style={{ color: "#f472b6" }}>
              {actor.replace(/^agent:/, "AGENT·").toUpperCase()}
            </span>
          )}
        </div>
        <div className="text-[9px] mt-0.5" style={{ color: colors.text }}>
          {title}
        </div>
        <button
          type="button"
          onClick={() => setLoser((m) => ({ ...m, [c.id]: picked ? "" : id }))}
          className="text-[7px] mt-1 tracking-widest"
          style={{ color: picked ? "#a78bfa" : "#444" }}
        >
          {picked ? "✓ THIS ONE IS SUPERSEDED" : "mark superseded"}
        </button>
      </div>
    );
  };

  if (!conflicts.length) {
    return (
      <div className="p-3 text-[9px]" style={{ color: colors.textSecondary }}>
        No open contradictions. New findings that clash with what is written land here.
      </div>
    );
  }

  return (
    <div className="space-y-2 p-2">
      {conflicts.map((c) => {
        const text = draft[c.id] ?? "";
        return (
          <div key={c.id} className="border p-1.5" style={{ borderColor: "#f8717155" }}>
            <div className="flex items-stretch gap-1">
              {side(c, "src")}
              <div
                className="self-center text-[10px] font-bold px-1"
                style={{ color: "#f87171" }}
                title="these two cannot both be right as written"
              >
                ⟂
              </div>
              {side(c, "dst")}
            </div>
            {c.note && (
              <div className="text-[8px] mt-1 px-1" style={{ color: colors.textSecondary }}>
                why linked: {c.note}
              </div>
            )}
            <div className="flex gap-1 mt-1">
              <input
                value={text}
                onChange={(e) => setDraft((m) => ({ ...m, [c.id]: e.target.value }))}
                placeholder="what settled it — the evidence, not the verdict"
                className="flex-1 border px-1.5 py-1 text-[9px] font-mono outline-none"
                style={{ borderColor: colors.border, color: colors.text, background: "#0a0a0a" }}
              />
              <button
                type="button"
                disabled={!text.trim() || busy === c.id}
                onClick={async () => {
                  setBusy(c.id);
                  try {
                    await onResolve(c.id, text.trim(), loser[c.id] || undefined);
                    setDraft((m) => ({ ...m, [c.id]: "" }));
                  } finally {
                    setBusy(null);
                  }
                }}
                className="text-[8px] px-2 border font-bold disabled:opacity-40"
                style={{ borderColor: "#4ade80", color: "#4ade80" }}
              >
                RESOLVE
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
