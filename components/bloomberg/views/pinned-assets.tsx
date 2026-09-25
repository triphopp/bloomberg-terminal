"use client";

import { type StockQuote as Quote, quoteQueryOptions } from "@/lib/market-data-client";
import { useQueryClient } from "@tanstack/react-query";
import { useAtom, useSetAtom } from "jotai";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Edit3,
  ExternalLink,
  GripVertical,
  Layers,
  LayoutGrid,
  LayoutList,
  Loader2,
  MessageSquare,
  Pin,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertBellCell } from "../alerts/AlertBellCell";
import { SymbolContextMenu } from "../alerts/SymbolContextMenu";
import { WatchlistAlertsBadge } from "../alerts/WatchlistAlertsBadge";
import {
  type PinGroup,
  type PinTag,
  type PinnedAsset,
  currentViewAtom,
  isDarkModeAtom,
  pinGroupsAtom,
  pinTagsAtom,
  pinnedAssetsAtom,
  stockSearchSymbolAtom,
} from "../atoms";
import { openChartWindowAtom } from "../atoms/chart-windows";
import { SessionGlyph, extendedSessionMove, staleMoveStyle } from "../core/market-session";
import {
  type PredictionSummary,
  probColor,
  useStockPredictionSummaries,
} from "../hooks/useStockPredictions";
import { useWatchlistQuotes, useWatchlistSparklines } from "../hooks/useWatchlistData";
import {
  type TrendState,
  type WatchlistSignal,
  useWatchlistSignals,
} from "../hooks/useWatchlistSignals";
import { bloombergColors } from "../lib/theme-config";
import { ExtCells, ExtHead, extLabelOf } from "./discover-lists";

type ThemeColors = typeof bloombergColors.dark;

// ── Constants ─────────────────────────────────────────────────────────────────

const LS_GROUPS = "bloomberg_pin_groups";
const LS_PINS = "bloomberg_pinned_assets";
const LS_TAGS = "bloomberg_pin_tags";
const LS_PIN_ORDER = "bloomberg_pin_order";
const LS_SORT_KEY = "bloomberg_pin_sort_key";
const LS_VIEW_MODE = "bloomberg_watchlist_view";
const LS_FOLDED_GROUPS = "bloomberg_watchlist_folded_groups";

/** compact = TICK DATA-style one-line rows (default) · table = full signal grid · cards */
type WatchlistViewMode = "compact" | "table" | "cards";
const VIEW_MODES: WatchlistViewMode[] = ["compact", "table", "cards"];
const VIEW_MODE_LABEL: Record<WatchlistViewMode, string> = {
  compact: "LIST",
  table: "TABLE",
  cards: "CARDS",
};
const nextViewMode = (m: WatchlistViewMode) =>
  VIEW_MODES[(VIEW_MODES.indexOf(m) + 1) % VIEW_MODES.length];

const PALETTE = [
  { label: "Gold", hex: "#f59e0b" },
  { label: "Green", hex: "#22c55e" },
  { label: "Blue", hex: "#3b82f6" },
  { label: "Purple", hex: "#a855f7" },
  { label: "Orange", hex: "#f97316" },
  { label: "Red", hex: "#ef4444" },
  { label: "Teal", hex: "#14b8a6" },
  { label: "Slate", hex: "#94a3b8" },
];

import { DEFAULT_WATCHLIST_GROUP as DEFAULT_GROUP } from "../core/global-search";

// ── Types ─────────────────────────────────────────────────────────────────────

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPrice(n: number) {
  if (n >= 10000)
    return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtVol(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

/**
 * Extended-hours line for a watchlist row.
 *
 * Renders only outside regular trading, because that is the only time the
 * regular-session price above it has gone stale. During the session it returns
 * null and the row keeps its normal single-line shape — nothing shifts.
 *
 * Venues without a pre/post concept (SET, crypto) simply never match.
 */
function SessionRow({ quote, colors }: { quote: Quote | undefined; colors: ThemeColors }) {
  const move = extendedSessionMove(quote);
  if (!move) return null;
  const up = (move.pct ?? move.change ?? 0) >= 0;
  return (
    <div
      className="font-mono whitespace-nowrap leading-tight text-[8px] flex items-center gap-0.5"
      title={move.label}
    >
      {/* Text tag, not the emoji — the SessionGlyph on the price line above
          already carries it, and two identical glyphs read as a rendering bug. */}
      <span style={{ color: colors.textSecondary, opacity: 0.7 }}>{move.short}</span>
      <span className="font-bold" style={{ color: colors.textSecondary }}>
        ${fmtPrice(move.price)}
      </span>
      {move.pct != null && (
        <span style={{ color: up ? "#00FF00" : "#FF4444" }}>
          {up ? "▲" : "▼"}
          {fmtPct(move.pct)}
        </span>
      )}
    </div>
  );
}

// ── Order persistence ────────────────────────────────────────────────────────

function saveOrder(pins: PinnedAsset[]) {
  try {
    localStorage.setItem(LS_PIN_ORDER, JSON.stringify(pins.map((p) => p.id)));
    localStorage.setItem(LS_SORT_KEY, "manual");
  } catch {}
}

function applySavedOrder(pins: PinnedAsset[]): PinnedAsset[] {
  try {
    const raw = localStorage.getItem(LS_PIN_ORDER);
    if (!raw) return pins;
    const order: string[] = JSON.parse(raw);
    const orderMap = new Map(order.map((id, idx) => [id, idx]));
    return [...pins].sort((a, b) => {
      const ia = orderMap.get(a.id) ?? Number.POSITIVE_INFINITY;
      const ib = orderMap.get(b.id) ?? Number.POSITIVE_INFINITY;
      return ia - ib;
    });
  } catch {
    return pins;
  }
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiGet(path: string) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function apiPost(path: string, body: unknown) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function apiPatch(path: string, body: unknown) {
  const r = await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function apiDelete(path: string) {
  const r = await fetch(path, { method: "DELETE" });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// ── ColorPicker ───────────────────────────────────────────────────────────────

function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {PALETTE.map(({ hex, label }) => (
        <button
          type="button"
          key={hex}
          data-frame
          title={label}
          onClick={() => onChange(hex)}
          className="w-4 h-4 border-2 transition-all"
          style={{
            background: hex,
            borderColor: value === hex ? "#fff" : "transparent",
            transform: value === hex ? "scale(1.15)" : "scale(1)",
          }}
        />
      ))}
    </div>
  );
}

// ── PriorityStars ─────────────────────────────────────────────────────────────

function PriorityStars({
  value = 1,
  onChange,
  readonly = false,
}: {
  value?: number;
  onChange?: (v: number) => void;
  readonly?: boolean;
}) {
  return (
    <span className="flex gap-0">
      {[1, 2, 3].map((star) => (
        <button
          type="button"
          key={star}
          className={`text-[10px] ${readonly ? "cursor-default" : "hover:opacity-80"}`}
          style={{ color: star <= value ? "#f59e0b" : "#333" }}
          onClick={readonly ? undefined : () => onChange?.(star)}
        >
          *
        </button>
      ))}
    </span>
  );
}

// ── TagChip ───────────────────────────────────────────────────────────────────

function TagChip({ tag }: { tag: PinTag }) {
  return (
    <span
      className="text-[8px] px-1 py-0 font-bold uppercase tracking-wider"
      style={{ background: `${tag.color}22`, color: tag.color, border: `1px solid ${tag.color}44` }}
    >
      {tag.name}
    </span>
  );
}

// ── Volume Bar ────────────────────────────────────────────────────────────────

function VolumeBar({
  current,
  avg,
  rvol,
  colors,
}: {
  current: number | null | undefined;
  avg: number | null | undefined;
  /** RVOL from the daily scan (vs the trailing 20d average) — preferred over the
   *  quote's 3-month average when available. */
  rvol?: number | null;
  colors: typeof bloombergColors.dark;
}) {
  const ratio = rvol ?? (current && avg ? current / avg : null);
  if (!current || ratio == null)
    return (
      <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
        —
      </span>
    );
  const barW = Math.min(100, ratio * 100);
  const barColor = ratio >= 2 ? "#ff9900" : ratio > 1 ? "#4ade80" : "#555";
  return (
    <div className="flex items-center gap-1 justify-end">
      <span className="text-[9px] font-mono w-[32px] text-right" style={{ color: colors.text }}>
        {fmtVol(current)}
      </span>
      <div className="w-[30px] h-[3px] relative" style={{ background: "#222" }}>
        <div
          className="absolute top-0 left-0 h-full"
          style={{ width: `${barW}%`, background: barColor }}
        />
      </div>
      <span
        className="text-[8px] font-mono"
        style={{ color: ratio >= 2 ? "#ff9900" : ratio >= 1 ? "#4ade80" : "#f87171" }}
        title={rvol != null ? "RVOL vs 20-day average volume" : "Volume vs 3-month average"}
      >
        {ratio.toFixed(1)}x
      </span>
    </div>
  );
}

// ── Polymarket implied direction ─────────────────────────────────────────────

/**
 * P(up) from Polymarket's single-name equity markets, with the horizon it applies
 * to — "62% 17d" reads as "the market charges 62c for this finishing higher inside
 * 17 days". Blank when no live market exists for the symbol, which is most of them.
 */
function PredictionCell({
  summary,
  colors,
}: {
  summary: PredictionSummary | undefined;
  colors: typeof bloombergColors.dark;
}) {
  if (!summary || summary.prob_up == null)
    return (
      <span className="text-[9px] font-mono" style={{ color: "#222" }}>
        —
      </span>
    );

  const prob = summary.prob_up;
  const clr = probColor(prob);
  const horizon = summary.horizon_days;
  const basis =
    summary.prob_up_source === "updown"
      ? "closes up today"
      : summary.prob_up_source === "cdf"
        ? "closes above spot"
        : summary.nearest_up
          ? `trades ${summary.nearest_up.strike}`
          : "implied up";

  const body = (
    <div className="flex items-center gap-1 justify-end">
      <span className="text-[9px] font-mono font-bold" style={{ color: clr }}>
        {Math.round(prob * 100)}%
      </span>
      {horizon != null && (
        <span className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>
          {Math.round(horizon)}d
        </span>
      )}
    </div>
  );

  const title = `Polymarket: ${Math.round(prob * 100)}% ${basis}${
    horizon != null ? ` · ${horizon}d left` : ""
  }${summary.skew != null ? ` · skew ${(summary.skew * 100).toFixed(0)}pp` : ""}${
    summary.event_title ? `\n${summary.event_title}` : ""
  }`;

  return summary.url ? (
    <a href={summary.url} target="_blank" rel="noopener noreferrer" title={title}>
      {body}
    </a>
  ) : (
    <span title={title}>{body}</span>
  );
}

// ── Signal cells (daily technical scan) ──────────────────────────────────────

/**
 * Track widths for the 3×2 signal grid, shared by the header, every row and the
 * footer so all three line up. Every cell is abbreviated to a glyph or 2-3 chars
 * with the full reading in its `title`, so the block stays narrow enough to sit
 * right beside the ticker.
 */
const SIGNAL_GRID_COLS = "grid-cols-[26px_24px_22px]";

const DASH = (
  <span className="text-[9px]" style={{ color: "#333" }}>
    —
  </span>
);

/** Composite score chip. Backend range is roughly [-6, +6]. */
function ScoreChip({ score }: { score: number | undefined }) {
  if (score == null) return DASH;
  const color =
    score >= 3
      ? "#22c55e"
      : score >= 1
        ? "#4ade80"
        : score <= -3
          ? "#ef4444"
          : score <= -1
            ? "#f87171"
            : "#888";
  return (
    <span
      className="text-[9px] font-bold px-0.5 tabular-nums"
      style={{ background: `${color}1a`, color, border: `1px solid ${color}44` }}
      title={`Composite signal score ${score} (trend + EMA cross + RSI + MACD + breakout)`}
    >
      {score > 0 ? `+${score}` : score}
    </span>
  );
}

function TrendCell({ state }: { state: TrendState | undefined }) {
  if (!state) return DASH;
  const map = {
    UP: { glyph: "▲", color: "#4ade80", label: "UP — price above EMA20 > EMA50" },
    DOWN: { glyph: "▼", color: "#f87171", label: "DOWN — price below EMA20 < EMA50" },
    FLAT: { glyph: "→", color: "#888", label: "FLAT — EMAs not stacked" },
  } as const;
  const s = map[state];
  return (
    <span className="text-[10px] font-bold" style={{ color: s.color }} title={`Trend: ${s.label}`}>
      {s.glyph}
    </span>
  );
}

function RsiCell({ rsi }: { rsi: WatchlistSignal["rsi"] | undefined }) {
  if (!rsi || rsi.value == null) return DASH;
  // Colour carries the OB/OS state — no room for the label next to the number.
  const color = rsi.state === "OB" ? "#ff9900" : rsi.state === "OS" ? "#4ade80" : "#ccc";
  return (
    <span
      className="text-[9px] font-mono tabular-nums"
      style={{ color, fontWeight: rsi.state === "NEUTRAL" ? 400 : 700 }}
      title={`RSI(14) ${rsi.value.toFixed(1)} — ${rsi.state === "OB" ? "overbought" : rsi.state === "OS" ? "oversold" : "neutral"}`}
    >
      {rsi.value.toFixed(0)}
    </span>
  );
}

/** Direction glyph + bars since the cross ("▲6" = bullish for 6 sessions). */
function MacdCell({ macd }: { macd: WatchlistSignal["macd"] | undefined }) {
  if (!macd || macd.state === "NONE") return DASH;
  const bull = macd.state === "BULL";
  const color = bull ? "#4ade80" : "#f87171";
  const fresh = macd.barsSinceCross != null && macd.barsSinceCross <= 3;
  return (
    <span
      className="text-[9px] font-mono tabular-nums"
      style={{ color, fontWeight: fresh ? 700 : 400 }}
      title={`MACD(12,26,9) histogram ${bull ? "bullish" : "bearish"} for ${macd.barsSinceCross ?? "?"} bars${fresh ? " — fresh cross" : ""}`}
    >
      {bull ? "▲" : "▼"}
      {macd.barsSinceCross ?? ""}
    </span>
  );
}

/** Donchian break if one fired, otherwise the position inside the 52-week range. */
function BreakoutCell({ sig }: { sig: WatchlistSignal | undefined }) {
  if (!sig) return DASH;
  if (sig.breakout.state !== "NONE") {
    const up = sig.breakout.state === "UP";
    return (
      <span
        className="text-[9px] font-bold px-0.5"
        style={{ background: up ? "#22c55e22" : "#ef444422", color: up ? "#4ade80" : "#f87171" }}
        title={
          up
            ? `Breakout — closed above the prior 20-day high (${sig.breakout.high?.toFixed(2)})`
            : `Breakdown — closed below the prior 20-day low (${sig.breakout.low?.toFixed(2)})`
        }
      >
        {up ? "▲B" : "▼B"}
      </span>
    );
  }
  const pos = sig.range52w.pct;
  if (pos == null) return DASH;
  const p = Math.round(pos * 100);
  const color = p >= 95 ? "#4ade80" : p <= 5 ? "#f87171" : "#888";
  return (
    <span
      className="text-[9px] font-mono tabular-nums"
      style={{ color }}
      title={`${p}% of the 52-week range (${sig.range52w.low}–${sig.range52w.high}) — no 20-day breakout`}
    >
      {p}
    </span>
  );
}

function AtrCell({ atrPct }: { atrPct: number | null | undefined }) {
  if (atrPct == null) return DASH;
  const color = atrPct >= 5 ? "#ff9900" : atrPct >= 2.5 ? "#ccc" : "#4ade80";
  return (
    <span
      className="text-[9px] font-mono tabular-nums"
      style={{ color }}
      title={`ATR(14) = ${atrPct.toFixed(2)}% of price — daily range budget for stops`}
    >
      {atrPct.toFixed(1)}
    </span>
  );
}

// ── Mini Sparkline ────────────────────────────────────────────────────────────

function MiniSparkline({ prices, isUp }: { prices: number[]; isUp: boolean }) {
  if (prices.length < 2) return <div style={{ height: 36 }} />;
  const W = 100;
  const H = 34;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const pts = prices
    .map((p, i) => {
      const x = (i / (prices.length - 1)) * W;
      const y = H - 2 - ((p - min) / range) * (H - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const color = isUp ? "#00FF00" : "#FF4444";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H, display: "block" }}>
      <title>{isUp ? "Price trend up" : "Price trend down"}</title>
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── GroupManagerPanel ─────────────────────────────────────────────────────────

/** One row of the group list: shows the group, switches to an inline editor on
 *  click. Rename and recolour both go through the same `onRename` patch. */
function GroupRow({
  group,
  count,
  colors,
  canDelete,
  onRename,
  onDelete,
}: {
  group: PinGroup;
  count: number;
  colors: ThemeColors;
  canDelete: boolean;
  onRename: (id: string, patch: { name?: string; color?: string }) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const n = name.trim();
    setEditing(false);
    if (!n || n === group.name) {
      setName(group.name);
      return;
    }
    onRename(group.id, { name: n });
  };

  if (editing) {
    return (
      <div className="space-y-1 py-0.5">
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            className="text-[10px] px-1 py-0.5 border outline-none font-mono flex-1 min-w-0"
            style={{
              background: colors.background,
              color: colors.text,
              borderColor: colors.accent,
            }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setName(group.name);
                setEditing(false);
              }
            }}
          />
          <button type="button" title="Save" onClick={commit}>
            <Check className="h-3 w-3" style={{ color: colors.accent }} />
          </button>
          <button
            type="button"
            title="Cancel"
            onClick={() => {
              setName(group.name);
              setEditing(false);
            }}
          >
            <X className="h-3 w-3" style={{ color: colors.textSecondary }} />
          </button>
        </div>
        <ColorPicker value={group.color} onChange={(hex) => onRename(group.id, { color: hex })} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 py-0.5 group/row">
      <span className="w-2 h-2 shrink-0" style={{ background: group.color }} title={group.color} />
      <button
        type="button"
        title="Rename group"
        className="flex-1 min-w-0 text-left text-[10px] font-mono truncate hover:underline"
        style={{ color: colors.text }}
        onClick={() => setEditing(true)}
      >
        {group.name}
      </button>
      <span className="text-[9px] shrink-0" style={{ color: colors.textSecondary }}>
        {count}
      </span>
      <button type="button" title="Rename group" onClick={() => setEditing(true)}>
        <Edit3 className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
      </button>
      <button
        type="button"
        title={
          canDelete ? "Delete group (pins move to the first group)" : "Cannot delete the last group"
        }
        disabled={!canDelete}
        className="disabled:opacity-25"
        onClick={() => canDelete && onDelete(group.id)}
      >
        <Trash2 className="h-2.5 w-2.5 text-red-400 hover:opacity-70" />
      </button>
    </div>
  );
}

function GroupManagerPanel({
  groups,
  pins,
  colors,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onClose,
}: {
  groups: PinGroup[];
  pins: PinnedAsset[];
  colors: ThemeColors;
  onCreateGroup: (g: PinGroup) => void;
  onRenameGroup: (id: string, patch: { name?: string; color?: string }) => void;
  onDeleteGroup: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[0].hex);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of pins) m[p.groupId] = (m[p.groupId] ?? 0) + 1;
    return m;
  }, [pins]);

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onCreateGroup({ id: Date.now().toString(), name: n, color });
    setName("");
  };

  return (
    <div
      className="absolute right-0 top-6 z-20 w-56 border p-2 text-xs space-y-1.5"
      style={{ background: colors.surface, borderColor: colors.border }}
    >
      <div className="flex items-center justify-between">
        <span className="font-bold tracking-widest text-[9px]" style={{ color: colors.accent }}>
          GROUP MANAGER
        </span>
        <button type="button" onClick={onClose}>
          <X className="h-3 w-3" style={{ color: colors.textSecondary }} />
        </button>
      </div>
      <div className="space-y-0.5 max-h-40 overflow-y-auto">
        {groups.length === 0 && (
          <div
            className="text-center py-1 opacity-50 text-[9px]"
            style={{ color: colors.textSecondary }}
          >
            No groups
          </div>
        )}
        {groups.map((g) => (
          <GroupRow
            key={g.id}
            group={g}
            count={counts[g.id] ?? 0}
            colors={colors}
            canDelete={groups.length > 1}
            onRename={onRenameGroup}
            onDelete={onDeleteGroup}
          />
        ))}
      </div>
      <div className="border-t pt-1.5" style={{ borderColor: colors.border }}>
        <input
          ref={inputRef}
          className="text-[10px] px-1 py-0.5 border outline-none font-mono w-full mb-1"
          style={{ background: colors.background, color: colors.text, borderColor: colors.border }}
          placeholder="Group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
        />
        <ColorPicker value={color} onChange={setColor} />
        <button
          type="button"
          className="mt-1 text-[10px] px-2 py-0.5 font-bold w-full disabled:opacity-40"
          style={{ background: colors.accent, color: "#000" }}
          disabled={!name.trim()}
          onClick={submit}
        >
          CREATE
        </button>
      </div>
    </div>
  );
}

// ── TagManagerPanel ───────────────────────────────────────────────────────────

function TagManagerPanel({
  tags,
  colors,
  onCreateTag,
  onDeleteTag,
  onClose,
}: {
  tags: PinTag[];
  colors: typeof bloombergColors.dark;
  onCreateTag: (t: PinTag) => void;
  onDeleteTag: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[7].hex);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onCreateTag({ id: Date.now().toString(), name: n, color });
    setName("");
  };

  return (
    <div
      className="absolute right-0 top-6 z-20 w-56 border p-2 text-xs space-y-1.5"
      style={{ background: colors.surface, borderColor: colors.border }}
    >
      <div className="flex items-center justify-between">
        <span className="font-bold tracking-widest text-[9px]" style={{ color: colors.accent }}>
          TAG MANAGER
        </span>
        <button type="button" onClick={onClose}>
          <X className="h-3 w-3" style={{ color: colors.textSecondary }} />
        </button>
      </div>
      <div className="space-y-0.5 max-h-32 overflow-y-auto">
        {tags.length === 0 && (
          <div
            className="text-center py-1 opacity-50 text-[9px]"
            style={{ color: colors.textSecondary }}
          >
            No tags
          </div>
        )}
        {tags.map((t) => (
          <div key={t.id} className="flex items-center justify-between">
            <TagChip tag={t} />
            <button type="button" onClick={() => onDeleteTag(t.id)}>
              <Trash2 className="h-2.5 w-2.5 text-red-400 hover:opacity-70" />
            </button>
          </div>
        ))}
      </div>
      <div className="border-t pt-1.5" style={{ borderColor: colors.border }}>
        <input
          ref={inputRef}
          className="text-[10px] px-1 py-0.5 border outline-none font-mono w-full mb-1"
          style={{ background: colors.background, color: colors.text, borderColor: colors.border }}
          placeholder="Tag name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
        />
        <ColorPicker value={color} onChange={setColor} />
        <button
          type="button"
          className="mt-1 text-[10px] px-2 py-0.5 font-bold w-full disabled:opacity-40"
          style={{ background: colors.accent, color: "#000" }}
          disabled={!name.trim()}
          onClick={submit}
        >
          CREATE
        </button>
      </div>
    </div>
  );
}

// ── AddCardForm ───────────────────────────────────────────────────────────────

function AddCardForm({
  groupId,
  groups,
  colors,
  onAdd,
  onCancel,
}: {
  groupId: string;
  groups: PinGroup[];
  colors: typeof bloombergColors.dark;
  onAdd: (p: PinnedAsset) => void;
  onCancel: () => void;
}) {
  const [symbol, setSymbol] = useState("");
  const [comment, setComment] = useState("");
  const [buyTarget, setBuyTarget] = useState("");
  const [sellTarget, setSellTarget] = useState("");
  const [selGroup, setSelGroup] = useState(groupId);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const iSt = { background: colors.background, color: colors.text, borderColor: colors.border };

  const submit = () => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    onAdd({
      id: Date.now().toString(),
      symbol: sym,
      groupId: selGroup,
      comment: comment.trim(),
      addedAt: new Date().toISOString().split("T")[0],
      buyTarget: buyTarget ? Number.parseFloat(buyTarget) : undefined,
      sellTarget: sellTarget ? Number.parseFloat(sellTarget) : undefined,
      priority: 1,
      tags: [],
    });
  };

  return (
    <div
      className="col-span-3 flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b"
      style={{ background: `${colors.accent}08`, borderColor: colors.border }}
    >
      <input
        ref={inputRef}
        className="text-[10px] px-1.5 py-0.5 border outline-none font-mono font-bold w-20 uppercase"
        style={iSt}
        placeholder="TICKER"
        value={symbol}
        onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      {groups.length > 1 && (
        <select
          className="text-[9px] px-0.5 py-0.5 border font-mono"
          style={iSt}
          value={selGroup}
          onChange={(e) => setSelGroup(e.target.value)}
        >
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      )}
      <input
        className="text-[10px] px-1 py-0.5 border outline-none font-mono w-14"
        style={{ ...iSt, color: "#4ade80" }}
        type="number"
        min="0"
        step="0.01"
        placeholder="Buy $"
        value={buyTarget}
        onChange={(e) => setBuyTarget(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <input
        className="text-[10px] px-1 py-0.5 border outline-none font-mono w-14"
        style={{ ...iSt, color: "#f87171" }}
        type="number"
        min="0"
        step="0.01"
        placeholder="Sell $"
        value={sellTarget}
        onChange={(e) => setSellTarget(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <input
        className="text-[10px] px-1 py-0.5 border outline-none font-mono flex-1 min-w-[60px]"
        style={iSt}
        placeholder="Note…"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="flex gap-1">
        <button
          type="button"
          className="text-[9px] px-2 py-0.5 font-bold flex items-center gap-0.5 disabled:opacity-40"
          style={{ background: colors.accent, color: "#000" }}
          disabled={!symbol.trim()}
          onClick={submit}
        >
          <Pin className="h-2.5 w-2.5" />
          PIN
        </button>
        <button
          type="button"
          className="text-[9px] px-2 py-0.5"
          style={{ background: colors.border, color: colors.textSecondary }}
          onClick={onCancel}
        >
          ESC
        </button>
      </div>
    </div>
  );
}

// ── EditCardForm ──────────────────────────────────────────────────────────────

function EditCardForm({
  pin,
  groups,
  allTags,
  colors,
  onSave,
  onCancel,
  onDelete,
}: {
  pin: PinnedAsset;
  groups: PinGroup[];
  allTags: PinTag[];
  colors: typeof bloombergColors.dark;
  onSave: (id: string, updates: Partial<PinnedAsset>) => void;
  onCancel: () => void;
  onDelete: (id: string) => void;
}) {
  const [editComment, setEditComment] = useState(pin.comment);
  const [editGroupId, setEditGroupId] = useState(pin.groupId);
  const [editBuyTarget, setEditBuyTarget] = useState(pin.buyTarget?.toString() ?? "");
  const [editSellTarget, setEditSellTarget] = useState(pin.sellTarget?.toString() ?? "");
  const [editPriority, setEditPriority] = useState(pin.priority ?? 1);
  const [editTags, setEditTags] = useState<string[]>(pin.tags ?? []);

  const iSt = { background: colors.background, color: colors.text, borderColor: colors.border };

  const save = () => {
    onSave(pin.id, {
      comment: editComment,
      groupId: editGroupId,
      // null, not undefined: handleSaveEdit only sends the fields that are
      // present in the update, so an emptied box used to clear the target in
      // the local list and leave it untouched in the database - the pin came
      // back with its old target on the next load, and the price-target badge
      // started warning again about a target the user had just deleted.
      buyTarget: editBuyTarget ? Number.parseFloat(editBuyTarget) : null,
      sellTarget: editSellTarget ? Number.parseFloat(editSellTarget) : null,
      priority: editPriority,
      tags: editTags,
    });
    onCancel();
  };

  const toggleTag = (tagId: string) =>
    setEditTags((ts) => (ts.includes(tagId) ? ts.filter((t) => t !== tagId) : [...ts, tagId]));

  return (
    <div
      className="col-span-3 flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b"
      style={{ background: `${colors.accent}0a`, borderColor: colors.border }}
    >
      <span className="font-bold font-mono text-[10px]" style={{ color: colors.accent }}>
        {pin.symbol}
      </span>
      <PriorityStars value={editPriority} onChange={setEditPriority} />
      {groups.length > 1 && (
        <select
          className="text-[9px] px-0.5 py-0.5 border font-mono"
          style={iSt}
          value={editGroupId}
          onChange={(e) => setEditGroupId(e.target.value)}
        >
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      )}
      <input
        className="text-[10px] px-1 py-0.5 border outline-none font-mono w-14"
        style={{ ...iSt, color: "#4ade80" }}
        type="number"
        min="0"
        step="0.01"
        placeholder="Buy $"
        value={editBuyTarget}
        onChange={(e) => setEditBuyTarget(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") onCancel();
        }}
      />
      <input
        className="text-[10px] px-1 py-0.5 border outline-none font-mono w-14"
        style={{ ...iSt, color: "#f87171" }}
        type="number"
        min="0"
        step="0.01"
        placeholder="Sell $"
        value={editSellTarget}
        onChange={(e) => setEditSellTarget(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") onCancel();
        }}
      />
      <input
        className="text-[10px] px-1 py-0.5 border outline-none font-mono flex-1 min-w-[60px]"
        style={iSt}
        placeholder="Note…"
        value={editComment}
        onChange={(e) => setEditComment(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") onCancel();
        }}
      />
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-0.5">
          {allTags.map((t) => (
            <label key={t.id} className="flex items-center gap-0.5 cursor-pointer">
              <input
                type="checkbox"
                checked={editTags.includes(t.id)}
                onChange={() => toggleTag(t.id)}
                className="w-2 h-2"
              />
              <span className="text-[8px]" style={{ color: t.color }}>
                {t.name}
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <button
          type="button"
          className="text-[9px] px-1.5 py-0.5 font-bold flex items-center gap-0.5"
          style={{ background: "#22c55e22", color: "#4ade80", border: "1px solid #22c55e44" }}
          onClick={save}
        >
          <Check className="h-2.5 w-2.5" />
          OK
        </button>
        <button
          type="button"
          className="text-[9px] px-1.5 py-0.5"
          style={{ background: colors.border, color: colors.textSecondary }}
          onClick={onCancel}
        >
          ESC
        </button>
        <button
          type="button"
          className="text-[9px] px-1 py-0.5"
          style={{ color: "#f87171" }}
          onClick={() => onDelete(pin.id)}
        >
          <Trash2 className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}

// ── Compact (TICK DATA-style) row ─────────────────────────────────────────────
//
// Same grammar as the MKT TICK DATA board: one 13px line, four columns —
// SYM · LAST · CHG · SIG. Company name, pin return, targets and comment move
// into the tooltip, so a squeezed panel shows ~3x the rows the table view does.

const COMPACT_COLS = 4;
const COMPACT_CELL = "pl-1 pr-0.5 py-0 text-right whitespace-nowrap tabular-nums";

function scoreColor(score: number) {
  return score >= 3
    ? "#22c55e"
    : score >= 1
      ? "#4ade80"
      : score <= -3
        ? "#ef4444"
        : score <= -1
          ? "#f87171"
          : "#888";
}

const CompactWatchRow = memo(function CompactWatchRow({
  pin,
  quote: q,
  score,
  quoteError,
  colors,
  onOpen,
  onEdit,
  onRemove,
  index,
  isDragging,
  isDragOver,
  onDragStartRow,
  onDragOverRow,
  onDropRow,
  onDragEndRow,
  showExt,
}: {
  pin: PinnedAsset;
  quote: Quote | undefined;
  score: number | undefined;
  quoteError: string | undefined;
  colors: ThemeColors;
  onOpen: (symbol: string, e?: { shiftKey?: boolean }) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  /** position in the sorted list — what handleReorder indexes */
  index: number;
  isDragging: boolean;
  isDragOver: boolean;
  onDragStartRow: (index: number) => void;
  onDragOverRow: (index: number) => void;
  onDropRow: (index: number) => void;
  onDragEndRow: () => void;
  /** render the two extended-hours columns (the list is in PRE/AH) */
  showExt: boolean;
}) {
  const price = q?.regularMarketPrice;
  const pct = q?.regularMarketChangePercent;
  const buyAlert = price != null && pin.buyTarget != null && price <= pin.buyTarget;
  const sellAlert = price != null && pin.sellTarget != null && price >= pin.sellTarget;
  const sincePin =
    price != null && pin.priceAtPin != null && pin.priceAtPin > 0
      ? ((price - pin.priceAtPin) / pin.priceAtPin) * 100
      : null;
  // A move from a session that has already ended is dimmed, never read as today's.
  const stale = q ? staleMoveStyle(q) : null;
  const title = [
    q?.shortName ?? pin.symbol,
    sincePin != null && pin.priceAtPin != null
      ? `since pin ${fmtPct(sincePin)} @${fmtPrice(pin.priceAtPin)}`
      : null,
    pin.buyTarget != null ? `buy ${fmtPrice(pin.buyTarget)}` : null,
    pin.sellTarget != null ? `sell ${fmtPrice(pin.sellTarget)}` : null,
    pin.comment || null,
    stale?.title ?? null,
    quoteError ? `price delayed: ${quoteError}` : null,
    "drag to reorder · double-click to edit",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <SymbolContextMenu
      symbol={pin.symbol}
      colors={colors}
      onOpen={onOpen}
      onRemove={() => onRemove(pin.id)}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: row click is a shortcut; the symbol opens from the keyboard via the context menu and the TABLE view */}
      <tr
        className="cursor-pointer hover:bg-[#111]"
        style={{
          borderBottom: "1px solid #111",
          boxShadow: isDragOver ? "inset 0 2px #00FFFF" : undefined,
          opacity: isDragging ? 0.4 : 1,
          background: sellAlert ? "#ef444414" : buyAlert ? "#22c55e14" : undefined,
        }}
        title={title}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          onDragStartRow(index);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          onDragOverRow(index);
        }}
        onDrop={(e) => {
          e.preventDefault();
          onDropRow(index);
        }}
        onDragEnd={onDragEndRow}
        onClick={(e) => onOpen(pin.symbol, e)}
        onDoubleClick={() => onEdit(pin.id)}
      >
        <td
          className="px-1 py-0 text-left font-bold truncate max-w-0 w-full"
          style={{ color: sellAlert ? "#ef4444" : buyAlert ? "#4ade80" : colors.accent }}
        >
          {pin.symbol}
          {quoteError && <span className="text-amber-400">!</span>}
        </td>
        <td className={COMPACT_CELL} style={{ color: colors.text }}>
          {price != null ? fmtPrice(price) : "—"}
        </td>
        <td
          className={COMPACT_CELL}
          style={{
            color: pct == null ? colors.textSecondary : pct >= 0 ? "#00FF00" : "#FF0000",
            opacity: stale?.opacity,
          }}
        >
          {pct != null ? fmtPct(pct) : "—"}
        </td>
        {showExt && <ExtCells quote={q} colors={colors} />}
        <td
          className={`${COMPACT_CELL} font-bold`}
          style={{ color: score == null ? colors.textSecondary : scoreColor(score) }}
        >
          {score == null ? "·" : score > 0 ? `+${score}` : score}
        </td>
      </tr>
    </SymbolContextMenu>
  );
});

// ── Main component ────────────────────────────────────────────────────────────

/**
 * Memoised: MKT re-renders on every keystroke / chart state change, and this
 * table (quotes × signals × PM per row) is the most expensive thing in it.
 * Callers must pass a stable `onSymbolClick`.
 */
export const PinnedAssets = memo(function PinnedAssets({
  onSymbolClick,
}: { onSymbolClick?: (symbol: string) => void } = {}) {
  const [isDarkMode] = useAtom(isDarkModeAtom);
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  const [groups, setGroups] = useAtom(pinGroupsAtom);
  const [pins, setPins] = useAtom(pinnedAssetsAtom);
  const [tags, setTags] = useAtom(pinTagsAtom);
  const setCurrentView = useSetAtom(currentViewAtom);
  const setStockSymbol = useSetAtom(stockSearchSymbolAtom);
  const openChartWindow = useSetAtom(openChartWindowAtom);

  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const pageSize = 100;
  const [collapsed, setCollapsed] = useState(false);
  const [showGroupMgr, setShowGroupMgr] = useState(false);
  const [showTagMgr, setShowTagMgr] = useState(false);
  /** Last failed group/pin write — shown in the header so an optimistic update
   *  that got rolled back is never silent. */
  const [mutError, setMutError] = useState<string>("");
  const [showAddRow, setShowAddRow] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<string>("symbol");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filterGroup, setFilterGroup] = useState<string>("all");
  const [expandedComment, setExpandedComment] = useState<string | null>(null);

  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "ok" | "error">("idle");
  const [syncError, setSyncError] = useState<string>("");
  const [viewMode, setViewMode] = useState<WatchlistViewMode>("compact");
  const [foldedGroups, setFoldedGroups] = useState<string[]>([]);
  // Restored after mount, not in the initializer: the server renders the
  // default, and a different first client render is a hydration mismatch.
  useEffect(() => {
    try {
      const v = localStorage.getItem(LS_VIEW_MODE);
      if (v === "compact" || v === "table" || v === "cards") setViewMode(v);
      const g = JSON.parse(localStorage.getItem(LS_FOLDED_GROUPS) ?? "[]");
      if (Array.isArray(g)) setFoldedGroups(g.filter((x) => typeof x === "string"));
    } catch {
      /* private mode — keep defaults */
    }
  }, []);
  const cycleViewMode = () => {
    const next = nextViewMode(viewMode);
    setViewMode(next);
    try {
      localStorage.setItem(LS_VIEW_MODE, next);
    } catch {}
  };
  const toggleGroupFold = (id: string) => {
    setFoldedGroups((prev) => {
      const next = prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id];
      try {
        localStorage.setItem(LS_FOLDED_GROUPS, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  // Drag-to-reorder state
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // ── localStorage helpers ──────────────────────────────────────────────────

  const saveToLS = useCallback((g: PinGroup[], p: PinnedAsset[], t: PinTag[]) => {
    try {
      localStorage.setItem(LS_GROUPS, JSON.stringify(g));
      localStorage.setItem(LS_PINS, JSON.stringify(p));
      localStorage.setItem(LS_TAGS, JSON.stringify(t));
    } catch {
      /* ignore quota errors */
    }
  }, []);

  /** Row as the pins API returns it — snake_case, every field optional. */
  interface PinRow {
    id: string;
    symbol: string;
    group_id: string;
    comment?: string | null;
    added_at?: string | null;
    addedAt?: string | null;
    buy_target?: number | null;
    sell_target?: number | null;
    price_at_pin?: number | null;
    priority?: number | null;
    tags?: string[] | null;
  }

  const mapAsset = (a: PinRow): PinnedAsset => ({
    id: a.id,
    symbol: a.symbol,
    groupId: a.group_id,
    comment: a.comment ?? "",
    addedAt: a.added_at ?? a.addedAt ?? "",
    buyTarget: a.buy_target ?? null,
    sellTarget: a.sell_target ?? null,
    priceAtPin: a.price_at_pin ?? undefined,
    priority: a.priority ?? 1,
    tags: a.tags ?? [],
  });

  // ── Initial load ────────────────────────────────────────────────────────

  const didLoad = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot bootstrap guarded by didLoad — re-running on every setter identity would refetch the whole watchlist
  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;

    const loadFromDB = async () => {
      setSyncStatus("syncing");
      try {
        const [gRes, aRes, tRes] = await Promise.all([
          apiGet("/api/pins/groups"),
          apiGet("/api/pins/assets"),
          apiGet("/api/pins/tags"),
        ]);

        // Backend returns a plain array; handle both array and wrapped-object shapes
        const rawGroups = Array.isArray(gRes) ? gRes : (gRes.groups ?? []);
        const rawAssets = Array.isArray(aRes) ? aRes : (aRes.assets ?? []);
        const rawTags = Array.isArray(tRes) ? tRes : (tRes.tags ?? []);

        const dbGroups: PinGroup[] = rawGroups.map((g: PinGroup) => ({
          id: g.id,
          name: g.name,
          color: g.color,
        }));
        const dbAssets: PinnedAsset[] = rawAssets.map(mapAsset);
        const dbTags: PinTag[] = rawTags.map((t: PinTag) => ({
          id: t.id,
          name: t.name,
          color: t.color,
        }));

        if (dbGroups.length === 0) {
          const lsGroups = localStorage.getItem(LS_GROUPS);
          const lsPins = localStorage.getItem(LS_PINS);
          if (lsGroups || lsPins) {
            const migrateGroups: PinGroup[] = lsGroups ? JSON.parse(lsGroups) : [DEFAULT_GROUP];
            const migratePins: PinnedAsset[] = lsPins ? JSON.parse(lsPins) : [];
            try {
              await apiPost("/api/pins/import", { groups: migrateGroups, assets: migratePins });
              const [g2, a2] = await Promise.all([
                apiGet("/api/pins/groups"),
                apiGet("/api/pins/assets"),
              ]);
              const rawG2 = Array.isArray(g2) ? g2 : (g2.groups ?? []);
              const rawA2 = Array.isArray(a2) ? a2 : (a2.assets ?? []);
              const migratedGroups = rawG2.map((g: PinGroup) => ({
                id: g.id,
                name: g.name,
                color: g.color,
              }));
              const migratedAssets = rawA2.map(mapAsset);
              if (migratedGroups.length > 0 || migratedAssets.length > 0) {
                const ordered = applySavedOrder(migratedAssets);
                setGroups(migratedGroups.length > 0 ? migratedGroups : [DEFAULT_GROUP]);
                setPins(ordered);
                setTags(dbTags);
                saveToLS(migratedGroups, ordered, dbTags);
                const savedSortKey = localStorage.getItem(LS_SORT_KEY);
                if (savedSortKey) setSortKey(savedSortKey);
                setSyncStatus("ok");
                return;
              }
              // Re-fetch returned empty — fall through to LS fallback below
            } catch {
              /* fall through */
            }
          }
          if (dbGroups.length === 0) {
            const lsGroupsFallback: PinGroup[] = lsGroups ? JSON.parse(lsGroups) : [DEFAULT_GROUP];
            const lsPinsFallback: PinnedAsset[] = lsPins ? JSON.parse(lsPins) : [];
            // The DB is reachable but has no groups, so seed the fallback ones.
            // pinned_assets.group_id is a real FK (PRAGMA foreign_keys = ON), so
            // without this row every "add pin" POST fails and the pin disappears
            // on the next reload.
            try {
              await apiPost("/api/pins/import", { groups: lsGroupsFallback, assets: [] });
            } catch (seedErr) {
              console.warn("[PinnedAssets] default group seed failed", seedErr);
            }
            const ordered = applySavedOrder(lsPinsFallback);
            setGroups(lsGroupsFallback);
            setPins(ordered);
            setTags(dbTags);
            saveToLS(lsGroupsFallback, ordered, dbTags);
            const savedSortKey = localStorage.getItem(LS_SORT_KEY);
            if (savedSortKey) setSortKey(savedSortKey);
            setSyncStatus("ok");
            return;
          }
        }

        const orderedDbAssets = applySavedOrder(dbAssets);
        setGroups(dbGroups.length > 0 ? dbGroups : [DEFAULT_GROUP]);
        setPins(orderedDbAssets);
        setTags(dbTags);
        saveToLS(dbGroups, orderedDbAssets, dbTags);
        const savedSortKey = localStorage.getItem(LS_SORT_KEY);
        if (savedSortKey) setSortKey(savedSortKey);
        setSyncStatus("ok");
      } catch (err) {
        console.warn("[PinnedAssets] Backend unavailable, using localStorage", err);
        setSyncStatus("error");
        setSyncError("DB offline");
        try {
          const lsGroups = localStorage.getItem(LS_GROUPS);
          const lsPins = localStorage.getItem(LS_PINS);
          const lsTags = localStorage.getItem(LS_TAGS);
          const parsed = lsPins ? JSON.parse(lsPins) : [];
          setGroups(lsGroups ? JSON.parse(lsGroups) : [DEFAULT_GROUP]);
          setPins(applySavedOrder(parsed));
          setTags(lsTags ? JSON.parse(lsTags) : []);
          const savedSortKey = localStorage.getItem(LS_SORT_KEY);
          if (savedSortKey) setSortKey(savedSortKey);
        } catch {
          setGroups([DEFAULT_GROUP]);
        }
      }
    };

    loadFromDB();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // All groups share per-symbol queries. Metadata edits/reordering do not refetch.
  const symbolKey = [...new Set(pins.map((p) => p.symbol))].sort().join(",");
  const signalSymbols = useMemo(() => (symbolKey ? symbolKey.split(",") : []), [symbolKey]);
  const {
    quotes,
    loading: loadingQuotes,
    errors: quoteErrors,
    loaded: quotesLoaded,
    total: quoteTotal,
    refresh: fetchQuotes,
  } = useWatchlistQuotes(signalSymbols, !collapsed);
  const {
    signals,
    isLoading: signalsLoading,
    errors: signalErrors,
  } = useWatchlistSignals(signalSymbols, !collapsed);
  const predictionSymbols = useMemo(
    () => signalSymbols.filter((s) => /^[A-Z][A-Z.\-]{0,5}$/.test(s) && !s.includes(".")),
    [signalSymbols]
  );
  const { summaries: pmSummaries, errors: pmErrors } = useStockPredictionSummaries(
    predictionSymbols,
    !collapsed
  );

  // ── CRUD Handlers ─────────────────────────────────────────────────────────

  // Group writes are optimistic, but a failed write used to be swallowed by a
  // console.error: the group appeared, localStorage kept it, and the next
  // bootstrap overwrote state with what the DB actually had — so it silently
  // vanished. Every group mutation now rolls the optimistic state back and
  // surfaces the failure instead.
  const rollbackGroups = useCallback(
    (prevGroups: PinGroup[], prevPins: PinnedAsset[], msg: string, err: unknown) => {
      console.error(`[pins] ${msg}`, err);
      setGroups(prevGroups);
      setPins(prevPins);
      saveToLS(prevGroups, prevPins, tags);
      setMutError(msg);
    },
    [setGroups, setPins, saveToLS, tags]
  );

  const handleAddGroup = async (g: PinGroup) => {
    const prevGroups = groups;
    const newGroups = [...groups, g];
    setGroups(newGroups);
    saveToLS(newGroups, pins, tags);
    setMutError("");
    try {
      await apiPost("/api/pins/groups", {
        id: g.id,
        name: g.name,
        color: g.color,
        sort_order: newGroups.length - 1,
      });
    } catch (err) {
      rollbackGroups(prevGroups, pins, `Create group "${g.name}" failed`, err);
    }
  };

  const handleRenameGroup = async (id: string, patch: { name?: string; color?: string }) => {
    const prevGroups = groups;
    const newGroups = groups.map((g) => (g.id === id ? { ...g, ...patch } : g));
    setGroups(newGroups);
    saveToLS(newGroups, pins, tags);
    setMutError("");
    try {
      await apiPatch(`/api/pins/groups/${encodeURIComponent(id)}`, patch);
    } catch (err) {
      rollbackGroups(prevGroups, pins, "Rename group failed", err);
    }
  };

  const handleDeleteGroup = async (id: string) => {
    if (groups.length <= 1) return;
    const prevGroups = groups;
    const prevPins = pins;
    const fallback = groups.find((g) => g.id !== id)?.id ?? groups[0].id;
    const newGroups = groups.filter((g) => g.id !== id);
    const newPins = pins.map((p) => (p.groupId === id ? { ...p, groupId: fallback } : p));
    setGroups(newGroups);
    setPins(newPins);
    saveToLS(newGroups, newPins, tags);
    setMutError("");
    if (filterGroup === id) setFilterGroup("all");
    try {
      await apiDelete(`/api/pins/groups/${encodeURIComponent(id)}`);
    } catch (err) {
      rollbackGroups(prevGroups, prevPins, "Delete group failed", err);
    }
  };

  const handleAddPin = async (pin: PinnedAsset) => {
    const cached = queryClient.getQueryData<Quote>(quoteQueryOptions(pin.symbol).queryKey);
    const fetchedAt =
      queryClient.getQueryState(quoteQueryOptions(pin.symbol).queryKey)?.dataUpdatedAt ?? 0;
    const price = Date.now() - fetchedAt < 60_000 ? (cached?.regularMarketPrice ?? null) : null;
    const added = { ...pin, priceAtPin: price ?? undefined };
    const newPins = [...pins, added];
    setPins(newPins);
    saveToLS(groups, newPins, tags);
    setShowAddRow(false);
    setMutError("");
    try {
      // Membership is saved immediately; a slow quote cannot delay the write.
      await apiPost("/api/pins/assets", {
        id: pin.id,
        symbol: pin.symbol,
        group_id: pin.groupId,
        comment: pin.comment,
        buy_target: pin.buyTarget ?? null,
        sell_target: pin.sellTarget ?? null,
        price_at_pin: price,
        priority: pin.priority ?? 1,
        added_at: pin.addedAt,
        tags: pin.tags ?? [],
      });
    } catch {
      setPins((current) => {
        const rolledBack = current.filter((p) => p.id !== pin.id);
        saveToLS(groups, rolledBack, tags);
        return rolledBack;
      });
      setMutError(`Could not save ${pin.symbol}. Please try again.`);
      return;
    }
    if (price == null) {
      try {
        // Joins the row/chart query; no second or third quote request on ADD.
        const quote = await queryClient.fetchQuery(quoteQueryOptions(pin.symbol));
        await apiPatch(`/api/pins/assets/${encodeURIComponent(pin.id)}`, {
          price_at_pin: quote.regularMarketPrice,
        });
        setPins((current) => {
          const updated = current.map((p) =>
            p.id === pin.id ? { ...p, priceAtPin: quote.regularMarketPrice } : p
          );
          saveToLS(groups, updated, tags);
          return updated;
        });
      } catch {
        // The pin is already saved. Missing entry price must remain unknown.
      }
    }
  };

  const handleDeletePin = async (id: string) => {
    const newPins = pins.filter((p) => p.id !== id);
    setPins(newPins);
    setEditingId(null);
    saveToLS(groups, newPins, tags);
    try {
      await apiDelete(`/api/pins/assets/${encodeURIComponent(id)}`);
    } catch (err) {
      console.error(err);
    }
  };

  const handleSaveEdit = async (id: string, updates: Partial<PinnedAsset>) => {
    const newPins = pins.map((p) => (p.id === id ? { ...p, ...updates } : p));
    setPins(newPins);
    saveToLS(groups, newPins, tags);
    try {
      const patchBody: Record<string, unknown> = {};
      if (updates.groupId !== undefined) patchBody.group_id = updates.groupId;
      if (updates.comment !== undefined) patchBody.comment = updates.comment;
      if (updates.buyTarget !== undefined) patchBody.buy_target = updates.buyTarget ?? null;
      if (updates.sellTarget !== undefined) patchBody.sell_target = updates.sellTarget ?? null;
      if (updates.priority !== undefined) patchBody.priority = updates.priority;
      await apiPatch(`/api/pins/assets/${encodeURIComponent(id)}`, patchBody);
      if (updates.tags !== undefined) {
        const oldPin = pins.find((p) => p.id === id);
        const oldTags = new Set(oldPin?.tags ?? []);
        const newTags = new Set(updates.tags);
        for (const tid of newTags) {
          if (!oldTags.has(tid))
            await apiPost(
              `/api/pins/assets/${encodeURIComponent(id)}/tags/${encodeURIComponent(tid)}`,
              {}
            );
        }
        for (const tid of oldTags) {
          if (!newTags.has(tid))
            await apiDelete(
              `/api/pins/assets/${encodeURIComponent(id)}/tags/${encodeURIComponent(tid)}`
            );
        }
      }
    } catch (err) {
      console.error("[handleSaveEdit]", err);
    }
  };

  /**
   * Shift+click pops the symbol into a floating chart window instead of
   * navigating. Kept here rather than threaded through a prop because every
   * caller of this component wants the same behaviour, and the row click
   * handlers below have several call sites.
   */
  const handleSymbolClick = (symbol: string, e?: { shiftKey?: boolean }) => {
    if (e?.shiftKey) {
      openChartWindow({ symbol });
      return;
    }
    if (onSymbolClick) {
      onSymbolClick(symbol);
    } else {
      setStockSymbol(symbol);
      setCurrentView("stock");
    }
  };

  const handleCreateTag = async (t: PinTag) => {
    const newTags = [...tags, t];
    setTags(newTags);
    saveToLS(groups, pins, newTags);
    try {
      await apiPost("/api/pins/tags", { id: t.id, name: t.name, color: t.color });
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteTag = async (tagId: string) => {
    const newTags = tags.filter((t) => t.id !== tagId);
    const newPins = pins.map((p) => ({
      ...p,
      tags: (p.tags ?? []).filter((tid) => tid !== tagId),
    }));
    setTags(newTags);
    setPins(newPins);
    saveToLS(groups, newPins, newTags);
    try {
      await apiDelete(`/api/pins/tags/${encodeURIComponent(tagId)}`);
    } catch (err) {
      console.error(err);
    }
  };

  // Stable handles for the memoised compact rows — the handlers above are
  // re-created every render, which would re-render every row on each quote tick.
  const handlersRef = useRef({ open: handleSymbolClick, remove: handleDeletePin });
  handlersRef.current = { open: handleSymbolClick, remove: handleDeletePin };
  const stableOpen = useCallback(
    (symbol: string, e?: { shiftKey?: boolean }) => handlersRef.current.open(symbol, e),
    []
  );
  const stableRemove = useCallback((id: string) => handlersRef.current.remove(id), []);

  // ── Sorting ─────────────────────────────────────────────────────────────

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
      try {
        localStorage.setItem(LS_SORT_KEY, key);
      } catch {}
    }
  };

  const getSortValue = useCallback(
    (pin: PinnedAsset, key: string): number | string => {
      const q = quotes[pin.symbol];
      const s = signals[pin.symbol];
      // Rank order for the categorical signal columns, so sorting groups
      // bullish → neutral → bearish instead of sorting the label alphabetically.
      const TREND_RANK = { UP: 1, FLAT: 0, DOWN: -1 } as const;
      switch (key) {
        case "symbol":
          return pin.symbol;
        // "priority" has no column any more (edit the stars in the edit row), but a
        // localStorage sort key saved before that change can still arrive here.
        case "priority":
          return pin.priority ?? 0;
        case "price":
          return q?.regularMarketPrice ?? 0;
        case "change":
          return q?.regularMarketChange ?? 0;
        case "pctChange":
          return q?.regularMarketChangePercent ?? 0;
        case "volume":
          return q?.regularMarketVolume ?? 0;
        case "score":
          return s?.score ?? -99;
        case "trend":
          return s ? TREND_RANK[s.trend.state] : -99;
        case "rsi":
          return s?.rsi.value ?? -1;
        case "macd":
          return s ? (s.macd.state === "BULL" ? 1 : s.macd.state === "BEAR" ? -1 : 0) : -99;
        case "breakout":
          return s
            ? s.breakout.state === "UP"
              ? 2
              : s.breakout.state === "DOWN"
                ? -2
                : (s.range52w.pct ?? 0)
            : -99;
        case "rvol":
          return s?.rvol ?? -1;
        case "pm":
          return pmSummaries[pin.symbol]?.prob_up ?? -1;
        case "atr":
          return s?.atrPct ?? -1;
        case "sincePin": {
          const price = q?.regularMarketPrice;
          if (price && pin.priceAtPin && pin.priceAtPin > 0)
            return ((price - pin.priceAtPin) / pin.priceAtPin) * 100;
          return -9999;
        }
        default:
          return 0;
      }
    },
    [quotes, signals, pmSummaries]
  );

  // ── Derived ─────────────────────────────────────────────────────────────

  const filteredPins = useMemo(
    () => (filterGroup === "all" ? pins : pins.filter((p) => p.groupId === filterGroup)),
    [pins, filterGroup]
  );

  // ── Drag-to-reorder ─────────────────────────────────────────────────────

  const handleReorder = useCallback(
    async (fromIdx: number, toIdx: number, patch?: Partial<PinnedAsset>) => {
      if (fromIdx === toIdx && !patch) return;
      const displayed =
        sortKey === "manual"
          ? filteredPins
          : [...filteredPins].sort((a, b) => {
              const va = getSortValue(a, sortKey);
              const vb = getSortValue(b, sortKey);
              const cmp =
                typeof va === "string"
                  ? va.localeCompare(vb as string)
                  : (va as number) - (vb as number);
              return sortDir === "asc" ? cmp : -cmp;
            });
      const reordered = [...displayed];
      const [picked] = reordered.splice(fromIdx, 1);
      // A LIST-view drop onto a row of another group also moves it into that group.
      const moved = patch ? { ...picked, ...patch } : picked;
      reordered.splice(toIdx, 0, moved);
      const reorderedIds = new Set(reordered.map((p) => p.id));
      const remaining = pins.filter((p) => !reorderedIds.has(p.id));
      const newPins = [...reordered, ...remaining];
      setPins(newPins);
      setSortKey("manual");
      saveToLS(groups, newPins, tags);
      saveOrder(newPins);
      try {
        const orderPayload = newPins.map((p, i) => ({ id: p.id, sort_order: i }));
        await apiPatch("/api/pins/assets/reorder", { order: orderPayload });
      } catch {
        /* backend may not support this endpoint yet */
      }
      if (patch?.groupId !== undefined) {
        try {
          await apiPatch(`/api/pins/assets/${encodeURIComponent(moved.id)}`, {
            group_id: patch.groupId,
          });
        } catch (err) {
          console.error("[handleReorder] group move", err);
          setMutError(`Move ${moved.symbol} to group failed`);
        }
      }
    },
    [pins, filteredPins, sortKey, sortDir, groups, tags, saveToLS, setPins, getSortValue]
  );

  const sortedPins = useMemo(
    () =>
      sortKey === "manual"
        ? filteredPins
        : [...filteredPins].sort((a, b) => {
            const va = getSortValue(a, sortKey);
            const vb = getSortValue(b, sortKey);
            const cmp =
              typeof va === "string"
                ? va.localeCompare(vb as string)
                : (va as number) - (vb as number);
            return sortDir === "asc" ? cmp : -cmp;
          }),
    [filteredPins, sortKey, sortDir, getSortValue]
  );

  const pageCount = Math.max(1, Math.ceil(sortedPins.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageOffset = currentPage * pageSize;
  const displayedPins = sortedPins.slice(pageOffset, pageOffset + pageSize);
  // LIST-view drag-to-reorder. Callbacks are stable (ref-backed) so the
  // memoised rows only re-render when their own drag highlight changes.
  const dragFromRef = useRef<number | null>(null);
  const reorderCtx = useRef({ reorder: handleReorder, list: sortedPins, grouped: false });
  reorderCtx.current = {
    reorder: handleReorder,
    list: sortedPins,
    grouped: groups.length > 1 && filterGroup === "all",
  };
  const rowDragStart = useCallback((idx: number) => {
    dragFromRef.current = idx;
    setDragIdx(idx);
  }, []);
  const rowDragOver = useCallback((idx: number) => setDragOverIdx(idx), []);
  const rowDragEnd = useCallback(() => {
    dragFromRef.current = null;
    setDragIdx(null);
    setDragOverIdx(null);
  }, []);
  const rowDrop = useCallback(
    (toIdx: number) => {
      const from = dragFromRef.current;
      rowDragEnd();
      if (from == null) return;
      const { reorder, list, grouped } = reorderCtx.current;
      const src = list[from];
      const dst = list[toIdx];
      if (!src || !dst) return;
      const patch = grouped && src.groupId !== dst.groupId ? { groupId: dst.groupId } : undefined;
      reorder(from, toIdx, patch);
    },
    [rowDragEnd]
  );

  const sparklines = useWatchlistSparklines(
    viewMode === "cards" ? displayedPins.map((p) => p.symbol) : [],
    !collapsed && viewMode === "cards"
  );

  const totalAlerts = pins.filter((p) => {
    const q = quotes[p.symbol];
    if (!q) return false;
    return (
      (p.buyTarget != null && q.regularMarketPrice <= p.buyTarget) ||
      (p.sellTarget != null && q.regularMarketPrice >= p.sellTarget)
    );
  }).length;

  // Signal roll-up for the header bar
  const signalCounts = useMemo(() => {
    const counts = {
      up: 0,
      down: 0,
      breakouts: 0,
      breakdowns: 0,
      freshCross: 0,
      overbought: 0,
      oversold: 0,
      volSpike: 0,
    };
    for (const pin of pins) {
      const s = signals[pin.symbol];
      if (!s) continue;
      if (s.trend.state === "UP") counts.up++;
      else if (s.trend.state === "DOWN") counts.down++;
      if (s.breakout.state === "UP") counts.breakouts++;
      else if (s.breakout.state === "DOWN") counts.breakdowns++;
      if (s.flags.includes("MACD_CROSS_FRESH")) counts.freshCross++;
      if (s.rsi.state === "OB") counts.overbought++;
      else if (s.rsi.state === "OS") counts.oversold++;
      if (s.flags.includes("VOL_SPIKE")) counts.volSpike++;
    }
    return counts;
  }, [pins, signals]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="border" style={{ borderColor: colors.border, background: "#000" }}>
      {/* ── Section header ── */}
      <div
        className="flex flex-wrap items-center gap-1 px-1 py-0.5 border-b"
        style={{ borderColor: colors.border, background: "#111" }}
      >
        {/* No "WATCHLIST" caption here: the panel this sits inside already
            carries that heading, and repeating it read as two nested sections. */}
        <Pin className="h-3 w-3 shrink-0" style={{ color: colors.accent }} />
        <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
          ({pins.length})
        </span>

        {/* Actions sit first: the panel is used squeezed, and when they lived
            after the signal summary ADD/GRP were clipped off the right edge. */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            title="Add symbol"
            className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 border font-bold hover:opacity-80"
            style={{ borderColor: `${colors.accent}44`, color: colors.accent }}
            onClick={() => setShowAddRow((v) => !v)}
          >
            <Plus className="h-2.5 w-2.5" />
            ADD
          </button>

          <div className="relative">
            <button
              type="button"
              title="Groups — create, rename, recolour, delete"
              className="flex items-center gap-0.5 text-[9px] px-1 py-0.5 border font-bold hover:opacity-80"
              style={{
                borderColor: showGroupMgr ? colors.accent : colors.border,
                color: showGroupMgr ? colors.accent : colors.textSecondary,
              }}
              onClick={() => setShowGroupMgr((v) => !v)}
            >
              <Layers className="h-2.5 w-2.5" />
              GRP
            </button>
            {showGroupMgr && (
              <GroupManagerPanel
                groups={groups}
                pins={pins}
                colors={colors}
                onCreateGroup={handleAddGroup}
                onRenameGroup={handleRenameGroup}
                onDeleteGroup={handleDeleteGroup}
                onClose={() => setShowGroupMgr(false)}
              />
            )}
          </div>

          {/* Group filter */}
          {groups.length > 1 && (
            <select
              className="text-[9px] px-1 py-0.5 border font-mono max-w-[72px]"
              style={{
                background: colors.background,
                color: colors.text,
                borderColor: colors.border,
              }}
              value={filterGroup}
              onChange={(e) => {
                setFilterGroup(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">ALL</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name.toUpperCase()}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex-1 basis-0 min-w-0 flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
          {totalAlerts > 0 && (
            <span
              className="text-[9px] px-1.5 py-0 font-bold animate-pulse flex items-center gap-0.5"
              style={{ background: "#ef444420", color: "#ef4444", border: "1px solid #ef444440" }}
              title={`${totalAlerts} price target${totalAlerts === 1 ? "" : "s"} hit`}
            >
              <AlertTriangle className="h-2.5 w-2.5" />
              {totalAlerts}
            </span>
          )}

          <WatchlistAlertsBadge colors={colors} />

          {/* Signal summary — what the daily scan flagged across the whole list */}
          {pins.length > 0 && (
            <div
              className="flex items-center gap-2 text-[9px] font-mono"
              style={{ color: colors.textSecondary }}
            >
              {signalsLoading ? (
                <span className="flex items-center gap-0.5">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  SCAN
                </span>
              ) : (
                <>
                  <span>
                    TREND:<span style={{ color: "#4ade80" }}>▲{signalCounts.up}</span>
                    <span>/</span>
                    <span style={{ color: "#f87171" }}>▼{signalCounts.down}</span>
                  </span>
                  {signalCounts.breakouts > 0 && (
                    <span style={{ color: "#4ade80" }}>BRK {signalCounts.breakouts}</span>
                  )}
                  {signalCounts.breakdowns > 0 && (
                    <span style={{ color: "#f87171" }}>BRKDN {signalCounts.breakdowns}</span>
                  )}
                  {signalCounts.freshCross > 0 && (
                    <span style={{ color: colors.accent }}>MACD× {signalCounts.freshCross}</span>
                  )}
                  {signalCounts.overbought > 0 && (
                    <span style={{ color: "#ff9900" }}>OB {signalCounts.overbought}</span>
                  )}
                  {signalCounts.oversold > 0 && (
                    <span style={{ color: "#4ade80" }}>OS {signalCounts.oversold}</span>
                  )}
                  {signalCounts.volSpike > 0 && (
                    <span style={{ color: "#ff9900" }}>VOL⇧ {signalCounts.volSpike}</span>
                  )}
                </>
              )}
            </div>
          )}

          {syncStatus === "syncing" && (
            <span
              className="flex items-center gap-0.5 text-[8px]"
              style={{ color: colors.textSecondary }}
            >
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              SYNC
            </span>
          )}
          {syncStatus === "ok" && (
            <span className="text-[8px]" style={{ color: "#4ade8066" }}>
              DB
            </span>
          )}
          {syncStatus === "error" && (
            <span className="text-[8px]" title={syncError} style={{ color: "#f8717166" }}>
              LOCAL
            </span>
          )}
          {mutError && (
            <button
              type="button"
              title={`${mutError} — change was rolled back. Click to dismiss.`}
              className="flex items-center gap-0.5 text-[8px] px-1 border"
              style={{ color: "#f87171", borderColor: "#f8717166" }}
              onClick={() => setMutError("")}
            >
              <AlertTriangle className="h-2.5 w-2.5" />
              {mutError.toUpperCase()}
              <X className="h-2 w-2" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            title="Refresh"
            className="p-0.5 hover:opacity-70"
            onClick={fetchQuotes}
            disabled={loadingQuotes}
          >
            {loadingQuotes ? (
              <Loader2 className="h-3 w-3 animate-spin" style={{ color: colors.textSecondary }} />
            ) : (
              <RefreshCw className="h-3 w-3" style={{ color: colors.textSecondary }} />
            )}
          </button>

          <div className="relative">
            <button
              type="button"
              title="Tags"
              className="flex items-center gap-0.5 text-[9px] px-1 py-0.5 border font-bold hover:opacity-80"
              style={{ borderColor: colors.border, color: colors.textSecondary }}
              onClick={() => setShowTagMgr((v) => !v)}
            >
              <Tag className="h-2.5 w-2.5" />
            </button>
            {showTagMgr && (
              <TagManagerPanel
                tags={tags}
                colors={colors}
                onCreateTag={handleCreateTag}
                onDeleteTag={handleDeleteTag}
                onClose={() => setShowTagMgr(false)}
              />
            )}
          </div>

          <button
            type="button"
            title={`View: ${VIEW_MODE_LABEL[viewMode]} — click for ${VIEW_MODE_LABEL[nextViewMode(viewMode)]}`}
            className="text-[8px] font-bold tracking-wider px-0.5 hover:opacity-80"
            style={{ color: colors.textSecondary }}
            onClick={cycleViewMode}
          >
            {VIEW_MODE_LABEL[viewMode]}
          </button>

          <button
            type="button"
            className="p-0.5 hover:opacity-70"
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? (
              <ChevronDown className="h-3 w-3" style={{ color: colors.textSecondary }} />
            ) : (
              <ChevronUp className="h-3 w-3" style={{ color: colors.textSecondary }} />
            )}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div>
          {/* Add / Edit forms — shown above both table and card views */}
          {showAddRow && (
            <AddCardForm
              groupId={groups[0]?.id ?? "watchlist"}
              groups={groups}
              colors={colors}
              onAdd={handleAddPin}
              onCancel={() => setShowAddRow(false)}
            />
          )}
          {editingId &&
            !showAddRow &&
            (() => {
              const editPin = pins.find((p) => p.id === editingId);
              return editPin ? (
                <EditCardForm
                  pin={editPin}
                  groups={groups}
                  allTags={tags}
                  colors={colors}
                  onSave={handleSaveEdit}
                  onCancel={() => setEditingId(null)}
                  onDelete={handleDeletePin}
                />
              ) : null;
            })()}

          {pins.length === 0 && !showAddRow && (
            <div className="py-4 text-center" style={{ color: colors.textSecondary }}>
              <div className="text-[10px]">
                No symbols. Press <span style={{ color: colors.accent }}>+ADD</span> or pin from
                EQUITY view.
              </div>
            </div>
          )}

          {/* Progress line only until everything has loaded, or while an update is delayed — a
              permanent "PRICES 17/17 · SIGNALS 17/17" cost a row for nothing. */}
          {quoteTotal > 0 &&
            (quotesLoaded < quoteTotal ||
              Object.keys(quoteErrors).length > 0 ||
              signalErrors.length > 0 ||
              pmErrors.length > 0) && (
              <output
                className="px-2 py-1 text-[9px] flex flex-wrap gap-x-3"
                style={{ color: colors.textSecondary }}
              >
                <span>
                  PRICES {quotesLoaded}/{quoteTotal}
                  {loadingQuotes ? " · updating" : ""}
                </span>
                <span>
                  SIGNALS {Object.keys(signals).length}/{quoteTotal}
                  {signalsLoading ? " · updating" : ""}
                </span>
                {(Object.keys(quoteErrors).length > 0 ||
                  signalErrors.length > 0 ||
                  pmErrors.length > 0) && (
                  <span
                    style={{ color: "#f59e0b" }}
                    title={[...Object.values(quoteErrors), ...signalErrors, ...pmErrors].join("\n")}
                  >
                    UPDATE DELAYED · {Object.keys(quoteErrors).length} prices /{" "}
                    {signalErrors.length} signals / {pmErrors.length} PM — previous values retained
                  </span>
                )}
              </output>
            )}
          {pageCount > 1 && (
            <div
              className="px-2 py-1 flex items-center justify-between text-[10px]"
              style={{ color: colors.textSecondary }}
            >
              <button
                type="button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
                className="disabled:opacity-30"
              >
                ← PREV
              </button>
              <span>
                {pageOffset + 1}–{Math.min(pageOffset + pageSize, sortedPins.length)} /{" "}
                {sortedPins.length} · sorted across the full list
              </span>
              <button
                type="button"
                disabled={currentPage + 1 === pageCount}
                onClick={() => setPage(currentPage + 1)}
                className="disabled:opacity-30"
              >
                NEXT →
              </button>
            </div>
          )}

          {/* ── CARD VIEW ─────────────────────────────────────────────────── */}
          {(pins.length > 0 || showAddRow) && viewMode === "cards" && (
            <div
              className="grid gap-px overflow-y-auto"
              style={{
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                background: colors.border,
                maxHeight: "calc(100vh - 200px)",
              }}
            >
              {displayedPins.map((pin, pageIdx) => {
                const visualIdx = pageOffset + pageIdx;
                const q = quotes[pin.symbol];
                const group = groups.find((g) => g.id === pin.groupId);
                const dotColor = group?.color ?? "#94a3b8";
                const price = q?.regularMarketPrice;
                const pct = q?.regularMarketChangePercent ?? 0;
                const isUp = pct >= 0;
                const pctColor = isUp ? "#00FF00" : "#FF4444";
                const buyAlert = price != null && pin.buyTarget != null && price <= pin.buyTarget;
                const sellAlert =
                  price != null && pin.sellTarget != null && price >= pin.sellTarget;
                const hasAlert = buyAlert || sellAlert;
                const sincePin =
                  price != null && pin.priceAtPin != null && pin.priceAtPin > 0
                    ? ((price - pin.priceAtPin) / pin.priceAtPin) * 100
                    : null;
                const spark = sparklines[pin.symbol] ?? [];
                const cardSig = signals[pin.symbol];
                const isDragOver = dragOverIdx === visualIdx && dragIdx !== visualIdx;

                // Editing pin is shown above the grid — hide the card
                if (editingId === pin.id) return null;

                return (
                  <SymbolContextMenu
                    key={pin.id}
                    symbol={pin.symbol}
                    colors={colors}
                    onOpen={handleSymbolClick}
                    onRemove={() => handleDeletePin(pin.id)}
                  >
                    <div
                      // biome-ignore lint/a11y/useSemanticElements: a real <button> cannot be the drag source for the reorder handlers this card carries
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleSymbolClick(pin.symbol, e);
                        }
                      }}
                      draggable
                      onDragStart={() => setDragIdx(visualIdx)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOverIdx(visualIdx);
                      }}
                      onDrop={() => {
                        if (dragIdx !== null) handleReorder(dragIdx, visualIdx);
                        setDragIdx(null);
                        setDragOverIdx(null);
                      }}
                      onDragEnd={() => {
                        setDragIdx(null);
                        setDragOverIdx(null);
                      }}
                      className="group/card flex flex-col cursor-pointer transition-opacity p-1.5 min-h-[90px] hover:brightness-125"
                      style={{
                        background: hasAlert ? (sellAlert ? "#ef444408" : "#22c55e08") : "#000",
                        borderTop: isDragOver ? "2px solid #00FFFF" : `2px solid ${dotColor}`,
                        opacity: dragIdx === visualIdx ? 0.4 : 1,
                      }}
                      onClick={(e) => handleSymbolClick(pin.symbol, e)}
                    >
                      {/* Top row: symbol + alert + action icons */}
                      <div className="flex items-start justify-between gap-0.5 mb-0.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-0.5 flex-wrap">
                            <span
                              className="text-[10px] font-bold font-mono leading-tight"
                              style={{ color: colors.accent }}
                            >
                              {pin.symbol}
                            </span>
                            {quoteErrors[pin.symbol] && (
                              <span
                                className="text-[8px] text-amber-400"
                                title={quoteErrors[pin.symbol]}
                              >
                                PRICE DELAYED
                              </span>
                            )}
                            {hasAlert && (
                              <span
                                className="text-[7px] px-0.5 font-bold animate-pulse"
                                style={{
                                  background: sellAlert ? "#ef444420" : "#22c55e20",
                                  color: sellAlert ? "#ef4444" : "#4ade80",
                                }}
                              >
                                {sellAlert ? "SELL" : "BUY"}
                              </span>
                            )}
                            {/* biome-ignore lint/a11y/useKeyWithClickEvents: the trigger button inside stops propagation and is itself keyboard-reachable */}
                            <span onClick={(e) => e.stopPropagation()}>
                              <AlertBellCell
                                symbol={pin.symbol}
                                colors={colors}
                                hoverVisibilityClass="group-hover/card:opacity-40"
                              />
                            </span>
                          </div>
                          {q?.shortName && (
                            <div
                              className="text-[7px] truncate leading-tight"
                              style={{ color: colors.textSecondary }}
                            >
                              {q.shortName}
                            </div>
                          )}
                        </div>
                        {/* Edit / delete — visible on hover */}
                        {/* biome-ignore lint/a11y/useKeyWithClickEvents: not a control — the handler only stops the card's click from firing; the buttons inside are keyboard-reachable on their own */}
                        <div
                          className="flex gap-0.5 shrink-0 opacity-0 group-hover/card:opacity-100 transition-opacity"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button type="button" title="Edit" onClick={() => setEditingId(pin.id)}>
                            <Edit3
                              className="h-2.5 w-2.5"
                              style={{ color: colors.textSecondary }}
                            />
                          </button>
                          <button
                            type="button"
                            title="Delete"
                            onClick={() => handleDeletePin(pin.id)}
                          >
                            <Trash2 className="h-2 w-2 text-red-400" />
                          </button>
                        </div>
                      </div>

                      {/* %Change */}
                      <div className="flex items-baseline gap-1">
                        {(() => {
                          const stale = staleMoveStyle(q);
                          return (
                            <>
                              <span
                                className="text-[9px] font-bold font-mono"
                                style={{ color: pctColor, opacity: stale?.opacity }}
                                title={stale?.title}
                              >
                                {isUp ? "▲" : "▼"}
                                {fmtPct(pct)}
                              </span>
                              {stale?.tag && (
                                <span
                                  className="text-[7px] font-bold font-mono"
                                  style={{ color: colors.textSecondary }}
                                >
                                  {stale.tag}
                                </span>
                              )}
                            </>
                          );
                        })()}
                        <SessionGlyph state={q?.marketState} />
                        {sincePin != null && (
                          <span
                            className="text-[7px] font-mono"
                            style={{ color: sincePin >= 0 ? "#4ade8066" : "#f8717166" }}
                          >
                            {sincePin >= 0 ? "+" : ""}
                            {sincePin.toFixed(1)}% pin
                          </span>
                        )}
                      </div>
                      <SessionRow quote={q} colors={colors} />

                      {/* Signals — same daily scan as the table view, compacted */}
                      {cardSig && (
                        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                          <ScoreChip score={cardSig.score} />
                          <TrendCell state={cardSig.trend.state} />
                          <RsiCell rsi={cardSig.rsi} />
                          {cardSig.breakout.state !== "NONE" && <BreakoutCell sig={cardSig} />}
                        </div>
                      )}

                      {/* Sparkline */}
                      <div className="mt-auto pt-0.5">
                        <MiniSparkline prices={spark} isUp={isUp} />
                      </div>

                      {/* Comment */}
                      {pin.comment && (
                        <div
                          className="text-[7px] truncate mt-0.5"
                          style={{ color: `${dotColor}88` }}
                        >
                          {pin.comment}
                        </div>
                      )}
                    </div>
                  </SymbolContextMenu>
                );
              })}

              {/* Summary footer — spans all 3 columns */}
              {pins.length > 0 && (
                <div
                  className="col-span-3 px-2 py-1 flex items-center gap-3 text-[9px] font-mono"
                  style={{
                    background: "#0a0a0a",
                    borderTop: `1px solid ${colors.border}`,
                    color: colors.textSecondary,
                  }}
                >
                  <span style={{ color: colors.accent }}>TOTAL {filteredPins.length}</span>
                  {(() => {
                    const pcts = filteredPins
                      .map((p) => quotes[p.symbol]?.regularMarketChangePercent)
                      .filter((v): v is number => v != null);
                    if (!pcts.length) return null;
                    const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
                    return (
                      <span style={{ color: avg >= 0 ? "#00FF00" : "#FF0000" }}>
                        Avg {fmtPct(avg)}
                      </span>
                    );
                  })()}
                  {(() => {
                    const rets = filteredPins
                      .map((p) => {
                        const q = quotes[p.symbol];
                        if (!q?.regularMarketPrice || !p.priceAtPin || p.priceAtPin <= 0)
                          return null;
                        return ((q.regularMarketPrice - p.priceAtPin) / p.priceAtPin) * 100;
                      })
                      .filter((v): v is number => v != null);
                    if (!rets.length) return null;
                    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
                    return (
                      <span
                        className="font-bold ml-auto"
                        style={{ color: avg >= 0 ? "#00FF00" : "#FF0000" }}
                      >
                        PIN RTN {fmtPct(avg)}
                      </span>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* ── COMPACT VIEW (default) — TICK DATA grammar ─────────────────── */}
          {pins.length > 0 &&
            viewMode === "compact" &&
            (() => {
              const sortHead = (label: string, key: string, left = false) => (
                // biome-ignore lint/a11y/useKeyWithClickEvents: sort header in a dense board; the same sorts are keyboard-reachable in the TABLE view
                <th
                  className={`px-1 py-0 cursor-pointer select-none hover:opacity-80 ${left ? "text-left" : "text-right"}`}
                  style={{ color: sortKey === key ? "#00FFFF" : undefined }}
                  onClick={() => handleSort(key)}
                >
                  {label}
                  {sortKey === key ? (sortDir === "asc" ? "▲" : "▼") : ""}
                </th>
              );
              // More than one group and no filter → groups become foldable
              // sections like TICK DATA's regions; sort order holds inside each.
              const sections =
                groups.length > 1 && filterGroup === "all"
                  ? groups
                      .map((g) => ({
                        group: g as PinGroup | null,
                        rows: displayedPins.filter((p) => p.groupId === g.id),
                      }))
                      .filter((sec) => sec.rows.length > 0)
                  : [{ group: null as PinGroup | null, rows: displayedPins }];
              const extLabel = extLabelOf(displayedPins.map((p) => quotes[p.symbol]));
              const cols = COMPACT_COLS + (extLabel ? 2 : 0);
              const rowFor = (pin: PinnedAsset) => {
                const idx = pageOffset + displayedPins.indexOf(pin);
                return (
                  <CompactWatchRow
                    key={pin.id}
                    pin={pin}
                    quote={quotes[pin.symbol]}
                    score={signals[pin.symbol]?.score}
                    quoteError={quoteErrors[pin.symbol]}
                    colors={colors}
                    onOpen={stableOpen}
                    onEdit={setEditingId}
                    onRemove={stableRemove}
                    index={idx}
                    isDragging={dragIdx === idx}
                    isDragOver={dragOverIdx === idx && dragIdx !== idx}
                    onDragStartRow={rowDragStart}
                    onDragOverRow={rowDragOver}
                    onDropRow={rowDrop}
                    onDragEndRow={rowDragEnd}
                    showExt={extLabel != null}
                  />
                );
              };
              return (
                <table
                  className="w-full text-[9px] leading-[13px] font-mono"
                  style={{ borderCollapse: "collapse" }}
                >
                  <thead>
                    <tr
                      className="text-[7px] font-bold tracking-wider leading-[12px]"
                      style={{ background: "#050505", color: colors.textSecondary }}
                    >
                      {sortHead("SYM", "symbol", true)}
                      {sortHead("LAST", "price")}
                      {sortHead("CHG", "pctChange")}
                      {extLabel && <ExtHead label={extLabel} />}
                      {sortHead("SIG", "score")}
                    </tr>
                  </thead>
                  <tbody>
                    {sections.map(({ group, rows }) => {
                      if (!group) return rows.map(rowFor);
                      const folded = foldedGroups.includes(group.id);
                      return [
                        <tr key={`g-${group.id}`}>
                          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the fold header mirrors TICK DATA's RegionHeader; the SYM/LAST sort and the table view stay keyboard-reachable */}
                          <td
                            colSpan={cols}
                            className="px-1 py-0 text-[8px] font-bold tracking-widest cursor-pointer hover:bg-[#141414] leading-[14px]"
                            style={{
                              background: "#0a0a0a",
                              color: group.color,
                              borderBottom: `1px solid ${colors.border}`,
                            }}
                            onClick={() => toggleGroupFold(group.id)}
                          >
                            {folded ? "▸" : "▾"} {group.name.toUpperCase()}{" "}
                            <span style={{ color: colors.textSecondary }}>{rows.length}</span>
                          </td>
                        </tr>,
                        ...(folded ? [] : rows.map(rowFor)),
                      ];
                    })}
                  </tbody>
                </table>
              );
            })()}

          {/* ── TABLE VIEW ───────────────────────────────────────── */}
          {(pins.length > 0 || showAddRow) &&
            viewMode === "table" &&
            (() => {
              const SortTh = ({
                label,
                sortId,
                align = "right",
              }: { label: string; sortId: string; align?: "left" | "right" }) => (
                <th
                  className="px-1 py-0.5 cursor-pointer select-none whitespace-nowrap hover:opacity-80"
                  style={{
                    color: sortKey === sortId ? "#00FFFF" : colors.textSecondary,
                    textAlign: align,
                  }}
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: the header cell IS the sort control; it has to be focusable for the handler below to be reachable
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    if (sortKey === sortId) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                    else {
                      setSortKey(sortId);
                      setSortDir("asc");
                    }
                  }}
                  onClick={() => {
                    if (sortKey === sortId) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                    else {
                      setSortKey(sortId);
                      setSortDir("asc");
                    }
                  }}
                >
                  <span className="text-[9px] font-bold tracking-wider">
                    {label}
                    {sortKey === sortId ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                  </span>
                </th>
              );
              /** Same sort behaviour as SortTh but renders inline, so several can
               *  share one header cell (the signal grid, TICKER/Δ%/LAST). */
              const SortChip = ({
                label,
                sortId,
                defaultDir = "asc",
                dim = false,
                tiny = false,
              }: {
                label: string;
                sortId: string;
                defaultDir?: "asc" | "desc";
                dim?: boolean;
                tiny?: boolean;
              }) => {
                const active = sortKey === sortId;
                return (
                  <span
                    className={`${tiny ? "text-[8px]" : "text-[9px] tracking-wider"} font-bold cursor-pointer select-none hover:opacity-80`}
                    style={{
                      color: active
                        ? "#00FFFF"
                        : dim
                          ? `${colors.textSecondary}88`
                          : colors.textSecondary,
                    }}
                    title={`Sort by ${label}`}
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: inline sort control — several share one header cell, so each needs its own focus stop
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      if (active) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                      else {
                        setSortKey(sortId);
                        setSortDir(defaultDir);
                      }
                    }}
                    onClick={() => {
                      if (active) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                      else {
                        setSortKey(sortId);
                        setSortDir(defaultDir);
                      }
                    }}
                  >
                    {label}
                    {active ? (sortDir === "asc" ? "▲" : "▼") : ""}
                  </span>
                );
              };
              return (
                <div className="overflow-x-auto">
                  <table
                    className="w-full text-[10px] font-mono"
                    style={{ borderCollapse: "collapse" }}
                  >
                    <thead>
                      <tr
                        style={{
                          background: "#0a0a0a",
                          borderBottom: `1px solid ${colors.border}`,
                        }}
                      >
                        <th className="px-0.5 py-0.5 w-3" />
                        <th className="px-1 py-0.5 w-4" />
                        {/* CHG / %CHG live inside TICKER now — the panel is too narrow
                          to spend two columns on them. The Δ% chip keeps the
                          sort-by-change affordance that the dropped column had. */}
                        <th className="px-1 py-0.5 text-left whitespace-nowrap select-none">
                          <SortChip label="TICKER" sortId="symbol" />
                          <span className="ml-1">
                            <SortChip label="Δ%" sortId="pctChange" defaultDir="desc" dim />
                          </span>
                          <span className="ml-1">
                            <SortChip label="LAST" sortId="price" defaultDir="desc" dim />
                          </span>
                        </th>
                        {/* Six signals share one column as a 3×2 grid — the panel is
                          too narrow for six separate columns. Each label still sorts. */}
                        <th className="px-0.5 py-0.5 select-none whitespace-nowrap">
                          {/* Fixed track widths, not 1fr: inside an auto-layout table
                            the cell collapses and fr columns resolve to 0. The same
                            template is used by the body so the two grids line up. */}
                          <div className={`grid ${SIGNAL_GRID_COLS} gap-x-1 text-right`}>
                            <SortChip label="SIG" sortId="score" defaultDir="desc" tiny />
                            <SortChip label="TRD" sortId="trend" defaultDir="desc" tiny />
                            <SortChip label="RSI" sortId="rsi" defaultDir="desc" tiny />
                            <SortChip label="MCD" sortId="macd" defaultDir="desc" tiny />
                            <SortChip label="BRK" sortId="breakout" defaultDir="desc" tiny />
                            <SortChip label="ATR" sortId="atr" defaultDir="desc" tiny />
                          </div>
                        </th>
                        <SortTh label="VOLUME" sortId="rvol" />
                        {/* Polymarket implied P(up) over that market's own horizon */}
                        <SortTh label="PM" sortId="pm" />
                        <th className="px-1 py-0.5 text-right whitespace-nowrap">
                          <span
                            className="text-[9px] font-bold tracking-wider"
                            style={{ color: "#4ade80" }}
                          >
                            BUY
                          </span>
                          <span
                            className="text-[9px] mx-0.5"
                            style={{ color: colors.textSecondary }}
                          >
                            /
                          </span>
                          <span
                            className="text-[9px] font-bold tracking-wider"
                            style={{ color: "#f87171" }}
                          >
                            SELL
                          </span>
                        </th>
                        <SortTh label="PIN RTN" sortId="sincePin" />
                        <th className="px-1 py-0.5 w-6" />
                      </tr>
                    </thead>
                    <tbody>
                      {displayedPins.map((pin, pageIdx) => {
                        const visualIdx = pageOffset + pageIdx;
                        const q = quotes[pin.symbol];
                        const sig = signals[pin.symbol];
                        const group = groups.find((g) => g.id === pin.groupId);
                        const dotColor = group?.color ?? "#94a3b8";
                        const price = q?.regularMarketPrice;
                        const pct = q?.regularMarketChangePercent ?? 0;
                        const chg = q?.regularMarketChange ?? 0;
                        const isUp = pct >= 0;
                        const pctColor = isUp ? "#00FF00" : "#FF0000";
                        const buyAlert =
                          price != null && pin.buyTarget != null && price <= pin.buyTarget;
                        const sellAlert =
                          price != null && pin.sellTarget != null && price >= pin.sellTarget;
                        const hasAlert = buyAlert || sellAlert;
                        const sincePin =
                          price != null && pin.priceAtPin != null && pin.priceAtPin > 0
                            ? ((price - pin.priceAtPin) / pin.priceAtPin) * 100
                            : null;
                        const pinTagObjects = (pin.tags ?? [])
                          .map((tid) => tags.find((t) => t.id === tid))
                          .filter(Boolean) as PinTag[];
                        const isEditing = editingId === pin.id;
                        const isDragOver = dragOverIdx === visualIdx && dragIdx !== visualIdx;

                        return (
                          <SymbolContextMenu
                            key={pin.id}
                            symbol={pin.symbol}
                            colors={colors}
                            onOpen={handleSymbolClick}
                            onRemove={() => handleDeletePin(pin.id)}
                          >
                            <tr
                              draggable
                              onDragStart={() => setDragIdx(visualIdx)}
                              onDragOver={(e) => {
                                e.preventDefault();
                                setDragOverIdx(visualIdx);
                              }}
                              onDrop={() => {
                                if (dragIdx !== null) handleReorder(dragIdx, visualIdx);
                                setDragIdx(null);
                                setDragOverIdx(null);
                              }}
                              onDragEnd={() => {
                                setDragIdx(null);
                                setDragOverIdx(null);
                              }}
                              className="group/row hover:bg-[#111] transition-colors"
                              style={{
                                borderBottom: "1px solid #1a1a1a",
                                borderTop: isDragOver ? "2px solid #00FFFF" : undefined,
                                opacity: dragIdx === visualIdx ? 0.4 : 1,
                                background: isEditing
                                  ? `${colors.accent}15`
                                  : hasAlert
                                    ? sellAlert
                                      ? "#ef444408"
                                      : "#22c55e08"
                                    : undefined,
                              }}
                            >
                              <td className="px-0.5 py-0.5 cursor-grab active:cursor-grabbing">
                                <GripVertical
                                  className="h-2.5 w-2.5"
                                  style={{ color: colors.textSecondary, opacity: 0.4 }}
                                />
                              </td>
                              <td className="px-1 py-0.5 text-center">
                                {/* Group indicator: was a flat colour square that read as
                                    decoration until you had a second group to compare it
                                    against. An icon plus tooltip says what it is on its
                                    own, same glyph as the "New group" toolbar button. */}
                                <Layers
                                  className="h-2.5 w-2.5 inline-block"
                                  style={{ color: dotColor }}
                                  aria-label={group?.name ?? "Watchlist"}
                                >
                                  <title>{group?.name ?? "Watchlist"}</title>
                                </Layers>
                              </td>
                              <td className="px-1 py-0.5">
                                <div className="flex items-center gap-1 min-w-0">
                                  <button
                                    type="button"
                                    className="font-bold hover:opacity-70 flex items-center gap-0.5 shrink-0"
                                    style={{ color: colors.accent }}
                                    onClick={(e) => handleSymbolClick(pin.symbol, e)}
                                  >
                                    {pin.symbol}
                                    {quoteErrors[pin.symbol] && (
                                      <span
                                        className="text-[8px] text-amber-400"
                                        title={quoteErrors[pin.symbol]}
                                      >
                                        !
                                      </span>
                                    )}
                                    <ExternalLink className="h-2 w-2 opacity-0 group-hover/row:opacity-50" />
                                  </button>
                                  {/* Company name inline, not on its own row — at this
                                      size it read as a caption under every ticker and
                                      cost a full line per row for something secondary.
                                      Shrinks and truncates before anything else does. */}
                                  {q?.shortName && (
                                    <span
                                      className="text-[8px] truncate min-w-0"
                                      style={{ color: colors.textSecondary, flexShrink: 100 }}
                                      title={q.shortName}
                                    >
                                      {q.shortName}
                                    </span>
                                  )}
                                  {hasAlert && (
                                    <span
                                      className="text-[8px] px-1 py-0 font-bold animate-pulse"
                                      style={{
                                        background: sellAlert ? "#ef444422" : "#22c55e22",
                                        color: sellAlert ? "#ef4444" : "#4ade80",
                                        border: `1px solid ${sellAlert ? "#ef444444" : "#22c55e44"}`,
                                      }}
                                    >
                                      {sellAlert ? "SELL" : "BUY"}
                                    </span>
                                  )}
                                  {pinTagObjects.map((t) => (
                                    <TagChip key={t.id} tag={t} />
                                  ))}
                                  <AlertBellCell symbol={pin.symbol} colors={colors} />
                                </div>
                                {/* LAST / %CHG / CHG sit on their own line under the
                                symbol — as columns they pushed the signal grid far
                                away from the ticker in a ~370px panel. */}
                                {q &&
                                  (() => {
                                    // A move from a session that has already ended
                                    // is dimmed and dated, so it cannot be read as
                                    // today's.
                                    const stale = staleMoveStyle(q);
                                    return (
                                      <div
                                        className="font-mono whitespace-nowrap leading-tight"
                                        title={stale?.title}
                                      >
                                        {price != null && (
                                          <span
                                            className="font-bold"
                                            style={{ color: colors.text }}
                                          >
                                            ${fmtPrice(price)}
                                          </span>
                                        )}
                                        <span
                                          className="ml-1"
                                          style={{ color: pctColor, opacity: stale?.opacity }}
                                        >
                                          <span className="text-[8px]">{isUp ? "▲" : "▼"}</span>
                                          <span className="font-bold">{fmtPct(pct)}</span>
                                          <span
                                            className="text-[8px] ml-0.5"
                                            style={{ opacity: 0.75 }}
                                          >
                                            {isUp ? "+" : ""}
                                            {chg.toFixed(2)}
                                          </span>
                                        </span>
                                        {stale?.tag && (
                                          <span
                                            className="text-[7px] ml-0.5 font-bold"
                                            style={{ color: colors.textSecondary }}
                                          >
                                            {stale.tag}
                                          </span>
                                        )}
                                        <SessionGlyph state={q.marketState} className="ml-1" />
                                      </div>
                                    );
                                  })()}
                                <SessionRow quote={q} colors={colors} />
                                {pin.comment && (
                                  <button
                                    type="button"
                                    className="flex items-center gap-0.5 text-[8px] hover:opacity-70 max-w-[120px]"
                                    style={{ color: `${dotColor}99` }}
                                    onClick={() =>
                                      setExpandedComment(expandedComment === pin.id ? null : pin.id)
                                    }
                                  >
                                    <MessageSquare className="h-2 w-2 shrink-0" />
                                    <span
                                      className={
                                        expandedComment === pin.id
                                          ? "whitespace-pre-wrap"
                                          : "truncate"
                                      }
                                    >
                                      {pin.comment}
                                    </span>
                                  </button>
                                )}
                              </td>
                              {/* 3×2 signal grid — column order matches the header chips */}
                              <td className="px-0.5 py-0.5 whitespace-nowrap">
                                <div
                                  className={`grid ${SIGNAL_GRID_COLS} gap-x-1 gap-y-0 text-right leading-tight`}
                                >
                                  <span>
                                    <ScoreChip score={sig?.score} />
                                  </span>
                                  <span>
                                    <TrendCell state={sig?.trend.state} />
                                  </span>
                                  <span>
                                    <RsiCell rsi={sig?.rsi} />
                                  </span>
                                  <span>
                                    <MacdCell macd={sig?.macd} />
                                  </span>
                                  <span>
                                    <BreakoutCell sig={sig} />
                                  </span>
                                  <span>
                                    <AtrCell atrPct={sig?.atrPct} />
                                  </span>
                                </div>
                              </td>
                              <td className="px-1 py-0.5 text-right">
                                <VolumeBar
                                  current={q?.regularMarketVolume}
                                  avg={q?.averageDailyVolume3Month}
                                  rvol={sig?.rvol}
                                  colors={colors}
                                />
                              </td>
                              <td className="px-1 py-0.5 text-right">
                                <PredictionCell summary={pmSummaries[pin.symbol]} colors={colors} />
                              </td>
                              <td className="px-1 py-0.5 text-right">
                                <div className="flex items-center justify-end gap-1">
                                  {pin.buyTarget != null ? (
                                    <span
                                      style={{ color: buyAlert ? "#4ade80" : colors.textSecondary }}
                                    >
                                      <span className="text-[8px]">B</span>$
                                      {fmtPrice(pin.buyTarget)}
                                      {price != null && (
                                        <span
                                          className="text-[8px] ml-0.5"
                                          style={{ color: colors.textSecondary }}
                                        >
                                          ({(((pin.buyTarget - price) / price) * 100).toFixed(0)}%)
                                        </span>
                                      )}
                                    </span>
                                  ) : (
                                    <span style={{ color: "#222" }}>—</span>
                                  )}
                                  <span style={{ color: "#333" }}>|</span>
                                  {pin.sellTarget != null ? (
                                    <span
                                      style={{
                                        color: sellAlert ? "#ef4444" : colors.textSecondary,
                                      }}
                                    >
                                      <span className="text-[8px]">S</span>$
                                      {fmtPrice(pin.sellTarget)}
                                      {price != null && (
                                        <span
                                          className="text-[8px] ml-0.5"
                                          style={{ color: colors.textSecondary }}
                                        >
                                          ({(((pin.sellTarget - price) / price) * 100).toFixed(0)}%)
                                        </span>
                                      )}
                                    </span>
                                  ) : (
                                    <span style={{ color: "#222" }}>—</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-1 py-0.5 text-right font-bold">
                                {sincePin != null ? (
                                  <div>
                                    <span style={{ color: sincePin >= 0 ? "#00FF00" : "#FF0000" }}>
                                      {fmtPct(sincePin)}
                                    </span>
                                    {pin.priceAtPin != null && (
                                      <div
                                        className="text-[8px]"
                                        style={{ color: colors.textSecondary }}
                                      >
                                        @{fmtPrice(pin.priceAtPin)}
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <span style={{ color: colors.textSecondary }}>—</span>
                                )}
                              </td>
                              <td className="px-1 py-0.5 text-center">
                                <div className="flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity">
                                  <button
                                    type="button"
                                    title="Edit"
                                    onClick={() => setEditingId(isEditing ? null : pin.id)}
                                  >
                                    <Edit3
                                      className="h-2.5 w-2.5"
                                      style={{
                                        color: isEditing ? colors.accent : colors.textSecondary,
                                      }}
                                    />
                                  </button>
                                  <button
                                    type="button"
                                    title="Delete"
                                    onClick={() => handleDeletePin(pin.id)}
                                  >
                                    <Trash2 className="h-2.5 w-2.5 text-red-400" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          </SymbolContextMenu>
                        );
                      })}

                      {/* Footer row */}
                      {pins.length > 0 && (
                        <tr
                          style={{ borderTop: `1px solid ${colors.border}`, background: "#0a0a0a" }}
                        >
                          <td className="px-1 py-0.5" colSpan={3}>
                            <span
                              className="text-[9px] font-bold tracking-wider"
                              style={{ color: colors.accent }}
                            >
                              TOTAL {filteredPins.length} ASSETS
                            </span>
                            {(() => {
                              const pcts = filteredPins
                                .map((p) => quotes[p.symbol]?.regularMarketChangePercent)
                                .filter((v): v is number => v != null);
                              if (!pcts.length) return null;
                              const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
                              return (
                                <span
                                  className="text-[9px] font-mono ml-2"
                                  style={{ color: avg >= 0 ? "#00FF00" : "#FF0000" }}
                                >
                                  Avg:{fmtPct(avg)}
                                </span>
                              );
                            })()}
                          </td>
                          {/* Signal grid — mean score + trend split, aligned to the
                            first two cells of the 3-column grid above. */}
                          <td className="px-0.5 py-0.5 whitespace-nowrap">
                            <div
                              className={`grid ${SIGNAL_GRID_COLS} gap-x-1 text-right text-[9px] font-mono`}
                            >
                              <span>
                                {(() => {
                                  const vals = filteredPins
                                    .map((p) => signals[p.symbol]?.score)
                                    .filter((v): v is number => v != null);
                                  if (!vals.length) return null;
                                  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
                                  return (
                                    <span
                                      className="font-bold"
                                      style={{
                                        color:
                                          avg > 0
                                            ? "#4ade80"
                                            : avg < 0
                                              ? "#f87171"
                                              : colors.textSecondary,
                                      }}
                                    >
                                      {avg > 0 ? "+" : ""}
                                      {avg.toFixed(1)}
                                    </span>
                                  );
                                })()}
                              </span>
                              <span>
                                {(() => {
                                  const states = filteredPins
                                    .map((p) => signals[p.symbol]?.trend.state)
                                    .filter(Boolean);
                                  if (!states.length) return null;
                                  const up = states.filter((s) => s === "UP").length;
                                  const dn = states.filter((s) => s === "DOWN").length;
                                  return (
                                    <>
                                      <span style={{ color: "#4ade80" }}>▲{up}</span>
                                      <span style={{ color: colors.textSecondary }}>/</span>
                                      <span style={{ color: "#f87171" }}>▼{dn}</span>
                                    </>
                                  );
                                })()}
                              </span>
                              <span />
                            </div>
                          </td>
                          {/* VOLUME · PM · BUY/SELL */}
                          <td colSpan={3} />
                          <td className="px-1 py-0.5 text-right text-[9px]">
                            {(() => {
                              const rets = filteredPins
                                .map((p) => {
                                  const q = quotes[p.symbol];
                                  if (!q?.regularMarketPrice || !p.priceAtPin || p.priceAtPin <= 0)
                                    return null;
                                  return (
                                    ((q.regularMarketPrice - p.priceAtPin) / p.priceAtPin) * 100
                                  );
                                })
                                .filter((v): v is number => v != null);
                              if (!rets.length) return null;
                              const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
                              return (
                                <span
                                  className="font-bold"
                                  style={{ color: avg >= 0 ? "#00FF00" : "#FF0000" }}
                                >
                                  Avg:{fmtPct(avg)}
                                </span>
                              );
                            })()}
                          </td>
                          <td />
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              );
            })()}
        </div>
      )}
    </div>
  );
});
