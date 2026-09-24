"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { bloombergColors } from "../lib/theme-config";

// ── Types ─────────────────────────────────────────────────────────────────────

type Quadrant = "Leading" | "Improving" | "Weakening" | "Lagging";

interface RrgPoint {
  date: string;
  ratio: number;
  mom: number;
}

interface RrgRow {
  id: string;
  name: string;
  symbol: string;
  quadrant: Quadrant;
  points: RrgPoint[];
}

export interface RotationMapData {
  rows: RrgRow[];
  expected?: number;
  bench: string;
  market: string;
  tail: number;
  as_of: string | null;
  method?: string;
  error?: string;
}

// Same quadrant colours as the table so the two views read as one.
export const QUAD_COLOR: Record<Quadrant, string> = {
  Leading: "#4ade80",
  Improving: "#60a5fa",
  Weakening: "#facc15",
  Lagging: "#f87171",
};

// One colour per sector — the quadrant is already the background, so the line
// colour's only job is telling two neighbouring trails apart.
const SERIES = [
  "#38bdf8",
  "#f472b6",
  "#a3e635",
  "#fb923c",
  "#c084fc",
  "#2dd4bf",
  "#facc15",
  "#f87171",
  "#818cf8",
  "#4ade80",
  "#e879f9",
  "#fbbf24",
  "#94a3b8",
];

/** "Technology (XLK)" → "XLK"; TH basket names are kept, trimmed. */
const shortName = (r: RrgRow, market: string) =>
  market === "US" ? r.symbol : r.name.replace(/\s*\(.*\)$/, "").slice(0, 12);

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function useRotationMap(market: string, tail: number, enabled: boolean) {
  return useQuery<RotationMapData>({
    queryKey: ["rotation-map", market, tail],
    queryFn: async () => {
      const res = await fetch(`/api/rotation/map?market=${market}&tail=${tail}`);
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    enabled,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}

// ── Plot ──────────────────────────────────────────────────────────────────────

interface RotationMapProps {
  data: RotationMapData;
  colors: typeof bloombergColors.dark;
  compact: boolean;
}

/** Relative Rotation Graph: RS-Ratio (trend vs benchmark) across, RS-Momentum
 *  (rate of change of that trend) up. Sectors rotate clockwise through
 *  Improving → Leading → Weakening → Lagging; the tail shows where each came
 *  from over the last N weeks, the dot is this week. */
export function RotationMap({ data, colors, compact }: RotationMapProps) {
  const [boxRef, { w, h }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const rows = data.rows;
  const colorOf = useMemo(
    () => Object.fromEntries(rows.map((r, i) => [r.id, SERIES[i % SERIES.length]])),
    [rows]
  );
  const visible = rows.filter((r) => !hidden.has(r.id));

  // Symmetric around 100 on each axis so the crosshair is always the centre and
  // quadrant areas stay equal; each axis gets its own span because RS-Ratio
  // usually swings several times wider than RS-Mom.
  const span = (vals: number[]) => Math.max(1, ...vals.map((v) => Math.abs(v - 100))) * 1.12;
  const all = (visible.length ? visible : rows).flatMap((r) => r.points);
  const sx = span(all.map((p) => p.ratio));
  const sy = span(all.map((p) => p.mom));

  const pad = compact ? { l: 26, r: 6, t: 6, b: 16 } : { l: 38, r: 10, t: 10, b: 22 };
  const pw = Math.max(0, w - pad.l - pad.r);
  const ph = Math.max(0, h - pad.t - pad.b);
  const X = (v: number) => pad.l + ((v - (100 - sx)) / (2 * sx)) * pw;
  const Y = (v: number) => pad.t + (1 - (v - (100 - sy)) / (2 * sy)) * ph;
  const cx = X(100);
  const cy = Y(100);
  const fs = compact ? 7 : 9;

  const ticks = (s: number) => {
    const step = s > 6 ? 4 : s > 3 ? 2 : s > 1.5 ? 1 : 0.5;
    const out: number[] = [];
    for (let v = 100 - Math.floor(s / step) * step; v <= 100 + s; v += step) out.push(v);
    return out;
  };

  const focus = hover ? rows.find((r) => r.id === hover) : null;
  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next.size >= rows.length ? prev : next;
    });

  return (
    <div className={`flex h-full min-h-0 ${compact ? "flex-col" : "flex-row"}`}>
      <div ref={boxRef} className="relative flex-1 min-h-[120px] min-w-0">
        {w > 0 && h > 0 && (
          <svg
            width={w}
            height={h}
            role="img"
            aria-label={`Relative rotation graph of ${rows.length} sectors vs ${data.bench}`}
            onMouseLeave={() => setHover(null)}
          >
            {/* Quadrants */}
            {(
              [
                ["Improving", pad.l, pad.t, cx - pad.l, cy - pad.t],
                ["Leading", cx, pad.t, pad.l + pw - cx, cy - pad.t],
                ["Lagging", pad.l, cy, cx - pad.l, pad.t + ph - cy],
                ["Weakening", cx, cy, pad.l + pw - cx, pad.t + ph - cy],
              ] as const
            ).map(([q, x, y, qw, qh]) => (
              <g key={q}>
                <rect x={x} y={y} width={qw} height={qh} fill={QUAD_COLOR[q]} opacity={0.055} />
                <text
                  x={q === "Improving" || q === "Lagging" ? x + 4 : x + qw - 4}
                  y={q === "Improving" || q === "Leading" ? y + fs + 2 : y + qh - 4}
                  textAnchor={q === "Improving" || q === "Lagging" ? "start" : "end"}
                  fontSize={fs}
                  fontFamily="monospace"
                  fontWeight={700}
                  fill={QUAD_COLOR[q]}
                  opacity={0.55}
                >
                  {q.toUpperCase()}
                </text>
              </g>
            ))}

            {/* Grid + axes */}
            {ticks(sx).map((v) => (
              <g key={`x${v}`}>
                <line x1={X(v)} x2={X(v)} y1={pad.t} y2={pad.t + ph} stroke="#1a1a1a" />
                <text
                  x={X(v)}
                  y={pad.t + ph + fs + 3}
                  textAnchor="middle"
                  fontSize={fs - 1}
                  fontFamily="monospace"
                  fill={colors.textSecondary}
                >
                  {Number(v.toFixed(1))}
                </text>
              </g>
            ))}
            {ticks(sy).map((v) => (
              <g key={`y${v}`}>
                <line x1={pad.l} x2={pad.l + pw} y1={Y(v)} y2={Y(v)} stroke="#1a1a1a" />
                <text
                  x={pad.l - 3}
                  y={Y(v) + 3}
                  textAnchor="end"
                  fontSize={fs - 1}
                  fontFamily="monospace"
                  fill={colors.textSecondary}
                >
                  {Number(v.toFixed(1))}
                </text>
              </g>
            ))}
            <line x1={cx} x2={cx} y1={pad.t} y2={pad.t + ph} stroke="#555" strokeDasharray="3 3" />
            <line x1={pad.l} x2={pad.l + pw} y1={cy} y2={cy} stroke="#555" strokeDasharray="3 3" />
            {!compact && (
              <>
                <text
                  x={pad.l + pw}
                  y={cy - 4}
                  textAnchor="end"
                  fontSize={fs - 1}
                  fontFamily="monospace"
                  fill="#777"
                >
                  RS-RATIO →
                </text>
                <text
                  x={cx + 4}
                  y={pad.t + fs + 12}
                  fontSize={fs - 1}
                  fontFamily="monospace"
                  fill="#777"
                >
                  ↑ RS-MOM
                </text>
              </>
            )}

            {/* Trails — faded tail, solid head */}
            {visible.map((r) => {
              const c = colorOf[r.id];
              const dim = hover != null && hover !== r.id;
              const pts = r.points;
              const head = pts[pts.length - 1];
              return (
                <g
                  key={r.id}
                  opacity={dim ? 0.12 : 1}
                  onMouseEnter={() => setHover(r.id)}
                  style={{ cursor: "pointer" }}
                >
                  {pts.slice(1).map((p, i) => {
                    const prev = pts[i];
                    return (
                      <line
                        key={p.date}
                        x1={X(prev.ratio)}
                        y1={Y(prev.mom)}
                        x2={X(p.ratio)}
                        y2={Y(p.mom)}
                        stroke={c}
                        strokeWidth={hover === r.id ? 2 : 1.3}
                        opacity={0.25 + (0.75 * (i + 1)) / Math.max(1, pts.length - 1)}
                      />
                    );
                  })}
                  {pts.slice(0, -1).map((p, i) => (
                    <circle
                      key={p.date}
                      cx={X(p.ratio)}
                      cy={Y(p.mom)}
                      r={compact ? 1.2 : 1.8}
                      fill={c}
                      opacity={0.3 + (0.5 * i) / Math.max(1, pts.length - 1)}
                    />
                  ))}
                  <circle
                    cx={X(head.ratio)}
                    cy={Y(head.mom)}
                    r={compact ? 3 : 4.5}
                    fill={c}
                    stroke="#000"
                    strokeWidth={1}
                  />
                  <text
                    x={X(head.ratio) + (compact ? 4 : 6)}
                    y={Y(head.mom) - (compact ? 3 : 4)}
                    fontSize={fs}
                    fontFamily="monospace"
                    fontWeight={700}
                    fill={c}
                    stroke="#000"
                    strokeWidth={2.5}
                    paintOrder="stroke"
                  >
                    {shortName(r, data.market)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}

        {focus && (
          <div
            className="absolute top-1 right-1 px-2 py-1 font-mono pointer-events-none"
            style={{
              fontSize: compact ? 8 : 10,
              background: "#0d0d0d",
              border: `1px solid ${colorOf[focus.id]}`,
              color: colors.text,
            }}
          >
            <div className="font-bold" style={{ color: colorOf[focus.id] }}>
              {focus.name}
            </div>
            <div style={{ color: QUAD_COLOR[focus.quadrant] }}>{focus.quadrant}</div>
            <div>
              RS-Ratio {focus.points.at(-1)?.ratio.toFixed(2)} · RS-Mom{" "}
              {focus.points.at(-1)?.mom.toFixed(2)}
            </div>
            <div style={{ color: colors.textSecondary }}>
              {focus.points[0]?.date} → {focus.points.at(-1)?.date} · {focus.points.length}w
            </div>
          </div>
        )}
      </div>

      {!compact && (
        <div
          className="shrink-0 w-44 overflow-y-auto border-l px-2 py-1"
          style={{ borderColor: colors.border }}
        >
          {(["Leading", "Improving", "Weakening", "Lagging"] as const).map((q) => {
            const inQ = rows.filter((r) => r.quadrant === q);
            if (!inQ.length) return null;
            return (
              <div key={q} className="mb-1.5">
                <div className="text-[8px] font-bold font-mono" style={{ color: QUAD_COLOR[q] }}>
                  {q.toUpperCase()} · {inQ.length}
                </div>
                {inQ.map((r) => {
                  const off = hidden.has(r.id);
                  return (
                    <button
                      type="button"
                      key={r.id}
                      onClick={() => toggle(r.id)}
                      onMouseEnter={() => !off && setHover(r.id)}
                      onMouseLeave={() => setHover(null)}
                      className="flex items-center gap-1.5 w-full text-left text-[9px] font-mono leading-4"
                      style={{ color: off ? "#444" : colors.text }}
                      title="Click to hide / show"
                    >
                      <span
                        data-frame
                        className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ background: off ? "#333" : colorOf[r.id] }}
                      />
                      <span className="truncate">{r.name}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Loading / error wrapper ───────────────────────────────────────────────────

export function RotationMapPanel({
  market,
  tail,
  colors,
  compact,
}: {
  market: string;
  tail: number;
  colors: typeof bloombergColors.dark;
  compact: boolean;
}) {
  const { data, isLoading, isError, refetch } = useRotationMap(market, tail, true);
  if (isLoading)
    return (
      <div className="flex items-center justify-center h-full gap-1">
        <Loader2 className="h-3 w-3 animate-spin" style={{ color: colors.textSecondary }} />
        <span className="text-[7px] font-mono" style={{ color: colors.textSecondary }}>
          loading rotation map…
        </span>
      </div>
    );
  if (isError || !data || data.error || !data.rows.length)
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-[7px] font-mono" style={{ color: "#FF4444" }}>
          {data?.error ?? "NO DATA"}{" "}
          <button type="button" className="underline hover:opacity-70" onClick={() => refetch()}>
            RETRY
          </button>
        </span>
      </div>
    );
  return <RotationMap data={data} colors={colors} compact={compact} />;
}
