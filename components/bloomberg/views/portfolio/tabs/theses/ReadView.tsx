"use client";
import { ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Colors } from "../../helpers";
import { headingsOf, renderMarkdown } from "./markdown";
import {
  NOTE_IMPACT_COLOR,
  NOTE_KIND_COLOR,
  NOTE_STATUS_COLOR,
  STATUS_COLOR,
  type Thesis,
  type ThesisEvent,
  type ThesisNote,
  ZETTEL_KIND_COLOR,
  type Zettel,
} from "./types";

type GraphRow = {
  slug: string;
  title: string;
  description: string;
  as_of: string | null;
  version: number;
  render_url: string;
};

type Section = { id: string; title: string; level: number };

/** The whole thesis as one document.
 *
 *  The tabbed view answers "what is in the knowledge base"; this answers "what
 *  does this thesis actually say", which is a different question and the one a
 *  human asks before a trade. Everything the tabs hold — body, notes, zettel,
 *  rendered analysis pages, history — is laid out in reading order, at reading
 *  size (~13.5px, 72ch, line-height 1.75) rather than terminal density, with a
 *  contents rail that follows the scroll.
 *
 *  It reads; it does not edit. Anything that changes state stays in the tabs,
 *  so there is no second write path to keep in step. */
export function ReadView({
  thesis,
  notes,
  events,
  colors,
}: {
  thesis: Thesis;
  notes: ThesisNote[];
  events: ThesisEvent[];
  colors: Colors;
}) {
  const [zettel, setZettel] = useState<Zettel[]>([]);
  const [graphs, setGraphs] = useState<GraphRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    Promise.all([
      fetch(`/api/v2/zettel?thesis_id=${encodeURIComponent(thesis.id)}&limit=200`, {
        signal: ac.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setZettel(Array.isArray(d?.zettel) ? d.zettel : []))
        .catch(() => {}),
      fetch(`/api/v2/graphs?thesis_id=${encodeURIComponent(thesis.id)}&limit=100`, {
        signal: ac.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setGraphs(Array.isArray(d?.graphs) ? d.graphs : []))
        .catch(() => {}),
    ]).finally(() => setLoading(false));
    return () => ac.abort();
  }, [thesis.id]);

  // Open notes first — a resolved scenario is history, not a thing to weigh.
  const sortedNotes = useMemo(() => {
    const rank: Record<string, number> = { open: 0, watching: 1, confirmed: 2, dismissed: 3 };
    return [...notes].sort(
      (a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.pinned - a.pinned
    );
  }, [notes]);

  const bodyHeadings = useMemo(() => headingsOf(thesis.body ?? ""), [thesis.body]);

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [{ id: "sec-thesis", title: "THESIS", level: 1 }];
    for (const h of bodyHeadings) out.push({ id: h.id, title: h.title, level: 2 });
    if (sortedNotes.length)
      out.push({ id: "sec-notes", title: `NOTES (${sortedNotes.length})`, level: 1 });
    if (zettel.length)
      out.push({ id: "sec-kb", title: `KNOWLEDGE BASE (${zettel.length})`, level: 1 });
    if (graphs.length)
      out.push({ id: "sec-graphs", title: `ANALYSIS PAGES (${graphs.length})`, level: 1 });
    if (events.length)
      out.push({ id: "sec-history", title: `HISTORY (${events.length})`, level: 1 });
    return out;
  }, [bodyHeadings, sortedNotes.length, zettel.length, graphs.length, events.length]);

  // Scroll-spy on the scroll container, not the window: the document scrolls
  // inside a fixed-height panel, so IntersectionObserver needs it as root.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || sections.length === 0) return;
    // The entries only say "something moved"; which heading is current is then
    // decided by position, so a long section with nothing intersecting still
    // keeps its own entry lit.
    const obs = new IntersectionObserver(
      () => {
        let best: string | null = null;
        let bestTop = Number.POSITIVE_INFINITY;
        for (const s of sections) {
          const el = root.querySelector(`#${CSS.escape(s.id)}`);
          if (!el) continue;
          const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top;
          if (top <= 80 && Math.abs(top) < bestTop) {
            bestTop = Math.abs(top);
            best = s.id;
          }
        }
        setActive(best ?? sections[0].id);
      },
      { root, threshold: [0, 0.25, 1], rootMargin: "-60px 0px -70% 0px" }
    );
    for (const s of sections) {
      const el = root.querySelector(`#${CSS.escape(s.id)}`);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, [sections]);

  const jump = useCallback((id: string) => {
    const root = scrollRef.current;
    const el = root?.querySelector(`#${CSS.escape(id)}`);
    if (!root || !el) return;
    const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    root.scrollTo({ top: top - 12, behavior: "smooth" });
    setActive(id);
  }, []);

  const h2 = (id: string, title: string) => (
    <h2
      id={id}
      className="text-[15px] font-bold tracking-widest mt-8 mb-3 pb-1 scroll-mt-4"
      style={{ color: colors.accent, borderBottom: `1px solid ${colors.border}` }}
    >
      {title}
    </h2>
  );

  return (
    <div className="flex-1 flex min-h-0">
      {/* contents */}
      <nav
        className="hidden md:block w-48 shrink-0 border-r overflow-y-auto py-3 px-2"
        style={{ borderColor: colors.border }}
      >
        <div className="text-[8px] tracking-widest mb-2" style={{ color: colors.textSecondary }}>
          CONTENTS
        </div>
        {sections.map((s) => (
          <button
            type="button"
            key={s.id}
            onClick={() => jump(s.id)}
            className="block w-full text-left text-[10px] py-0.5 leading-snug hover:opacity-80"
            style={{
              color: active === s.id ? colors.accent : colors.textSecondary,
              paddingLeft: s.level === 1 ? 0 : 10,
              fontWeight: s.level === 1 ? 700 : 400,
              borderLeft: active === s.id ? `2px solid ${colors.accent}` : "2px solid transparent",
            }}
          >
            {s.title}
          </button>
        ))}
      </nav>

      {/* document */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <article className="mx-auto px-6 py-6" style={{ maxWidth: "76ch" }}>
          <div className="flex items-baseline gap-2 flex-wrap">
            <h1 className="text-[26px] font-bold" style={{ color: colors.accent }}>
              {thesis.symbol}
            </h1>
            <span
              className="text-[9px] px-1 font-bold"
              style={{
                color: STATUS_COLOR[thesis.status],
                border: `1px solid ${STATUS_COLOR[thesis.status]}`,
              }}
            >
              {thesis.status.toUpperCase()}
            </span>
          </div>
          <div className="text-[15px] mt-1 mb-2" style={{ color: colors.text }}>
            {thesis.title}
          </div>
          <div
            className="text-[11px] flex flex-wrap gap-x-4 gap-y-1 pb-4 mb-2 border-b"
            style={{ color: colors.textSecondary, borderColor: colors.border }}
          >
            <span>conviction {thesis.conviction == null ? "—" : `${thesis.conviction}/5`}</span>
            <span>horizon {thesis.time_horizon || "—"}</span>
            <span>target {thesis.target_price ?? "—"}</span>
            <span>stop {thesis.stop_price ?? "—"}</span>
            <span>{thesis.category || "—"}</span>
            <span>updated {(thesis.updated_at ?? "").slice(0, 10)}</span>
          </div>

          <div id="sec-thesis" className="scroll-mt-4" />
          {renderMarkdown(thesis.body ?? "_(ยังไม่มีเนื้อหา)_", colors, "read")}

          {sortedNotes.length > 0 && (
            <>
              {h2("sec-notes", `NOTES (${sortedNotes.length})`)}
              {sortedNotes.map((n) => (
                <section key={n.id} className="mb-5">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span
                      className="text-[9px] font-bold px-1"
                      style={{
                        color: NOTE_KIND_COLOR[n.kind],
                        border: `1px solid ${NOTE_KIND_COLOR[n.kind]}55`,
                      }}
                    >
                      {n.kind}
                    </span>
                    <span className="text-[14px] font-bold" style={{ color: colors.text }}>
                      {n.title}
                    </span>
                    <span className="text-[10px]" style={{ color: NOTE_STATUS_COLOR[n.status] }}>
                      {n.status}
                    </span>
                    {n.impact && (
                      <span className="text-[10px]" style={{ color: NOTE_IMPACT_COLOR[n.impact] }}>
                        {n.impact}
                      </span>
                    )}
                    {n.watch_date && (
                      <span className="text-[10px]" style={{ color: colors.textSecondary }}>
                        watch {n.watch_date}
                      </span>
                    )}
                  </div>
                  {renderMarkdown(n.body ?? "", colors, "read")}
                </section>
              ))}
            </>
          )}

          {loading && (
            <div
              className="flex items-center gap-2 mt-6 text-[11px]"
              style={{ color: colors.textSecondary }}
            >
              <Loader2 className="h-3 w-3 animate-spin" /> กำลังโหลดคลังความรู้และหน้าวิเคราะห์…
            </div>
          )}

          {zettel.length > 0 && (
            <>
              {h2("sec-kb", `KNOWLEDGE BASE (${zettel.length})`)}
              {zettel.map((z) => (
                <section key={z.id} className="mb-5">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
                      {z.ref}
                    </span>
                    <span
                      className="text-[9px] font-bold px-1"
                      style={{
                        color: ZETTEL_KIND_COLOR[z.kind],
                        border: `1px solid ${ZETTEL_KIND_COLOR[z.kind]}55`,
                      }}
                    >
                      {z.kind}
                    </span>
                    <span className="text-[14px] font-bold" style={{ color: colors.text }}>
                      {z.title}
                    </span>
                    {!!z.open_conflicts && (
                      <span className="text-[10px]" style={{ color: "#f87171" }}>
                        ⟂{z.open_conflicts} ขัดแย้ง
                      </span>
                    )}
                    {z.occurred_at && (
                      <span className="text-[10px]" style={{ color: colors.textSecondary }}>
                        {z.occurred_at.slice(0, 10)}
                      </span>
                    )}
                  </div>
                  {renderMarkdown(z.body ?? "", colors, "read")}
                  {!!z.source_count && (
                    <div className="text-[10px] mt-1" style={{ color: colors.textSecondary }}>
                      {z.source_count} แหล่งอ้างอิง · {z.actor}
                    </div>
                  )}
                </section>
              ))}
            </>
          )}

          {graphs.length > 0 && (
            <>
              {h2("sec-graphs", `ANALYSIS PAGES (${graphs.length})`)}
              {graphs.map((g) => (
                <section key={g.slug} className="mb-6">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-[14px] font-bold" style={{ color: colors.text }}>
                      {g.title}
                    </span>
                    <span className="text-[10px]" style={{ color: colors.textSecondary }}>
                      v{g.version} · as of {g.as_of ?? "—"}
                    </span>
                    <a
                      href={g.render_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[10px] font-bold"
                      style={{ color: colors.accent }}
                    >
                      <ExternalLink className="w-3 h-3" /> เปิดเต็มหน้า
                    </a>
                  </div>
                  {g.description && (
                    <p className="text-[12px] mt-1" style={{ color: colors.textSecondary }}>
                      {g.description}
                    </p>
                  )}
                  {/* Same sandbox rule as GraphsPanel: no allow-same-origin. */}
                  <iframe
                    src={g.render_url}
                    title={g.title}
                    sandbox="allow-scripts"
                    className="w-full mt-2 border"
                    style={{ height: 460, borderColor: colors.border, background: colors.bg }}
                  />
                </section>
              ))}
            </>
          )}

          {events.length > 0 && (
            <>
              {h2("sec-history", `HISTORY (${events.length})`)}
              <ul className="text-[12px] space-y-1" style={{ color: colors.textSecondary }}>
                {events.map((e) => (
                  <li key={e.id} className="flex gap-2">
                    <span className="font-mono shrink-0" style={{ color: colors.textSecondary }}>
                      {(e.occurred_at ?? e.created_at ?? "").slice(0, 10)}
                    </span>
                    <span className="font-bold shrink-0" style={{ color: colors.accent }}>
                      {e.event_type}
                    </span>
                    <span>{e.note}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="h-16" />
        </article>
      </div>
    </div>
  );
}
