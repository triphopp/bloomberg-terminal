"use client";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Colors } from "../../helpers";
import {
  NAV_DEFAULT,
  type NavCounts,
  type NavGroup,
  type NavSort,
  type NavState,
  facet,
  filterTheses,
  groupTheses,
  kindOf,
  sectorOf,
} from "./nav-filter";
import { STATUSES, STATUS_COLOR, type Thesis } from "./types";
import { UNREAD_COLOR, useReads } from "./useReads";

const FILTER_KEY = "bloomberg_thesis_nav";
const OPEN_KEY = "bloomberg_thesis_nav_open";

type ByThesis<T> = { by_thesis: Record<string, T> };

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export function useThesisList() {
  return useQuery({
    queryKey: ["theses", "list"],
    queryFn: ({ signal }) => getJson<{ theses: Thesis[] }>("/api/v2/theses", signal),
    staleTime: 60_000,
  });
}

function loadFilter(): NavState {
  if (typeof window === "undefined") return NAV_DEFAULT;
  try {
    const s = localStorage.getItem(FILTER_KEY);
    // The search text is not restored: a forgotten query reads as "my theses are gone".
    if (s) return { ...NAV_DEFAULT, ...(JSON.parse(s) as Partial<NavState>), q: "" };
  } catch {
    /* ignore */
  }
  return NAV_DEFAULT;
}

/** "NVDA — sells the whole rack" → "sells the whole rack": the symbol is
 *  already the column to its left. */
function shortTitle(t: Thesis): string {
  const title = t.title ?? "";
  if (!title.toUpperCase().startsWith(t.symbol.toUpperCase())) return title;
  return title.slice(t.symbol.length).replace(/^[\s—–:·-]+/, "") || title;
}

function Badge({ n, bg, fg, title }: { n: number; bg: string; fg: string; title: string }) {
  if (!n) return null;
  return (
    <span
      className="text-[8px] px-1 font-bold font-mono shrink-0"
      title={title}
      style={{ background: bg, color: fg }}
    >
      {n}
    </span>
  );
}

/** The one thesis list of PORT → TOOLS. THESES, QUESTIONS and TRACK all pick
 *  their subject here: a search box, filters by kind / sector / status / owed
 *  work / unread, and one line per thesis. */
export function ThesisNavigator({
  colors,
  selectedId,
  onSelect,
  allLabel,
  onNew,
  footer,
}: {
  colors: Colors;
  selectedId: string;
  onSelect: (id: string) => void;
  /** When set, a first row that selects "" — every thesis at once. */
  allLabel?: string;
  onNew?: () => void;
  footer?: ReactNode;
}) {
  const { data, isLoading } = useThesisList();
  const theses = data?.theses ?? [];
  // Same keys as the tab badges, so these are cache hits, not extra requests.
  const { data: qCounts } = useQuery({
    queryKey: ["questions", "counts"],
    queryFn: ({ signal }) =>
      getJson<ByThesis<{ pending: number; watch: number }>>("/api/v2/questions/counts", signal),
    staleTime: 60_000,
  });
  const { data: tCounts } = useQuery({
    queryKey: ["tracking", "counts"],
    queryFn: ({ signal }) =>
      getJson<ByThesis<{ alert: number }>>("/api/v2/tracking/counts", signal),
    staleTime: 60_000,
  });
  const reads = useReads();

  const [f, setF] = useState<NavState>(loadFilter);
  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify({ ...f, q: "" }));
    } catch {
      /* ignore */
    }
  }, [f]);
  const set = (patch: Partial<NavState>) => setF((p) => ({ ...p, ...patch }));

  const counts = useMemo(() => {
    const out: Record<string, NavCounts> = {};
    for (const t of theses) {
      const q = qCounts?.by_thesis[t.id];
      out[t.id] = {
        pending: q?.pending ?? 0,
        watch: q?.watch ?? 0,
        alert: tCounts?.by_thesis[t.id]?.alert ?? 0,
        unread: reads.byThesis[t.id]?.total ?? 0,
      };
    }
    return out;
  }, [theses, qCounts, tCounts, reads.byThesis]);

  const shown = useMemo(() => filterTheses([...theses], f, counts), [theses, f, counts]);
  const groups = useMemo(() => groupTheses(shown, f.group), [shown, f.group]);
  const kinds = useMemo(() => facet(theses, kindOf), [theses]);
  const sectors = useMemo(() => facet(theses, sectorOf), [theses]);
  const orphanUnread = reads.byThesis[""]?.total ?? 0;
  const filtered = !!f.q || !!f.kind || !!f.sector || !!f.status || f.onlyPending || f.onlyUnread;

  // "/" jumps to the search box from anywhere in the tab that is not a field.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ↑ ↓ in the search box walks the visible rows, in the order they are drawn.
  const order = useMemo(() => groups.flatMap(([, list]) => list.map((t) => t.id)), [groups]);
  const step = (d: number) => {
    if (!order.length) return;
    const i = order.indexOf(selectedId);
    onSelect(order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + d))]);
  };

  const border = { borderColor: colors.border };
  const dim = { color: colors.textSecondary };
  const chip = (on: boolean) => ({
    borderColor: on ? colors.accent : colors.border,
    color: on ? colors.accent : colors.textSecondary,
    background: on ? `${colors.accent}18` : "transparent",
  });
  const selectStyle = {
    background: colors.surface,
    borderColor: colors.border,
    color: colors.text,
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-2 py-1.5 border-b flex flex-col gap-1.5" style={border}>
        <div className="flex items-center gap-1">
          <input
            ref={searchRef}
            value={f.q}
            onChange={(e) => set({ q: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                step(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                step(-1);
              } else if (e.key === "Escape") set({ q: "" });
            }}
            placeholder="ค้นหา thesis  ( / )"
            aria-label="ค้นหา thesis"
            className="flex-1 min-w-0 px-1.5 py-0.5 border outline-none text-[10px]"
            style={selectStyle}
          />
          {onNew && (
            <button
              type="button"
              onClick={onNew}
              title="thesis ใหม่"
              className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 border font-bold text-[9px]"
              style={{ borderColor: colors.accent, color: colors.accent }}
            >
              <Plus className="h-3 w-3" />
              ใหม่
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-1 text-[9px]">
          <button
            type="button"
            className="px-1.5 border"
            style={chip(!f.kind)}
            onClick={() => set({ kind: "" })}
          >
            ทั้งหมด {theses.length}
          </button>
          {kinds.map(([k, n]) => (
            <button
              aria-pressed={f.kind === k}
              type="button"
              key={k}
              className="px-1.5 border"
              style={chip(f.kind === k)}
              onClick={() => set({ kind: f.kind === k ? "" : k })}
            >
              {k} {n}
            </button>
          ))}
        </div>

        <div className="flex gap-1 text-[9px]">
          <select
            value={f.sector}
            onChange={(e) => set({ sector: e.target.value })}
            aria-label="sector"
            className="flex-1 min-w-0 border px-1 outline-none"
            style={selectStyle}
          >
            <option value="">ทุก sector</option>
            {sectors.map(([s, n]) => (
              <option key={s} value={s}>
                {s} ({n})
              </option>
            ))}
          </select>
          <select
            value={f.status}
            onChange={(e) => set({ status: e.target.value })}
            aria-label="สถานะ"
            className="border px-1 outline-none"
            style={selectStyle}
          >
            <option value="">ทุกสถานะ</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-1 text-[9px]">
          <button
            aria-pressed={f.onlyPending}
            type="button"
            className="px-1.5 border"
            style={chip(f.onlyPending)}
            onClick={() => set({ onlyPending: !f.onlyPending })}
            title="thesis ที่มีคำถามค้าง หรือตัวเลขถึงวัน / ไม่ตรง"
          >
            มีงานค้าง
          </button>
          <button
            aria-pressed={f.onlyUnread}
            type="button"
            className="px-1.5 border"
            style={chip(f.onlyUnread)}
            onClick={() => set({ onlyUnread: !f.onlyUnread })}
          >
            ยังไม่อ่าน
          </button>
          <select
            value={f.group}
            onChange={(e) => set({ group: e.target.value as NavGroup })}
            aria-label="จัดกลุ่ม"
            className="ml-auto border px-1 outline-none"
            style={selectStyle}
          >
            <option value="kind">กลุ่ม: kind</option>
            <option value="sector">กลุ่ม: sector</option>
            <option value="category">กลุ่ม: category</option>
            <option value="none">ไม่จัดกลุ่ม</option>
          </select>
          <select
            value={f.sort}
            onChange={(e) => set({ sort: e.target.value as NavSort })}
            aria-label="เรียง"
            className="border px-1 outline-none"
            style={selectStyle}
          >
            <option value="updated">แก้ล่าสุด</option>
            <option value="symbol">A–Z</option>
            <option value="work">งานค้าง</option>
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {allLabel && (
          <button
            type="button"
            onClick={() => onSelect("")}
            className="w-full text-left px-2 py-1 border-b font-bold text-[10px]"
            style={{
              ...border,
              color: selectedId === "" ? colors.accent : colors.textSecondary,
              background: selectedId === "" ? colors.bgSelected : "transparent",
            }}
          >
            {allLabel}
          </button>
        )}
        {groups.map(([label, list]) => (
          <div key={label || "—"}>
            {f.group !== "none" && (
              <div
                className="px-2 py-0.5 border-b text-[8px] tracking-widest flex"
                style={{ ...border, ...dim, background: colors.surface }}
              >
                <span>{label || "ไม่ระบุ"}</span>
                <span className="ml-auto font-mono">{list.length}</span>
              </div>
            )}
            {list.map((t) => {
              const c = counts[t.id];
              return (
                <button
                  aria-pressed={selectedId === t.id}
                  type="button"
                  key={t.id}
                  onClick={() => onSelect(t.id)}
                  title={`${t.symbol} — ${t.title}\n${kindOf(t)}${sectorOf(t) ? ` · ${sectorOf(t)}` : ""}${t.tags ? ` · ${t.tags}` : ""}`}
                  className="w-full flex items-center gap-1.5 text-left px-2 py-0.5 border-b hover:opacity-90 text-[10px] leading-snug"
                  style={{
                    ...border,
                    background: selectedId === t.id ? colors.bgSelected : "transparent",
                  }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: STATUS_COLOR[t.status] ?? "#666" }}
                  />
                  <span
                    className="font-bold font-mono shrink-0 max-w-[40%] truncate"
                    style={{ color: colors.accent }}
                  >
                    {t.symbol}
                  </span>
                  <span className="flex-1 min-w-0 truncate" style={dim}>
                    {shortTitle(t)}
                  </span>
                  <Badge
                    n={c?.pending ?? 0}
                    bg="#7f1d1d"
                    fg="#fecaca"
                    title={`${c?.pending} คำถามค้าง`}
                  />
                  <Badge
                    n={c?.alert ?? 0}
                    bg="#7c2d12"
                    fg="#fed7aa"
                    title={`${c?.alert} ตัวเลขถึงวัน / ไม่ตรง / แตะเส้น killer`}
                  />
                  <Badge
                    n={c?.watch ?? 0}
                    bg="#78350f"
                    fg="#fde68a"
                    title={`${c?.watch} คำถามเฝ้าดู`}
                  />
                  {!!c?.unread && (
                    <span
                      className="text-[8px] font-bold font-mono shrink-0"
                      title={`${c.unread} รายการยังไม่อ่าน`}
                      style={{ color: UNREAD_COLOR }}
                    >
                      ●{c.unread}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
        {!isLoading && shown.length === 0 && (
          <div className="p-2 text-[10px]" style={dim}>
            {theses.length ? "ไม่พบ thesis ที่ตรงกับตัวกรอง" : "ยังไม่มี thesis"}
          </div>
        )}
        {orphanUnread > 0 && (
          <div className="px-2 py-1 text-[9px]" style={{ color: UNREAD_COLOR }}>
            ●{orphanUnread} รายการยังไม่อ่านที่ไม่ผูก thesis (ดูใน KB)
          </div>
        )}
      </div>

      <div
        className="shrink-0 px-2 py-0.5 border-t text-[8px] flex items-center gap-2"
        style={{ ...border, ...dim }}
      >
        <span className="font-mono">
          {shown.length} / {theses.length}
        </span>
        {filtered && (
          <button
            type="button"
            className="flex items-center gap-0.5 hover:opacity-80"
            onClick={() => setF((p) => ({ ...NAV_DEFAULT, group: p.group, sort: p.sort }))}
          >
            <X className="h-2.5 w-2.5" />
            ล้างตัวกรอง
          </button>
        )}
        {footer && <span className="ml-auto">{footer}</span>}
      </div>
    </div>
  );
}

/** Desktop frame for the navigator: a fixed-width column that folds to a strip. */
export function NavRail({ colors, children }: { colors: Colors; children: ReactNode }) {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const s = localStorage.getItem(OPEN_KEY);
      if (s) return JSON.parse(s) as boolean;
    } catch {
      /* ignore */
    }
    return true;
  });
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(open));
    } catch {
      /* ignore */
    }
  }, [open]);
  return (
    <div
      className={`${open ? "w-72" : "w-6"} shrink-0 border-r flex flex-col min-h-0 relative`}
      style={{ borderColor: colors.border }}
    >
      <button
        aria-pressed={open}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? "พับรายการ thesis" : "กางรายการ thesis"}
        className="absolute z-10 top-1/2 -right-2 w-4 h-8 flex items-center justify-center border"
        style={{
          borderColor: colors.border,
          background: colors.surface,
          color: colors.textSecondary,
        }}
      >
        {open ? <ChevronLeft className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {open && children}
    </div>
  );
}
