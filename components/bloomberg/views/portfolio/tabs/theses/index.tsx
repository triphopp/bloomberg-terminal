"use client";
import { toolsThesisIdAtom } from "@/components/bloomberg/atoms";
import { useIsMobile } from "@/hooks/use-mobile";
import { useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { BookOpen, FlaskConical, Loader2, MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Colors } from "../../helpers";
import { fmtAmt, fmtQty, pnlColor } from "../../helpers";
import { ConfirmDeleteModal } from "../../modals/ConfirmDeleteModal";
import type { Trade } from "../../types";
import { ReadView } from "./ReadView";
import { type ThesisDraft, ThesisEditor, draftFrom, emptyDraft } from "./ThesisEditor";
import { NavRail, ThesisNavigator, useThesisList } from "./ThesisNavigator";
import { type NoteDraft, ThesisNotes } from "./ThesisNotes";
import { ThesisTimeline } from "./ThesisTimeline";
import { AntiPanel, useAntiCounts } from "./anti/AntiPanel";
import { GraphsPanel } from "./graphs/GraphsPanel";
import { renderMarkdown } from "./markdown";
import { INSTRUMENT_KINDS, kindOf, sectorOf, tagsOf } from "./nav-filter";
import {
  STATUS_COLOR,
  type Thesis,
  type ThesisEvent,
  type ThesisLink,
  type ThesisNote,
} from "./types";
import { ReadDot, UnreadBar, useReads } from "./useReads";
import { ZettelPanel } from "./zettel/ZettelPanel";

type SubTab = "thesis" | "anti" | "notes" | "kb" | "graphs" | "history" | "trades" | "ai";

const API = "/api/v2/theses";

export function ThesesTab({
  colors,
  accountId,
  initialSymbol,
  onConsumeInitialSymbol,
  initialOpen,
  onConsumeInitialOpen,
}: {
  colors: Colors;
  accountId?: string;
  /** Symbol handed over from the positions table — select its thesis, or open a
   *  pre-filled NEW form when the holding has none yet. */
  initialSymbol?: string | null;
  onConsumeInitialSymbol?: () => void;
  /** A thesis to land on, handed over by the calendar or a CALENDAR alert —
   *  on NOTES, at one note, when the date is a note of it. */
  initialOpen?: { thesisId: string; sub: "thesis" | "notes" | "graphs"; noteId?: string } | null;
  onConsumeInitialOpen?: () => void;
}) {
  const qc = useQueryClient();
  const { data: listData, isLoading: loadingList } = useThesisList();
  const theses = useMemo(() => listData?.theses ?? [], [listData]);
  // Shared with QUESTIONS and TRACK: the three tabs stay on the same thesis.
  const [toolsThesisId, setToolsThesisId] = useAtom(toolsThesisIdAtom);
  const selectedId = toolsThesisId || null;
  const setSelectedId = useCallback(
    (id: string | null) => setToolsThesisId(id ?? ""),
    [setToolsThesisId]
  );
  const reads = useReads();
  const { data: antiCounts } = useAntiCounts();
  const [menuOpen, setMenuOpen] = useState(false);
  const [detail, setDetail] = useState<{
    thesis: Thesis;
    events: ThesisEvent[];
    links: ThesisLink[];
    notes?: ThesisNote[];
    counts?: { zettel: number; conflicts: number; graphs: number };
  } | null>(null);
  const [subTab, setSubTab] = useState<SubTab>(() => initialOpen?.sub ?? "thesis");
  // The note a hand-over points at: NOTES scrolls to it and marks it.
  const [focusNoteId, setFocusNoteId] = useState<string | null>(() => initialOpen?.noteId ?? null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ThesisDraft>(emptyDraft());
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [positions, setPositions] = useState<Trade[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  // Counts for the KB and GRAPHS tab labels. They come with the detail payload,
  // so a tab that was never opened still shows its real number; the panels
  // report theirs up as they load, which keeps the label live while editing.
  const [kbCounts, setKbCounts] = useState<{ notes: number; conflicts: number } | null>(null);
  const [graphCount, setGraphCount] = useState<number | null>(null);
  // Phone: rail and detail can't share 375px (the detail got ~160px), so it is
  // one or the other. A hand-off from the positions table goes straight to detail.
  const isMobile = useIsMobile();
  const [mobileList, setMobileList] = useState(!initialSymbol && !initialOpen);
  // READ is a way of looking at the same thesis, not a tab: it stays on while
  // the user moves between theses, which is what "I am reading tonight" means.
  const [reading, setReading] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  // The list belongs to React Query (the navigator, QUESTIONS and TRACK read
  // the same cache); a write here refreshes it and whatever is unread.
  const loadList = useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["theses"] }),
        qc.invalidateQueries({ queryKey: ["reads"] }),
      ]),
    [qc]
  );

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await fetch(`${API}/${id}`);
      if (!r.ok) return;
      setDetail(await r.json());
      // A panel's own count belongs to the thesis it was mounted for; drop it
      // so the freshly loaded detail counts take over on a switch.
      setKbCounts(null);
      setGraphCount(null);
    } catch {
      /* ignore */
    }
  }, []);

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
  }, [initialSymbol, loadingList, theses, onConsumeInitialSymbol, setSelectedId]);

  // Taken as it arrives, not only on mount: a second alert can land while the
  // tab is already open on another thesis.
  useEffect(() => {
    if (!initialOpen) return;
    setSelectedId(initialOpen.thesisId);
    setEditing(false);
    setReading(false);
    setMobileList(false);
    setSubTab(initialOpen.sub);
    setFocusNoteId(initialOpen.noteId ?? null);
    onConsumeInitialOpen?.();
  }, [initialOpen, onConsumeInitialOpen, setSelectedId]);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    else setDetail(null);
    setMenuOpen(false);
  }, [selectedId, loadDetail]);

  // A remembered thesis that was deleted on another device would leave a blank pane.
  useEffect(() => {
    if (selectedId && theses.length && !theses.some((t) => t.id === selectedId))
      setSelectedId(null);
  }, [theses, selectedId, setSelectedId]);

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

  // The panel's own number wins once it has loaded — it reflects edits made in
  // the tab — otherwise the count that arrived with the thesis.
  const kbLabel = useMemo(() => {
    const notes = kbCounts?.notes ?? detail?.counts?.zettel ?? 0;
    const conflicts = kbCounts?.conflicts ?? detail?.counts?.conflicts ?? 0;
    return conflicts ? `KB (${notes}) ⟂${conflicts}` : `KB (${notes})`;
  }, [kbCounts, detail]);

  // Beliefs still owed an argument; ⚠ = what waits for the user (a fallen key
  // claim, a claim to rewrite, an agent's verdict to review). No number at all
  // while nothing has been put on the board — "0" would read as "all clear".
  const antiLabel = useMemo(() => {
    const n = selectedId ? antiCounts?.by_thesis[selectedId] : undefined;
    if (!n) return "ANTI-THESIS";
    return `ANTI-THESIS (${n.open})${n.alert ? ` ⚠${n.alert}` : ""}`;
  }, [antiCounts, selectedId]);

  const startNew = () => {
    setMobileList(false);
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
        kind: draft.kind,
        sector: draft.sector,
        tags: draft.tags,
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

  const selectThesis = (id: string) => {
    setFocusNoteId(null);
    setSelectedId(id);
    setMobileList(false);
    setEditing(false);
    setSubTab("thesis");
    setStreamText("");
  };
  const navigator = (
    <ThesisNavigator
      colors={colors}
      selectedId={selectedId ?? ""}
      onSelect={selectThesis}
      onNew={startNew}
      footer={
        <button
          type="button"
          onClick={importMd}
          title="นำเข้าไฟล์ .md จาก THESES_DIR"
          className="hover:opacity-80"
        >
          นำเข้า .md
        </button>
      }
    />
  );

  const kind = thesis ? kindOf(thesis) : "";
  const isInstrument = INSTRUMENT_KINDS.has(kind);
  const unread = (thesis && reads.byThesis[thesis.id]) || null;
  const dot = (n: number | undefined) => (n ? ` ●${n}` : "");
  // One line of facts under the title; a field with nothing in it is left out
  // rather than shown as a dash.
  const facts: { label: string; value: string; color?: string }[] = thesis
    ? [
        ...(thesis.conviction == null
          ? []
          : [{ label: "conviction", value: `${thesis.conviction}/5` }]),
        ...(thesis.time_horizon ? [{ label: "horizon", value: thesis.time_horizon }] : []),
        ...(isInstrument && thesis.target_price != null
          ? [{ label: "target", value: String(thesis.target_price) }]
          : []),
        ...(isInstrument && thesis.stop_price != null
          ? [{ label: "stop", value: String(thesis.stop_price) }]
          : []),
        ...(thesis.category ? [{ label: "category", value: thesis.category }] : []),
        ...(thesis.strategy ? [{ label: "strategy", value: thesis.strategy }] : []),
        ...(isInstrument
          ? [
              livePosition
                ? {
                    label: "ถืออยู่",
                    value: `${fmtQty(livePosition.volume)} sh · ${fmtAmt(livePosition.pnl)}${
                      livePosition.pct == null ? "" : ` (${livePosition.pct.toFixed(1)}%)`
                    }`,
                    color: pnlColor(livePosition.pnl),
                  }
                : { label: "ถืออยู่", value: "ไม่ได้ถือ" },
            ]
          : []),
        { label: "แก้ล่าสุด", value: (thesis.updated_at ?? "").slice(0, 10) },
      ]
    : [];
  const actionBtn = "text-[9px] px-2 py-0.5 border font-bold";

  return (
    <div className="reading flex" style={{ minHeight: "400px", height: "100%" }}>
      {isMobile ? (
        <div className={mobileList ? "w-full flex flex-col min-h-0" : "hidden"}>{navigator}</div>
      ) : (
        <NavRail colors={colors}>{navigator}</NavRail>
      )}

      {/* Detail */}
      <div className={`flex-1 flex flex-col min-w-0 ${isMobile && mobileList ? "hidden" : ""}`}>
        {isMobile && (
          <button
            type="button"
            onClick={() => setMobileList(true)}
            className="px-3 py-2 text-[10px] text-left border-b tracking-widest shrink-0"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            ← รายการ thesis
          </button>
        )}
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
            <div
              className="border-b shrink-0 px-3 pt-2 pb-1.5"
              style={{ borderColor: colors.border }}
            >
              <div className="flex items-baseline gap-2 flex-wrap">
                <ReadDot type="thesis" id={thesis.id} colors={colors} reads={reads} />
                <span className="font-bold font-mono text-sm" style={{ color: colors.accent }}>
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
                <span className="text-[9px]" style={{ color: colors.textSecondary }}>
                  {[kind, sectorOf(thesis)].filter(Boolean).join(" · ")}
                  {tagsOf(thesis).map((t) => (
                    <span key={t} className="ml-1.5" style={{ color: colors.textDimmed }}>
                      #{t}
                    </span>
                  ))}
                </span>
                <span className="ml-auto text-[9px]">
                  <UnreadBar
                    count={unread?.total ?? 0}
                    onMarkAll={() => void reads.markThesis(thesis.id)}
                    colors={colors}
                  />
                </span>
              </div>
              <div className="text-[11px] font-bold" style={{ color: colors.text }}>
                {thesis.title}
              </div>
              <div
                className="text-[9px] flex flex-wrap gap-x-3"
                style={{ color: colors.textSecondary }}
              >
                {facts.map((x) => (
                  <span key={x.label}>
                    {x.label}{" "}
                    <span className="font-mono" style={{ color: x.color ?? colors.text }}>
                      {x.value}
                    </span>
                  </span>
                ))}
              </div>

              <div className="flex gap-1 mt-1.5 flex-wrap items-center relative">
                {!reading &&
                  (
                    [
                      ["thesis", "THESIS"],
                      ["anti", antiLabel],
                      ["notes", `NOTES (${openNoteCount})${dot(unread?.note)}`],
                      ["kb", `${kbLabel}${dot(unread?.zettel)}`],
                      [
                        "graphs",
                        `RESEARCH (${graphCount ?? detail?.counts?.graphs ?? 0})${dot(unread?.graph)}`,
                      ],
                      ["history", `HISTORY (${detail?.events.length ?? 0})`],
                      ["trades", `TRADES (${detail?.links.length ?? 0})`],
                      ["ai", "AI"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      type="button"
                      key={key}
                      aria-pressed={subTab === key}
                      onClick={() => setSubTab(key as SubTab)}
                      className={actionBtn}
                      style={{
                        borderColor: subTab === key ? colors.accent : colors.border,
                        color: subTab === key ? colors.accent : colors.textSecondary,
                        background: subTab === key ? "#ff990015" : "transparent",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                <span className="flex-1" />
                <button
                  aria-pressed={reading}
                  type="button"
                  onClick={() => setReading((v) => !v)}
                  title="อ่านทั้ง thesis เป็นเอกสารหน้าเดียว"
                  className={actionBtn}
                  style={{
                    borderColor: reading ? colors.accent : colors.border,
                    color: reading ? colors.accent : colors.textSecondary,
                    background: reading ? "#ff990015" : "transparent",
                  }}
                >
                  READ
                </button>
                <button
                  type="button"
                  onClick={startEdit}
                  className={actionBtn}
                  style={{ borderColor: colors.accent, color: colors.accent }}
                >
                  EDIT
                </button>
                <button
                  aria-pressed={menuOpen}
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  title="เพิ่มเติม"
                  aria-label="เพิ่มเติม"
                  className={actionBtn}
                  style={{ borderColor: colors.border, color: colors.textSecondary }}
                >
                  <MoreHorizontal className="h-3 w-3" />
                </button>
                {menuOpen && (
                  <div
                    className="absolute right-0 top-full mt-1 z-20 border flex flex-col text-[10px] min-w-[180px]"
                    style={{ borderColor: colors.border, background: colors.surface }}
                  >
                    <button
                      type="button"
                      className="px-2 py-1 text-left hover:opacity-80 flex items-center gap-1"
                      style={{ color: colors.accent }}
                      disabled={streaming}
                      onClick={() => {
                        setMenuOpen(false);
                        void runResearch();
                      }}
                    >
                      {streaming ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <FlaskConical className="h-3 w-3" />
                      )}
                      วิเคราะห์ด้วย AI
                    </button>
                    <button
                      type="button"
                      className="px-2 py-1 text-left hover:opacity-80"
                      style={{ color: colors.text }}
                      title="เขียน markdown กลับไปที่ THESES_DIR (Obsidian)"
                      onClick={() => {
                        setMenuOpen(false);
                        void exportMd();
                      }}
                    >
                      Export .md
                    </button>
                    <button
                      type="button"
                      className="px-2 py-1 text-left hover:opacity-80"
                      style={{ color: "#f87171" }}
                      onClick={() => {
                        setMenuOpen(false);
                        setConfirmDelete(true);
                      }}
                    >
                      ลบ thesis
                    </button>
                  </div>
                )}
              </div>
            </div>

            {reading && (
              <ReadView
                thesis={thesis}
                notes={detail?.notes ?? []}
                events={detail?.events ?? []}
                colors={colors}
              />
            )}

            {!reading && subTab === "thesis" && (
              <div className="flex-1 overflow-y-auto p-4">
                <div className="prose-measure">
                  {renderMarkdown(thesis.body ?? "", colors, "read")}
                  {thesis.source_file && (
                    <div className="mt-3 text-[8px]" style={{ color: colors.textDimmed }}>
                      source file: {thesis.source_file}
                    </div>
                  )}
                </div>
              </div>
            )}

            {!reading && subTab === "anti" && (
              <AntiPanel
                key={thesis.id}
                thesisId={thesis.id}
                colors={colors}
                onChange={() => void loadDetail(thesis.id)}
              />
            )}

            {!reading && subTab === "notes" && (
              <ThesisNotes
                notes={detail?.notes ?? []}
                onCreate={createNote}
                onPatch={patchNote}
                onDelete={removeNote}
                colors={colors}
                focusId={focusNoteId}
              />
            )}

            {!reading && subTab === "kb" && (
              <ZettelPanel
                thesisId={thesis.id}
                symbol={thesis.symbol}
                colors={colors}
                onCountsChange={setKbCounts}
              />
            )}

            {!reading && subTab === "graphs" && (
              <GraphsPanel thesisId={thesis.id} colors={colors} onCountChange={setGraphCount} />
            )}

            {!reading && subTab === "history" && (
              <ThesisTimeline
                events={detail?.events ?? []}
                onAddNote={addNote}
                onDeleteNote={deleteNote}
                colors={colors}
              />
            )}

            {!reading && subTab === "trades" && (
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

            {!reading && subTab === "ai" && (
              <div className="flex-1 overflow-y-auto p-4" ref={textRef}>
                {streamText ? (
                  renderMarkdown(streamText, colors, "read")
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
