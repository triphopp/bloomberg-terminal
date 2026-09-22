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

/** The analysis pages attached to one thesis, as an index — not a viewer.
 *
 *  An analysis page is a full document: a masthead, its own section navigation
 *  and a text column set to a reading measure. Squeezing that into the panel
 *  left of the thesis meant a strip of tabs across the top, an iframe the size
 *  of a postcard, and a page whose own layout collapsed inside it. So the panel
 *  keeps only what it is good at — the list — and the page opens in a real
 *  browser tab, where it has the width it was written for.
 *
 *  Nothing is rendered inline any more, which also retires the sandbox question
 *  the embedded frame raised: a model-written document is now loaded by the
 *  browser as its own top-level page under the backend's CSP, never inside the
 *  terminal's origin. */
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
      setBanner(null);
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

      <div
        className="shrink-0 flex items-center gap-2 px-2 py-1 border-b text-[8px] font-mono"
        style={{ borderColor: colors.border, color: colors.textSecondary }}
      >
        <span className="font-bold tracking-widest" style={{ color: colors.accent }}>
          หน้าวิเคราะห์ {rows.length}
        </span>
        <span>คลิกเพื่อเปิดแท็บใหม่</span>
        {loading && (
          <Loader2 className="w-3 h-3 animate-spin shrink-0" style={{ color: colors.accent }} />
        )}
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

      <div className="flex-1 overflow-y-auto">
        {rows.map((g) => (
          <div
            key={g.slug}
            className="group border-b px-2 py-1.5"
            style={{ borderColor: colors.border }}
          >
            <div className="flex items-start gap-2">
              {/* A real link, so middle-click and ⌘-click behave like links do. */}
              <a
                href={g.render_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 min-w-0 text-left"
              >
                <div
                  className="text-[10px] font-bold leading-snug flex items-center gap-1"
                  style={{ color: colors.accent }}
                >
                  <span className="truncate">{g.title}</span>
                  <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
                </div>
                {g.description && (
                  <div
                    className="text-[8px] leading-snug mt-0.5 line-clamp-2"
                    style={{ color: colors.textSecondary }}
                  >
                    {g.description}
                  </div>
                )}
                <div
                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-[7px] font-mono"
                  style={{ color: colors.textSecondary }}
                >
                  {g.symbol && <span style={{ color: colors.accent }}>{g.symbol}</span>}
                  <span>as of {g.as_of ?? "—"}</span>
                  <span>v{g.version}</span>
                  <span>{Math.round(g.bytes / 1024)} KB</span>
                  {g.zettel_refs && <span>refs {g.zettel_refs}</span>}
                  <span>by {g.actor}</span>
                </div>
              </a>
              <button
                type="button"
                onClick={() => void remove(g.slug)}
                title="ลบออกจากรายการ (ไฟล์ยังอยู่)"
                className="shrink-0 p-1 opacity-0 group-hover:opacity-100 focus:opacity-100"
                style={{ color: "#ff5555" }}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
