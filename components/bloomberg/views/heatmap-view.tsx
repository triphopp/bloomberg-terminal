"use client";

/**
 * HMAP — one equity market as a sector-grouped treemap (replaced GMOV 2026-09-25).
 *
 * Opened by the `heatmap(MARKET, period?)` terminal command, or `3` for the
 * last market. Data: `/api/market-heatmap` (routers/market_heatmap.py) — the
 * ~275 largest names, 25 per sector, from one screener call per sector.
 *
 * Built for speed and density:
 * - every colour metric (1D · 52W · vs 50D/200D average · off 52W high · RVOL)
 *   is in the one payload, so switching metric is instant and costs no request;
 * - the layout is a hand-rolled squarified treemap of absolutely positioned
 *   divs, computed once per (data, size, zoom) — no chart library, no SVG;
 * - the tile layer is memoised apart from the hover bar, so pointing at a
 *   tile re-renders one line, not 275 tiles.
 */

import { useQuery } from "@tanstack/react-query";
import { useAtom, useSetAtom } from "jotai";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  currentViewAtom,
  heatmapMarketAtom,
  heatmapMetricAtom,
  stockSearchSymbolAtom,
} from "../atoms";
import { openChartWindowAtom } from "../atoms/chart-windows";
import { bloombergColors } from "../lib/theme-config";

const colors = bloombergColors.dark;

// ── Data ──────────────────────────────────────────────────────────────────────

interface Tile {
  s: string; // symbol
  n: string; // short name
  sec: string;
  cap: number;
  px: number;
  d1: number | null;
  w52: number | null;
  d50: number | null;
  d200: number | null;
  hi: number | null;
  rv: number | null;
  pe: number | null;
  cur: string | null;
  ms: string | null;
  pre: number | null;
  post: number | null;
}

interface HeatmapPayload {
  market?: string;
  tiles: Tile[];
  currency?: string;
  asOf?: number;
  partial?: boolean;
  stale?: boolean;
  error?: string;
}

type Metric = "d1" | "w52" | "d50" | "d200" | "hi" | "rv";

const METRICS: { key: Metric; label: string; desc: string }[] = [
  { key: "d1", label: "1D", desc: "Today's % change" },
  { key: "w52", label: "52W", desc: "% change over 52 weeks" },
  { key: "d50", label: "50D", desc: "% above / below the 50-day average" },
  { key: "d200", label: "200D", desc: "% above / below the 200-day average" },
  { key: "hi", label: "HIGH", desc: "% below the 52-week high (0 = at the high)" },
  { key: "rv", label: "RVOL", desc: "Volume ÷ 3-month average (partial day while trading)" },
];

/** Clamp for the colour scale — a move this big or bigger is full colour. */
const SCALE: Record<Exclude<Metric, "rv" | "hi">, number> = { d1: 3, w52: 60, d50: 12, d200: 30 };

const QUICK_MARKETS = ["US", "TH", "JP", "HK", "CN", "KR", "TW", "IN", "UK", "DE"];

const SECTOR_SHORT: Record<string, string> = {
  Technology: "TECH",
  "Financial Services": "FIN",
  Healthcare: "HLTH",
  "Consumer Cyclical": "DISC",
  "Communication Services": "COMM",
  Industrials: "INDU",
  "Consumer Defensive": "STPL",
  Energy: "ENRG",
  "Basic Materials": "MATR",
  "Real Estate": "REIT",
  Utilities: "UTIL",
};

// ── Colour ────────────────────────────────────────────────────────────────────

const NEG = [246, 53, 56]; // red
const MID = [48, 51, 64]; // slate — "no move" must not read as a colour
const POS = [48, 204, 90]; // green
const HOT = [255, 153, 0]; // orange — RVOL

function mix(a: number[], b: number[], t: number) {
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
}

function tileColor(metric: Metric, v: number | null): string {
  if (v == null) return "#1a1a1f";
  if (metric === "rv") {
    // 1× = normal day (slate); 3× and up = full orange; quiet days darken
    if (v <= 1) return mix([22, 24, 30], MID, Math.max(0, v));
    return mix(MID, HOT, Math.min(1, (v - 1) / 2));
  }
  if (metric === "hi") {
    // 0 … -5% = at the highs (green); -30% or worse = red; -12% ≈ neutral
    const t = Math.max(-1, Math.min(1, (v + 12) / 12));
    return t >= 0 ? mix(MID, POS, t) : mix(MID, NEG, -t);
  }
  const t = Math.max(-1, Math.min(1, v / SCALE[metric]));
  // sqrt: small moves still read as coloured, big moves do not all saturate
  const k = Math.sqrt(Math.abs(t));
  return t >= 0 ? mix(MID, POS, k) : mix(MID, NEG, k);
}

function fmtMetric(metric: Metric, v: number | null): string {
  if (v == null) return "—";
  if (metric === "rv") return `${v.toFixed(1)}×`;
  const d = metric === "d1" ? 2 : 1;
  return `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
}

function fmtCap(v: number): string {
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  return v.toFixed(0);
}

function fmtPx(v: number): string {
  return v >= 1000
    ? v.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Cap-weighted mean of a metric (RVOL too — a big name trading heavy matters more). */
function capWeighted(tiles: Tile[], metric: Metric): number | null {
  let num = 0;
  let den = 0;
  for (const t of tiles) {
    const v = t[metric];
    if (v == null) continue;
    num += v * t.cap;
    den += t.cap;
  }
  return den > 0 ? num / den : null;
}

// ── Squarified treemap (Bruls, Huizing & van Wijk) ───────────────────────────

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function worst(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/** Lay `values` (sorted desc, any scale) into `rect`; returns one Rect per value, same order. */
function squarify(values: number[], rect: Rect): Rect[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return values.map(() => ({ ...rect, w: 0, h: 0 }));
  const scale = (rect.w * rect.h) / total;
  const areas = values.map((v) => v * scale);
  const out: Rect[] = [];
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    const row: number[] = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) {
      row.push(areas[j]);
      j++;
    }
    const rowSum = row.reduce((a, b) => a + b, 0);
    if (w >= h) {
      // column on the left
      const cw = rowSum / h;
      let cy = y;
      for (const a of row) {
        const ch = a / cw;
        out.push({ x, y: cy, w: cw, h: ch });
        cy += ch;
      }
      x += cw;
      w -= cw;
    } else {
      // row on top
      const rh = rowSum / w;
      let cx = x;
      for (const a of row) {
        const cw = a / rh;
        out.push({ x: cx, y, w: cw, h: rh });
        cx += cw;
      }
      y += rh;
      h -= rh;
    }
    i = j;
  }
  return out;
}

interface Placed {
  tile: Tile;
  r: Rect;
}
interface PlacedSector {
  sec: string;
  r: Rect;
  tiles: Placed[];
}

const SECTOR_HEAD = 12; // px — label strip at the top of each sector block
const GAP = 1;

function layout(
  tiles: Tile[],
  box: { w: number; h: number },
  sizeMode: "cap" | "sqrt"
): PlacedSector[] {
  const weight = (t: Tile) => (sizeMode === "sqrt" ? Math.sqrt(t.cap) : t.cap);
  const bySec = new Map<string, Tile[]>();
  for (const t of tiles) {
    const arr = bySec.get(t.sec);
    if (arr) arr.push(t);
    else bySec.set(t.sec, [t]);
  }
  const secs = [...bySec.entries()]
    .map(([sec, ts]) => ({
      sec,
      ts: ts.sort((a, b) => weight(b) - weight(a)),
      w: ts.reduce((a, t) => a + weight(t), 0),
    }))
    .sort((a, b) => b.w - a.w);
  const secRects = squarify(
    secs.map((s) => s.w),
    { x: 0, y: 0, w: box.w, h: box.h }
  );
  return secs.map((s, i) => {
    const r = secRects[i];
    const inner: Rect = {
      x: r.x + GAP,
      y: r.y + SECTOR_HEAD,
      w: Math.max(0, r.w - GAP * 2),
      h: Math.max(0, r.h - SECTOR_HEAD - GAP),
    };
    const rs = squarify(s.ts.map(weight), inner);
    return { sec: s.sec, r, tiles: s.ts.map((tile, k) => ({ tile, r: rs[k] })) };
  });
}

// ── Tile layer (memoised apart from hover) ───────────────────────────────────

const TileLayer = memo(function TileLayer({
  placed,
  metric,
  onHover,
  onPick,
}: {
  placed: PlacedSector[];
  metric: Metric;
  onHover: (t: Tile | null) => void;
  onPick: (t: Tile, shift: boolean) => void;
}) {
  return (
    <>
      {placed.map((sec) => (
        <div
          key={sec.sec}
          className="absolute overflow-hidden"
          style={{
            left: sec.r.x,
            top: sec.r.y,
            width: sec.r.w,
            height: sec.r.h,
            background: "#000",
            outline: "1px solid #000",
          }}
        >
          <div
            className="absolute left-0 right-0 top-0 px-1 text-[8px] font-bold tracking-widest truncate leading-[12px]"
            style={{ color: colors.textSecondary, height: SECTOR_HEAD }}
          >
            {SECTOR_SHORT[sec.sec] ?? sec.sec.toUpperCase()}
          </div>
          {sec.tiles.map(({ tile, r }) => {
            const w = r.w - GAP;
            const h = r.h - GAP;
            if (w <= 0 || h <= 0) return null;
            const v = tile[metric];
            const big = w > 70 && h > 38;
            const showSym = w > 26 && h > 12;
            const showVal = w > 34 && h > 24;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: dense visual map; every symbol is reachable from global search
              <div
                key={tile.s}
                className="absolute flex flex-col items-center justify-center overflow-hidden cursor-pointer hover:brightness-125 font-mono leading-none"
                style={{
                  left: r.x - sec.r.x,
                  top: r.y - sec.r.y,
                  width: w,
                  height: h,
                  background: tileColor(metric, v),
                  color: "#fff",
                }}
                onMouseEnter={() => onHover(tile)}
                onClick={(e) => onPick(tile, e.shiftKey)}
              >
                {showSym && (
                  <span
                    className={`font-bold truncate max-w-full px-0.5 ${big ? "text-[12px]" : "text-[9px]"}`}
                  >
                    {tile.s.replace(/\.(BK|T|HK|SS|SZ|KS|KQ|TW|NS|BO|L|DE|PA|SI|AX|TO)$/, "")}
                  </span>
                )}
                {showVal && (
                  <span className={`${big ? "text-[10px] mt-0.5" : "text-[8px]"} opacity-90`}>
                    {fmtMetric(metric, v)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
});

// ── View ──────────────────────────────────────────────────────────────────────

export function HeatmapView() {
  const [market, setMarket] = useAtom(heatmapMarketAtom);
  const [metricRaw, setMetric] = useAtom(heatmapMetricAtom);
  const metric = (METRICS.some((m) => m.key === metricRaw) ? metricRaw : "d1") as Metric;
  const [sizeMode, setSizeMode] = useState<"cap" | "sqrt">("cap");
  const [zoom, setZoom] = useState<string | null>(null);
  const [hover, setHover] = useState<Tile | null>(null);
  const setView = useSetAtom(currentViewAtom);
  const setStockSymbol = useSetAtom(stockSearchSymbolAtom);
  const openChartWindow = useSetAtom(openChartWindowAtom);

  // A new market resets the sector zoom — its sectors are not the same map.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on market only
  useEffect(() => setZoom(null), [market]);

  const { data, isLoading, isFetching, refetch } = useQuery<HeatmapPayload>({
    queryKey: ["market-heatmap", market],
    queryFn: () =>
      fetch(`/api/market-heatmap?market=${encodeURIComponent(market)}`).then((r) => r.json()),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const tiles = data?.tiles ?? [];

  // Measure the map box
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setBox((b) =>
        Math.abs(b.w - width) < 1 && Math.abs(b.h - height) < 1
          ? b
          : { w: Math.floor(width), h: Math.floor(height) }
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = useMemo(() => (zoom ? tiles.filter((t) => t.sec === zoom) : tiles), [tiles, zoom]);
  const placed = useMemo(() => layout(shown, box, sizeMode), [shown, box, sizeMode]);

  // Sector strip: cap-weighted metric per sector, best → worst
  const sectorStats = useMemo(() => {
    const by = new Map<string, Tile[]>();
    for (const t of tiles) {
      const a = by.get(t.sec);
      if (a) a.push(t);
      else by.set(t.sec, [t]);
    }
    return [...by.entries()]
      .map(([sec, ts]) => ({ sec, v: capWeighted(ts, metric), n: ts.length }))
      .sort((a, b) => (b.v ?? Number.NEGATIVE_INFINITY) - (a.v ?? Number.NEGATIVE_INFINITY));
  }, [tiles, metric]);

  const breadth = useMemo(() => {
    let up = 0;
    let dn = 0;
    for (const t of shown) {
      if ((t.d1 ?? 0) > 0) up++;
      else if ((t.d1 ?? 0) < 0) dn++;
    }
    return { up, dn, avg: capWeighted(shown, metric) };
  }, [shown, metric]);

  const onHover = useCallback((t: Tile | null) => setHover(t), []);
  const onPick = useCallback(
    (t: Tile, shift: boolean) => {
      if (shift) {
        openChartWindow({ symbol: t.s });
        return;
      }
      setStockSymbol(t.s);
      setView("stock");
    },
    [openChartWindow, setStockSymbol, setView]
  );

  const chip = (active: boolean) => ({
    color: active ? colors.accent : colors.textSecondary,
    background: active ? `${colors.accent}20` : "transparent",
  });

  const asOf = data?.asOf
    ? new Date(data.asOf * 1000).toLocaleTimeString("en-US", { hour12: false })
    : null;

  return (
    <div className="h-full flex flex-col overflow-hidden font-mono" style={{ background: "#000" }}>
      {/* ── Control bar ── */}
      <div
        className="shrink-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 py-0.5 text-[9px]"
        style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}
      >
        <span className="font-bold tracking-widest" style={{ color: colors.accent }}>
          HMAP
        </span>
        <div className="flex border" style={{ borderColor: colors.border }}>
          {[...new Set([...QUICK_MARKETS, market.toUpperCase()])].map((m) => (
            <button
              type="button"
              key={m}
              className="px-1 font-bold leading-4"
              style={chip(market.toUpperCase() === m)}
              onClick={() => setMarket(m)}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="flex border" style={{ borderColor: colors.border }}>
          {METRICS.map((m) => (
            <button
              type="button"
              key={m.key}
              title={m.desc}
              className="px-1 font-bold leading-4"
              style={chip(metric === m.key)}
              onClick={() => setMetric(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="px-1 font-bold leading-4 border"
          style={{ ...chip(sizeMode === "sqrt"), borderColor: colors.border }}
          title="Tile size: market cap, or √cap so mega-caps do not swallow the map"
          onClick={() => setSizeMode((s) => (s === "cap" ? "sqrt" : "cap"))}
        >
          {sizeMode === "cap" ? "SIZE CAP" : "SIZE √CAP"}
        </button>
        <span>
          <span style={{ color: "#30cc5a" }}>▲{breadth.up}</span>
          <span style={{ color: colors.textSecondary }}>/</span>
          <span style={{ color: "#f63538" }}>▼{breadth.dn}</span>
        </span>
        <span style={{ color: colors.textSecondary }}>
          CAP-WTD {METRICS.find((m) => m.key === metric)?.label}{" "}
          <span
            className="font-bold"
            style={{
              color:
                breadth.avg == null || metric === "rv"
                  ? colors.text
                  : breadth.avg >= 0
                    ? "#30cc5a"
                    : "#f63538",
            }}
          >
            {fmtMetric(metric, breadth.avg)}
          </span>
        </span>
        <span className="ml-auto" style={{ color: colors.textSecondary }}>
          {data?.market?.toUpperCase()} · {tiles.length} names
          {data?.currency ? ` · ${data.currency}` : ""}
          {asOf ? ` · ${asOf}` : ""}
          {data?.stale && <span style={{ color: "#facc15" }}> · STALE</span>}
          {data?.partial && <span style={{ color: "#facc15" }}> · PARTIAL</span>}
          {isFetching && " · …"}
        </span>
        <button
          type="button"
          className="px-1"
          style={{ color: colors.textSecondary }}
          onClick={() => refetch()}
          title="Refresh"
        >
          ↻
        </button>
      </div>

      {/* ── Sector strip: click to zoom into one sector ── */}
      {sectorStats.length > 0 && (
        <div
          className="shrink-0 flex text-[8px] leading-[14px] overflow-hidden"
          style={{ borderBottom: `1px solid ${colors.border}` }}
        >
          {zoom && (
            <button
              type="button"
              className="px-1 font-bold shrink-0"
              style={{ color: colors.accent, background: "#0a0a0a" }}
              onClick={() => setZoom(null)}
              title="Back to the whole market"
            >
              ← ALL
            </button>
          )}
          {sectorStats.map((s) => (
            <button
              type="button"
              key={s.sec}
              className="flex-1 min-w-0 px-0.5 truncate text-center"
              style={{
                background: tileColor(metric, s.v),
                color: "#fff",
                outline: zoom === s.sec ? `1px solid ${colors.accent}` : undefined,
                outlineOffset: -1,
              }}
              title={`${s.sec} · ${s.n} names · cap-weighted ${fmtMetric(metric, s.v)} — click to zoom`}
              onClick={() => setZoom((z) => (z === s.sec ? null : s.sec))}
            >
              <span className="font-bold">{SECTOR_SHORT[s.sec] ?? s.sec}</span>{" "}
              {fmtMetric(metric, s.v)}
            </button>
          ))}
        </div>
      )}

      {/* ── Map ── */}
      <div
        ref={boxRef}
        className="relative flex-1 min-h-0 overflow-hidden"
        onMouseLeave={() => setHover(null)}
      >
        {data?.error ? (
          <div className="p-2 text-[10px]" style={{ color: "#facc15" }}>
            {data.error}
          </div>
        ) : isLoading ? (
          <div className="p-2 text-[10px]" style={{ color: colors.textSecondary }}>
            loading {market.toUpperCase()}…
          </div>
        ) : (
          <TileLayer placed={placed} metric={metric} onHover={onHover} onPick={onPick} />
        )}
      </div>

      {/* ── Hover line: everything about one name, all metrics at once ── */}
      <div
        className="shrink-0 flex items-center gap-2 px-1 text-[9px] leading-[14px] whitespace-nowrap overflow-hidden"
        style={{ background: "#0a0a0a", borderTop: `1px solid ${colors.border}` }}
      >
        {hover ? (
          <>
            <span className="font-bold" style={{ color: colors.accent }}>
              {hover.s}
            </span>
            <span className="truncate max-w-[180px]" style={{ color: colors.textSecondary }}>
              {hover.n}
            </span>
            <span style={{ color: colors.text }}>{fmtPx(hover.px)}</span>
            {METRICS.map((m) => {
              const v = hover[m.key];
              const col =
                v == null || m.key === "rv" ? colors.text : v >= 0 ? "#30cc5a" : "#f63538";
              return (
                <span key={m.key}>
                  <span style={{ color: colors.textSecondary }}>{m.label} </span>
                  <span style={{ color: col }}>{fmtMetric(m.key, v)}</span>
                </span>
              );
            })}
            {(hover.pre ?? hover.post) != null && (
              <span>
                <span style={{ color: colors.textSecondary }}>
                  {hover.pre != null ? "PRE " : "AH "}
                </span>
                <span
                  style={{
                    color: ((hover.pre ?? hover.post) as number) >= 0 ? "#30cc5a" : "#f63538",
                  }}
                >
                  {fmtMetric("d1", (hover.pre ?? hover.post) as number)}
                </span>
              </span>
            )}
            <span>
              <span style={{ color: colors.textSecondary }}>MCAP </span>
              {fmtCap(hover.cap)}
            </span>
            {hover.pe != null && (
              <span>
                <span style={{ color: colors.textSecondary }}>P/E </span>
                {hover.pe.toFixed(1)}
              </span>
            )}
            <span style={{ color: colors.textSecondary }}>
              {SECTOR_SHORT[hover.sec] ?? hover.sec}
            </span>
          </>
        ) : (
          <span style={{ color: colors.textSecondary }}>
            hover a tile for all metrics · click = equity view · shift-click = chart window · sector
            strip = zoom · command: heatmap(TH, 52w)
          </span>
        )}
      </div>
    </div>
  );
}
