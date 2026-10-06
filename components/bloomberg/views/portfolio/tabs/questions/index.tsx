"use client";
import { toolsThesisIdAtom } from "@/components/bloomberg/atoms";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { ChevronDown, ChevronRight, GitMerge } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Colors } from "../../helpers";
import { QuickTopic } from "../theses/QuickTopic";
import { NavRail, ThesisNavigator, useThesisList } from "../theses/ThesisNavigator";
import { ReadDot, UNREAD_COLOR, UnreadBar, useReads } from "../theses/useReads";
import { CalendarView } from "./CalendarView";
import {
  BASIS_LABEL,
  GAP_LABEL,
  LEVEL_LABEL,
  type QAnswer,
  type QCountsPayload,
  type QDetail,
  type QNode,
  type QTree,
  SIGNAL_LABEL,
  STATUS_COLOR,
  actorTag,
  stateLabel,
} from "./types";

const API = "/api/v2/questions";
const COLLAPSE_KEY = "bloomberg_questions_collapsed";
const HIDE_CLEAR_KEY = "bloomberg_questions_hide_clear";

/** Which rows of the list to keep. "review" = an answer is waiting for the user. */
type Flt = "" | "pending" | "watch" | "due" | "review" | "unread";

function loadJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const s = localStorage.getItem(key);
    if (s) return JSON.parse(s) as T;
  } catch {
    /* ignore */
  }
  return fallback;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** The backend refuses with either a sentence or `{missing: [...]}` — show both as lines. */
async function send(url: string, method: string, body?: unknown): Promise<string[] | null> {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.ok) return null;
  const d = await r.json().catch(() => ({}));
  const detail = d?.detail;
  if (detail && typeof detail === "object" && Array.isArray(detail.missing)) return detail.missing;
  return [typeof detail === "string" ? detail : `HTTP ${r.status}`];
}

type Row = { node: QNode; depth: number; stubUnder?: string; merge: boolean; kids: number };

/** Depth-first from the root. A question with two parents is drawn once, under
 *  the first; under the other it is a one-line pointer — the convergence point
 *  is one question, not two copies of it. */
function buildRows(tree: QTree | undefined, collapsed: Set<string> = new Set()): Row[] {
  if (!tree) return [];
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, string[]>();
  const parentCount = new Map<string, number>();
  for (const e of tree.edges) {
    if (!byId.has(e.child_id)) continue;
    parentCount.set(e.child_id, (parentCount.get(e.child_id) ?? 0) + 1);
    if (!byId.has(e.parent_id)) continue;
    kids.set(e.parent_id, [...(kids.get(e.parent_id) ?? []), e.child_id]);
  }
  // Oldest first, so the tree reads in the order the questions were asked. An
  // imported tree shares one timestamp, so the Q-ref breaks the tie.
  const age = (id: string) => `${byId.get(id)?.created_at ?? ""} ${byId.get(id)?.ref ?? ""}`;
  for (const list of kids.values()) list.sort((a, b) => age(a).localeCompare(age(b)));
  const drawnUnder = new Map<string, string>();
  const rows: Row[] = [];
  const walk = (id: string, depth: number, parentRef: string) => {
    const node = byId.get(id);
    if (!node) return;
    const merge = (parentCount.get(id) ?? 0) > 1;
    const first = drawnUnder.get(id);
    if (first !== undefined) {
      rows.push({ node, depth, stubUnder: first, merge, kids: 0 });
      return;
    }
    drawnUnder.set(id, parentRef);
    const below = kids.get(id) ?? [];
    rows.push({ node, depth, merge, kids: below.length });
    // A folded branch is still "drawn" for the passes below: its children are
    // hidden, not orphans to be listed again at the root.
    const mark = (cid: string) => {
      if (drawnUnder.has(cid)) return;
      drawnUnder.set(cid, node.ref);
      for (const g of kids.get(cid) ?? []) mark(g);
    };
    if (collapsed.has(id)) for (const c of below) mark(c);
    else for (const c of below) walk(c, depth + 1, node.ref);
  };
  const hasParentHere = new Set(
    tree.edges.filter((e) => byId.has(e.parent_id)).map((e) => e.child_id)
  );
  for (const n of tree.nodes) if (n.is_root) walk(n.id, 0, "");
  for (const n of tree.nodes)
    if (!drawnUnder.has(n.id) && !hasParentHere.has(n.id)) walk(n.id, 0, "");
  for (const n of tree.nodes) if (!drawnUnder.has(n.id)) walk(n.id, 0, "");
  return rows;
}

export function Chip({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="text-[8px] px-1 border whitespace-nowrap"
      style={{ color, borderColor: `${color}66` }}
    >
      {text}
    </span>
  );
}

/** The two numbers. Red = owed work, amber = resting on something untested. */
export function QuestionBadges({ pending, watch }: { pending: number; watch: number }) {
  if (!pending && !watch) return null;
  return (
    <span className="inline-flex gap-0.5 ml-1 align-middle">
      {pending > 0 && (
        <span
          className="text-[8px] px-1 font-bold"
          title={`${pending} คำถามค้าง`}
          style={{ background: "#7f1d1d", color: "#fecaca" }}
        >
          {pending}
        </span>
      )}
      {watch > 0 && (
        <span
          className="text-[8px] px-1 font-bold"
          title={`${watch} คำถามเฝ้าดู`}
          style={{ background: "#78350f", color: "#fde68a" }}
        >
          {watch}
        </span>
      )}
    </span>
  );
}

export function useQuestionCounts() {
  return useQuery({
    queryKey: ["questions", "counts"],
    queryFn: ({ signal }) => getJson<QCountsPayload>(`${API}/counts`, signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export function QuestionsTab({
  colors,
  initialQuestion,
  onConsumeInitialQuestion,
}: {
  colors: Colors;
  /** A question to land on, handed over by another tab (TRACK → the "why" of a miss). */
  initialQuestion?: { thesisId: string | null; questionId: string } | null;
  onConsumeInitialQuestion?: () => void;
}) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["questions"] });

  // "" = every thesis. Shared with THESES and TRACK.
  const [thesisId, setThesisId] = useAtom(toolsThesisIdAtom);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a hand-over is taken once, on mount
  useEffect(() => {
    if (initialQuestion?.thesisId) setThesisId(initialQuestion.thesisId);
  }, []);
  const reads = useReads();
  const [search, setSearch] = useState("");
  const [flt, setFlt] = useState<Flt>("");
  const [hideClear, setHideClear] = useState<boolean>(() => loadJson(HIDE_CLEAR_KEY, false));
  // Folded branches, per thesis: { thesisId: [question ids] }.
  const [folded, setFolded] = useState<Record<string, string[]>>(() => loadJson(COLLAPSE_KEY, {}));
  useEffect(() => {
    try {
      localStorage.setItem(HIDE_CLEAR_KEY, JSON.stringify(hideClear));
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(folded));
    } catch {
      /* ignore */
    }
  }, [hideClear, folded]);
  const collapsed = useMemo(() => new Set(folded[thesisId] ?? []), [folded, thesisId]);
  const toggleFold = (id: string) =>
    setFolded((p) => {
      const cur = new Set(p[thesisId] ?? []);
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
      return { ...p, [thesisId]: [...cur] };
    });
  const [selectedId, setSelectedId] = useState<string | null>(initialQuestion?.questionId ?? null);
  // The question to land on. Held until the tree knows it: the tree on screen at
  // mount can predate a question that was opened a moment ago.
  const wanted = useRef<string | null>(initialQuestion?.questionId ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: taken once, on mount
  useEffect(() => {
    if (initialQuestion) onConsumeInitialQuestion?.();
  }, []);
  const [adding, setAdding] = useState(false);
  // "tree" = one thesis's questions; "calendar" = every dated thing the whole book waits on.
  const [view, setView] = useState<"tree" | "calendar">("tree");

  const { data: thesesData } = useThesisList();
  const theses = thesesData?.theses ?? [];

  // A remembered thesis that no longer exists would leave the tab empty.
  useEffect(() => {
    if (thesisId && theses.length && !theses.some((t) => t.id === thesisId)) setThesisId("");
  }, [theses, thesisId, setThesisId]);

  // A search always runs over every thesis; so does the view with none picked.
  const q = search.trim();
  const flat = !thesisId || !!q;
  const { data: flatData, isFetching: flatFetching } = useQuery({
    queryKey: ["questions", "search", q],
    queryFn: ({ signal }) =>
      getJson<{ questions: QNode[] }>(`${API}${q ? `?q=${encodeURIComponent(q)}` : ""}`, signal),
    enabled: flat,
    staleTime: 30_000,
  });

  const {
    data: tree,
    isLoading,
    isFetching,
  } = useQuery({
    queryKey: ["questions", "tree", thesisId],
    queryFn: ({ signal }) =>
      getJson<QTree>(`${API}/tree?thesis_id=${encodeURIComponent(thesisId)}`, signal),
    enabled: !!thesisId,
    staleTime: 30_000,
  });
  const keep = (n: QNode) => {
    const st = n.state;
    if (hideClear && !flt && (st.status === "CLEAR" || st.status === "DROPPED")) return false;
    if (flt === "pending") return st.status === "OPEN";
    if (flt === "watch") return st.status === "WATCH";
    if (flt === "due") return st.due;
    if (flt === "review") return !!st.proposed_answer_id;
    if (flt === "unread") return reads.unreadUnder("answer", n.id).length > 0;
    return true;
  };
  // A status filter breaks the tree apart (a matching child under a hidden
  // parent), so filtered rows are listed flat and nothing is folded away.
  const allRows = useMemo(
    () => buildRows(tree, flt ? new Set() : collapsed),
    [tree, collapsed, flt]
  );
  const rows = flat ? [] : allRows.filter((r) => keep(r.node));
  const flatRows = flat
    ? (flatData?.questions ?? []).filter((n) => n.state.status !== "DROPPED" || !!q).filter(keep)
    : [];

  useEffect(() => {
    if (flat || !tree) return;
    if (wanted.current) {
      const id = wanted.current;
      if (tree.nodes.some((n) => n.id === id)) {
        wanted.current = null;
        setSelectedId(id);
        return;
      }
      if (isFetching) return;
      wanted.current = null;
    }
    if (selectedId && tree.nodes.some((n) => n.id === selectedId)) return;
    setSelectedId(allRows[0]?.node.id ?? null);
  }, [tree, allRows, selectedId, isFetching, flat]);

  // `m` marks the answers of the open question as read.
  const unreadHere = selectedId ? reads.unreadUnder("answer", selectedId) : [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads.mark` is stable enough; keyed on the unread set
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "m" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (!unreadHere.length) return;
      e.preventDefault();
      e.stopPropagation();
      void reads.mark(unreadHere);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [unreadHere.map((u) => u.id).join(",")]);

  const { data: detail } = useQuery({
    queryKey: ["questions", "detail", selectedId],
    queryFn: ({ signal }) => getJson<QDetail>(`${API}/${selectedId}`, signal),
    enabled: !!selectedId,
    staleTime: 30_000,
  });

  const thesis = theses.find((t) => t.id === thesisId);
  const border = { borderColor: colors.border };
  const dim = { color: colors.textSecondary };
  const symbolOf = (id: string | null) => theses.find((t) => t.id === id)?.symbol ?? "";
  const unreadAnswers = reads.byThesis[thesisId]?.answer ?? 0;
  const chip = (on: boolean) => ({
    borderColor: on ? colors.accent : colors.border,
    color: on ? colors.accent : colors.textSecondary,
    background: on ? `${colors.accent}18` : "transparent",
  });
  const pickThesis = (id: string) => {
    setThesisId(id);
    setSelectedId(null);
    setAdding(false);
    setSearch("");
    setView("tree");
  };
  const fields: [Flt, string][] = [
    ["", "ทั้งหมด"],
    ["pending", `ค้าง${tree && !flat ? ` ${tree.counts.pending}` : ""}`],
    ["watch", `เฝ้าดู${tree && !flat ? ` ${tree.counts.watch}` : ""}`],
    ["due", `ถึงวัน${tree && !flat ? ` ${tree.counts.due}` : ""}`],
    ["review", "รอรับรอง"],
    ["unread", "ยังไม่อ่าน"],
  ];

  const rowButton = (n: QNode, opts: { depth: number; kids: number; merge: boolean }) => {
    const fresh = reads.unreadUnder("answer", n.id).length;
    return (
      <div
        key={n.id}
        className="flex items-center border-b"
        style={{
          ...border,
          paddingLeft: 4 + opts.depth * 14,
          background: selectedId === n.id ? colors.bgSelected : "transparent",
        }}
      >
        {opts.kids > 0 && !flt ? (
          <button
            type="button"
            onClick={() => toggleFold(n.id)}
            title={collapsed.has(n.id) ? "กางคำถามย่อย" : "พับคำถามย่อย"}
            className="shrink-0 w-4 h-5 flex items-center justify-center"
            style={dim}
          >
            {collapsed.has(n.id) ? (
              <ChevronRight className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </button>
        ) : (
          <span className="shrink-0 w-4" />
        )}
        <button
          type="button"
          onClick={() => {
            setSelectedId(n.id);
            setAdding(false);
          }}
          title={n.title}
          className="flex-1 min-w-0 flex items-center gap-1.5 text-left py-1 pr-2 hover:opacity-90"
        >
          <span className="font-mono shrink-0" style={dim}>
            {n.ref}
          </span>
          {flat && (
            <span className="font-mono font-bold shrink-0" style={{ color: colors.accent }}>
              {n.symbol || symbolOf(n.thesis_id)}
            </span>
          )}
          <span className="flex-1 min-w-0 truncate" style={{ color: colors.text }}>
            {n.title}
          </span>
          {collapsed.has(n.id) && opts.kids > 0 && !flt && (
            <span className="font-mono shrink-0" style={dim}>
              +{opts.kids}
            </span>
          )}
          {fresh > 0 && (
            <span className="shrink-0" style={{ color: UNREAD_COLOR }} title="มีคำตอบที่ยังไม่อ่าน">
              ●
            </span>
          )}
          {opts.merge && <GitMerge className="h-2.5 w-2.5 shrink-0" style={{ color: "#60a5fa" }} />}
          {n.gaps.includes("parent") && <Chip text="ยังไม่ผูกสาย" color="#888" />}
          {n.state.due && <Chip text="ถึงวัน" color="#60a5fa" />}
          <Chip text={stateLabel(n.state)} color={STATUS_COLOR[n.state.status]} />
        </button>
      </div>
    );
  };

  return (
    <div className="reading flex h-full overflow-hidden">
      <NavRail colors={colors}>
        <ThesisNavigator
          colors={colors}
          selectedId={thesisId}
          onSelect={pickThesis}
          allLabel="ทุก thesis"
        />
      </NavRail>

      <div className="flex-1 min-w-0 flex flex-col overflow-hidden text-[10px]">
        <div
          className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b flex-wrap"
          style={border}
        >
          <span className="font-bold font-mono" style={{ color: colors.accent }}>
            {thesis?.symbol ?? "ทุก thesis"}
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setSearch("")}
            placeholder="ค้นคำถาม — ทุก thesis"
            aria-label="ค้นคำถาม"
            className="w-48 px-1.5 py-0.5 border outline-none"
            style={{ background: colors.surface, borderColor: colors.border, color: colors.text }}
          />
          {fields.map(([k, label]) => (
            <button
              aria-pressed={flt === k}
              type="button"
              key={k || "all"}
              className="px-1.5 border whitespace-nowrap"
              style={chip(flt === k)}
              onClick={() => setFlt(k)}
            >
              {label}
            </button>
          ))}
          <button
            aria-pressed={hideClear}
            type="button"
            className="px-1.5 border whitespace-nowrap"
            style={chip(hideClear)}
            onClick={() => setHideClear((v) => !v)}
            title="ซ่อนคำถามที่ตอบชัดแล้วหรือเลิกติดตาม"
          >
            ซ่อนที่ชัดแล้ว
          </button>
          {!flat && tree && (
            <span style={dim}>
              ปลายสายชัด {tree.leaves.clear}/{tree.leaves.total}
            </span>
          )}
          {!!thesisId && (
            <UnreadBar
              count={unreadAnswers}
              onMarkAll={() => void reads.markThesis(thesisId, ["answer"])}
              colors={colors}
            />
          )}
          <span className="flex-1" />
          <button
            aria-pressed={view === "calendar"}
            type="button"
            onClick={() => setView((v) => (v === "calendar" ? "tree" : "calendar"))}
            className="px-1.5 border font-bold whitespace-nowrap"
            style={chip(view === "calendar")}
          >
            ปฏิทิน
          </button>
          <button
            type="button"
            className="px-1.5 border font-bold hover:opacity-80 whitespace-nowrap"
            style={{ ...border, color: colors.accent }}
            onClick={() => {
              setView("tree");
              setAdding((v) => !v);
            }}
          >
            {adding ? "ปิด" : "+ คำถาม"}
          </button>
        </div>

        {view === "calendar" && (
          <CalendarView
            colors={colors}
            onOpenQuestion={(tid, qid) => {
              if (tid) setThesisId(tid);
              setSearch("");
              setSelectedId(qid);
              setAdding(false);
              setView("tree");
            }}
          />
        )}

        <div
          className="flex-1 flex min-h-0"
          style={{ display: view === "tree" ? undefined : "none" }}
        >
          <div className="w-[44%] min-w-[240px] border-r overflow-y-auto" style={border}>
            {flat && flatRows.map((n) => rowButton(n, { depth: 0, kids: 0, merge: false }))}
            {!flat &&
              rows.map((r, i) =>
                r.stubUnder !== undefined ? (
                  <button
                    aria-pressed={selectedId === r.node.id}
                    type="button"
                    key={`stub-${r.node.id}-${i}`}
                    onClick={() => setSelectedId(r.node.id)}
                    className="w-full text-left py-1 pr-2 border-b"
                    style={{ ...border, ...dim, paddingLeft: 20 + r.depth * 14 }}
                  >
                    {r.node.ref} (บรรจบ ดูใต้ {r.stubUnder})
                  </button>
                ) : (
                  rowButton(r.node, { depth: flt ? 0 : r.depth, kids: r.kids, merge: r.merge })
                )
              )}
            {flat && !flatFetching && flatRows.length === 0 && (
              <div className="p-3" style={dim}>
                {q ? `ไม่พบคำถามที่มี "${q}"` : "ไม่มีคำถามที่ตรงกับตัวกรอง"}
              </div>
            )}
            {!flat && !isLoading && rows.length === 0 && (
              <div className="p-3 leading-relaxed" style={dim}>
                {allRows.length
                  ? "ไม่มีคำถามที่ตรงกับตัวกรอง"
                  : "thesis นี้ยังไม่มีคำถาม เริ่มจากคำถามราก: คำถามตัดสินใจของ thesis แล้วแตกข้อย่อยที่ตอบแล้วทำให้รากขยับ"}
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 overflow-y-auto p-3">
            {adding && !thesisId ? (
              <div className="leading-relaxed" style={dim}>
                <div className="font-bold mb-1" style={{ color: colors.accent }}>
                  คำถามใหม่ — อยู่ใต้ thesis ไหน
                </div>
                เลือก thesis จากรายการทางซ้าย หรือเปิดหัวข้อใหม่สำหรับเรื่องที่ยังไม่มี thesis (เช่นเศรษฐกิจ กองทุน
                อุตสาหกรรม):
                <div className="mt-2">
                  <QuickTopic colors={colors} onCreated={(id) => setThesisId(id)} />
                </div>
              </div>
            ) : adding && thesisId ? (
              <AddForm
                colors={colors}
                thesisId={thesisId}
                parent={detail?.question ?? null}
                hasRoot={!!tree?.nodes.some((n) => n.is_root && n.state.status !== "DROPPED")}
                onDone={(id) => {
                  setAdding(false);
                  // Select only once the tree knows the new row, or the
                  // "selection no longer exists" fallback snaps back to the root.
                  void refresh().then(() => {
                    if (id) setSelectedId(id);
                  });
                }}
              />
            ) : detail ? (
              <Detail
                d={detail}
                colors={colors}
                reads={reads}
                onSelect={setSelectedId}
                onChange={() => {
                  void refresh();
                  void reads.refresh();
                }}
              />
            ) : (
              <div style={dim}>เลือกคำถามทางซ้าย</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Label({ children, colors }: { children: React.ReactNode; colors: Colors }) {
  return (
    <div className="text-[8px] tracking-widest mt-3 mb-0.5" style={{ color: colors.textSecondary }}>
      {children}
    </div>
  );
}

export function Errors({ lines }: { lines: string[] | null }) {
  if (!lines?.length) return null;
  return (
    <div className="mt-2 p-1.5 border" style={{ borderColor: "#f8717155", color: "#f87171" }}>
      {lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  );
}

function ZRefs({ items, colors }: { items: QAnswer["evidence"]; colors: Colors }) {
  return (
    <>
      {items.map((z) => (
        <div key={z.id} className="leading-relaxed">
          <span className="font-mono font-bold" style={{ color: colors.accent }}>
            {z.ref}
          </span>{" "}
          <span style={{ color: colors.text }}>{z.title}</span>
          {z.sources
            .filter((s) => s.url)
            .map((s) => (
              <a
                key={s.url}
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="ml-1 underline"
                style={{ color: colors.textSecondary }}
              >
                {s.publisher || "source"}
                {s.reliability === "primary" ? " · primary" : ""}
              </a>
            ))}
        </div>
      ))}
    </>
  );
}

function Detail({
  d,
  colors,
  reads,
  onSelect,
  onChange,
}: {
  d: QDetail;
  colors: Colors;
  reads: ReturnType<typeof useReads>;
  onSelect: (id: string) => void;
  onChange: () => void;
}) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the draft when another question is opened
  useEffect(() => {
    setNote("");
    setErr(null);
  }, [d.question.id]);

  const q = d.question;
  const s = d.state;
  const shownId = s.proposed_answer_id ?? s.current_answer_id;
  const shown = d.answers.find((a) => a.id === shownId) ?? null;
  const older = d.answers.filter((a) => a.id !== shownId);
  const dim = { color: colors.textSecondary };
  const text = { color: colors.text };

  const act = async (url: string, body?: unknown) => {
    setBusy(true);
    const e = await send(url, "POST", body);
    setBusy(false);
    setErr(e);
    if (!e) {
      setNote("");
      onChange();
    }
  };
  const btn = "px-2 py-0.5 border font-bold hover:opacity-80 disabled:opacity-40";

  return (
    <div className="leading-relaxed max-w-[78ch]">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-mono" style={dim}>
          {q.ref}
        </span>
        <Chip text={stateLabel(s)} color={STATUS_COLOR[s.status]} />
        {d.parents.length > 1 && <Chip text="จุดบรรจบ" color="#60a5fa" />}
        {q.is_root && <Chip text="คำถามราก" color={colors.accent} />}
        {q.gaps.length > 0 && (
          <span style={dim}>ยังขาด: {q.gaps.map((g) => GAP_LABEL[g] ?? g).join(" · ")}</span>
        )}
        {q.claimed_by && <Chip text={`${actorTag(q.claimed_by)} กำลังตรวจ`} color="#f472b6" />}
        {q.next_check && <span style={dim}>ตรวจถัดไป {q.next_check}</span>}
      </div>
      <div className="text-[13px] font-bold mt-1" style={text}>
        {q.title}
      </div>

      <Label colors={colors}>ความคิดที่นำมา</Label>
      <div style={q.thought ? text : dim}>{q.thought || "ยังไม่ได้ระบุ"}</div>

      <Label colors={colors}>คำตอบล่าสุด</Label>
      {shown ? (
        <>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Chip
              text={
                LEVEL_LABEL[shown.level] +
                (shown.basis ? ` · ${BASIS_LABEL[shown.basis] ?? shown.basis}` : "")
              }
              color={STATUS_COLOR[s.status]}
            />
            {actorTag(shown.actor) && <Chip text={actorTag(shown.actor)} color="#f472b6" />}
            <span style={dim}>{shown.created_at.slice(0, 10)}</span>
            <ReadDot type="answer" id={shown.id} colors={colors} reads={reads} />
            {reads.isUnread("answer", shown.id) && (
              <span style={{ color: UNREAD_COLOR }}>ยังไม่อ่าน (กด m)</span>
            )}
          </div>
          <div className="mt-1" style={text}>
            {shown.answer}
            {shown.value && (
              <span className="font-mono">
                {" "}
                — {shown.value}
                {shown.unit ? ` ${shown.unit}` : ""}
                {shown.as_of ? ` (ณ ${shown.as_of})` : ""}
              </span>
            )}
          </div>
        </>
      ) : (
        <div style={dim}>ยังไม่มีคำตอบ — คำถามนี้อยู่ในคิวให้ agent ตรวจผ่าน MCP</div>
      )}

      {!!shown?.assumptions.length && (
        <>
          <Label colors={colors}>สมมติฐานที่รอตรวจ</Label>
          {shown.assumptions.map((a) => (
            <div key={a.id} className="mb-1.5">
              <div style={text}>
                {a.check && (
                  <Chip
                    text={a.check.result === "HELD" ? "ผ่าน" : "พัง"}
                    color={a.check.result === "HELD" ? "#4ade80" : "#f87171"}
                  />
                )}{" "}
                {a.statement}
              </div>
              <div style={dim}>
                ตรวจด้วย {a.metric} · จาก {a.source_hint} · ภายใน {a.check_by} · ถือว่าผิดถ้า{" "}
                {a.falsifier}
              </div>
              {a.check && (
                <div style={dim}>
                  ผลตรวจ {a.check.created_at.slice(0, 10)}: {a.check.note}
                  {a.check_zettel ? ` (${a.check_zettel.ref})` : ""}
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {!!shown?.alternatives.length && (
        <>
          <Label colors={colors}>คำอธิบายคู่แข่ง</Label>
          {shown.alternatives.map((a) => (
            <div key={a} style={text}>
              · {a}
            </div>
          ))}
        </>
      )}

      {!!shown?.signals.length && (
        <>
          <Label colors={colors}>สัญญาณ ({shown.signals.length})</Label>
          {shown.signals.map((g) => (
            <div
              key={g.id}
              className="mb-1.5 pl-1.5 border-l"
              style={{ borderColor: `${SIGNAL_LABEL[g.result].color}88` }}
            >
              <div style={text}>
                <Chip text={SIGNAL_LABEL[g.result].text} color={SIGNAL_LABEL[g.result].color} />{" "}
                {g.diagnostic && <Chip text="แยกคำอธิบายได้" color="#60a5fa" />} {g.expectation}
              </div>
              {(g.finding || g.searched_where) && (
                <div style={dim}>
                  {g.finding}
                  {g.finding && g.searched_where ? " · " : ""}
                  {g.searched_where ? `ค้นแล้วที่: ${g.searched_where}` : ""}
                </div>
              )}
              <div style={dim}>
                {g.supports ? `ชี้ไปทาง: ${g.supports}` : ""}
                {g.origin ? ` · ต้นทาง: ${g.origin}` : ""}
                {g.zettel ? ` · ${g.zettel.ref}` : ""}
              </div>
            </div>
          ))}
        </>
      )}

      {!!shown?.searched && (
        <>
          <Label colors={colors}>ค้นแล้วที่</Label>
          <div style={text}>{shown.searched}</div>
        </>
      )}

      {!!d.parents.length && (
        <>
          <Label colors={colors}>ผลต่อแม่</Label>
          {d.parents.map((p) => (
            <div key={p.id} className="mb-1">
              <button type="button" onClick={() => onSelect(p.id)} className="text-left">
                <span className="font-mono font-bold" style={{ color: colors.accent }}>
                  {p.ref}
                </span>{" "}
                <span style={dim}>{p.title}</span>
              </button>
              <div style={p.if_a ? text : dim}>ถ้าตอบทางหนึ่ง: {p.if_a || "ยังไม่ได้ระบุ"}</div>
              <div style={p.if_b ? text : dim}>ถ้าตอบอีกทาง: {p.if_b || "ยังไม่ได้ระบุ"}</div>
            </div>
          ))}
        </>
      )}

      {!!d.children.length && (
        <>
          <Label colors={colors}>คำถามย่อย</Label>
          {d.children.map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => onSelect(c.id)}
              className="block text-left"
            >
              <span className="font-mono font-bold" style={{ color: colors.accent }}>
                {c.ref}
              </span>{" "}
              <span style={text}>{c.title}</span>
            </button>
          ))}
        </>
      )}

      {!!shown && (shown.evidence.length > 0 || shown.signals.some((g) => g.zettel)) && (
        <>
          <Label colors={colors}>หลักฐาน</Label>
          <ZRefs
            colors={colors}
            items={[
              ...shown.evidence,
              ...shown.signals.flatMap((g) => (g.zettel ? [g.zettel] : [])),
            ].filter((z, i, all) => all.findIndex((x) => x.id === z.id) === i)}
          />
        </>
      )}

      {d.dates.length > 0 && (
        <>
          <Label colors={colors}>วันที่รอ</Label>
          {d.dates.map((x) => (
            <div key={x.link_id} className="mb-1">
              <span className="font-mono" style={text}>
                {x.date}
              </span>{" "}
              <Chip
                text={x.status === "CONFIRMED" ? "ยืนยัน" : "ประมาณ"}
                color={x.status === "CONFIRMED" ? "#4ade80" : "#fbbf24"}
              />{" "}
              <span style={text}>{x.title}</span>
              {x.reads && <span style={dim}> — ดู: {x.reads}</span>}
              <div style={dim}>ที่มาของวันที่: {x.source}</div>
            </div>
          ))}
        </>
      )}

      {s.status === "DROPPED" && (
        <>
          <Label colors={colors}>เหตุที่เลิกติดตาม</Label>
          <div style={text}>{q.drop_reason}</div>
        </>
      )}

      <div className="mt-4 pt-2 border-t" style={{ borderColor: colors.border }}>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={s.proposed_answer_id ? "หมายเหตุ (บังคับเมื่อไม่รับ)" : "เหตุผล (บังคับเมื่อเลิกติดตาม)"}
          className="w-full px-1.5 py-1 border outline-none mb-1.5"
          style={{ background: "#0a0a0a", borderColor: colors.border, color: colors.text }}
        />
        <div className="flex gap-1.5 flex-wrap">
          {s.proposed_answer_id && (
            <>
              <button
                type="button"
                disabled={busy}
                className={btn}
                style={{ borderColor: "#4ade8088", color: "#4ade80" }}
                onClick={() =>
                  act(`${API}/answers/${s.proposed_answer_id}/review`, {
                    decision: "ACCEPTED",
                    note,
                  })
                }
              >
                รับรองคำตอบ
              </button>
              <button
                type="button"
                disabled={busy}
                className={btn}
                style={{ borderColor: "#f8717188", color: "#f87171" }}
                onClick={() =>
                  act(`${API}/answers/${s.proposed_answer_id}/review`, {
                    decision: "REJECTED",
                    note,
                  })
                }
              >
                ไม่รับ
              </button>
            </>
          )}
          {s.status === "DROPPED" ? (
            <button
              type="button"
              disabled={busy}
              className={btn}
              style={{ borderColor: colors.border, color: colors.accent }}
              onClick={() => act(`${API}/${q.id}/reopen`)}
            >
              กลับมาติดตาม
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              className={btn}
              style={{ borderColor: colors.border, color: colors.textSecondary }}
              onClick={() => act(`${API}/${q.id}/drop`, { reason: note })}
            >
              เลิกติดตาม
            </button>
          )}
        </div>
        <Errors lines={err} />
      </div>

      {!!older.length && (
        <>
          <Label colors={colors}>คำตอบก่อนหน้า ({older.length})</Label>
          {older.map((a) => (
            <div key={a.id} className="mb-1" style={dim}>
              <ReadDot type="answer" id={a.id} colors={colors} reads={reads} />{" "}
              {a.created_at.slice(0, 10)} · {LEVEL_LABEL[a.level]}
              {actorTag(a.actor) ? ` · ${actorTag(a.actor)}` : ""}
              {a.review ? ` · ${a.review.result === "ACCEPTED" ? "รับรอง" : "ไม่รับ"}` : ""}
              {a.review?.note ? ` — ${a.review.note}` : ""}
              <div style={text}>{a.answer}</div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

type AddMode = "under" | "loose" | "root";

/** Quick capture: only the question is required. Where it hangs, how each
 *  answer would move its parent and the thought behind it can all come later —
 *  the row shows what is still missing. */
function AddForm({
  colors,
  thesisId,
  parent,
  hasRoot,
  onDone,
}: {
  colors: Colors;
  thesisId: string;
  parent: QDetail["question"] | null;
  hasRoot: boolean;
  onDone: (newId?: string) => void;
}) {
  const [f, setF] = useState({ title: "", thought: "", if_a: "", if_b: "", next_check: "" });
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<AddMode>(parent ? "under" : hasRoot ? "loose" : "root");
  const under = mode === "under" && !!parent;
  const field = "w-full px-1.5 py-1 border outline-none";
  const fieldStyle = { background: "#0a0a0a", borderColor: colors.border, color: colors.text };
  const set =
    (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async () => {
    setBusy(true);
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: f.title,
        thought: f.thought,
        thesis_id: thesisId,
        is_root: mode === "root",
        parents: under && parent ? [{ parent: parent.id, if_a: f.if_a, if_b: f.if_b }] : [],
        next_check: f.next_check || null,
      }),
    });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (r.ok) return onDone(d?.question?.id);
    setErr([typeof d?.detail === "string" ? d.detail : `HTTP ${r.status}`]);
  };

  const modes: { id: AddMode; label: string; show: boolean }[] = [
    { id: "under", label: `ผูกใต้ ${parent?.ref ?? ""}`, show: !!parent },
    { id: "loose", label: "ยังไม่ผูกสาย", show: true },
    { id: "root", label: "คำถามราก", show: !hasRoot },
  ];

  return (
    <div className="leading-relaxed max-w-[640px]">
      <div className="flex gap-2 items-center">
        <span className="font-bold" style={{ color: colors.accent }}>
          คำถามใหม่
        </span>
        {modes
          .filter((m) => m.show)
          .map((m) => (
            <button
              aria-pressed={mode === m.id}
              type="button"
              key={m.id}
              onClick={() => setMode(m.id)}
              className="px-1.5 border"
              style={{
                borderColor: colors.border,
                color: mode === m.id ? colors.accent : colors.textSecondary,
              }}
            >
              {m.label}
            </button>
          ))}
      </div>
      <Label colors={colors}>คำถาม</Label>
      <input className={field} style={fieldStyle} value={f.title} onChange={set("title")} />
      <Label colors={colors}>ความคิดที่นำมา — เห็นอะไรจึงสงสัย (ใส่ทีหลังได้)</Label>
      <textarea
        className={field}
        style={fieldStyle}
        rows={2}
        value={f.thought}
        onChange={set("thought")}
      />
      {under && (
        <>
          <Label colors={colors}>ถ้าตอบทางหนึ่ง {parent?.ref} เปลี่ยนอย่างไร (ใส่ทีหลังได้)</Label>
          <input className={field} style={fieldStyle} value={f.if_a} onChange={set("if_a")} />
          <Label colors={colors}>ถ้าตอบอีกทาง {parent?.ref} เปลี่ยนอย่างไร (ใส่ทีหลังได้)</Label>
          <input className={field} style={fieldStyle} value={f.if_b} onChange={set("if_b")} />
        </>
      )}
      <Label colors={colors}>วันตรวจถัดไป (YYYY-MM-DD, ไม่บังคับ)</Label>
      <input
        className={field}
        style={fieldStyle}
        value={f.next_check}
        onChange={set("next_check")}
      />
      <div className="flex gap-1.5 mt-3">
        <button
          type="button"
          disabled={busy || !f.title.trim()}
          className="px-2 py-0.5 border font-bold disabled:opacity-40"
          style={{ borderColor: colors.border, color: colors.accent }}
          onClick={submit}
        >
          บันทึก
        </button>
        <button
          type="button"
          className="px-2 py-0.5 border"
          style={{ borderColor: colors.border, color: colors.textSecondary }}
          onClick={() => onDone()}
        >
          ยกเลิก
        </button>
      </div>
      <Errors lines={err} />
    </div>
  );
}
