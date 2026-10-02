"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { Colors } from "../../helpers";

// Read marks — /api/v2/reads (backend/routers/reads.py). Unread is derived by
// the backend: never marked, or changed since it was last marked.

export type ReadType = "thesis" | "note" | "zettel" | "answer" | "graph" | "reading";
export type ReadItem = { type: ReadType; id: string };

interface UnreadPayload {
  /** `parent_id` = the question of an answer, the metric of a reading. */
  items: { type: ReadType; id: string; thesis_id: string; parent_id: string | null }[];
  by_thesis: Record<string, { total: number } & Record<ReadType, number>>;
  total: number;
}

const API = "/api/v2/reads";
export const UNREAD_COLOR = "#60a5fa";

async function post(url: string, body: unknown) {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function useReads() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["reads", "unread"],
    queryFn: async ({ signal }) => {
      const r = await fetch(`${API}/unread`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as UnreadPayload;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { own, under } = useMemo(() => {
    const own = new Set<string>();
    const under = new Map<string, ReadItem[]>();
    for (const i of data?.items ?? []) {
      own.add(`${i.type}:${i.id}`);
      if (i.parent_id) {
        const k = `${i.type}:${i.parent_id}`;
        under.set(k, [...(under.get(k) ?? []), { type: i.type, id: i.id }]);
      }
    }
    return { own, under };
  }, [data]);

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ["reads"] }), [qc]);

  return {
    byThesis: data?.by_thesis ?? {},
    isUnread: (type: ReadType, id: string) => own.has(`${type}:${id}`),
    /** Unread items hanging under a parent — the answers of one question. */
    unreadUnder: (type: ReadType, parentId: string) => under.get(`${type}:${parentId}`) ?? [],
    mark: async (items: ReadItem[]) => {
      if (!items.length) return;
      await post(API, { items });
      await refresh();
    },
    unmark: async (items: ReadItem[]) => {
      await post(`${API}/unmark`, { items });
      await refresh();
    },
    /** Everything unread under one thesis, optionally only some types. */
    markThesis: async (thesisId: string, types?: ReadType[]) => {
      await post(API, { thesis_id: thesisId, types });
      await refresh();
    },
    /** A write elsewhere (an edit, a new note) can change what is unread. */
    refresh,
  };
}

/** One control per item: a filled dot while unread (click = read), a faint ring
 *  once read (click = back to unread). Opening an item never marks it. */
export function ReadDot({
  type,
  id,
  colors,
  reads,
}: {
  type: ReadType;
  id: string;
  colors: Colors;
  reads: ReturnType<typeof useReads>;
}) {
  const unread = reads.isUnread(type, id);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void (unread ? reads.mark([{ type, id }]) : reads.unmark([{ type, id }]));
      }}
      title={unread ? "ยังไม่อ่าน — กดเพื่อทำเครื่องหมายว่าอ่านแล้ว" : "อ่านแล้ว — กดเพื่อกลับเป็นยังไม่อ่าน"}
      aria-label={unread ? "ทำเครื่องหมายว่าอ่านแล้ว" : "กลับเป็นยังไม่อ่าน"}
      className="shrink-0 inline-flex items-center justify-center w-4 h-4 align-middle"
    >
      <span
        className="block w-2 h-2 rounded-full"
        style={unread ? { background: UNREAD_COLOR } : { border: `1px solid ${colors.textDimmed}` }}
      />
    </button>
  );
}

/** "n ยังไม่อ่าน · อ่านทั้งหมด" for a list header. Renders nothing at zero. */
export function UnreadBar({
  count,
  onMarkAll,
  colors,
}: {
  count: number;
  onMarkAll: () => void;
  colors: Colors;
}) {
  if (!count) return null;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span style={{ color: UNREAD_COLOR }}>{count} ยังไม่อ่าน</span>
      <button
        type="button"
        onClick={onMarkAll}
        className="px-1.5 border hover:opacity-80"
        style={{ borderColor: colors.border, color: colors.textSecondary }}
      >
        อ่านทั้งหมด
      </button>
    </span>
  );
}
