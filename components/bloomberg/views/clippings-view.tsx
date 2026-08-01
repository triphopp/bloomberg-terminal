"use client";

import { useAtom } from "jotai";
import {
  BookOpen,
  ExternalLink,
  FolderOpen,
  RefreshCw,
  Send,
  Settings,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isDarkModeAtom } from "../atoms";
import { BloombergButton } from "../core/bloomberg-button";
import { bloombergColors } from "../lib/theme-config";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ClippingMeta {
  file: string;
  title: string;
  source: string;
  author: string;
  published: string;
  tags: string[];
  description: string;
  preview: string;
  char_count: number;
}

interface ClippingContent extends ClippingMeta {
  body: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Remove markdown image syntax — FB CDN links expire and clutter the AI prompt */
function stripImages(md: string): string {
  return md
    .replace(/!\[.*?\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const CLIPPINGS_DIR_KEY = "bloomberg_clippings_dir";

// ─── Component ─────────────────────────────────────────────────────────────────

export default function ClippingsView({ onBack }: { onBack: () => void }) {
  const [isDarkMode] = useAtom(isDarkModeAtom);
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  // ── Settings state ───────────────────────────────────────────────────────────
  const [clippingsDir, setClippingsDir] = useState("");
  const [dirInput, setDirInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);

  // Load saved dir from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CLIPPINGS_DIR_KEY);
      if (saved) {
        setClippingsDir(saved);
        setDirInput(saved);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // ── File list state ──────────────────────────────────────────────────────────
  const [clippings, setClippings] = useState<ClippingMeta[]>([]);
  const [filtered, setFiltered] = useState<ClippingMeta[]>([]);
  const [filterQuery, setFilterQuery] = useState("");
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // ── Content state ────────────────────────────────────────────────────────────
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<ClippingContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);

  // ── Ollama state ─────────────────────────────────────────────────────────────
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("llama3.2");
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [aiOutput, setAiOutput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [showCustom, setShowCustom] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const aiScrollRef = useRef<HTMLDivElement>(null);

  const panel = { backgroundColor: colors.surface, borderColor: colors.border };

  // ── Fetch list ───────────────────────────────────────────────────────────────
  const fetchList = useCallback(
    async (dirOverride?: string) => {
      setListLoading(true);
      setListError(null);
      const dir = dirOverride ?? clippingsDir;
      try {
        const params = new URLSearchParams();
        if (dir) params.set("dir", dir);
        const qs = params.toString();
        const res = await fetch(`/api/clippings${qs ? `?${qs}` : ""}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const items: ClippingMeta[] = data.clippings ?? [];
        setClippings(items);
        setFiltered(items);
        if (data.error) setListError(data.error);
      } catch (err) {
        setListError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        setListLoading(false);
      }
    },
    [clippingsDir]
  );

  // ── Fetch Ollama models ──────────────────────────────────────────────────────
  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch("/api/clippings/ai/models");
      const data = await res.json();
      if (data.models?.length) {
        setModels(data.models);
        setSelectedModel(data.models[0]);
      }
      if (data.error) setOllamaError(data.error);
    } catch {
      setOllamaError("Cannot reach Ollama");
    }
  }, []);

  useEffect(() => {
    fetchList();
    fetchModels();
    return () => abortRef.current?.abort();
  }, [fetchList, fetchModels]);

  // ── Filter ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!filterQuery.trim()) {
      setFiltered(clippings);
      return;
    }
    const q = filterQuery.toLowerCase();
    setFiltered(
      clippings.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.preview.toLowerCase().includes(q) ||
          c.tags.some((t) => String(t).toLowerCase().includes(q))
      )
    );
  }, [filterQuery, clippings]);

  // ── Select file ──────────────────────────────────────────────────────────────
  const handleSelectFile = useCallback(
    async (file: string) => {
      setSelectedFile(file);
      setContent(null);
      setAiOutput("");
      setAiError(null);
      setContentLoading(true);
      try {
        const params = new URLSearchParams({ file });
        if (clippingsDir) params.set("dir", clippingsDir);
        const res = await fetch(`/api/clippings/content?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setContent(await res.json());
      } catch (err) {
        setAiError(err instanceof Error ? err.message : "Failed to load content");
      } finally {
        setContentLoading(false);
      }
    },
    [clippingsDir]
  );

  // ── AI stream ────────────────────────────────────────────────────────────────
  const handleAiAction = useCallback(
    async (action: string) => {
      if (!selectedFile) return;
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      setAiOutput("");
      setAiLoading(true);
      setAiError(null);
      try {
        const res = await fetch("/api/clippings/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: selectedFile,
            action,
            model: selectedModel,
            custom_prompt: customPrompt,
            dir: clippingsDir,
          }),
          signal: abortRef.current.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = JSON.parse(line.slice(6));
            if (data.error) {
              setAiError(data.error);
              break;
            }
            if (data.token) setAiOutput((prev) => prev + data.token);
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setAiError(err instanceof Error ? err.message : "Request failed");
      } finally {
        setAiLoading(false);
      }
    },
    [selectedFile, selectedModel, customPrompt, clippingsDir]
  );

  // Auto-scroll AI output — aiOutput is the trigger (re-run on every chunk
  // appended), not a value the effect body reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (aiScrollRef.current) {
      aiScrollRef.current.scrollTop = aiScrollRef.current.scrollHeight;
    }
  }, [aiOutput]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col h-full font-mono"
      style={{ backgroundColor: colors.background, color: colors.text }}
    >
      {/* ── Header bar ────────────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-2 px-2 py-1 shrink-0"
        style={{ backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}` }}
      >
        <span className="text-[9px] font-mono opacity-40" style={{ color: colors.textSecondary }}>
          DIR:
        </span>
        <span
          className="text-xs truncate max-w-xs"
          style={{ color: colors.textSecondary }}
          title={clippingsDir || CLIPPINGS_DIR_LABEL}
        >
          {clippingsDir ? clippingsDir.split(/[\\/]/).pop() || clippingsDir : CLIPPINGS_DIR_LABEL}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {/* Settings toggle */}
          <BloombergButton
            color={showSettings ? "accent" : "default"}
            onClick={() => setShowSettings((s) => !s)}
            title="Configure clippings directory"
          >
            <Settings className="h-3 w-3" />
          </BloombergButton>
          {/* Ollama model selector */}
          <span className="text-xs" style={{ color: colors.textSecondary }}>
            Ollama:
          </span>
          {ollamaError ? (
            <span className="text-xs" style={{ color: colors.negative }}>
              ✕ offline
            </span>
          ) : (
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="text-xs bg-transparent border px-1.5 py-0.5 font-mono outline-none"
              style={{ borderColor: colors.border, color: colors.text }}
            >
              {models.length === 0 && <option value="llama3.2">llama3.2</option>}
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
          <BloombergButton color="default" onClick={() => fetchList()} disabled={listLoading}>
            <RefreshCw className={`h-3 w-3 ${listLoading ? "animate-spin" : ""}`} />
          </BloombergButton>
        </div>
      </div>

      {/* ── Settings panel ────────────────────────────────────────────────────── */}
      {showSettings && (
        <div
          className="flex items-center gap-2 px-2 py-1 shrink-0"
          style={{ backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}` }}
        >
          <FolderOpen className="h-3 w-3 shrink-0" style={{ color: colors.accent }} />
          <span className="text-xs shrink-0" style={{ color: colors.textSecondary }}>
            Clippings Dir:
          </span>
          <input
            type="text"
            value={dirInput}
            onChange={(e) => setDirInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const val = dirInput.trim();
                setClippingsDir(val);
                try {
                  localStorage.setItem(CLIPPINGS_DIR_KEY, val);
                } catch {
                  /* ignore */
                }
                fetchList(val);
                setShowSettings(false);
              }
            }}
            placeholder="e.g. C:/Users/you/notes/clippings"
            className="flex-1 text-xs bg-transparent border px-2 py-0.5 font-mono outline-none"
            style={{ borderColor: colors.border, color: colors.text }}
          />
          <BloombergButton
            color="green"
            onClick={() => {
              const val = dirInput.trim();
              setClippingsDir(val);
              try {
                localStorage.setItem(CLIPPINGS_DIR_KEY, val);
              } catch {
                /* ignore */
              }
              fetchList(val);
              setShowSettings(false);
            }}
          >
            APPLY
          </BloombergButton>
          {clippingsDir && (
            <BloombergButton
              color="default"
              onClick={() => {
                setClippingsDir("");
                setDirInput("");
                try {
                  localStorage.removeItem(CLIPPINGS_DIR_KEY);
                } catch {
                  /* ignore */
                }
                fetchList("");
                setShowSettings(false);
              }}
              title="Reset to server default"
            >
              RESET
            </BloombergButton>
          )}
        </div>
      )}

      {/* ── Two-panel body ─────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left: file list ─────────────────────────────────────────────────── */}
        <div
          className="flex flex-col shrink-0 border-r overflow-hidden"
          style={{ width: 280, borderColor: colors.border }}
        >
          {/* Filter input */}
          <div className="px-2 py-1.5 border-b shrink-0" style={{ borderColor: colors.border }}>
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Filter by title / tag…"
              className="w-full bg-transparent text-xs outline-none font-mono placeholder:opacity-40"
              style={{ color: colors.text }}
            />
          </div>

          {/* File list */}
          <div
            className="flex-1 overflow-y-auto"
            style={{ scrollbarWidth: "thin", scrollbarColor: "#333 #000" }}
          >
            {listLoading && (
              <div className="flex justify-center py-8">
                <RefreshCw className="h-4 w-4 animate-spin" style={{ color: colors.accent }} />
              </div>
            )}
            {listError && (
              <div className="p-2 text-xs" style={{ color: colors.negative }}>
                {listError}
              </div>
            )}
            {!listLoading &&
              filtered.map((c) => (
                <button
                  key={c.file}
                  type="button"
                  onClick={() => handleSelectFile(c.file)}
                  className="w-full text-left px-2 py-1 border-b hover:opacity-80 transition-opacity"
                  style={{
                    borderColor: colors.border,
                    backgroundColor: selectedFile === c.file ? `${colors.accent}18` : "transparent",
                  }}
                >
                  <div className="flex items-start gap-1.5">
                    <BookOpen
                      className="h-3 w-3 mt-0.5 shrink-0"
                      style={{
                        color: selectedFile === c.file ? colors.accent : colors.textSecondary,
                      }}
                    />
                    <div className="min-w-0">
                      <p
                        className="text-xs font-bold truncate"
                        style={{
                          color: selectedFile === c.file ? colors.accent : colors.text,
                        }}
                      >
                        {c.title}
                      </p>
                      {c.preview && (
                        <p
                          className="text-xs mt-0.5 line-clamp-2 leading-relaxed"
                          style={{ color: colors.textSecondary }}
                        >
                          {c.preview.substring(0, 100)}
                        </p>
                      )}
                      <div
                        className="flex items-center gap-2 mt-0.5 text-xs"
                        style={{ color: colors.textSecondary }}
                      >
                        {c.published && <span>{c.published}</span>}
                        <span>{Math.ceil(c.char_count / 5)} words</span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            {!listLoading && filtered.length === 0 && !listError && (
              <p className="py-8 text-center text-xs" style={{ color: colors.textSecondary }}>
                No clippings found
              </p>
            )}
          </div>

          {/* Footer count */}
          <div
            className="px-2 py-1 border-t shrink-0 text-xs"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            {filtered.length} / {clippings.length} files
          </div>
        </div>

        {/* ── Right: content + AI ─────────────────────────────────────────────── */}
        <div
          className="flex-1 overflow-y-auto"
          style={{ scrollbarWidth: "thin", scrollbarColor: "#333 #000" }}
        >
          {/* Empty state */}
          {!selectedFile && (
            <div className="flex flex-col items-center justify-center h-full py-20 gap-3">
              <BookOpen className="h-12 w-12 opacity-15" />
              <p className="text-[10px]" style={{ color: colors.textSecondary }}>
                Select a clipping from the list
              </p>
            </div>
          )}

          {/* Loading content */}
          {selectedFile && contentLoading && (
            <div className="flex items-center justify-center py-20 gap-2">
              <RefreshCw className="h-5 w-5 animate-spin" style={{ color: colors.accent }} />
              <span className="text-[10px]" style={{ color: colors.textSecondary }}>
                Loading…
              </span>
            </div>
          )}

          {/* Content loaded */}
          {selectedFile && content && !contentLoading && (
            <div className="p-3 space-y-3 max-w-4xl">
              {/* ── Metadata header ── */}
              <div>
                <h2 className="text-sm font-bold leading-snug mb-1">{content.title}</h2>
                <div
                  className="flex flex-wrap items-center gap-3 text-xs"
                  style={{ color: colors.textSecondary }}
                >
                  {content.source && (
                    <a
                      href={content.source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 hover:opacity-70"
                      style={{ color: colors.accent }}
                    >
                      <ExternalLink className="h-3 w-3" />
                      Source
                    </a>
                  )}
                  {content.published && <span>{content.published}</span>}
                  {content.author && <span>by {content.author}</span>}
                  <span>{Math.ceil(content.char_count / 5)} words</span>
                </div>
                {content.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {content.tags.map((t) => (
                      <span
                        key={String(t)}
                        className="text-xs px-1.5 py-0.5 border"
                        style={{ borderColor: colors.border, color: colors.textSecondary }}
                      >
                        #{t}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* ── AI panel ── */}
              <div className="border p-2 space-y-2" style={panel}>
                <div className="flex items-center justify-between">
                  <span
                    className="text-xs font-bold tracking-widest"
                    style={{ color: colors.accent }}
                  >
                    AI · {selectedModel}
                  </span>
                  {aiLoading && (
                    <button
                      type="button"
                      onClick={() => abortRef.current?.abort()}
                      className="flex items-center gap-1 text-xs px-2 py-0.5 border hover:opacity-70"
                      style={{ borderColor: colors.negative, color: colors.negative }}
                    >
                      <Square className="h-2.5 w-2.5" />
                      STOP
                    </button>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex flex-wrap gap-1">
                  <BloombergButton
                    color="accent"
                    onClick={() => handleAiAction("summarize")}
                    disabled={aiLoading}
                  >
                    SUMMARIZE
                  </BloombergButton>
                  <BloombergButton
                    color="green"
                    onClick={() => handleAiAction("translate_th")}
                    disabled={aiLoading}
                  >
                    TRANSLATE → TH
                  </BloombergButton>
                  <BloombergButton
                    color="default"
                    onClick={() => setShowCustom((v) => !v)}
                    disabled={aiLoading}
                  >
                    CUSTOM
                  </BloombergButton>
                </div>

                {/* Custom prompt input */}
                {showCustom && (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === "Enter" && customPrompt.trim() && handleAiAction("custom")
                      }
                      placeholder="Ask anything about this article…"
                      className="flex-1 bg-transparent text-xs border px-2 py-1 outline-none font-mono placeholder:opacity-40"
                      style={{ borderColor: colors.border, color: colors.text }}
                    />
                    <BloombergButton
                      color="accent"
                      onClick={() => handleAiAction("custom")}
                      disabled={aiLoading || !customPrompt.trim()}
                    >
                      <Send className="h-3 w-3" />
                    </BloombergButton>
                  </div>
                )}

                {/* AI error */}
                {aiError && (
                  <div
                    className="text-xs p-2 border"
                    style={{
                      borderColor: colors.negative,
                      color: colors.negative,
                      backgroundColor: `${colors.negative}10`,
                    }}
                  >
                    {aiError}
                  </div>
                )}

                {/* Streaming output */}
                {(aiOutput || aiLoading) && (
                  <div
                    ref={aiScrollRef}
                    className="max-h-72 overflow-y-auto p-2 border text-xs leading-relaxed"
                    style={{
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    }}
                  >
                    <pre className="whitespace-pre-wrap font-mono" style={{ color: colors.text }}>
                      {aiOutput}
                      {aiLoading && (
                        <span className="animate-pulse" style={{ color: colors.accent }}>
                          ▋
                        </span>
                      )}
                    </pre>
                  </div>
                )}
              </div>

              {/* ── Original content ── */}
              <div className="border p-3" style={panel}>
                <h3
                  className="text-xs font-bold tracking-widest mb-3"
                  style={{ color: colors.accent }}
                >
                  ORIGINAL CONTENT
                </h3>
                <div
                  className="text-sm leading-relaxed whitespace-pre-wrap"
                  style={{ color: colors.text }}
                >
                  {stripImages(content.body)}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// show a short display-only path label in the header
const CLIPPINGS_DIR_LABEL = "Obsidian / Clippings";
