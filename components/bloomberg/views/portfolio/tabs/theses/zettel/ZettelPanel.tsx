"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Colors } from "../../../helpers";
import { renderMarkdown } from "../markdown";
import {
  STANCE_COLOR,
  ZETTEL_KINDS,
  ZETTEL_KIND_COLOR,
  ZETTEL_RELS,
  ZETTEL_REL_COLOR,
  ZETTEL_STATUS_COLOR,
  type Zettel,
  type ZettelConflict,
  type ZettelDetail,
  type ZettelKind,
  type ZettelRel,
} from "../types";
import { ConflictPanel } from "./ConflictPanel";
import { ZettelGraph } from "./ZettelGraph";

const API = "/api/v2/zettel";

type Pane = "notes" | "conflicts" | "graph";

const emptyDraft = {
  title: "",
  kind: "CLAIM" as ZettelKind,
  body: "",
  stance: "",
  tags: "",
  occurred_at: "",
  url: "",
  publisher: "",
  quote: "",
};

/** The knowledge base for one thesis.
 *
 *  Notes are atomic and shared: the same zettel can hang off several theses, so
 *  what is listed here is "what this thesis leans on", not "what belongs to it".
 *  Editing is deliberately thin — the archive is meant to grow by adding notes
 *  and links, not by rewriting what was already written down. */
export function ZettelPanel({
  thesisId,
  symbol,
  colors,
  onCountsChange,
}: {
  thesisId: string;
  symbol: string;
  colors: Colors;
  onCountsChange?: (counts: { notes: number; conflicts: number }) => void;
}) {
  const [pane, setPane] = useState<Pane>("notes");
  const [rows, setRows] = useState<Zettel[]>([]);
  const [conflicts, setConflicts] = useState<ZettelConflict[]>([]);
  const [selected, setSelected] = useState<ZettelDetail | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<ZettelKind | "">("");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ ...emptyDraft });
  const [linking, setLinking] = useState<{ rel: ZettelRel; target: string } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, conf] = await Promise.all([
      fetch(`${API}?thesis_id=${encodeURIComponent(thesisId)}&limit=200`).then((r) => r.json()),
      fetch(`${API}/conflicts?thesis_id=${encodeURIComponent(thesisId)}`).then((r) => r.json()),
    ]);
    setRows(Array.isArray(list.zettel) ? list.zettel : []);
    setConflicts(Array.isArray(conf.conflicts) ? conf.conflicts : []);
  }, [thesisId]);

  useEffect(() => {
    void load();
    setSelected(null);
  }, [load]);

  useEffect(() => {
    onCountsChange?.({ notes: rows.length, conflicts: conflicts.length });
  }, [rows.length, conflicts.length, onCountsChange]);

  const open = useCallback(async (id: string) => {
    const r = await fetch(`${API}/${id}`);
    if (r.ok) {
      setSelected(await r.json());
      setPane("notes");
    }
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (z) =>
        (!kindFilter || z.kind === kindFilter) &&
        (!q ||
          z.title.toLowerCase().includes(q) ||
          z.tags.toLowerCase().includes(q) ||
          z.ref.toLowerCase().includes(q))
    );
  }, [rows, query, kindFilter]);

  const create = async () => {
    if (!draft.title.trim()) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        title: draft.title.trim(),
        kind: draft.kind,
        body: draft.body,
        stance: draft.stance || null,
        tags: draft.tags,
        occurred_at: draft.occurred_at || null,
        thesis_id: thesisId,
        symbol,
      };
      if (draft.url || draft.quote || draft.publisher) {
        body.sources = [{ url: draft.url, publisher: draft.publisher, quote: draft.quote }];
      }
      const r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        // 409 carries the note that already says this — the useful answer, not an error.
        setBanner(typeof e.detail === "string" ? e.detail : "Could not save the note");
        return;
      }
      setDraft({ ...emptyDraft });
      setCreating(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const link = async () => {
    if (!selected || !linking?.target.trim()) return;
    const r = await fetch(`${API}/edges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        src_id: selected.zettel.id,
        dst_id: linking.target.trim(),
        rel: linking.rel,
      }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      setBanner(typeof e.detail === "string" ? e.detail : "Could not link");
      return;
    }
    setLinking(null);
    await Promise.all([load(), open(selected.zettel.id)]);
  };

  const resolve = async (edgeId: string, resolution: string, supersededId?: string) => {
    await fetch(`${API}/edges/${edgeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution, superseded_id: supersededId ?? null }),
    });
    await load();
  };

  const exportVault = async () => {
    const r = await fetch(`${API}/export-md`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setBanner(
      r.ok
        ? `exported ${d.written} notes to ${d.dir}${d.stale?.length ? ` · ${d.stale.length} stale file(s) left behind` : ""}`
        : "export failed"
    );
  };

  const tab = (key: Pane, label: string, danger = false) => (
    <button
      type="button"
      key={key}
      onClick={() => setPane(key)}
      className="text-[8px] px-2 py-0.5 border font-bold"
      style={{
        borderColor: pane === key ? colors.accent : colors.border,
        color: danger ? "#f87171" : pane === key ? colors.accent : colors.textSecondary,
        background: pane === key ? "#ff990015" : "transparent",
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div
        className="flex items-center gap-1 px-2 py-1 border-b shrink-0"
        style={{ borderColor: colors.border }}
      >
        {tab("notes", `NOTES (${rows.length})`)}
        {tab("conflicts", `CONFLICTS (${conflicts.length})`, conflicts.length > 0)}
        {tab("graph", "GRAPH")}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter by text, tag or Z-ref"
          className="flex-1 border px-1.5 py-0.5 text-[8px] font-mono outline-none"
          style={{ borderColor: colors.border, color: colors.text, background: "#0a0a0a" }}
        />
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as ZettelKind | "")}
          className="border px-1 py-0.5 text-[8px] outline-none"
          style={{ borderColor: colors.border, color: colors.textSecondary, background: "#0a0a0a" }}
        >
          <option value="">ALL KINDS</option>
          {ZETTEL_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="text-[8px] px-2 py-0.5 border font-bold"
          style={{ borderColor: colors.accent, color: colors.accent }}
        >
          + NOTE
        </button>
        <button
          type="button"
          onClick={exportVault}
          title="write the whole base to the Obsidian vault (one-way)"
          className="text-[8px] px-2 py-0.5 border font-bold"
          style={{ borderColor: colors.border, color: colors.textSecondary }}
        >
          EXPORT
        </button>
      </div>

      {banner && (
        <button
          type="button"
          onClick={() => setBanner(null)}
          className="px-2 py-1 text-[8px] text-left border-b shrink-0"
          style={{ borderColor: colors.border, color: colors.accent, background: "#ff990010" }}
        >
          {banner} — click to dismiss
        </button>
      )}

      {creating && (
        <div className="border-b p-2 space-y-1 shrink-0" style={{ borderColor: colors.border }}>
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="the idea as ONE sentence — 'CXMT ships DDR5 at >90% yield'"
            className="w-full border px-1.5 py-1 text-[9px] font-mono outline-none"
            style={{ borderColor: colors.border, color: colors.text, background: "#0a0a0a" }}
          />
          <div className="flex gap-1">
            <select
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as ZettelKind })}
              className="border px-1 py-0.5 text-[8px] outline-none"
              style={{ borderColor: colors.border, color: colors.text, background: "#0a0a0a" }}
            >
              {ZETTEL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <select
              value={draft.stance}
              onChange={(e) => setDraft({ ...draft, stance: e.target.value })}
              className="border px-1 py-0.5 text-[8px] outline-none"
              style={{ borderColor: colors.border, color: colors.text, background: "#0a0a0a" }}
            >
              <option value="">stance —</option>
              <option value="bull">bull</option>
              <option value="bear">bear</option>
              <option value="neutral">neutral</option>
            </select>
            <input
              type="date"
              value={draft.occurred_at}
              onChange={(e) => setDraft({ ...draft, occurred_at: e.target.value })}
              title="date of the fact (the filing, the article) — not today"
              className="border px-1 py-0.5 text-[8px] font-mono outline-none"
              style={{
                borderColor: colors.border,
                color: colors.textSecondary,
                background: "#0a0a0a",
              }}
            />
            <input
              value={draft.tags}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
              placeholder="tags, comma separated"
              className="flex-1 border px-1.5 py-0.5 text-[8px] font-mono outline-none"
              style={{ borderColor: colors.border, color: colors.text, background: "#0a0a0a" }}
            />
          </div>
          <textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder="reasoning, numbers, what would change your mind (markdown)"
            rows={3}
            className="w-full border px-1.5 py-1 text-[9px] font-mono outline-none"
            style={{ borderColor: colors.border, color: colors.text, background: "#0a0a0a" }}
          />
          <div className="flex gap-1">
            <input
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              placeholder="source url"
              className="flex-1 border px-1.5 py-0.5 text-[8px] font-mono outline-none"
              style={{ borderColor: colors.border, color: colors.text, background: "#0a0a0a" }}
            />
            <input
              value={draft.publisher}
              onChange={(e) => setDraft({ ...draft, publisher: e.target.value })}
              placeholder="publisher"
              className="w-28 border px-1.5 py-0.5 text-[8px] font-mono outline-none"
              style={{ borderColor: colors.border, color: colors.text, background: "#0a0a0a" }}
            />
          </div>
          <input
            value={draft.quote}
            onChange={(e) => setDraft({ ...draft, quote: e.target.value })}
            placeholder="the sentence you are relying on — quoted, so it can be checked later"
            className="w-full border px-1.5 py-0.5 text-[8px] font-mono outline-none"
            style={{ borderColor: colors.border, color: colors.text, background: "#0a0a0a" }}
          />
          <div className="flex gap-1">
            <button
              type="button"
              onClick={create}
              disabled={busy || !draft.title.trim()}
              className="text-[8px] px-2 py-0.5 border font-bold disabled:opacity-40"
              style={{ borderColor: colors.accent, color: colors.accent }}
            >
              SAVE
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setDraft({ ...emptyDraft });
              }}
              className="text-[8px] px-2 py-0.5 border"
              style={{ borderColor: colors.border, color: colors.textSecondary }}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}

      {pane === "conflicts" && (
        <div className="flex-1 overflow-y-auto">
          <ConflictPanel conflicts={conflicts} onResolve={resolve} onOpen={open} colors={colors} />
        </div>
      )}

      {pane === "graph" && (
        <div className="flex-1 overflow-auto">
          <ZettelGraph thesisId={thesisId} onOpen={open} colors={colors} />
        </div>
      )}

      {pane === "notes" && (
        <div className="flex-1 flex min-h-0">
          <div
            className="w-64 shrink-0 overflow-y-auto border-r"
            style={{ borderColor: colors.border }}
          >
            {visible.map((z) => (
              <button
                type="button"
                key={z.id}
                onClick={() => open(z.id)}
                className="w-full text-left px-2 py-1 border-b"
                style={{
                  borderColor: colors.border,
                  background: selected?.zettel.id === z.id ? "#ff990012" : "transparent",
                }}
              >
                <div className="flex items-center gap-1">
                  <span className="text-[7px] font-mono font-bold" style={{ color: colors.accent }}>
                    {z.ref}
                  </span>
                  <span
                    className="text-[7px] font-bold"
                    style={{ color: ZETTEL_KIND_COLOR[z.kind] }}
                  >
                    {z.kind}
                  </span>
                  {z.stance && (
                    <span
                      className="text-[7px] font-bold"
                      style={{ color: STANCE_COLOR[z.stance] }}
                    >
                      {z.stance.toUpperCase()}
                    </span>
                  )}
                  {!!z.open_conflicts && (
                    <span className="text-[7px] font-bold" style={{ color: "#f87171" }}>
                      ⟂{z.open_conflicts}
                    </span>
                  )}
                  {z.actor !== "user" && (
                    <span className="text-[7px] font-bold ml-auto" style={{ color: "#f472b6" }}>
                      AGENT
                    </span>
                  )}
                </div>
                <div className="text-[9px] leading-tight" style={{ color: colors.text }}>
                  {z.title}
                </div>
                <div className="flex items-center gap-2 text-[7px]" style={{ color: "#555" }}>
                  <span>{String(z.occurred_at ?? z.created_at).slice(0, 10)}</span>
                  {/* An EVIDENCE note with no source is a rumour with a date. */}
                  <span style={{ color: z.source_count ? "#555" : "#f87171" }}>
                    {z.source_count ?? 0} src
                  </span>
                  <span style={{ color: ZETTEL_STATUS_COLOR[z.status] }}>{z.status}</span>
                </div>
              </button>
            ))}
            {!visible.length && (
              <div className="p-2 text-[8px]" style={{ color: colors.textSecondary }}>
                {rows.length
                  ? "nothing matches that filter"
                  : "no notes yet — findings from you or the agent land here"}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3 min-w-0">
            {!selected ? (
              <div className="text-[9px]" style={{ color: colors.textSecondary }}>
                Pick a note. Each one is a single idea with its sources and the links that connect
                it to the rest — including what it contradicts.
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="text-[10px] font-mono font-bold"
                    style={{ color: colors.accent }}
                  >
                    {selected.zettel.ref}
                  </span>
                  <span
                    className="text-[8px] font-bold"
                    style={{ color: ZETTEL_KIND_COLOR[selected.zettel.kind] }}
                  >
                    {selected.zettel.kind}
                  </span>
                  <span
                    className="text-[8px] font-bold"
                    style={{ color: ZETTEL_STATUS_COLOR[selected.zettel.status] }}
                  >
                    {selected.zettel.status.toUpperCase()}
                  </span>
                  {selected.zettel.actor !== "user" && (
                    <span className="text-[7px] font-bold" style={{ color: "#f472b6" }}>
                      {selected.zettel.actor.replace(/^agent:/, "AGENT·").toUpperCase()}
                    </span>
                  )}
                  <span className="text-[7px] font-mono" style={{ color: "#555" }}>
                    fact dated {String(selected.zettel.occurred_at ?? "").slice(0, 10) || "—"}
                  </span>
                </div>
                <div className="text-[11px] font-bold mt-1" style={{ color: colors.text }}>
                  {selected.zettel.title}
                </div>
                {selected.zettel.body && (
                  <div className="mt-2">{renderMarkdown(selected.zettel.body, colors)}</div>
                )}

                {selected.refs.length > 1 && (
                  <div className="mt-2 text-[8px]" style={{ color: colors.textSecondary }}>
                    also used by:{" "}
                    {selected.refs
                      .filter((r) => r.target_type === "thesis" && r.target_id !== thesisId)
                      .map((r) => r.symbol ?? r.target_id)
                      .join(" · ") || "—"}
                  </div>
                )}

                <div
                  className="mt-3 text-[8px] tracking-widest"
                  style={{ color: colors.textSecondary }}
                >
                  SOURCES
                </div>
                {selected.sources.length ? (
                  selected.sources.map((s) => (
                    <div key={s.id} className="mt-1">
                      <div className="flex items-center gap-1 text-[8px]">
                        <span style={{ color: colors.text }}>
                          {s.publisher || s.title || "source"}
                        </span>
                        <span style={{ color: "#555" }}>
                          {String(s.published_at ?? "").slice(0, 10)}
                        </span>
                        <span style={{ color: s.reliability === "primary" ? "#4ade80" : "#666" }}>
                          {s.reliability}
                        </span>
                        {s.url && (
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate"
                            style={{ color: colors.accent }}
                          >
                            {s.url}
                          </a>
                        )}
                      </div>
                      {s.quote && (
                        <div
                          className="text-[8px] pl-2 border-l"
                          style={{ borderColor: "#333", color: colors.textSecondary }}
                        >
                          {s.quote}
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="text-[8px]" style={{ color: "#f87171" }}>
                    no source — this is an opinion until one is added
                  </div>
                )}

                <div className="mt-3 flex items-center gap-1">
                  <span
                    className="text-[8px] tracking-widest"
                    style={{ color: colors.textSecondary }}
                  >
                    LINKS
                  </span>
                  <button
                    type="button"
                    onClick={() => setLinking(linking ? null : { rel: "CONTRADICTS", target: "" })}
                    className="text-[7px]"
                    style={{ color: colors.accent }}
                  >
                    + link
                  </button>
                </div>
                {linking && (
                  <div className="flex gap-1 mt-1">
                    <select
                      value={linking.rel}
                      onChange={(e) => setLinking({ ...linking, rel: e.target.value as ZettelRel })}
                      className="border px-1 py-0.5 text-[8px] outline-none"
                      style={{
                        borderColor: colors.border,
                        color: colors.text,
                        background: "#0a0a0a",
                      }}
                    >
                      {ZETTEL_RELS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <input
                      value={linking.target}
                      onChange={(e) => setLinking({ ...linking, target: e.target.value })}
                      placeholder="target Z-ref, e.g. Z-0007"
                      className="flex-1 border px-1.5 py-0.5 text-[8px] font-mono outline-none"
                      style={{
                        borderColor: colors.border,
                        color: colors.text,
                        background: "#0a0a0a",
                      }}
                    />
                    <button
                      type="button"
                      onClick={link}
                      className="text-[8px] px-2 border font-bold"
                      style={{ borderColor: colors.accent, color: colors.accent }}
                    >
                      LINK
                    </button>
                  </div>
                )}
                {[...selected.edges.out, ...selected.edges.in].map((e) => {
                  const outgoing = e.src_id === selected.zettel.id;
                  return (
                    <button
                      type="button"
                      key={e.id}
                      onClick={() => open(outgoing ? e.dst_id : e.src_id)}
                      className="flex items-center gap-1 text-[8px] mt-0.5 w-full text-left"
                    >
                      <span style={{ color: "#555" }}>{outgoing ? "→" : "←"}</span>
                      <span className="font-bold" style={{ color: ZETTEL_REL_COLOR[e.rel] }}>
                        {e.rel}
                      </span>
                      <span className="font-mono" style={{ color: colors.accent }}>
                        {e.other_ref}
                      </span>
                      <span className="truncate" style={{ color: colors.text }}>
                        {e.other_title}
                      </span>
                      {e.rel === "CONTRADICTS" && (
                        <span
                          className="text-[7px] font-bold shrink-0"
                          style={{ color: e.resolved_at ? "#4ade80" : "#f87171" }}
                        >
                          {e.resolved_at ? "RESOLVED" : "OPEN"}
                        </span>
                      )}
                    </button>
                  );
                })}
                {!selected.edges.out.length && !selected.edges.in.length && (
                  <div className="text-[8px]" style={{ color: "#555" }}>
                    unlinked — a note nothing connects to is hard to find again
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
