"use client";
import { useState, useEffect, useRef } from "react";
import { BookOpen, FlaskConical, Loader2 } from "lucide-react";
import type { ThesisData } from "../types";
import { type Colors } from "../helpers";

function renderMarkdown(text: string, colors: Colors) {
  return text.split("\n").map((line, i) => {
    if (line.startsWith("### "))
      return <h4 key={i} className="font-bold text-xs mt-3 mb-1" style={{ color: colors.accent }}>{line.slice(4)}</h4>;
    if (line.startsWith("## "))
      return <h3 key={i} className="font-bold text-sm mt-4 mb-1" style={{ color: colors.accent }}>{line.slice(3)}</h3>;
    if (line.startsWith("- "))
      return <li key={i} className="text-xs ml-3 mb-0.5" style={{ color: colors.textSecondary }}>{line.slice(2)}</li>;
    if (line.trim())
      return <p key={i} className="text-xs mb-1 leading-relaxed" style={{ color: colors.textSecondary }}
        dangerouslySetInnerHTML={{ __html: line.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>") }} />;
    return <br key={i} />;
  });
}

export function ThesesTab({ colors }: { colors: Colors }) {
  const [theses, setTheses]         = useState<(ThesisData["meta"] & { file: string; symbol: string })[]>([]);
  const [selected, setSelected]     = useState<ThesisData | null>(null);
  const [streaming, setStreaming]    = useState(false);
  const [streamText, setStreamText]  = useState("");
  const [loadingList, setLoadingList] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoadingList(true);
    fetch("/api/portfolio/theses")
      .then(r => r.json())
      .then(d => setTheses(d.theses ?? []))
      .catch(() => {})
      .finally(() => setLoadingList(false));
  }, []);

  const loadThesis = async (symbol: string) => {
    try {
      const r = await fetch(`/api/portfolio/thesis?symbol=${encodeURIComponent(symbol)}`);
      setSelected(await r.json());
      setStreamText("");
    } catch { /* ignore */ }
  };

  const runResearch = async (symbol: string) => {
    setStreaming(true); setStreamText("");
    try {
      const r = await fetch("/api/portfolio/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, provider: "claude" }),
      });
      const reader = r.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(line.slice(5));
            if (ev.token) setStreamText(t => t + ev.token);
            if (ev.done) break;
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ } finally { setStreaming(false); }
  };

  useEffect(() => {
    if (textRef.current) textRef.current.scrollTop = textRef.current.scrollHeight;
  }, [streamText]);

  return (
    <div className="flex" style={{ minHeight: "400px", height: "100%" }}>
      {/* List */}
      <div className="w-48 border-r overflow-y-auto flex-shrink-0" style={{ borderColor: colors.border }}>
        <div className="px-2 py-1 text-[9px] font-bold tracking-widest border-b" style={{ color: colors.accent, borderColor: colors.border }}>
          THESES
        </div>
        {loadingList && <div className="p-2"><Loader2 className="h-3 w-3 animate-spin" style={{ color: colors.accent }} /></div>}
        {theses.map(t => (
          <button key={t.file} onClick={() => loadThesis(t.symbol)}
            className="w-full text-left px-2 py-1 border-b hover:opacity-80"
            style={{ borderColor: colors.border, background: selected?.symbol === t.symbol ? "#0a1628" : "transparent" }}>
            <div className="font-bold text-[10px]" style={{ color: colors.accent }}>{t.symbol}</div>
            <div className="text-[8px] truncate" style={{ color: colors.textSecondary }}>{t.title}</div>
            <div className="text-[8px]" style={{ color: t.status === "active" ? "#4ade80" : "#666" }}>{t.status}</div>
          </button>
        ))}
        {!loadingList && theses.length === 0 && (
          <div className="p-2 text-[9px]" style={{ color: colors.textSecondary }}>No theses found</div>
        )}
      </div>

      {/* Detail */}
      <div className="flex-1 overflow-y-auto p-3" ref={textRef}>
        {selected ? (
          <>
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="font-bold text-sm" style={{ color: colors.accent }}>{selected.symbol}</div>
                <div className="text-[10px]" style={{ color: colors.textSecondary }}>{selected.meta.title}</div>
              </div>
              <button
                onClick={() => runResearch(selected.symbol)}
                disabled={streaming}
                className="flex items-center gap-1 text-[9px] px-2 py-1 border font-bold hover:opacity-80 disabled:opacity-40"
                style={{ borderColor: colors.accent, color: colors.accent }}>
                {streaming ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <FlaskConical className="h-2.5 w-2.5" />}
                AI ANALYSIS
              </button>
            </div>
            {streamText ? (
              <div className="text-xs space-y-0.5">{renderMarkdown(streamText, colors)}</div>
            ) : (
              <div className="text-xs space-y-0.5">{renderMarkdown(selected.raw_body, colors)}</div>
            )}
          </>
        ) : (
          <div className="h-full flex items-center justify-center" style={{ color: colors.textSecondary }}>
            <div className="text-center">
              <BookOpen className="h-8 w-8 mx-auto mb-2 opacity-20" />
              <div className="text-xs">Select a thesis</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
