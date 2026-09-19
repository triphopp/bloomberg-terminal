"use client";
import { useEffect, useState } from "react";
import { SeriesBoard } from "../../ui/series-board";

type Group = {
  group_key: string;
  series_count: number;
  last_date: string | null;
  captured_at: string | null;
  sources: string[];
};

const GROUP_KEY = "bloomberg_news_data_group";

/** DATA — published numbers that are not instruments.
 *
 *  A quote has a ticker and a provider; an industry spot price, a freight rate
 *  or a survey index has neither, and before this tab there was nowhere in the
 *  terminal for one. The tab itself is only a group selector: the groups come
 *  from the backend, so adding a collector puts a new board here without a
 *  frontend change, and nothing in this file names a specific market. */
export function DataTab({
  colors,
}: {
  colors: {
    text: string;
    textSecondary: string;
    accent: string;
    border: string;
    background: string;
  };
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [group, setGroup] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return localStorage.getItem(GROUP_KEY);
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/v2/series/groups", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list: Group[] = Array.isArray(d?.groups) ? d.groups : [];
        setGroups(list);
        setGroup((cur) =>
          cur && list.some((g) => g.group_key === cur) ? cur : (list[0]?.group_key ?? null)
        );
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, []);

  useEffect(() => {
    if (!group) return;
    try {
      localStorage.setItem(GROUP_KEY, group);
    } catch {
      /* ignore */
    }
  }, [group]);

  if (loading) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-[10px]"
        style={{ color: colors.textSecondary }}
      >
        กำลังโหลด…
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div
        className="flex-1 p-4 text-[10px] leading-relaxed"
        style={{ color: colors.textSecondary }}
      >
        <div className="font-bold mb-2" style={{ color: colors.accent }}>
          ยังไม่มีชุดข้อมูล
        </div>
        <p>
          ตัวเก็บข้อมูลอยู่ที่ <span className="font-mono">backend/series_sources/</span> — ตัวแรกคือ{" "}
          <span className="font-mono">dramexchange</span> (ราคา DRAM/NAND) เรียกเก็บครั้งแรกด้วย{" "}
          <span className="font-mono">POST /api/v2/series/refresh</span>
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {groups.length > 1 && (
        <div
          className="shrink-0 flex items-center gap-1 px-2 py-1 border-b"
          style={{ borderColor: colors.border }}
        >
          {groups.map((g) => (
            <button
              type="button"
              key={g.group_key}
              onClick={() => setGroup(g.group_key)}
              className="text-[9px] px-2 py-0.5 border font-bold tracking-widest"
              style={{
                borderColor: group === g.group_key ? colors.accent : colors.border,
                color: group === g.group_key ? colors.accent : colors.textSecondary,
                background: group === g.group_key ? "#ff990015" : "transparent",
              }}
              title={`${g.series_count} series · ล่าสุด ${g.last_date ?? "—"}`}
            >
              {g.group_key.toUpperCase()} ({g.series_count})
            </button>
          ))}
        </div>
      )}
      {group && <SeriesBoard group={group} colors={colors} />}
    </div>
  );
}
