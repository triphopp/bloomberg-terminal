"use client";
import { ExternalLink, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Colors } from "../../../helpers";

const API = "/api/v2/graphs";

export type AnalysisGraph = {
  id: string;
  slug: string;
  title: string;
  description: string;
  symbol: string | null;
  thesis_id: string | null;
  zettel_refs: string;
  tags: string;
  as_of: string | null;
  sources: { title?: string; url?: string }[];
  version: number;
  bytes: number;
  actor: string;
  created_at: string;
  updated_at: string;
  render_url: string;
  file: string;
};

/** Rendered analysis pages attached to one thesis.
 *
 *  The page is a whole HTML document written by an agent, so it is shown in an
 *  iframe WITHOUT `allow-same-origin`: the frame gets an opaque origin and can
 *  neither read the terminal's cookies and localStorage nor call its API. The
 *  backend sends a matching CSP; both have to stay, since either one alone
 *  turns "a chart someone generated" into script running on our own origin.
 *  `allow-scripts` is kept because the diagrams animate and filter. */
export function GraphsPanel({
  thesisId,
  colors,
  onCountChange,
}: {
  thesisId: string;
  colors: Colors;
  onCountChange?: (n: number) => void;
}) {
  const [rows, setRows] = useState<AnalysisGraph[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}?thesis_id=${encodeURIComponent(thesisId)}&limit=100`);
      const d = await r.json();
      const list: AnalysisGraph[] = Array.isArray(d.graphs) ? d.graphs : [];
      setRows(list);
      onCountChange?.(list.length);
      setSelected((cur) =>
        cur && list.some((g) => g.slug === cur) ? cur : (list[0]?.slug ?? null)
      );
    } catch {
      setBanner("โหลดรายการไม่สำเร็จ — backend ตอบไหม?");
    } finally {
      setLoading(false);
    }
  }, [thesisId, onCountChange]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (slug: string) => {
    if (!window.confirm(`ลบกราฟ "${slug}" ออกจากรายการ? (ไฟล์ยังอยู่บนดิสก์)`)) return;
    await fetch(`${API}/${encodeURIComponent(slug)}`, { method: "DELETE" });
    await load();
  };

  const current = rows.find((g) => g.slug === selected) ?? null;

  if (!loading && rows.length === 0) {
    return (
      <div
        className="flex-1 overflow-y-auto p-4 text-[9px]"
        style={{ color: colors.textSecondary }}
      >
        <div className="font-bold mb-2" style={{ color: colors.accent }}>
          ยังไม่มีหน้าวิเคราะห์สำหรับ thesis นี้
        </div>
        <p className="mb-1">
          หน้าวิเคราะห์ถูกสร้างจาก agent ผ่าน MCP tool{" "}
          <span style={{ color: colors.accent }}>graph_create</span> — หนึ่งหน้า = หนึ่งภาพรวม
          (แผนที่กระแสเงิน, บันไดสัญญาณ, ตารางเทียบข้ามบริษัท)
        </p>
        <p>
          ไฟล์เก็บที่ <span className="font-mono">research/graphs/&lt;slug&gt;/index.html</span>
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {banner && (
        <div className="shrink-0 px-2 py-1 text-[8px]" style={{ color: "#ff5555" }}>
          {banner}
        </div>
      )}

      {/* index strip */}
      <div
        className="shrink-0 flex items-center gap-1 overflow-x-auto px-2 py-1 border-b"
        style={{ borderColor: colors.border }}
      >
        {loading && (
          <Loader2 className="w-3 h-3 animate-spin shrink-0" style={{ color: colors.accent }} />
        )}
        {rows.map((g) => (
          <button
            type="button"
            key={g.slug}
            onClick={() => setSelected(g.slug)}
            className="text-[8px] px-2 py-0.5 border font-bold whitespace-nowrap"
            style={{
              borderColor: selected === g.slug ? colors.accent : colors.border,
              color: selected === g.slug ? colors.accent : colors.textSecondary,
              background: selected === g.slug ? "#ff990015" : "transparent",
            }}
          >
            {g.title}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void load()}
          title="reload"
          className="ml-auto shrink-0 p-1"
          style={{ color: colors.textSecondary }}
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      {current && (
        <>
          <div
            className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 text-[8px] border-b"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            <span style={{ color: colors.accent }} className="font-bold">
              {current.symbol ?? "—"}
            </span>
            <span>as of {current.as_of ?? "—"}</span>
            <span>v{current.version}</span>
            <span>{Math.round(current.bytes / 1024)} KB</span>
            {current.zettel_refs && <span>refs: {current.zettel_refs}</span>}
            <span>by {current.actor}</span>
            <a
              href={current.render_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-bold"
              style={{ color: colors.accent }}
            >
              <ExternalLink className="w-3 h-3" /> เปิดแท็บใหม่
            </a>
            <button
              type="button"
              onClick={() => void remove(current.slug)}
              className="inline-flex items-center gap-1"
              style={{ color: "#ff5555" }}
            >
              <Trash2 className="w-3 h-3" /> ลบออกจากรายการ
            </button>
          </div>

          {current.description && (
            <div className="shrink-0 px-2 py-1 text-[8px]" style={{ color: colors.textSecondary }}>
              {current.description}
            </div>
          )}

          <iframe
            key={`${current.slug}-v${current.version}`}
            src={current.render_url}
            title={current.title}
            // No allow-same-origin: see the component docstring.
            sandbox="allow-scripts"
            className="flex-1 w-full border-0"
            // The page paints its own background; this only covers the moment
            // before it does, so it takes the terminal's ground rather than the
            // browser default white, which flashes hard on a black screen.
            style={{ background: colors.bg }}
          />
        </>
      )}
    </div>
  );
}
