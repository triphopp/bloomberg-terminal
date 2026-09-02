"use client";
import { BookOpen, FlaskConical, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Colors } from "../../helpers";
import { fmtK, pnlColor } from "../../helpers";
import { ConfirmDeleteModal } from "../../modals/ConfirmDeleteModal";
import type { Trade } from "../../types";
import { type ThesisDraft, ThesisEditor, draftFrom, emptyDraft } from "./ThesisEditor";
import { type NoteDraft, ThesisNotes } from "./ThesisNotes";
import { ThesisRail } from "./ThesisRail";
import { ThesisTimeline } from "./ThesisTimeline";
import { renderMarkdown } from "./markdown";
import {
  STATUS_COLOR,
  type Thesis,
  type ThesisEvent,
  type ThesisLink,
  type ThesisNote,
} from "./types";

type SubTab = "thesis" | "notes" | "history" | "trades" | "ai";

const API = "/api/v2/theses";

export function ThesesTab({
  colors,
  accountId,
  initialSymbol,
  onConsumeInitialSymbol,
}: {
  colors: Colors;
  accountId?: string;
  /** Symbol handed over from the positions table — select its thesis, or open a
   *  pre-filled NEW form when the holding has none yet. */
  initialSymbol?: string | null;
  onConsumeInitialSymbol?: () => void;
}) {
  const [theses, setTheses] = useState<Thesis[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    thesis: Thesis;
    events: ThesisEvent[];
    links: ThesisLink[];
    notes?: ThesisNote[];
  } | null>(null);
  const [subTab, setSubTab] = useState<SubTab>("thesis");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ThesisDraft>(emptyDraft());
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [positions, setPositions] = useState<Trade[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const textRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async (signal?: AbortSignal) => {
    setLoadingList(true);
    try {
      const r = await fetch(API, { signal });
      const d = await r.json();
      setTheses(Array.isArray(d.theses) ? d.theses : []);
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") setTheses([]);
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await fetch(`${API}/${id}`);
      if (!r.ok) return;
      setDetail(await r.json());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    loadList(ac.signal);
    return () => ac.abort();
  }, [loadList]);

  // Open positions power the "what am I actually holding" strip in the header —
  // a thesis is only worth re-reading against the position it justifies.
  useEffect(() => {
    const ac = new AbortController();
    const qs = new URLSearchParams();
    if (accountId && accountId !== "all") qs.set("account_id", accountId);
    fetch(`/api/v2/portfolio/open-positions?${qs}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setPositions(Array.isArray(d?.positions) ? d.positions : []))
      .catch(() => {});
    return () => ac.abort();
  }, [accountId]);

  // Runs once the list has arrived, so an unknown symbol correctly falls
  // through to the NEW form instead of racing the fetch.
  useEffect(() => {
    if (!initialSymbol || loadingList) return;
    const match = theses.find((t) => t.symbol.toUpperCase() === initialSymbol.toUpperCase());
    if (match) {
      setSelectedId(match.id);
      setEditing(false);
      setSubTab("thesis");
    } else {
      setIsNew(true);
      setEditing(true);
      setDraft(emptyDraft(initialSymbol.toUpperCase()));
    }
    onConsumeInitialSymbol?.();
  }, [initialSymbol, loadingList, theses, onConsumeInitialSymbol]);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: textRef is stable
  useEffect(() => {
    if (textRef.current) textRef.current.scrollTop = textRef.current.scrollHeight;
  }, [streamText]);

  const thesis = detail?.thesis ?? null;

  const livePosition = useMemo(() => {
    if (!thesis) return null;
    const lots = positions.filter(
      (p) => (p.symbol ?? "").toUpperCase() === thesis.symbol.toUpperCase()
    );
    if (lots.length === 0) return null;
    const volume = lots.reduce((n, p) => n + (p.volume ?? 0), 0);
    const pnl = lots.reduce((n, p) => n + (p.unrealized_pnl_base ?? 0), 0);
    const cost = lots.reduce((n, p) => n + (p.cost_basis_base ?? 0), 0);
    return { volume, pnl, pct: cost > 0 ? (pnl / cost) * 100 : null, lots: lots.length };
  }, [positions, thesis]);

  // Only unresolved notes are counted on the tab: a badge that also counts
  // dismissed scenarios never goes down, so it stops meaning anything.
  const openNoteCount = useMemo(
    () =>
      (detail?.notes ?? []).filter((n) => n.status === "open" || n.status === "watching").length,
    [detail]
  );

  const startNew = () => {
    setIsNew(true);
    setEditing(true);
    setDraft(emptyDraft());
  };

  const startEdit = () => {
    if (!thesis) return;
    setIsNew(false);
    setEditing(true);
    setDraft(draftFrom(thesis));
  };

  const numOrNull = (v: string) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        symbol: draft.symbol.trim(),
        title: draft.title.trim() || draft.symbol.trim().toUpperCase(),
        category: draft.category,
        sub_portfolio: draft.sub_portfolio,
        strategy: draft.strategy,
        status: draft.status,
        conviction: numOrNull(draft.conviction),
        time_horizon: draft.time_horizon,
        target_price: numOrNull(draft.target_price),
        stop_price: numOrNull(draft.stop_price),
        body: draft.body,
      };
      if (!isNew) body.note = draft.note;
      const r = await fetch(isNew ? API : `${API}/${selectedId}`, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) {
        setBanner(typeof d.detail === "string" ? d.detail : "Save failed");
        return;
      }
      setEditing(false);
      await loadList();
      const id = d.thesis?.id ?? selectedId;
      if (id) {
        setSelectedId(id);
        await loadDetail(id);
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    // Soft delete: it disappears from the rail but stays restorable and the
    // history survives, so a mis-click is not a lost record.
    await fetch(`${API}/${selectedId}`, { method: "DELETE" });
    setConfirmDelete(false);
    setSelectedId(null);
    setDetail(null);
    await loadList();
  };

  const exportMd = async () => {
    if (!selectedId) return;
    const r = await fetch(`${API}/${selectedId}/export-md`, { method: "POST" });
    const d = await r.json();
    setBanner(r.ok ? `Exported → ${d.file}` : (d.detail ?? "Export failed"));
    if (r.ok) loadDetail(selectedId);
  };

  const importMd = async () => {
    const r = await fetch(`${API}/import-md`, { method: "POST" });
    const d = await r.json();
    setBanner(
      r.ok
        ? `Imported ${d.imported_count} file(s), skipped ${d.skipped?.length ?? 0}`
        : (d.detail ?? "Import failed")
    );
    if (r.ok) loadList();
  };

  const addNote = async (note: string, occurredAt: string) => {
    if (!selectedId) return;
    await fetch(`${API}/${selectedId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "NOTE",
        note,
        occurred_at: occurredAt ? `${occurredAt}T00:00:00` : undefined,
      }),
    });
    loadDetail(selectedId);
  };

  const deleteNote = async (id: string) => {
    if (!selectedId) return;
    await fetch(`${API}/${selectedId}/events/${id}`, { method: "DELETE" });
    loadDetail(selectedId);
  };

  // ── Notes ────────────────────────────────────────────────────────────────
  // Reload the list too: the rail badge counts open notes, so adding or
  // resolving one has to move it or the badge lies until the next mount.
  const afterNoteWrite = async () => {
    if (!selectedId) return;
    await loadDetail(selectedId);
    loadList();
  };

  const createNote = async (d: NoteDraft) => {
    if (!selectedId) return;
    const r = await fetch(`${API}/${selectedId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: d.kind,
        title: d.title.trim(),
        body: d.body,
        impact: d.impact || null,
        likelihood: d.likelihood === "" ? null : Number(d.likelihood),
        severity: d.severity === "" ? null : Number(d.severity),
        status: d.status,
        watch_date: d.watch_date || null,
        pinned: d.pinned,
      }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      setBanner(typeof e.detail === "string" ? e.detail : "Could not add the note");
      return;
    }
    await afterNoteWrite();
  };

  const patchNote = async (id: string, patch: Record<string, unknown>) => {
    if (!selectedId) return;
    const r = await fetch(`${API}/${selectedId}/notes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      setBanner(typeof e.detail === "string" ? e.detail : "Could not save the note");
      return;
    }
    await afterNoteWrite();
  };

  const removeNote = async (id: string) => {
    if (!selectedId) return;
    await fetch(`${API}/${selectedId}/notes/${id}`, { method: "DELETE" });
    await afterNoteWrite();
  };

  const runResearch = async () => {
    if (!thesis) return;
    setSubTab("ai");
    setStreaming(true);
    setStreamText("");
    try {
      const r = await fetch("/api/portfolio/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: thesis.symbol, provider: "claude" }),
      });
      const reader = r.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(line.slice(5));
            if (ev.token) setStreamText((t) => t + ev.token);
            if (ev.done) break;
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    } finally {
      setStreaming(false);
    }
  };

  const chip = (label: string, value: string, color?: string) => (
    <div className="px-1.5 py-0.5" style={{ background: "#0a0a0a" }}>
      <div className="text-[7px] tracking-widest" style={{ color: colors.textSecondary }}>
        {label}
      </div>
      <div className="text-[9px] font-bold font-mono" style={{ color: color ?? colors.text }}>
        {value}
      </div>
    </div>
  );

  return (
    <div className="flex" style={{ minHeight: "400px", height: "100%" }}>
      {/* Rail */}
      <div
        className="w-52 border-r flex flex-col flex-shrink-0"
        style={{ borderColor: colors.border }}
      >
        <div
          className="px-2 py-1 flex items-center gap-1 border-b shrink-0"
          style={{ borderColor: colors.border }}
        >
          <span className="text-[9px] font-bold tracking-widest" style={{ color: colors.accent }}>
            THESES
          </span>
          {loadingList && (
            <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: colors.accent }} />
          )}
          <button
            type="button"
            onClick={startNew}
            title="new thesis"
            className="ml-auto flex items-center gap-0.5 text-[7px] px-1 py-0.5 border font-bold"
            style={{ borderColor: colors.accent, color: colors.accent }}
          >
            <Plus className="h-2 w-2" />
            NEW
          </button>
        </div>
        <ThesisRail
          theses={theses}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setEditing(false);
            setSubTab("thesis");
            setStreamText("");
          }}
          colors={colors}
        />
        <button
          type="button"
          onClick={importMd}
          className="border-t px-2 py-1 text-[7px] tracking-widest shrink-0"
          style={{ borderColor: colors.border, color: colors.textSecondary }}
        >
          IMPORT .MD FROM THESES_DIR
        </button>
      </div>

      {/* Detail */}
      <div className="flex-1 flex flex-col min-w-0">
        {banner && (
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="px-2 py-1 text-[8px] text-left border-b"
            style={{ borderColor: colors.border, color: colors.accent, background: "#ff990010" }}
          >
            {banner} — click to dismiss
          </button>
        )}

        {editing ? (
          <ThesisEditor
            draft={draft}
            setDraft={setDraft}
            onSave={save}
            onCancel={() => setEditing(false)}
            saving={saving}
            isNew={isNew}
            colors={colors}
          />
        ) : thesis ? (
          <>
            <div className="border-b shrink-0" style={{ borderColor: colors.border }}>
              <div className="flex items-start justify-between px-3 pt-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm" style={{ color: colors.accent }}>
                      {thesis.symbol}
                    </span>
                    <span
                      className="text-[8px] px-1 font-bold"
                      style={{
                        color: STATUS_COLOR[thesis.status],
                        border: `1px solid ${STATUS_COLOR[thesis.status]}`,
                      }}
                    >
                      {thesis.status.toUpperCase()}
                    </span>
                  </div>
                  <div className="text-[10px]" style={{ color: colors.textSecondary }}>
                    {thesis.title}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={startEdit}
                    className="text-[8px] px-2 py-1 border font-bold"
                    style={{ borderColor: colors.accent, color: colors.accent }}
                  >
                    EDIT
                  </button>
                  <button
                    type="button"
                    onClick={exportMd}
                    title="write markdown back to THESES_DIR (Obsidian)"
                    className="text-[8px] px-2 py-1 border font-bold"
                    style={{ borderColor: colors.border, color: colors.textSecondary }}
                  >
                    EXPORT
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="text-[8px] px-2 py-1 border font-bold"
                    style={{ borderColor: "#f87171", color: "#f87171" }}
                  >
                    DELETE
                  </button>
                  <button
                    type="button"
                    onClick={runResearch}
                    disabled={streaming}
                    className="flex items-center gap-1 text-[8px] px-2 py-1 border font-bold disabled:opacity-40"
                    style={{ borderColor: colors.accent, color: colors.accent }}
                  >
                    {streaming ? (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    ) : (
                      <FlaskConical className="h-2.5 w-2.5" />
                    )}
                    AI
                  </button>
                </div>
              </div>

              <div className="flex gap-px px-3 py-2 flex-wrap">
                {chip("CONVICTION", thesis.conviction == null ? "—" : `${thesis.conviction}/5`)}
                {chip("HORIZON", thesis.time_horizon || "—")}
                {chip("TARGET", thesis.target_price == null ? "—" : String(thesis.target_price))}
                {chip("STOP", thesis.stop_price == null ? "—" : String(thesis.stop_price))}
                {chip("CATEGORY", thesis.category || "—")}
                {chip("STRATEGY", thesis.strategy || "—")}
                {livePosition
                  ? chip(
                      "POSITION (OPEN)",
                      `${livePosition.volume.toLocaleString()} sh · ${fmtK(livePosition.pnl)}${
                        livePosition.pct == null ? "" : ` (${livePosition.pct.toFixed(1)}%)`
                      }`,
                      pnlColor(livePosition.pnl)
                    )
                  : chip("POSITION (OPEN)", "not held", colors.textSecondary)}
                {chip("UPDATED", (thesis.updated_at ?? "").slice(0, 10))}
              </div>

              <div className="flex gap-1 px-3 pb-1">
                {(
                  [
                    ["thesis", "THESIS"],
                    ["notes", `NOTES (${openNoteCount})`],
                    ["history", `HISTORY (${detail?.events.length ?? 0})`],
                    ["trades", `LINKED TRADES (${detail?.links.length ?? 0})`],
                    ["ai", "AI ANALYSIS"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    type="button"
                    key={key}
                    onClick={() => setSubTab(key as SubTab)}
                    className="text-[8px] px-2 py-0.5 border font-bold"
                    style={{
                      borderColor: subTab === key ? colors.accent : colors.border,
                      color: subTab === key ? colors.accent : colors.textSecondary,
                      background: subTab === key ? "#ff990015" : "transparent",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {subTab === "thesis" && (
              <div className="flex-1 overflow-y-auto p-3">
                {renderMarkdown(thesis.body ?? "", colors)}
                {thesis.source_file && (
                  <div className="mt-3 text-[7px]" style={{ color: "#444" }}>
                    source file: {thesis.source_file}
                  </div>
                )}
              </div>
            )}

            {subTab === "notes" && (
              <ThesisNotes
                notes={detail?.notes ?? []}
                onCreate={createNote}
                onPatch={patchNote}
                onDelete={removeNote}
                colors={colors}
              />
            )}

            {subTab === "history" && (
              <ThesisTimeline
                events={detail?.events ?? []}
                onAddNote={addNote}
                onDeleteNote={deleteNote}
                colors={colors}
              />
            )}

            {subTab === "trades" && (
              <div className="flex-1 overflow-y-auto p-3">
                <table className="w-full text-[9px] font-mono">
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                      {["SYMBOL", "ENTRY", "EXIT", "VOL", "ROLE", ""].map((h) => (
                        <th
                          key={h}
                          className="text-left py-0.5"
                          style={{ color: colors.textSecondary }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(detail?.links ?? []).map((l) => (
                      <tr key={l.trade_id} style={{ borderBottom: "1px solid #1a1a1a" }}>
                        <td className="py-0.5" style={{ color: colors.accent }}>
                          {l.symbol ?? "—"}
                        </td>
                        <td className="py-0.5" style={{ color: colors.text }}>
                          {l.date_entry ?? "—"} @ {l.price_entry ?? "—"}
                        </td>
                        <td className="py-0.5" style={{ color: colors.text }}>
                          {l.date_exit ? `${l.date_exit} @ ${l.price_exit ?? "—"}` : "open"}
                        </td>
                        <td className="py-0.5" style={{ color: colors.text }}>
                          {l.volume ?? "—"}
                        </td>
                        <td className="py-0.5" style={{ color: colors.textSecondary }}>
                          {l.role || "—"}
                        </td>
                        <td className="py-0.5 text-right">
                          <button
                            type="button"
                            onClick={async () => {
                              await fetch(`${API}/${selectedId}/links/${l.trade_id}`, {
                                method: "DELETE",
                              });
                              if (selectedId) loadDetail(selectedId);
                            }}
                            className="text-[7px]"
                            style={{ color: "#f87171" }}
                          >
                            UNLINK
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(detail?.links ?? []).length === 0 && (
                  <div className="text-[9px] mt-2" style={{ color: colors.textSecondary }}>
                    No linked trades. Link one from the positions table.
                  </div>
                )}
              </div>
            )}

            {subTab === "ai" && (
              <div className="flex-1 overflow-y-auto p-3" ref={textRef}>
                {streamText ? (
                  renderMarkdown(streamText, colors)
                ) : (
                  <div className="text-[9px]" style={{ color: colors.textSecondary }}>
                    Press AI to run an analysis against this thesis.
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div
            className="flex-1 flex items-center justify-center"
            style={{ color: colors.textSecondary }}
          >
            <div className="text-center">
              <BookOpen className="h-8 w-8 mx-auto mb-2 opacity-20" />
              <div className="text-xs">Select a thesis, or press NEW</div>
            </div>
          </div>
        )}
      </div>

      {confirmDelete && thesis && (
        <ConfirmDeleteModal
          title={`Delete thesis — ${thesis.symbol}`}
          message="It is removed from the list but kept in the database with its full history, and can be restored."
          colors={colors}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={remove}
        />
      )}
    </div>
  );
}
