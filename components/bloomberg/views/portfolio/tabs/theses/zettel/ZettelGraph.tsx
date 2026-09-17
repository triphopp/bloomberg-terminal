"use client";
import { useEffect, useMemo, useState } from "react";
import type { Colors } from "../../../helpers";
import { ZETTEL_KIND_COLOR, ZETTEL_REL_COLOR, type Zettel, type ZettelEdge } from "../types";

const API = "/api/v2/zettel";

type Node = Pick<Zettel, "id" | "ref" | "kind" | "title" | "stance" | "status" | "actor">;

/** The argument, drawn.
 *
 *  Deliberately a deterministic radial layout rather than a force simulation:
 *  the same set of notes has to land in the same place every time it is opened,
 *  or comparing "before and after today's research" becomes guesswork. Obsidian
 *  has the exploratory view; this one is for orientation. */
export function ZettelGraph({
  thesisId,
  onOpen,
  colors,
}: {
  thesisId: string;
  onOpen: (id: string) => void;
  colors: Colors;
}) {
  const [data, setData] = useState<{ nodes: Node[]; edges: ZettelEdge[] }>({
    nodes: [],
    edges: [],
  });
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`${API}/graph?thesis_id=${encodeURIComponent(thesisId)}&depth=2`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setData({ nodes: d.nodes ?? [], edges: d.edges ?? [] });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [thesisId]);

  const layout = useMemo(() => {
    const n = data.nodes.length;
    const size = 520;
    const r = Math.max(120, Math.min(210, 40 + n * 12));
    const pos = new Map<string, { x: number; y: number }>();
    // Most-connected note in the middle; the rest on a ring, ordered so that
    // linked notes sit near each other.
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.src_id, (degree.get(e.src_id) ?? 0) + 1);
      degree.set(e.dst_id, (degree.get(e.dst_id) ?? 0) + 1);
    }
    const sorted = [...data.nodes].sort(
      (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.ref.localeCompare(b.ref)
    );
    const [hub, ...rest] = sorted;
    if (hub) pos.set(hub.id, { x: size / 2, y: size / 2 });
    rest.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, rest.length) - Math.PI / 2;
      pos.set(node.id, {
        x: size / 2 + r * Math.cos(angle),
        y: size / 2 + r * Math.sin(angle),
      });
    });
    return { pos, size };
  }, [data]);

  if (!data.nodes.length) {
    return (
      <div className="p-3 text-[9px]" style={{ color: colors.textSecondary }}>
        Nothing to draw yet — the graph appears once notes are linked to each other.
      </div>
    );
  }

  return (
    <div className="p-2">
      <svg
        viewBox={`0 0 ${layout.size} ${layout.size}`}
        className="w-full max-w-[520px]"
        role="img"
        aria-label="knowledge base graph"
      >
        <title>Notes and the links between them</title>
        {data.edges.map((e) => {
          const a = layout.pos.get(e.src_id);
          const b = layout.pos.get(e.dst_id);
          if (!a || !b) return null;
          const open = e.rel === "CONTRADICTS" && !e.resolved_at;
          return (
            <line
              key={e.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={ZETTEL_REL_COLOR[e.rel]}
              strokeWidth={open ? 1.6 : 0.8}
              strokeOpacity={hover && ![e.src_id, e.dst_id].includes(hover) ? 0.15 : 0.75}
              strokeDasharray={e.rel === "CONTRADICTS" && e.resolved_at ? "3 2" : undefined}
            />
          );
        })}
        {data.nodes.map((node) => {
          const p = layout.pos.get(node.id);
          if (!p) return null;
          const dim = hover && hover !== node.id;
          return (
            // An SVG <g> has no semantic interactive element to swap in; the
            // notes list beside the graph is the keyboard path to the same note,
            // so this stays a focusable group rather than a faked button.
            <g
              key={node.id}
              tabIndex={0}
              aria-label={`${node.ref} ${node.title}`}
              onMouseEnter={() => setHover(node.id)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(node.id)}
              onBlur={() => setHover(null)}
              onClick={() => onOpen(node.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(node.id);
                }
              }}
              style={{ cursor: "pointer" }}
              opacity={dim ? 0.4 : 1}
            >
              <circle
                cx={p.x}
                cy={p.y}
                r={node.status === "superseded" ? 4 : 6}
                fill={node.status === "superseded" ? "#222" : ZETTEL_KIND_COLOR[node.kind]}
                stroke={node.actor === "user" ? "#333" : "#f472b6"}
                strokeWidth={1}
              />
              <text
                x={p.x + 9}
                y={p.y + 3}
                fontSize={7}
                fontFamily="monospace"
                fill={colors.textSecondary}
              >
                {node.ref}
              </text>
              {hover === node.id && (
                <text x={p.x + 9} y={p.y + 13} fontSize={8} fill={colors.text}>
                  {node.title.slice(0, 46)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex gap-2 flex-wrap mt-1">
        {Object.entries(ZETTEL_REL_COLOR).map(([rel, color]) => (
          <span key={rel} className="text-[7px] font-bold" style={{ color }}>
            {rel}
          </span>
        ))}
        <span className="text-[7px]" style={{ color: "#f472b6" }}>
          pink ring = written by an agent
        </span>
      </div>
    </div>
  );
}
