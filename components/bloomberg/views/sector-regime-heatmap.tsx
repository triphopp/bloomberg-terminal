"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, Maximize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { bloombergColors } from "../lib/theme-config";
import { RotationTable } from "./rotation-table";

// ── Constants ─────────────────────────────────────────────────────────────────

const LS_DEFAULTS = "bloomberg_regime_defaults";
const PERIODS = ["1m", "3m", "6m", "1y"] as const;
const MODES = [
  { key: "corr", label: "CORR", desc: "Pearson Correlation Matrix" },
  { key: "geom", label: "GEOM", desc: "Geometric: Wedge Product / Gram Determinant" },
  { key: "rot", label: "ROT", desc: "Theme/Sector rotation table vs SPY (RRG quadrants)" },
] as const;

type Period = (typeof PERIODS)[number];
type Mode = "corr" | "geom" | "rot";
type GeomView = "matrix" | "space";

// One distinct vivid colour per sector (dark-background safe)
const SECTOR_COLORS = [
  "#00B4D8", // TECH  — sky blue
  "#F4A261", // FIN   — orange
  "#57CC99", // HLTH  — mint
  "#FF6B6B", // ENRG  — coral
  "#C77DFF", // INDU  — violet
  "#FFD166", // COND  — yellow
  "#4CC9F0", // CONS  — light blue
  "#FF84B7", // REIT  — pink
  "#A8DADC", // UTIL  — teal
  "#CDB4DB", // MATR  — lavender
  "#80FFDB", // COMM  — aquamarine
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface PeriodScore {
  score: number;
  label: string;
  color: string;
}

interface RegimeTrend {
  mode: string;
  periods: Record<string, PeriodScore>;
  trend: "CONTRACTING" | "EXPANDING" | "STABLE";
  trend_color: string;
  risk_delta: number;
}

interface RegimeData {
  sectors: string[];
  abbrs: string[];
  symbols: string[];
  matrix: number[][];
  positions_2d?: [number, number][];
  variance_explained?: [number, number];
  regime_score: number;
  regime_label: string;
  regime_color: string;
  description: string;
  mode: string;
  period: string;
  n: number;
  // calibration fields (optional — present when backend is updated)
  k_signal?: number;
  lambda_max?: number;
  calibration_method?: string;
  error?: string;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadDefaults(): { mode: Mode; period: Period; geomView: GeomView } {
  try {
    const s = localStorage.getItem(LS_DEFAULTS);
    if (s) {
      const p = JSON.parse(s);
      if (MODES.some((m) => m.key === p.mode) && PERIODS.includes(p.period))
        return {
          mode: p.mode,
          period: p.period,
          geomView: p.geomView === "space" ? "space" : "matrix",
        };
    }
  } catch {
    /* ignore */
  }
  return { mode: "corr", period: "3m", geomView: "matrix" };
}

function saveDefaults(mode: Mode, period: Period, geomView: GeomView) {
  try {
    localStorage.setItem(LS_DEFAULTS, JSON.stringify({ mode, period, geomView }));
  } catch {
    /* ignore */
  }
}

// ── Color scales — Bloomberg Terminal theme ───────────────────────────────────
// CORR: -1 = Bloomberg teal #00A0C8, 0 = near-black, +1 = Bloomberg orange #FF9800
// GEOM:  0 = near-black (co-moving),  1 = Bloomberg amber #FFB300 (orthogonal)

function corrColor(v: number): string {
  if (v >= 0) {
    // near-black → Bloomberg orange #FF9800 (255, 152, 0)
    const t = v;
    return `rgb(${Math.round(12 + t * 243)},${Math.round(8 + t * 144)},${Math.round(5 * (1 - t))})`;
  }
  // near-black → Bloomberg teal #00A0C8 (0, 160, 200)
  const t = -v;
  return `rgb(${Math.round(12 * (1 - t))},${Math.round(8 + t * 152)},${Math.round(5 + t * 195)})`;
}

function geomColor(v: number): string {
  // near-black → Bloomberg amber #FFB300 (255, 179, 0)
  const t = Math.max(0, Math.min(1, v));
  return `rgb(${Math.round(12 + t * 243)},${Math.round(10 + t * 169)},${Math.round(5 * (1 - t))})`;
}

function cellBg(v: number, mode: Mode, isDiag: boolean): string {
  if (isDiag) return "#1c1c1c";
  return mode === "corr" ? corrColor(v) : geomColor(v);
}

function cellFg(v: number, mode: Mode, isDiag: boolean): string {
  if (isDiag) return "#444";
  const lum = mode === "corr" ? Math.abs(v) : v;
  return lum > 0.5 ? "rgba(0,0,0,0.85)" : "#666";
}

// ── Convex Hull (gift-wrapping) ───────────────────────────────────────────────

function convexHull(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts;
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] < pts[start][0] || (pts[i][0] === pts[start][0] && pts[i][1] < pts[start][1]))
      start = i;
  }
  const hull: [number, number][] = [];
  let cur = start;
  do {
    hull.push(pts[cur]);
    let nxt = (cur + 1) % pts.length;
    for (let i = 0; i < pts.length; i++) {
      const cross =
        (pts[nxt][0] - pts[cur][0]) * (pts[i][1] - pts[cur][1]) -
        (pts[nxt][1] - pts[cur][1]) * (pts[i][0] - pts[cur][0]);
      if (cross < 0) nxt = i;
    }
    cur = nxt;
  } while (cur !== start && hull.length <= pts.length);
  return hull;
}

// ── Wedge Geometry View ───────────────────────────────────────────────────────
// Visualises sector return vectors as unit arrows on a 2D projection plane.
// The plane is the PCA 2D subspace of the Gram matrix (= correlation matrix).
// Arrow angle between sectors i,j approximates arccos(ρ_ij).
// The wedge product r̂_i ∧ r̂_j has magnitude |sin θ_ij| = area of unit parallelogram.
// Convex hull area of all arrow tips ≈ proxy for det(Gram)^(1/N) regime score.

interface WedgeProps {
  data: RegimeData;
  svgW: number;
  svgH: number;
  compact: boolean;
  colors: typeof bloombergColors.dark;
}

function WedgeGeometryView({ data, svgW, svgH, compact, colors }: WedgeProps) {
  const { abbrs, sectors, positions_2d, variance_explained, regime_score, regime_color } = data;

  if (!positions_2d?.length) return null;

  // Leave margin for labels around the circle
  const labelMargin = compact ? 22 : 44;
  const cx = svgW / 2;
  const cy = svgH / 2;
  const R = Math.min(cx, cy) - labelMargin; // circle radius

  if (R < 20) return null;

  // SVG coordinates: x right, y down — flip y so +y = up
  const toSVG = (x: number, y: number): [number, number] => [cx + x * R, cy - y * R];

  // Convex hull of arrow tips
  const tips: [number, number][] = positions_2d.map(([x, y]) => toSVG(x, y));
  const hull = convexHull([...tips]);

  const fs = compact ? 6.5 : 10;
  const arrowSize = compact ? 4 : 7;
  const strokeW = compact ? 1.2 : 1.8;

  const labels = compact ? abbrs : sectors;

  // Hull area (shoelace) → normalised to circle area for display
  let hullArea = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x0, y0] = hull[i];
    const [x1, y1] = hull[(i + 1) % hull.length];
    hullArea += x0 * y1 - x1 * y0;
  }
  hullArea = Math.abs(hullArea) / 2;
  const circleArea = Math.PI * R * R;
  const fillRatio = Math.min(1, hullArea / circleArea);

  return (
    <svg width={svgW} height={svgH} style={{ display: "block" }} aria-label="Wedge geometry plot">
      <title>Wedge geometry plot</title>
      {/* Reference circles */}
      <circle
        cx={cx}
        cy={cy}
        r={R}
        fill="none"
        stroke="#2a2a2a"
        strokeWidth={0.8}
        strokeDasharray="5 4"
      />
      <circle
        cx={cx}
        cy={cy}
        r={R * 0.5}
        fill="none"
        stroke="#1e1e1e"
        strokeWidth={0.5}
        strokeDasharray="2 5"
      />

      {/* Axes */}
      <line x1={cx - R} y1={cy} x2={cx + R} y2={cy} stroke="#222" strokeWidth={0.5} />
      <line x1={cx} y1={cy - R} x2={cx} y2={cy + R} stroke="#222" strokeWidth={0.5} />

      {/* Axis labels */}
      {!compact && (
        <>
          <text
            x={cx + R + 2}
            y={cy + 3}
            fontSize={7}
            fill="#333"
            fontFamily="monospace"
            textAnchor="start"
          >
            PC1
          </text>
          <text
            x={cx + 2}
            y={cy - R - 2}
            fontSize={7}
            fill="#333"
            fontFamily="monospace"
            textAnchor="start"
          >
            PC2
          </text>
        </>
      )}

      {/* Convex hull — filled with regime colour, shows "spread" */}
      {hull.length > 2 && (
        <polygon
          points={hull.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
          fill={`${regime_color}1A`}
          stroke={`${regime_color}55`}
          strokeWidth={compact ? 0.8 : 1.2}
          strokeDasharray="4 2"
        />
      )}

      {/* Sector arrows */}
      {positions_2d.map(([px, py], i) => {
        const [tx, ty] = toSVG(px, py);
        const color = SECTOR_COLORS[i % SECTOR_COLORS.length];

        // Arrowhead direction
        const ang = Math.atan2(ty - cy, tx - cx);
        const ax1 = tx - arrowSize * Math.cos(ang - 0.42);
        const ay1 = ty - arrowSize * Math.sin(ang - 0.42);
        const ax2 = tx - arrowSize * Math.cos(ang + 0.42);
        const ay2 = ty - arrowSize * Math.sin(ang + 0.42);

        // Label: positioned just beyond the unit-circle edge, in arrow direction
        const norm = Math.sqrt(px * px + py * py) || 1;
        const lx = cx + (px / norm) * (R + (compact ? 12 : 20));
        const ly = cy - (py / norm) * (R + (compact ? 12 : 20));

        return (
          <g key={sectors[i]}>
            {/* Shaft */}
            <line
              x1={cx}
              y1={cy}
              x2={tx}
              y2={ty}
              stroke={color}
              strokeWidth={strokeW}
              opacity={0.88}
            />
            {/* Arrowhead */}
            <polygon
              points={`${tx.toFixed(1)},${ty.toFixed(1)} ${ax1.toFixed(1)},${ay1.toFixed(1)} ${ax2.toFixed(1)},${ay2.toFixed(1)}`}
              fill={color}
              opacity={0.9}
            />
            {/* Label */}
            <text
              x={lx.toFixed(1)}
              y={(ly + fs * 0.38).toFixed(1)}
              textAnchor="middle"
              fontSize={fs}
              fill={color}
              fontFamily="monospace"
              fontWeight="bold"
              style={{ pointerEvents: "none" }}
            >
              <title>{`${sectors[i]}: (${px.toFixed(2)}, ${py.toFixed(2)})`}</title>
              {compact ? labels[i] : labels[i].slice(0, 11)}
            </text>
          </g>
        );
      })}

      {/* Origin dot */}
      <circle cx={cx} cy={cy} r={2.5} fill="#555" />

      {/* Variance explained */}
      {variance_explained && (
        <text
          x={compact ? svgW - 3 : svgW - 5}
          y={compact ? 10 : 12}
          textAnchor="end"
          fontSize={compact ? 6 : 8}
          fill={colors.textSecondary}
          fontFamily="monospace"
          opacity={0.6}
        >
          {`PC1+PC2: ${((variance_explained[0] + variance_explained[1]) * 100).toFixed(0)}%`}
        </text>
      )}

      {/* Hull fill ratio label */}
      {!compact && (
        <text
          x={5}
          y={svgH - 5}
          fontSize={7}
          fill={colors.textSecondary}
          fontFamily="monospace"
          opacity={0.5}
        >
          {`hull/circle: ${(fillRatio * 100).toFixed(0)}%`}
        </text>
      )}
    </svg>
  );
}

// ── Heatmap SVG ───────────────────────────────────────────────────────────────

interface HeatmapSVGProps {
  data: RegimeData;
  svgW: number;
  svgH: number;
  compact: boolean;
  colors: typeof bloombergColors.dark;
}

function HeatmapSVG({ data, svgW, svgH, compact, colors }: HeatmapSVGProps) {
  const { matrix, abbrs, sectors, n } = data;
  const mode = data.mode as Mode;

  const labelW = compact ? 30 : 108;
  const labelH = compact ? 30 : 88;
  const pad = 2;
  const gridW = svgW - labelW - pad;
  const gridH = svgH - labelH - pad;
  const cw = gridW / n;
  const ch = gridH / n;
  const fs = compact ? 7 : 10;
  const vfs = compact ? 5.5 : 8;
  const labels = compact ? abbrs : sectors;

  if (!matrix?.length) return null;

  return (
    <svg
      width={svgW}
      height={svgH}
      style={{ display: "block" }}
      aria-label="Sector correlation heatmap"
    >
      <title>Sector correlation heatmap</title>
      {/* Y-axis labels */}
      {labels.map((lbl, i) => (
        <text
          key={`y-${lbl}`}
          x={labelW - 3}
          y={labelH + i * ch + ch / 2 + fs * 0.35}
          textAnchor="end"
          fontSize={fs}
          fill={colors.textSecondary}
          fontFamily="monospace"
        >
          {compact ? lbl : lbl.slice(0, 13)}
        </text>
      ))}

      {/* X-axis labels — rotated */}
      {labels.map((lbl, j) => {
        const cx2 = labelW + j * cw + cw / 2;
        const cy2 = labelH - 3;
        return (
          <text
            key={`x-${lbl}`}
            x={cx2}
            y={cy2}
            textAnchor="start"
            fontSize={fs}
            fill={colors.textSecondary}
            fontFamily="monospace"
            transform={`rotate(-55 ${cx2} ${cy2})`}
          >
            {compact ? lbl : lbl.slice(0, 10)}
          </text>
        );
      })}

      {/* Cells */}
      {matrix.map((row, i) =>
        row.map((val, j) => {
          const isDiag = i === j;
          const x = labelW + j * cw;
          const y = labelH + i * ch;
          return (
            <g key={`${sectors[i]}-${sectors[j]}`}>
              <rect
                x={x}
                y={y}
                width={Math.max(1, cw - 0.5)}
                height={Math.max(1, ch - 0.5)}
                fill={cellBg(val, mode, isDiag)}
                stroke="#0d0d0d"
                strokeWidth={0.4}
              >
                <title>{`${sectors[i]} × ${sectors[j]}: ${val.toFixed(4)}`}</title>
              </rect>
              {!compact && !isDiag && cw > 44 && (
                <text
                  x={x + cw / 2}
                  y={y + ch / 2 + vfs * 0.35}
                  textAnchor="middle"
                  fontSize={vfs}
                  fill={cellFg(val, mode, isDiag)}
                  fontFamily="monospace"
                  fontWeight="bold"
                >
                  {val.toFixed(2)}
                </text>
              )}
            </g>
          );
        })
      )}

      <rect
        x={labelW}
        y={labelH}
        width={gridW}
        height={gridH}
        fill="none"
        stroke="#333"
        strokeWidth={0.5}
      />
    </svg>
  );
}

// ── Color Legend ──────────────────────────────────────────────────────────────

function ColorLegend({ mode, width }: { mode: Mode; width: number }) {
  const steps = 60;
  const bw = Math.max(40, width);
  return (
    <svg width={bw} height={6} style={{ display: "block" }} aria-label="Color scale legend">
      <title>Color scale legend</title>
      {Array.from({ length: steps }).map((_, i) => {
        const t = i / (steps - 1);
        const v = mode === "corr" ? -1 + t * 2 : t;
        return (
          <rect
            key={t}
            x={(i / steps) * bw}
            y={0}
            width={bw / steps + 0.5}
            height={6}
            fill={mode === "corr" ? corrColor(v) : geomColor(v)}
          />
        );
      })}
    </svg>
  );
}

// ── Regime Trend Strip ────────────────────────────────────────────────────────
// Shows all 4 periods simultaneously so user sees direction of change,
// not just a static snapshot.

const PERIOD_ORDER = ["1m", "3m", "6m", "1y"] as const;

// Short label map: CORR labels
const SHORT_LABEL: Record<string, string> = {
  DIVERGENT: "DIV",
  TRENDING: "TRD",
  "RISK-OFF": "R/O",
  CRISIS: "CRS",
  CORRELATED: "COR",
  MIXED: "MIX",
  "N/A": "N/A",
};

interface RegimeTrendStripProps {
  mode: Mode;
  colors: typeof bloombergColors.dark;
  onPeriodClick: (p: Period) => void;
  activePeriod: Period;
}

function RegimeTrendStrip({ mode, colors, onPeriodClick, activePeriod }: RegimeTrendStripProps) {
  // mounted guard — prevents SSR/client hydration mismatch from dynamic bar heights
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const { data, isLoading } = useQuery<RegimeTrend>({
    queryKey: ["regime-trend", mode],
    queryFn: async () => {
      const res = await fetch(`/api/regime/trend?mode=${mode}`);
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  // Same skeleton on server and client until mounted — avoids hydration mismatch
  if (!mounted || isLoading || !data)
    return (
      <div
        className="flex items-center gap-1 px-1 py-0.5"
        style={{ borderBottom: `1px solid ${colors.border}`, background: "#060606" }}
      >
        {mounted && (
          <Loader2 className="h-2 w-2 animate-spin" style={{ color: colors.textSecondary }} />
        )}
        <span className="text-[6px] font-mono" style={{ color: colors.textSecondary }}>
          {mounted ? "loading trend…" : ""}
        </span>
      </div>
    );

  const { periods, trend, trend_color, risk_delta } = data;

  // Max score for bar scaling
  const scores = PERIOD_ORDER.map((p) => periods[p]?.score ?? 0);
  const maxScore = Math.max(...scores, 0.01);

  const trendArrow = trend === "CONTRACTING" ? "→" : trend === "EXPANDING" ? "←" : "—";
  const trendLabel =
    trend === "CONTRACTING"
      ? "risk↑ (sectors converging)"
      : trend === "EXPANDING"
        ? "risk↓ (sectors diverging)"
        : "stable";

  return (
    <div
      className="shrink-0 px-1 py-0.5"
      style={{ background: "#060606", borderBottom: `1px solid ${colors.border}` }}
      title={`Regime trend across periods. ${trendLabel}. risk_delta=${risk_delta > 0 ? "+" : ""}${risk_delta.toFixed(3)}`}
    >
      {/* Period columns */}
      <div className="flex items-end gap-0.5 mb-0.5">
        {PERIOD_ORDER.map((p) => {
          const raw = periods[p] as Partial<PeriodScore> & {
            regime_score?: number;
            regime_label?: string;
            regime_color?: string;
          };
          if (!raw) return null;
          // Normalise: backend may return {score} or legacy {regime_score}
          const ps: PeriodScore = {
            score: raw.score ?? raw.regime_score ?? 0,
            label: raw.label ?? raw.regime_label ?? "N/A",
            color: raw.color ?? raw.regime_color ?? "#888",
          };
          const barH = Math.max(2, Math.round((ps.score / maxScore) * 14));
          const isActive = p === activePeriod;
          return (
            <button
              type="button"
              key={p}
              className="flex flex-col items-center gap-px flex-1 cursor-pointer hover:opacity-80"
              style={{ outline: isActive ? `1px solid ${ps.color}44` : "none" }}
              onClick={() => onPeriodClick(p)}
              title={`${p.toUpperCase()}: ${ps.label} (${ps.score.toFixed(3)}) — click to select`}
            >
              {/* Score value */}
              <span className="text-[5.5px] font-mono leading-none" style={{ color: ps.color }}>
                {ps.score.toFixed(2)}
              </span>
              {/* Bar */}
              <div
                style={{
                  width: "100%",
                  height: `${barH}px`,
                  background: ps.color,
                  opacity: isActive ? 1 : 0.55,
                  minHeight: "2px",
                  borderRadius: "1px 1px 0 0",
                }}
              />
              {/* Period label */}
              <span
                className="text-[5.5px] font-bold font-mono leading-none"
                style={{ color: isActive ? ps.color : colors.textSecondary }}
              >
                {p}
              </span>
              {/* Regime short label */}
              <span
                className="text-[5px] font-mono leading-none"
                style={{ color: `${ps.color}99` }}
              >
                {SHORT_LABEL[ps.label] ?? ps.label.slice(0, 3)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Trend summary row */}
      <div className="flex items-center gap-1">
        <span className="text-[6px] font-bold font-mono" style={{ color: trend_color }}>
          {trendArrow} {trend}
        </span>
        <span className="text-[5.5px] font-mono" style={{ color: colors.textSecondary }}>
          Δ{risk_delta > 0 ? "+" : ""}
          {risk_delta.toFixed(3)} (1m vs 1y)
        </span>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

interface SectorRegimeHeatmapProps {
  colors: typeof bloombergColors.dark;
  isDark: boolean;
}

export function SectorRegimeHeatmap({ colors }: SectorRegimeHeatmapProps) {
  const [mode, setMode] = useState<Mode>(() => loadDefaults().mode);
  const [period, setPeriod] = useState<Period>(() => loadDefaults().period);
  const [geomView, setGeomView] = useState<GeomView>(() => loadDefaults().geomView);
  const [expanded, setExpanded] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const [cSize, setCSize] = useState({ w: 240, h: 220 });

  useEffect(() => {
    saveDefaults(mode, period, geomView);
  }, [mode, period, geomView]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setCSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [expanded]);

  const isRot = mode === "rot";

  const { data, isLoading, isError, refetch } = useQuery<RegimeData>({
    queryKey: ["regime-correlation", mode, period],
    queryFn: async () => {
      const res = await fetch(`/api/regime/correlation?mode=${mode}&period=${period}`);
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
    enabled: !isRot,
  });

  const hasData = !isRot && !!data && !data.error && data.matrix.length > 0;
  const isGeom = mode === "geom";
  const hasGeom = isGeom && hasData && !!data.positions_2d?.length;
  const showSpace = isGeom && geomView === "space" && hasGeom;

  const [modalDims, setModalDims] = useState({ w: 900, h: 640 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure viewport each time the modal opens
  useEffect(() => {
    setModalDims({
      w: Math.min(window.innerWidth - 60, 960),
      h: Math.min(window.innerHeight - 120, 700),
    });
  }, [expanded]);
  const modalW = modalDims.w;
  const modalH = modalDims.h;
  const modalContentH = modalH - 110;

  return (
    <>
      {/* ── Compact panel ───────────────────────────────────────────────────── */}
      <div className="flex flex-col h-full overflow-hidden" style={{ background: "#000" }}>
        {/* Header */}
        <div
          className="flex items-center gap-1 px-1 py-0.5 shrink-0"
          style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}
        >
          <span className="text-[8px] font-bold tracking-widest" style={{ color: "#FF9800" }}>
            REGIME
          </span>

          <div className="flex overflow-hidden border ml-1" style={{ borderColor: colors.border }}>
            {MODES.map(({ key, label, desc }) => (
              <button
                type="button"
                key={key}
                title={desc}
                className="text-[7px] font-bold px-1.5 py-0 leading-4"
                style={{
                  background: mode === key ? "#FF980020" : "transparent",
                  color: mode === key ? "#FF9800" : colors.textSecondary,
                  borderRight: key === "corr" ? `1px solid ${colors.border}` : undefined,
                }}
                onClick={() => setMode(key as Mode)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* GEOM sub-toggle: MATRIX | SPACE */}
          {isGeom && (
            <div
              className="flex overflow-hidden border ml-1"
              style={{ borderColor: colors.border }}
            >
              {(["matrix", "space"] as GeomView[]).map((v) => (
                <button
                  type="button"
                  key={v}
                  className="text-[7px] font-bold px-1 py-0 leading-4"
                  style={{
                    background: geomView === v ? "#57CC9920" : "transparent",
                    color: geomView === v ? "#57CC99" : colors.textSecondary,
                    borderRight: v === "matrix" ? `1px solid ${colors.border}` : undefined,
                  }}
                  onClick={() => setGeomView(v)}
                >
                  {v === "matrix" ? "MTX" : "SPC"}
                </button>
              ))}
            </div>
          )}

          {!isRot && (
            <div className="flex ml-auto gap-px">
              {PERIODS.map((p) => (
                <button
                  type="button"
                  key={p}
                  className="text-[7px] font-bold px-0.5 py-0 leading-4"
                  style={{ color: period === p ? "#FF9800" : colors.textSecondary }}
                  onClick={() => setPeriod(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
          {isRot && <div className="ml-auto" />}

          <button
            type="button"
            className="ml-1 p-0.5 hover:opacity-70"
            title="Expand (full view)"
            onClick={() => setExpanded(true)}
          >
            <Maximize2 className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
          </button>
        </div>

        {/* Regime badge */}
        {!isRot && (
          <div
            className="flex items-center gap-2 px-1 py-0.5 shrink-0"
            style={{ background: "#080808", borderBottom: `1px solid ${colors.border}` }}
          >
            {isLoading && (
              <Loader2
                className="h-2.5 w-2.5 animate-spin"
                style={{ color: colors.textSecondary }}
              />
            )}
            {isError && (
              <span className="text-[7px] font-mono" style={{ color: "#FF4444" }}>
                ERROR{" "}
                <button
                  type="button"
                  className="underline hover:opacity-70"
                  onClick={() => refetch()}
                >
                  RETRY
                </button>
              </span>
            )}
            {hasData && (
              <>
                <span
                  className="text-[8px] font-bold font-mono"
                  style={{ color: data.regime_color }}
                >
                  ◉ {data.regime_label}
                </span>
                <span className="text-[7px] font-mono" style={{ color: colors.textSecondary }}>
                  {data.regime_score.toFixed(3)}
                </span>
                {isGeom && data.k_signal !== undefined && (
                  <span
                    className="text-[6px] font-mono px-0.5"
                    style={{
                      color: `${data.regime_color}CC`,
                      border: `1px solid ${data.regime_color}44`,
                    }}
                  >
                    k={data.k_signal}
                  </span>
                )}
                {isGeom && data.variance_explained && (
                  <span
                    className="text-[6px] font-mono"
                    style={{ color: `${colors.textSecondary}88` }}
                  >
                    PC1+2:
                    {((data.variance_explained[0] + data.variance_explained[1]) * 100).toFixed(0)}%
                  </span>
                )}
                <span
                  className="ml-auto text-[6px] font-mono"
                  style={{ color: `${colors.textSecondary}55` }}
                >
                  {data.calibration_method === "RMT" || data.calibration_method === "MRS"
                    ? data.calibration_method
                    : mode.toUpperCase()}
                  ·{period.toUpperCase()}
                </span>
              </>
            )}
            {!isLoading && !isError && !hasData && (
              <span className="text-[7px] font-mono" style={{ color: colors.textSecondary }}>
                —
              </span>
            )}
          </div>
        )}

        {/* Trend strip — all periods + direction */}
        {!isRot && (
          <RegimeTrendStrip
            mode={mode}
            colors={colors}
            activePeriod={period}
            onPeriodClick={(p) => setPeriod(p)}
          />
        )}

        {/* Visualisation area */}
        {isRot ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <RotationTable colors={colors} compact />
          </div>
        ) : (
          <div
            ref={containerRef}
            className="flex-1 min-h-0 overflow-hidden cursor-zoom-in"
            title="Click to expand"
            role="presentation"
            onClick={() => hasData && setExpanded(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hasData) setExpanded(true);
            }}
          >
            {showSpace ? (
              <WedgeGeometryView
                data={data}
                svgW={cSize.w}
                svgH={cSize.h}
                compact
                colors={colors}
              />
            ) : hasData ? (
              <HeatmapSVG data={data} svgW={cSize.w} svgH={cSize.h} compact colors={colors} />
            ) : isLoading ? (
              <div className="flex items-center justify-center h-full">
                <span className="text-[7px] font-mono" style={{ color: colors.textSecondary }}>
                  LOADING…
                </span>
              </div>
            ) : null}
          </div>
        )}

        {/* Legend strip */}
        {hasData && !showSpace && (
          <div
            className="shrink-0 flex items-center gap-1.5 px-1 py-0.5"
            style={{ borderTop: `1px solid ${colors.border}`, background: "#060606" }}
          >
            <span className="text-[6px] font-mono" style={{ color: colors.textSecondary }}>
              {mode === "corr" ? "-1" : "0"}
            </span>
            <div className="flex-1">
              <ColorLegend mode={mode} width={cSize.w - 36} />
            </div>
            <span className="text-[6px] font-mono" style={{ color: colors.textSecondary }}>
              +1
            </span>
          </div>
        )}
        {showSpace && (
          <div
            className="shrink-0 px-1 py-0.5"
            style={{ borderTop: `1px solid ${colors.border}`, background: "#060606" }}
          >
            <span className="text-[6px] font-mono" style={{ color: `${colors.textSecondary}66` }}>
              angle ≈ arccos(ρ) · hull = regime volume
            </span>
          </div>
        )}
      </div>

      {/* ── Expanded Modal ───────────────────────────────────────────────────── */}
      {expanded && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.88)" }}
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setExpanded(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setExpanded(false);
          }}
        >
          <div
            className="relative flex flex-col"
            style={{
              width: modalW,
              maxWidth: "calc(100vw - 40px)",
              background: "#050505",
              border: `1px solid ${colors.border}`,
              boxShadow: "0 0 60px rgba(0,0,0,0.9)",
            }}
          >
            {/* Modal header */}
            <div
              className="flex items-center gap-2 px-3 py-1.5 shrink-0"
              style={{ borderBottom: `1px solid ${colors.border}`, background: "#0c0c0c" }}
            >
              <span className="text-[10px] font-bold tracking-widest" style={{ color: "#FF9800" }}>
                US SECTOR REGIME DETECTION
              </span>

              <div
                className="flex border overflow-hidden ml-2"
                style={{ borderColor: colors.border }}
              >
                {MODES.map(({ key, label, desc }) => (
                  <button
                    type="button"
                    key={key}
                    title={desc}
                    className="text-[9px] font-bold px-2 py-0.5"
                    style={{
                      background: mode === key ? "#FF980020" : "transparent",
                      color: mode === key ? "#FF9800" : colors.textSecondary,
                      borderRight: key === "corr" ? `1px solid ${colors.border}` : undefined,
                    }}
                    onClick={() => setMode(key as Mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {!isRot && (
                <div className="flex gap-1 ml-2">
                  {PERIODS.map((p) => (
                    <button
                      type="button"
                      key={p}
                      className="text-[9px] font-bold px-1.5 py-0.5 border"
                      style={{
                        borderColor: period === p ? "#FF9800" : colors.border,
                        background: period === p ? "#FF980015" : "transparent",
                        color: period === p ? "#FF9800" : colors.textSecondary,
                      }}
                      onClick={() => setPeriod(p)}
                    >
                      {p.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}

              <div className="ml-auto flex items-center gap-3">
                {hasData && (
                  <>
                    <span
                      className="text-[9px] font-bold font-mono"
                      style={{ color: data.regime_color }}
                    >
                      ◉ {data.regime_label}
                    </span>
                    {isGeom && data.k_signal !== undefined && (
                      <span
                        className="text-[8px] font-mono px-1"
                        style={{
                          color: `${data.regime_color}CC`,
                          border: `1px solid ${data.regime_color}44`,
                        }}
                      >
                        k={data.k_signal} / λ={data.lambda_max?.toFixed(2)}
                      </span>
                    )}
                    <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
                      score: {data.regime_score.toFixed(4)}
                    </span>
                    {data.calibration_method && (
                      <span
                        className="text-[7px] font-mono"
                        style={{ color: `${colors.textSecondary}66` }}
                      >
                        [{data.calibration_method}]
                      </span>
                    )}
                  </>
                )}
                <button
                  type="button"
                  className="ml-2 p-0.5 hover:opacity-70"
                  title="Close (Esc)"
                  onClick={() => setExpanded(false)}
                >
                  <X className="h-4 w-4" style={{ color: colors.textSecondary }} />
                </button>
              </div>
            </div>

            {/* GEOM sub-toggle inside modal header row */}
            {isGeom && (
              <div
                className="px-3 py-1 shrink-0 flex items-center gap-2"
                style={{ background: "#080808", borderBottom: `1px solid ${colors.border}` }}
              >
                <span className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
                  VIEW
                </span>
                <div className="flex border overflow-hidden" style={{ borderColor: colors.border }}>
                  {(["matrix", "space"] as GeomView[]).map((v) => (
                    <button
                      type="button"
                      key={v}
                      className="text-[8px] font-bold px-2 py-0.5"
                      style={{
                        background: geomView === v ? "#57CC9920" : "transparent",
                        color: geomView === v ? "#57CC99" : colors.textSecondary,
                        borderRight: v === "matrix" ? `1px solid ${colors.border}` : undefined,
                      }}
                      onClick={() => setGeomView(v)}
                    >
                      {v === "matrix" ? "MATRIX  |sin θ|" : "WEDGE SPACE  PCA"}
                    </button>
                  ))}
                </div>
                {geomView === "space" && data?.variance_explained && (
                  <span
                    className="text-[8px] font-mono ml-2"
                    style={{ color: `${colors.textSecondary}88` }}
                  >
                    PC1+PC2:{" "}
                    {((data.variance_explained[0] + data.variance_explained[1]) * 100).toFixed(0)}%
                    variance
                  </span>
                )}
              </div>
            )}

            {/* Content area — always single view, full width */}
            <div className="overflow-hidden" style={{ height: modalContentH, background: "#000" }}>
              {!isRot && isLoading && (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="h-6 w-6 animate-spin" style={{ color: "#FF9800" }} />
                </div>
              )}
              {isRot ? (
                <RotationTable colors={colors} compact={false} />
              ) : showSpace ? (
                <div className="p-3 h-full">
                  <WedgeGeometryView
                    data={data}
                    svgW={modalW - 24}
                    svgH={modalContentH - 24}
                    compact={false}
                    colors={colors}
                  />
                </div>
              ) : hasData ? (
                <div className="p-3 h-full overflow-auto">
                  <HeatmapSVG
                    data={data}
                    svgW={modalW - 24}
                    svgH={modalContentH - 24}
                    compact={false}
                    colors={colors}
                  />
                </div>
              ) : null}
            </div>

            {/* Footer */}
            <div
              className="shrink-0 px-3 py-1.5 flex items-center gap-2"
              style={{ borderTop: `1px solid ${colors.border}`, background: "#0a0a0a" }}
            >
              {!showSpace && hasData && (
                <>
                  <span
                    className="text-[8px] font-mono shrink-0"
                    style={{ color: colors.textSecondary }}
                  >
                    {mode === "corr" ? "−1.0" : "0.0"}
                  </span>
                  <div className="flex-1">
                    <ColorLegend mode={mode} width={modalW - 160} />
                  </div>
                  <span
                    className="text-[8px] font-mono shrink-0"
                    style={{ color: colors.textSecondary }}
                  >
                    {mode === "corr" ? "+1.0" : "+1.0 (⊥)"}
                  </span>
                </>
              )}
              {showSpace && (
                <span
                  className="text-[7px] font-mono"
                  style={{ color: `${colors.textSecondary}66` }}
                >
                  Arrow angle ≈ arccos(ρ) · Convex hull area ∝ det(Gram)^(1/N) · Hover arrow for
                  sector name
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
