"use client";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Colors } from "../../helpers";
import { useThesisList } from "../theses/ThesisNavigator";
import type { AnalysisGraph } from "../theses/graphs/GraphsPanel";
import { ReadDot, UNREAD_COLOR, useReads } from "../theses/useReads";
import {
  ROW_H,
  fmtStamp,
  matchesResearch,
  newestFirst,
  pageCount,
  pageOf,
  pageSizeFor,
  pageSlice,
} from "./paging";

const API = "/api/v2/graphs";

/** RESEARCH — every analysis page of every thesis in one list, newest first.
 *
 *  A page belongs to its thesis (THESES → RESEARCH), which is the right place to
 *  read it from and the wrong place to find out that a new one exists. This tab
 *  is the second: the same rows, across theses, ordered by when each was last
 *  written. It is an index like the per-thesis panel — a page opens in its own
 *  browser tab — and it writes nothing; deleting stays in the thesis.
 *
 *  A page of the list is as many rows as the panel is tall (paging.ts), so there
 *  is nothing to scroll: read the page, then turn it. */
export function ResearchTab({
  colors,
  onOpenThesis,
}: {
  colors: Colors;
  /** Jump to the thesis a page belongs to, on its RESEARCH tab. */
  onOpenThesis: (thesisId: string) => void;
}) {
  const reads = useReads();
  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["graphs", "all"],
    queryFn: async ({ signal }) => {
      const r = await fetch(`${API}?limit=500`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      return (Array.isArray(d.graphs) ? d.graphs : []) as AnalysisGraph[];
    },
    staleTime: 60_000,
  });

  // A page's symbol is what it is about; its thesis can be another one (a MU
  // page written for the SNDK thesis), and that is where THESIS ▸ leads.
  const { data: thesisList } = useThesisList();
  const thesisSymbol = useMemo(
    () => new Map((thesisList?.theses ?? []).map((t) => [t.id, t.symbol])),
    [thesisList]
  );

  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  // The first row on screen, not a page number — see pageOf().
  const [first, setFirst] = useState(0);

  const all = useMemo(() => newestFirst(data ?? []), [data]);
  const unreadCount = all.filter((g) => reads.isUnread("graph", g.id)).length;
  const rows = all.filter(
    (g) => matchesResearch(g, query) && (!unreadOnly || reads.isUnread("graph", g.id))
  );

  const listRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(1);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setSize(pageSizeFor(el.clientHeight));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pages = pageCount(rows.length, size);
  const page = pageOf(first, rows.length, size);
  const shown = pageSlice(rows, page, size);
  const go = (p: number) => setFirst(Math.min(pages - 1, Math.max(0, p)) * size);

  const btn = "shrink-0 px-1.5 py-0.5 border font-bold hover:opacity-80 disabled:opacity-30";

  return (
    <div
      className="h-full flex flex-col overflow-hidden outline-none"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the list takes PgUp / PgDn once clicked
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement) return;
        if (e.key === "PageDown" || e.key === "ArrowRight") go(page + 1);
        else if (e.key === "PageUp" || e.key === "ArrowLeft") go(page - 1);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div
        className="shrink-0 flex items-center gap-2 px-2 py-1 border-b text-[8px] font-mono"
        style={{ borderColor: colors.border, color: colors.textSecondary }}
      >
        <span className="font-bold tracking-widest" style={{ color: colors.accent }}>
          RESEARCH {rows.length}
          {rows.length !== all.length && ` / ${all.length}`}
        </span>
        <span className="hidden sm:inline">ทุก thesis · ใหม่สุดก่อน · คลิกเพื่อเปิดแท็บใหม่</span>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setFirst(0);
          }}
          placeholder="ค้นหา ชื่อ / symbol / tag"
          className="ml-auto w-40 px-1.5 py-0.5 border bg-transparent outline-none"
          style={{ borderColor: colors.border, color: colors.text }}
        />
        <button
          type="button"
          aria-pressed={unreadOnly}
          onClick={() => {
            setUnreadOnly((v) => !v);
            setFirst(0);
          }}
          className={btn}
          style={{
            borderColor: unreadOnly ? UNREAD_COLOR : colors.border,
            color: unreadOnly || unreadCount ? UNREAD_COLOR : colors.textSecondary,
          }}
        >
          {unreadCount} ยังไม่อ่าน
        </button>
        {isFetching && (
          <Loader2 className="w-3 h-3 animate-spin shrink-0" style={{ color: colors.accent }} />
        )}
        <button
          type="button"
          onClick={() => void refetch()}
          title="reload"
          className="shrink-0 p-1"
          style={{ color: colors.textSecondary }}
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      {error && (
        <div className="shrink-0 px-2 py-1 text-[8px]" style={{ color: "#ff5555" }}>
          โหลดรายการไม่สำเร็จ — backend ตอบไหม?
        </div>
      )}

      {/* Never scrolls: `size` rows of ROW_H are all that is rendered. */}
      <div ref={listRef} className="flex-1 min-h-0 overflow-hidden">
        {shown.map((g) => (
          <div
            key={g.slug}
            className="flex items-center gap-2 px-2 border-b overflow-hidden"
            style={{ height: ROW_H, borderColor: colors.border }}
          >
            <ReadDot type="graph" id={g.id} colors={colors} reads={reads} />
            <span
              className="shrink-0 w-28 text-[8px] font-mono leading-tight"
              style={{ color: colors.textSecondary }}
            >
              <span className="block">{fmtStamp(g.updated_at)}</span>
              <span className="block truncate font-bold" style={{ color: colors.accent }}>
                {g.symbol ?? "—"}
              </span>
            </span>
            {/* A real link, so middle-click and ⌘-click behave like links do. */}
            <a
              href={g.render_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 min-w-0"
              title={g.description || g.title}
            >
              <div
                className="text-[10px] font-bold leading-snug flex items-center gap-1"
                style={{ color: colors.text }}
              >
                <span className="truncate">{g.title}</span>
                <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
              </div>
              <div
                className="text-[8px] leading-snug truncate"
                style={{ color: colors.textSecondary }}
              >
                {g.version > 1 && <span className="font-mono">v{g.version} · </span>}
                {g.description || `as of ${g.as_of ?? "—"}`}
              </div>
            </a>
            {g.thesis_id && (
              <button
                type="button"
                onClick={() => onOpenThesis(g.thesis_id as string)}
                title="ไปที่ thesis ของหน้านี้"
                className={`${btn} text-[8px] font-mono`}
                style={{ borderColor: colors.border, color: colors.textSecondary }}
              >
                {thesisSymbol.get(g.thesis_id) ?? "THESIS"} ▸
              </button>
            )}
          </div>
        ))}
        {!shown.length && !isFetching && !error && (
          <div className="p-4 text-[9px]" style={{ color: colors.textSecondary }}>
            {all.length
              ? "ไม่มีหน้า research ที่ตรงกับตัวกรอง"
              : "ยังไม่มีหน้า research — agent สร้างผ่าน MCP tool graph_create แล้วจะมาอยู่ที่นี่"}
          </div>
        )}
      </div>

      <div
        className="shrink-0 flex items-center justify-center gap-2 px-2 py-1 border-t text-[8px] font-mono"
        style={{ borderColor: colors.border, color: colors.textSecondary }}
      >
        <button
          type="button"
          onClick={() => go(page - 1)}
          disabled={page === 0}
          title="หน้าก่อน (PgUp)"
          className={`${btn} flex items-center`}
          style={{ borderColor: colors.border, color: colors.accent }}
        >
          <ChevronLeft className="w-3 h-3" /> ใหม่กว่า
        </button>
        <span>
          หน้า <span style={{ color: colors.accent }}>{page + 1}</span> / {pages}
          {rows.length > 0 &&
            ` · ${page * size + 1}–${page * size + shown.length} จาก ${rows.length}`}
        </span>
        <button
          type="button"
          onClick={() => go(page + 1)}
          disabled={page >= pages - 1}
          title="หน้าถัดไป (PgDn)"
          className={`${btn} flex items-center`}
          style={{ borderColor: colors.border, color: colors.accent }}
        >
          เก่ากว่า <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
