"use client";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { Colors } from "../../helpers";
import { STATUS_COLOR, type Thesis } from "./types";

// Grouped the same way PORT groups positions: category → sub-portfolio → symbol.
export function ThesisRail({
  theses,
  selectedId,
  onSelect,
  colors,
}: {
  theses: Thesis[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  colors: Colors;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const map = new Map<string, Map<string, Thesis[]>>();
    for (const t of theses) {
      const cat = t.category || "UNCATEGORISED";
      const sub = t.sub_portfolio || "";
      if (!map.has(cat)) map.set(cat, new Map());
      const subs = map.get(cat) as Map<string, Thesis[]>;
      if (!subs.has(sub)) subs.set(sub, []);
      (subs.get(sub) as Thesis[]).push(t);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [theses]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex-1 overflow-y-auto">
      {groups.map(([cat, subs]) => {
        const isCollapsed = collapsed.has(cat);
        const count = [...subs.values()].reduce((n, arr) => n + arr.length, 0);
        return (
          <div key={cat}>
            <button
              type="button"
              onClick={() => toggle(cat)}
              className="w-full flex items-center gap-1 px-2 py-1 border-b text-[8px] font-bold tracking-widest"
              style={{ borderColor: colors.border, color: colors.accent, background: "#0a0a0a" }}
            >
              {isCollapsed ? (
                <ChevronRight className="h-2.5 w-2.5" />
              ) : (
                <ChevronDown className="h-2.5 w-2.5" />
              )}
              {cat}
              <span className="ml-auto" style={{ color: colors.textSecondary }}>
                {count}
              </span>
            </button>
            {!isCollapsed &&
              [...subs.entries()].map(([sub, items]) => (
                <div key={`${cat}:${sub}`}>
                  {sub && (
                    <div
                      className="px-2 py-0.5 text-[7px] tracking-widest"
                      style={{ color: colors.textSecondary, background: "#050505" }}
                    >
                      {sub}
                    </div>
                  )}
                  {items.map((t) => (
                    <button
                      type="button"
                      key={t.id}
                      onClick={() => onSelect(t.id)}
                      className="w-full text-left px-2 py-1 border-b hover:opacity-80"
                      style={{
                        borderColor: colors.border,
                        background: selectedId === t.id ? "#0a1628" : "transparent",
                      }}
                    >
                      <div className="flex items-center gap-1">
                        <span
                          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{ background: STATUS_COLOR[t.status] ?? "#666" }}
                          title={t.status}
                        />
                        <span className="font-bold text-[10px]" style={{ color: colors.accent }}>
                          {t.symbol}
                        </span>
                        {!!t.open_note_count && (
                          <span
                            className="text-[7px] px-0.5 border"
                            title={`${t.open_note_count} open note(s) — scenarios, risks, catalysts`}
                            style={{ color: "#60a5fa", borderColor: "#60a5fa55" }}
                          >
                            {t.open_note_count}N
                          </span>
                        )}
                        {t.conviction != null && (
                          <span
                            className="ml-auto text-[7px]"
                            style={{ color: colors.textSecondary }}
                          >
                            {"■".repeat(t.conviction)}
                            <span style={{ color: "#222" }}>{"■".repeat(5 - t.conviction)}</span>
                          </span>
                        )}
                      </div>
                      <div className="text-[8px] truncate" style={{ color: colors.textSecondary }}>
                        {t.title}
                      </div>
                    </button>
                  ))}
                </div>
              ))}
          </div>
        );
      })}
      {theses.length === 0 && (
        <div className="p-2 text-[9px]" style={{ color: colors.textSecondary }}>
          No theses
        </div>
      )}
    </div>
  );
}
