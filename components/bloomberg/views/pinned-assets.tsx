"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Edit3,
  ExternalLink,
  GripVertical,
  LayoutGrid,
  LayoutList,
  Layers,
  Loader2,
  MessageSquare,
  Pin,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { bloombergColors } from "../lib/theme-config";
import {
  currentViewAtom,
  isDarkModeAtom,
  pinnedAssetsAtom,
  pinGroupsAtom,
  pinTagsAtom,
  stockSearchSymbolAtom,
  type PinGroup,
  type PinnedAsset,
  type PinTag,
} from "../atoms";

// ── Constants ─────────────────────────────────────────────────────────────────

const LS_GROUPS    = "bloomberg_pin_groups";
const LS_PINS      = "bloomberg_pinned_assets";
const LS_TAGS      = "bloomberg_pin_tags";
const LS_PIN_ORDER = "bloomberg_pin_order";
const LS_SORT_KEY  = "bloomberg_pin_sort_key";

const PALETTE = [
  { label: "Gold",    hex: "#f59e0b" },
  { label: "Green",   hex: "#22c55e" },
  { label: "Blue",    hex: "#3b82f6" },
  { label: "Purple",  hex: "#a855f7" },
  { label: "Orange",  hex: "#f97316" },
  { label: "Red",     hex: "#ef4444" },
  { label: "Teal",    hex: "#14b8a6" },
  { label: "Slate",   hex: "#94a3b8" },
];

import { DEFAULT_WATCHLIST_GROUP as DEFAULT_GROUP } from "../core/global-search";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Quote {
  regularMarketPrice:         number;
  regularMarketChangePercent: number;
  regularMarketChange:        number;
  shortName?:                 string;
  longName?:                  string;
  marketCap?:                 number;
  trailingPE?:                number;
  forwardPE?:                 number;
  beta?:                      number;
  regularMarketVolume?:       number;
  averageDailyVolume3Month?:  number;
  fiftyTwoWeekHigh?:          number;
  fiftyTwoWeekLow?:           number;
  dividendYield?:             number;
  epsTrailingTwelveMonths?:   number;
  regularMarketOpen?:         number;
  regularMarketPreviousClose?: number;
  returnOnEquity?:            number;
  returnOnAssets?:            number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPrice(n: number) {
  if (n >= 10000) return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9)  return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6)  return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3)  return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtVol(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e9)  return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6)  return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3)  return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

// ── Order persistence ────────────────────────────────────────────────────────

function saveOrder(pins: PinnedAsset[]) {
  try {
    localStorage.setItem(LS_PIN_ORDER, JSON.stringify(pins.map(p => p.id)));
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
      const ia = orderMap.get(a.id) ?? Infinity;
      const ib = orderMap.get(b.id) ?? Infinity;
      return ia - ib;
    });
  } catch { return pins; }
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
        <button key={hex} title={label} onClick={() => onChange(hex)}
          className="w-4 h-4 border-2 transition-all"
          style={{
            background:  hex,
            borderColor: value === hex ? "#fff" : "transparent",
            transform:   value === hex ? "scale(1.15)" : "scale(1)",
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

// ── 52-Week Range Bar ─────────────────────────────────────────────────────────

function RangeBar52W({ price, low, high, colors }: {
  price: number;
  low: number;
  high: number;
  colors: typeof bloombergColors.dark;
}) {
  const range = high - low;
  if (range <= 0) return null;
  const pct = Math.min(100, Math.max(0, ((price - low) / range) * 100));
  return (
    <div className="flex items-center gap-1 w-full min-w-[60px]">
      <span className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>{fmtPrice(low)}</span>
      <div className="flex-1 h-[3px] relative" style={{ background: "#333" }}>
        <div
          className="absolute top-0 left-0 h-full"
          style={{ width: `${pct}%`, background: pct > 70 ? "#4ade80" : pct < 30 ? "#f87171" : "#ff9900" }}
        />
        <div
          className="absolute top-[-2px] w-[3px] h-[7px]"
          style={{ left: `${pct}%`, background: "#fff", transform: "translateX(-50%)" }}
        />
      </div>
      <span className="text-[8px] font-mono" style={{ color: colors.textSecondary }}>{fmtPrice(high)}</span>
    </div>
  );
}

// ── Volume Bar ────────────────────────────────────────────────────────────────

function VolumeBar({ current, avg, colors }: {
  current: number | null | undefined;
  avg: number | null | undefined;
  colors: typeof bloombergColors.dark;
}) {
  if (!current || !avg || avg === 0) return <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>—</span>;
  const ratio = current / avg;
  const barW = Math.min(100, ratio * 100);
  const barColor = ratio > 1.5 ? "#ff9900" : ratio > 1 ? "#4ade80" : "#555";
  return (
    <div className="flex items-center gap-1">
      <span className="text-[9px] font-mono w-[32px] text-right" style={{ color: colors.text }}>{fmtVol(current)}</span>
      <div className="w-[30px] h-[3px] relative" style={{ background: "#222" }}>
        <div className="absolute top-0 left-0 h-full" style={{ width: `${barW}%`, background: barColor }} />
      </div>
      <span className="text-[8px] font-mono" style={{ color: ratio >= 1 ? "#4ade80" : "#f87171" }}>
        {ratio.toFixed(1)}x
      </span>
    </div>
  );
}

// ── Mini Sparkline ────────────────────────────────────────────────────────────

function MiniSparkline({ prices, isUp }: { prices: number[]; isUp: boolean }) {
  if (prices.length < 2) return <div style={{ height: 36 }} />;
  const W = 100, H = 34;
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
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ── AddGroupInline ────────────────────────────────────────────────────────────

function AddGroupInline({
  colors, onAdd, onCancel,
}: {
  colors: typeof bloombergColors.dark;
  onAdd: (g: PinGroup) => void;
  onCancel: () => void;
}) {
  const [name,  setName]  = useState("");
  const [color, setColor] = useState(PALETTE[0].hex);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onAdd({ id: Date.now().toString(), name: n, color });
  };

  return (
    <div className="flex items-center gap-2 px-2 py-1 border"
      style={{ background: colors.surface, borderColor: colors.border }}>
      <input
        ref={inputRef}
        className="text-xs px-1 py-0.5 border outline-none font-mono w-24"
        style={{ background: colors.background, color: colors.text, borderColor: colors.border }}
        placeholder="Group name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }}
      />
      <ColorPicker value={color} onChange={setColor} />
      <button
        className="text-[10px] px-2 py-0.5 font-bold disabled:opacity-40"
        style={{ background: colors.accent, color: "#000" }}
        disabled={!name.trim()}
        onClick={submit}
      >ADD</button>
      <button onClick={onCancel}><X className="h-3 w-3" style={{ color: colors.textSecondary }} /></button>
    </div>
  );
}

// ── TagManagerPanel ───────────────────────────────────────────────────────────

function TagManagerPanel({
  tags, colors, onCreateTag, onDeleteTag, onClose,
}: {
  tags: PinTag[];
  colors: typeof bloombergColors.dark;
  onCreateTag: (t: PinTag) => void;
  onDeleteTag: (id: string) => void;
  onClose: () => void;
}) {
  const [name,  setName]  = useState("");
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
        <span className="font-bold tracking-widest text-[9px]" style={{ color: colors.accent }}>TAG MANAGER</span>
        <button onClick={onClose}><X className="h-3 w-3" style={{ color: colors.textSecondary }} /></button>
      </div>
      <div className="space-y-0.5 max-h-32 overflow-y-auto">
        {tags.length === 0 && (
          <div className="text-center py-1 opacity-50 text-[9px]" style={{ color: colors.textSecondary }}>No tags</div>
        )}
        {tags.map((t) => (
          <div key={t.id} className="flex items-center justify-between">
            <TagChip tag={t} />
            <button onClick={() => onDeleteTag(t.id)}>
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
          onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }}
        />
        <ColorPicker value={color} onChange={setColor} />
        <button
          className="mt-1 text-[10px] px-2 py-0.5 font-bold w-full disabled:opacity-40"
          style={{ background: colors.accent, color: "#000" }}
          disabled={!name.trim()}
          onClick={submit}
        >CREATE</button>
      </div>
    </div>
  );
}

// ── AddCardForm ───────────────────────────────────────────────────────────────

function AddCardForm({
  groupId, groups, colors, onAdd, onCancel,
}: {
  groupId:  string;
  groups:   PinGroup[];
  colors:   typeof bloombergColors.dark;
  onAdd:    (p: PinnedAsset) => void;
  onCancel: () => void;
}) {
  const [symbol,     setSymbol]     = useState("");
  const [comment,    setComment]    = useState("");
  const [buyTarget,  setBuyTarget]  = useState("");
  const [sellTarget, setSellTarget] = useState("");
  const [selGroup,   setSelGroup]   = useState(groupId);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const iSt = { background: colors.background, color: colors.text, borderColor: colors.border };

  const submit = () => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    onAdd({
      id:         Date.now().toString(),
      symbol:     sym,
      groupId:    selGroup,
      comment:    comment.trim(),
      addedAt:    new Date().toISOString().split("T")[0],
      buyTarget:  buyTarget  ? parseFloat(buyTarget)  : undefined,
      sellTarget: sellTarget ? parseFloat(sellTarget) : undefined,
      priority:   1,
      tags:       [],
    });
  };

  return (
    <div className="col-span-3 flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b"
      style={{ background: `${colors.accent}08`, borderColor: colors.border }}>
      <input ref={inputRef}
        className="text-[10px] px-1.5 py-0.5 border outline-none font-mono font-bold w-20 uppercase"
        style={iSt} placeholder="TICKER" value={symbol}
        onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }} />
      {groups.length > 1 && (
        <select className="text-[9px] px-0.5 py-0.5 border font-mono" style={iSt}
          value={selGroup} onChange={(e) => setSelGroup(e.target.value)}>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      )}
      <input className="text-[10px] px-1 py-0.5 border outline-none font-mono w-14"
        style={{ ...iSt, color: "#4ade80" }}
        type="number" min="0" step="0.01" placeholder="Buy $" value={buyTarget}
        onChange={(e) => setBuyTarget(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }} />
      <input className="text-[10px] px-1 py-0.5 border outline-none font-mono w-14"
        style={{ ...iSt, color: "#f87171" }}
        type="number" min="0" step="0.01" placeholder="Sell $" value={sellTarget}
        onChange={(e) => setSellTarget(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }} />
      <input className="text-[10px] px-1 py-0.5 border outline-none font-mono flex-1 min-w-[60px]" style={iSt}
        placeholder="Note…" value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }} />
      <div className="flex gap-1">
        <button className="text-[9px] px-2 py-0.5 font-bold flex items-center gap-0.5 disabled:opacity-40"
          style={{ background: colors.accent, color: "#000" }} disabled={!symbol.trim()} onClick={submit}>
          <Pin className="h-2.5 w-2.5" />PIN
        </button>
        <button className="text-[9px] px-2 py-0.5"
          style={{ background: colors.border, color: colors.textSecondary }} onClick={onCancel}>ESC</button>
      </div>
    </div>
  );
}

// ── EditCardForm ──────────────────────────────────────────────────────────────

function EditCardForm({
  pin, groups, allTags, colors, onSave, onCancel, onDelete,
}: {
  pin:      PinnedAsset;
  groups:   PinGroup[];
  allTags:  PinTag[];
  colors:   typeof bloombergColors.dark;
  onSave:   (id: string, updates: Partial<PinnedAsset>) => void;
  onCancel: () => void;
  onDelete: (id: string) => void;
}) {
  const [editComment,    setEditComment]    = useState(pin.comment);
  const [editGroupId,    setEditGroupId]    = useState(pin.groupId);
  const [editBuyTarget,  setEditBuyTarget]  = useState(pin.buyTarget?.toString() ?? "");
  const [editSellTarget, setEditSellTarget] = useState(pin.sellTarget?.toString() ?? "");
  const [editPriority,   setEditPriority]   = useState(pin.priority ?? 1);
  const [editTags,       setEditTags]       = useState<string[]>(pin.tags ?? []);

  const iSt = { background: colors.background, color: colors.text, borderColor: colors.border };

  const save = () => {
    onSave(pin.id, {
      comment:    editComment,
      groupId:    editGroupId,
      buyTarget:  editBuyTarget  ? parseFloat(editBuyTarget)  : undefined,
      sellTarget: editSellTarget ? parseFloat(editSellTarget) : undefined,
      priority:   editPriority,
      tags:       editTags,
    });
    onCancel();
  };

  const toggleTag = (tagId: string) =>
    setEditTags((ts) => ts.includes(tagId) ? ts.filter((t) => t !== tagId) : [...ts, tagId]);

  return (
    <div className="col-span-3 flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b"
      style={{ background: `${colors.accent}0a`, borderColor: colors.border }}>
      <span className="font-bold font-mono text-[10px]" style={{ color: colors.accent }}>{pin.symbol}</span>
      <PriorityStars value={editPriority} onChange={setEditPriority} />
      {groups.length > 1 && (
        <select className="text-[9px] px-0.5 py-0.5 border font-mono" style={iSt}
          value={editGroupId} onChange={(e) => setEditGroupId(e.target.value)}>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      )}
      <input className="text-[10px] px-1 py-0.5 border outline-none font-mono w-14"
        style={{ ...iSt, color: "#4ade80" }}
        type="number" min="0" step="0.01" placeholder="Buy $" value={editBuyTarget}
        onChange={(e) => setEditBuyTarget(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") onCancel(); }} />
      <input className="text-[10px] px-1 py-0.5 border outline-none font-mono w-14"
        style={{ ...iSt, color: "#f87171" }}
        type="number" min="0" step="0.01" placeholder="Sell $" value={editSellTarget}
        onChange={(e) => setEditSellTarget(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") onCancel(); }} />
      <input className="text-[10px] px-1 py-0.5 border outline-none font-mono flex-1 min-w-[60px]" style={iSt}
        placeholder="Note…" value={editComment}
        onChange={(e) => setEditComment(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") onCancel(); }} />
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-0.5">
          {allTags.map((t) => (
            <label key={t.id} className="flex items-center gap-0.5 cursor-pointer">
              <input type="checkbox" checked={editTags.includes(t.id)} onChange={() => toggleTag(t.id)} className="w-2 h-2" />
              <span className="text-[8px]" style={{ color: t.color }}>{t.name}</span>
            </label>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <button className="text-[9px] px-1.5 py-0.5 font-bold flex items-center gap-0.5"
          style={{ background: "#22c55e22", color: "#4ade80", border: "1px solid #22c55e44" }} onClick={save}>
          <Check className="h-2.5 w-2.5" />OK
        </button>
        <button className="text-[9px] px-1.5 py-0.5"
          style={{ background: colors.border, color: colors.textSecondary }} onClick={onCancel}>ESC</button>
        <button className="text-[9px] px-1 py-0.5" style={{ color: "#f87171" }} onClick={() => onDelete(pin.id)}>
          <Trash2 className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PinnedAssets({ onSymbolClick }: { onSymbolClick?: (symbol: string) => void } = {}) {
  const [isDarkMode]    = useAtom(isDarkModeAtom);
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  const [groups, setGroups] = useAtom(pinGroupsAtom);
  const [pins,   setPins]   = useAtom(pinnedAssetsAtom);
  const [tags,   setTags]   = useAtom(pinTagsAtom);
  const setCurrentView      = useSetAtom(currentViewAtom);
  const setStockSymbol      = useSetAtom(stockSearchSymbolAtom);

  const [quotes,        setQuotes]        = useState<Record<string, Quote>>({});
  const [loadingQuotes, setLoadingQuotes] = useState(false);
  const [collapsed,     setCollapsed]     = useState(false);
  const [showAddGroup,  setShowAddGroup]  = useState(false);
  const [showTagMgr,    setShowTagMgr]    = useState(false);
  const [showAddRow,    setShowAddRow]    = useState(false);
  const [editingId,     setEditingId]     = useState<string | null>(null);
  const [sortKey,       setSortKey]       = useState<string>("symbol");
  const [sortDir,       setSortDir]       = useState<"asc" | "desc">("asc");
  const [filterGroup,   setFilterGroup]   = useState<string>("all");
  const [expandedComment, setExpandedComment] = useState<string | null>(null);

  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "ok" | "error">("idle");
  const [syncError,  setSyncError]  = useState<string>("");
  const [viewMode,   setViewMode]   = useState<"table" | "cards">("table");

  // Drag-to-reorder state
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const fetchedSparklines = useRef<Set<string>>(new Set());
  const [sparklines, setSparklines] = useState<Record<string, number[]>>({});

  useEffect(() => {
    const symbols = [...new Set(pins.map((p) => p.symbol))];
    for (const sym of symbols) {
      if (fetchedSparklines.current.has(sym)) continue;
      fetchedSparklines.current.add(sym);
      fetch(`/api/stock?type=history&symbol=${encodeURIComponent(sym)}&period=3mo&interval=1d`)
        .then((r) => r.json())
        .then((d) => {
          const prices = (d?.quotes ?? [])
            .filter((q: any) => q.close != null)
            .map((q: any) => q.close as number);
          if (prices.length > 0) setSparklines((prev) => ({ ...prev, [sym]: prices }));
        })
        .catch(() => {});
    }
  }, [pins]);

  // ── localStorage helpers ──────────────────────────────────────────────────

  const saveToLS = useCallback((g: PinGroup[], p: PinnedAsset[], t: PinTag[]) => {
    try {
      localStorage.setItem(LS_GROUPS, JSON.stringify(g));
      localStorage.setItem(LS_PINS,   JSON.stringify(p));
      localStorage.setItem(LS_TAGS,   JSON.stringify(t));
    } catch { /* ignore quota errors */ }
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapAsset = (a: any): PinnedAsset => ({
    id:          a.id,
    symbol:      a.symbol,
    groupId:     a.group_id,
    comment:     a.comment ?? "",
    addedAt:     a.added_at ?? a.addedAt ?? "",
    buyTarget:   a.buy_target ?? undefined,
    sellTarget:  a.sell_target ?? undefined,
    priceAtPin:  a.price_at_pin ?? undefined,
    priority:    a.priority ?? 1,
    tags:        a.tags ?? [],
  });

  // ── Initial load ────────────────────────────────────────────────────────

  const didLoad = useRef(false);
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
        const rawTags   = Array.isArray(tRes) ? tRes : (tRes.tags   ?? []);

        const dbGroups: PinGroup[] = rawGroups.map((g: PinGroup) => ({
          id: g.id, name: g.name, color: g.color,
        }));
        const dbAssets: PinnedAsset[] = rawAssets.map(mapAsset);
        const dbTags:   PinTag[]      = rawTags.map((t: PinTag) => ({
          id: t.id, name: t.name, color: t.color,
        }));

        if (dbGroups.length === 0) {
          const lsGroups = localStorage.getItem(LS_GROUPS);
          const lsPins   = localStorage.getItem(LS_PINS);
          if (lsGroups || lsPins) {
            const migrateGroups: PinGroup[] = lsGroups ? JSON.parse(lsGroups) : [DEFAULT_GROUP];
            const migratePins:   PinnedAsset[] = lsPins ? JSON.parse(lsPins) : [];
            try {
              await apiPost("/api/pins/import", { groups: migrateGroups, assets: migratePins });
              const [g2, a2] = await Promise.all([apiGet("/api/pins/groups"), apiGet("/api/pins/assets")]);
              const rawG2 = Array.isArray(g2) ? g2 : (g2.groups ?? []);
              const rawA2 = Array.isArray(a2) ? a2 : (a2.assets ?? []);
              const migratedGroups = rawG2.map((g: PinGroup) => ({ id: g.id, name: g.name, color: g.color }));
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
            } catch { /* fall through */ }
          }
          if (dbGroups.length === 0) {
            const lsGroupsFallback: PinGroup[] = lsGroups ? JSON.parse(lsGroups) : [DEFAULT_GROUP];
            const lsPinsFallback:   PinnedAsset[] = lsPins ? JSON.parse(lsPins) : [];
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
          const lsPins   = localStorage.getItem(LS_PINS);
          const lsTags   = localStorage.getItem(LS_TAGS);
          const parsed   = lsPins ? JSON.parse(lsPins) : [];
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

  // ── Fetch quotes (full data) ────────────────────────────────────────────

  const fetchQuotes = useCallback(async () => {
    if (!pins.length) return;
    setLoadingQuotes(true);
    const symbols = [...new Set(pins.map((p) => p.symbol))];
    await Promise.all(
      symbols.map(async (sym) => {
        try {
          const res  = await fetch(`/api/stock?type=quote&symbol=${sym}`);
          const data = await res.json();
          if (data?.regularMarketPrice) {
            setQuotes((q) => ({ ...q, [sym]: data as Quote }));
          }
        } catch { /* ignore */ }
      })
    );
    setLoadingQuotes(false);
  }, [pins]);

  useEffect(() => { fetchQuotes(); }, [fetchQuotes]);

  // ── CRUD Handlers ─────────────────────────────────────────────────────────

  const handleAddGroup = async (g: PinGroup) => {
    const newGroups = [...groups, g];
    setGroups(newGroups);
    setShowAddGroup(false);
    saveToLS(newGroups, pins, tags);
    try {
      await apiPost("/api/pins/groups", { id: g.id, name: g.name, color: g.color, sort_order: newGroups.length - 1 });
    } catch (err) { console.error("[handleAddGroup]", err); }
  };

  const handleDeleteGroup = async (id: string) => {
    if (groups.length <= 1) return;
    const fallback = groups.find((g) => g.id !== id)?.id ?? groups[0].id;
    const newGroups = groups.filter((g) => g.id !== id);
    const newPins   = pins.map((p) => p.groupId === id ? { ...p, groupId: fallback } : p);
    setGroups(newGroups);
    setPins(newPins);
    saveToLS(newGroups, newPins, tags);
    try { await apiDelete(`/api/pins/groups/${encodeURIComponent(id)}`); } catch (err) { console.error(err); }
  };

  const handleAddPin = async (pin: PinnedAsset) => {
    const newPins = [...pins, pin];
    setPins(newPins);
    saveToLS(groups, newPins, tags);
    setShowAddRow(false);
    fetch(`/api/stock?type=quote&symbol=${pin.symbol}`)
      .then((r) => r.json())
      .then((d) => { if (d?.regularMarketPrice) setQuotes((q) => ({ ...q, [pin.symbol]: d as Quote })); })
      .catch(() => {});
    try {
      const currentPrice = (await fetch(`/api/stock?type=quote&symbol=${pin.symbol}`)
        .then((r) => r.json()).catch(() => ({})))?.regularMarketPrice ?? null;
      await apiPost("/api/pins/assets", {
        id: pin.id, symbol: pin.symbol, group_id: pin.groupId, comment: pin.comment,
        buy_target: pin.buyTarget ?? null, sell_target: pin.sellTarget ?? null,
        price_at_pin: currentPrice, priority: pin.priority ?? 1, added_at: pin.addedAt, tags: pin.tags ?? [],
      });
      if (currentPrice != null) {
        setPins((ps) => ps.map((p) => p.id === pin.id ? { ...p, priceAtPin: currentPrice } : p));
      }
    } catch (err) { console.error("[handleAddPin]", err); }
  };

  const handleDeletePin = async (id: string) => {
    const newPins = pins.filter((p) => p.id !== id);
    setPins(newPins);
    setEditingId(null);
    saveToLS(groups, newPins, tags);
    try { await apiDelete(`/api/pins/assets/${encodeURIComponent(id)}`); } catch (err) { console.error(err); }
  };

  const handleSaveEdit = async (id: string, updates: Partial<PinnedAsset>) => {
    const newPins = pins.map((p) => p.id === id ? { ...p, ...updates } : p);
    setPins(newPins);
    saveToLS(groups, newPins, tags);
    try {
      const patchBody: Record<string, unknown> = {};
      if (updates.groupId   !== undefined) patchBody.group_id   = updates.groupId;
      if (updates.comment   !== undefined) patchBody.comment    = updates.comment;
      if (updates.buyTarget !== undefined) patchBody.buy_target = updates.buyTarget ?? null;
      if (updates.sellTarget !== undefined) patchBody.sell_target = updates.sellTarget ?? null;
      if (updates.priority  !== undefined) patchBody.priority   = updates.priority;
      await apiPatch(`/api/pins/assets/${encodeURIComponent(id)}`, patchBody);
      if (updates.tags !== undefined) {
        const oldPin  = pins.find((p) => p.id === id);
        const oldTags = new Set(oldPin?.tags ?? []);
        const newTags = new Set(updates.tags);
        for (const tid of newTags) {
          if (!oldTags.has(tid)) await apiPost(`/api/pins/assets/${encodeURIComponent(id)}/tags/${encodeURIComponent(tid)}`, {});
        }
        for (const tid of oldTags) {
          if (!newTags.has(tid)) await apiDelete(`/api/pins/assets/${encodeURIComponent(id)}/tags/${encodeURIComponent(tid)}`);
        }
      }
    } catch (err) { console.error("[handleSaveEdit]", err); }
  };

  const handlePriorityChange = async (id: string, priority: number) => {
    const newPins = pins.map((p) => p.id === id ? { ...p, priority } : p);
    setPins(newPins);
    saveToLS(groups, newPins, tags);
    try { await apiPatch(`/api/pins/assets/${encodeURIComponent(id)}`, { priority }); } catch (err) { console.error(err); }
  };

  const handleSymbolClick = (symbol: string) => {
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
    try { await apiPost("/api/pins/tags", { id: t.id, name: t.name, color: t.color }); } catch (err) { console.error(err); }
  };

  const handleDeleteTag = async (tagId: string) => {
    const newTags = tags.filter((t) => t.id !== tagId);
    const newPins = pins.map((p) => ({ ...p, tags: (p.tags ?? []).filter((tid) => tid !== tagId) }));
    setTags(newTags);
    setPins(newPins);
    saveToLS(groups, newPins, newTags);
    try { await apiDelete(`/api/pins/tags/${encodeURIComponent(tagId)}`); } catch (err) { console.error(err); }
  };

  // ── Sorting ─────────────────────────────────────────────────────────────

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
      try { localStorage.setItem(LS_SORT_KEY, key); } catch {}
    }
  };

  const getSortValue = (pin: PinnedAsset, key: string): number | string => {
    const q = quotes[pin.symbol];
    switch (key) {
      case "symbol":   return pin.symbol;
      case "priority":  return pin.priority ?? 0;
      case "price":     return q?.regularMarketPrice ?? 0;
      case "change":    return q?.regularMarketChange ?? 0;
      case "pctChange": return q?.regularMarketChangePercent ?? 0;
      case "volume":    return q?.regularMarketVolume ?? 0;
      case "mktCap":    return q?.marketCap ?? 0;
      case "pe":        return q?.trailingPE ?? 9999;
      case "beta":      return q?.beta ?? 0;
      case "divYield":  return q?.dividendYield ?? 0;
      case "sincePin": {
        const price = q?.regularMarketPrice;
        if (price && pin.priceAtPin && pin.priceAtPin > 0) return ((price - pin.priceAtPin) / pin.priceAtPin * 100);
        return -9999;
      }
      default: return 0;
    }
  };

  // ── Derived ─────────────────────────────────────────────────────────────

  const filteredPins = filterGroup === "all" ? pins : pins.filter((p) => p.groupId === filterGroup);

  // ── Drag-to-reorder ─────────────────────────────────────────────────────

  const handleReorder = useCallback(async (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    const displayed = sortKey === "manual" ? filteredPins : [...filteredPins].sort((a, b) => {
      const va = getSortValue(a, sortKey);
      const vb = getSortValue(b, sortKey);
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
    const reordered = [...displayed];
    const [moved] = reordered.splice(fromIdx, 1);
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
    } catch { /* backend may not support this endpoint yet */ }
  }, [pins, filteredPins, sortKey, sortDir, groups, tags, saveToLS, setPins, getSortValue]);

  const sortedPins = sortKey === "manual"
    ? filteredPins
    : [...filteredPins].sort((a, b) => {
        const va = getSortValue(a, sortKey);
        const vb = getSortValue(b, sortKey);
        const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
        return sortDir === "asc" ? cmp : -cmp;
      });

  const totalAlerts = pins.filter((p) => {
    const q = quotes[p.symbol];
    if (!q) return false;
    return (p.buyTarget != null && q.regularMarketPrice <= p.buyTarget) ||
           (p.sellTarget != null && q.regularMarketPrice >= p.sellTarget);
  }).length;

  // Summary stats
  const totalMktCap = pins.reduce((acc, p) => acc + (quotes[p.symbol]?.marketCap ?? 0), 0);
  const avgPE = (() => {
    const vals = pins.map((p) => quotes[p.symbol]?.trailingPE).filter((v): v is number => v != null && v > 0);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  })();
  const avgBeta = (() => {
    const vals = pins.map((p) => quotes[p.symbol]?.beta).filter((v): v is number => v != null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  })();

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="border" style={{ borderColor: colors.border, background: "#000" }}>
      {/* ── Section header ── */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-b" style={{ borderColor: colors.border, background: "#111" }}>
        <Pin className="h-3 w-3 shrink-0" style={{ color: colors.accent }} />
        <span className="text-[10px] font-bold tracking-widest" style={{ color: colors.accent }}>
          WATCHLIST
        </span>
        <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
          ({pins.length})
        </span>

        {totalAlerts > 0 && (
          <span className="text-[9px] px-1.5 py-0 font-bold animate-pulse flex items-center gap-0.5"
            style={{ background: "#ef444420", color: "#ef4444", border: "1px solid #ef444440" }}>
            <AlertTriangle className="h-2.5 w-2.5" />{totalAlerts}
          </span>
        )}

        {/* Summary stats bar */}
        {pins.length > 0 && (
          <div className="flex items-center gap-3 ml-2 text-[9px] font-mono" style={{ color: colors.textSecondary }}>
            {totalMktCap > 0 && <span>MCap:<span style={{ color: colors.text }}>{fmtCompact(totalMktCap)}</span></span>}
            {avgPE != null && <span>AvgPE:<span style={{ color: colors.text }}>{avgPE.toFixed(1)}</span></span>}
            {avgBeta != null && <span>AvgB:<span style={{ color: avgBeta > 1.2 ? "#ff9900" : avgBeta < 0.8 ? "#4ade80" : colors.text }}>{avgBeta.toFixed(2)}</span></span>}
          </div>
        )}

        {syncStatus === "syncing" && (
          <span className="flex items-center gap-0.5 text-[8px]" style={{ color: colors.textSecondary }}>
            <Loader2 className="h-2.5 w-2.5 animate-spin" />SYNC
          </span>
        )}
        {syncStatus === "ok" && <span className="text-[8px]" style={{ color: "#4ade8066" }}>DB</span>}
        {syncStatus === "error" && <span className="text-[8px]" title={syncError} style={{ color: "#f8717166" }}>LOCAL</span>}

        <div className="ml-auto flex items-center gap-1">
          {/* Group filter */}
          {groups.length > 1 && (
            <select className="text-[9px] px-1 py-0.5 border font-mono"
              style={{ background: colors.background, color: colors.text, borderColor: colors.border }}
              value={filterGroup}
              onChange={(e) => setFilterGroup(e.target.value)}>
              <option value="all">ALL</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name.toUpperCase()}</option>)}
            </select>
          )}

          <button title="Add symbol" className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 border font-bold hover:opacity-80"
            style={{ borderColor: colors.accent + "44", color: colors.accent }}
            onClick={() => setShowAddRow((v) => !v)}>
            <Plus className="h-2.5 w-2.5" />ADD
          </button>

          <button title="Refresh" className="p-0.5 hover:opacity-70" onClick={fetchQuotes} disabled={loadingQuotes}>
            {loadingQuotes
              ? <Loader2 className="h-3 w-3 animate-spin" style={{ color: colors.textSecondary }} />
              : <RefreshCw className="h-3 w-3" style={{ color: colors.textSecondary }} />}
          </button>

          <div className="relative">
            <button title="Tags" className="flex items-center gap-0.5 text-[9px] px-1 py-0.5 border font-bold hover:opacity-80"
              style={{ borderColor: colors.border, color: colors.textSecondary }}
              onClick={() => setShowTagMgr((v) => !v)}>
              <Tag className="h-2.5 w-2.5" />
            </button>
            {showTagMgr && (
              <TagManagerPanel tags={tags} colors={colors} onCreateTag={handleCreateTag}
                onDeleteTag={handleDeleteTag} onClose={() => setShowTagMgr(false)} />
            )}
          </div>

          <button title="New group" className="flex items-center gap-0.5 text-[9px] px-1 py-0.5 border font-bold hover:opacity-80"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
            onClick={() => setShowAddGroup((v) => !v)}>
            <Layers className="h-2.5 w-2.5" />
          </button>

          <button
            title={viewMode === "table" ? "Switch to card view" : "Switch to table view"}
            className="p-0.5 hover:opacity-80"
            onClick={() => setViewMode((v) => v === "table" ? "cards" : "table")}
          >
            {viewMode === "table"
              ? <LayoutGrid className="h-3 w-3" style={{ color: colors.textSecondary }} />
              : <LayoutList className="h-3 w-3" style={{ color: colors.accent }} />}
          </button>

          <button className="p-0.5 hover:opacity-70" onClick={() => setCollapsed((v) => !v)}>
            {collapsed
              ? <ChevronDown className="h-3 w-3" style={{ color: colors.textSecondary }} />
              : <ChevronUp   className="h-3 w-3" style={{ color: colors.textSecondary }} />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div>
          {showAddGroup && (
            <AddGroupInline colors={colors} onAdd={handleAddGroup} onCancel={() => setShowAddGroup(false)} />
          )}

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
          {editingId && !showAddRow && (() => {
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
              <div className="text-[10px]">No symbols. Press <span style={{ color: colors.accent }}>+ADD</span> or pin from EQUITY view.</div>
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

              {sortedPins.map((pin, visualIdx) => {
                const q         = quotes[pin.symbol];
                const group     = groups.find((g) => g.id === pin.groupId);
                const dotColor  = group?.color ?? "#94a3b8";
                const price     = q?.regularMarketPrice;
                const pct       = q?.regularMarketChangePercent ?? 0;
                const isUp      = pct >= 0;
                const pctColor  = isUp ? "#00FF00" : "#FF4444";
                const buyAlert  = price != null && pin.buyTarget  != null && price <= pin.buyTarget;
                const sellAlert = price != null && pin.sellTarget != null && price >= pin.sellTarget;
                const hasAlert  = buyAlert || sellAlert;
                const sincePin  =
                  price != null && pin.priceAtPin != null && pin.priceAtPin > 0
                    ? ((price - pin.priceAtPin) / pin.priceAtPin) * 100
                    : null;
                const spark = sparklines[pin.symbol] ?? [];
                const isDragOver = dragOverIdx === visualIdx && dragIdx !== visualIdx;

                // Editing pin is shown above the grid — hide the card
                if (editingId === pin.id) return null;

                return (
                  <div
                    key={pin.id}
                    draggable
                    onDragStart={() => setDragIdx(visualIdx)}
                    onDragOver={(e) => { e.preventDefault(); setDragOverIdx(visualIdx); }}
                    onDrop={() => { if (dragIdx !== null) handleReorder(dragIdx, visualIdx); setDragIdx(null); setDragOverIdx(null); }}
                    onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
                    className="group/card flex flex-col cursor-pointer transition-opacity p-1.5 min-h-[90px] hover:brightness-125"
                    style={{
                      background: hasAlert
                        ? (sellAlert ? "#ef444408" : "#22c55e08")
                        : "#000",
                      borderTop: isDragOver ? "2px solid #00FFFF" : `2px solid ${dotColor}`,
                      opacity: dragIdx === visualIdx ? 0.4 : 1,
                    }}
                    onClick={() => handleSymbolClick(pin.symbol)}
                  >
                    {/* Top row: symbol + alert + action icons */}
                    <div className="flex items-start justify-between gap-0.5 mb-0.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-0.5 flex-wrap">
                          <span className="text-[10px] font-bold font-mono leading-tight" style={{ color: colors.accent }}>
                            {pin.symbol}
                          </span>
                          {hasAlert && (
                            <span
                              className="text-[7px] px-0.5 font-bold animate-pulse"
                              style={{
                                background:  sellAlert ? "#ef444420" : "#22c55e20",
                                color:       sellAlert ? "#ef4444"   : "#4ade80",
                              }}
                            >
                              {sellAlert ? "SELL" : "BUY"}
                            </span>
                          )}
                        </div>
                        {q?.shortName && (
                          <div className="text-[7px] truncate leading-tight" style={{ color: colors.textSecondary }}>
                            {q.shortName}
                          </div>
                        )}
                      </div>
                      {/* Edit / delete — visible on hover */}
                      <div
                        className="flex gap-0.5 shrink-0 opacity-0 group-hover/card:opacity-100 transition-opacity"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button title="Edit" onClick={() => setEditingId(pin.id)}>
                          <Edit3 className="h-2.5 w-2.5" style={{ color: colors.textSecondary }} />
                        </button>
                        <button title="Delete" onClick={() => handleDeletePin(pin.id)}>
                          <Trash2 className="h-2 w-2 text-red-400" />
                        </button>
                      </div>
                    </div>

                    {/* %Change */}
                    <div className="flex items-baseline gap-1">
                      <span className="text-[9px] font-bold font-mono" style={{ color: pctColor }}>
                        {isUp ? "▲" : "▼"}{fmtPct(pct)}
                      </span>
                      {sincePin != null && (
                        <span
                          className="text-[7px] font-mono"
                          style={{ color: sincePin >= 0 ? "#4ade8066" : "#f8717166" }}
                        >
                          {sincePin >= 0 ? "+" : ""}{sincePin.toFixed(1)}% pin
                        </span>
                      )}
                    </div>

                    {/* Sparkline */}
                    <div className="mt-auto pt-0.5">
                      <MiniSparkline prices={spark} isUp={isUp} />
                    </div>

                    {/* Comment */}
                    {pin.comment && (
                      <div className="text-[7px] truncate mt-0.5" style={{ color: `${dotColor}88` }}>
                        {pin.comment}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Summary footer — spans all 3 columns */}
              {pins.length > 0 && (
                <div
                  className="col-span-3 px-2 py-1 flex items-center gap-3 text-[9px] font-mono"
                  style={{ background: "#0a0a0a", borderTop: `1px solid ${colors.border}`, color: colors.textSecondary }}
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
                        if (!q?.regularMarketPrice || !p.priceAtPin || p.priceAtPin <= 0) return null;
                        return ((q.regularMarketPrice - p.priceAtPin) / p.priceAtPin) * 100;
                      })
                      .filter((v): v is number => v != null);
                    if (!rets.length) return null;
                    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
                    return (
                      <span className="font-bold ml-auto" style={{ color: avg >= 0 ? "#00FF00" : "#FF0000" }}>
                        PIN RTN {fmtPct(avg)}
                      </span>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* ── TABLE VIEW (default) ───────────────────────────────────────── */}
          {(pins.length > 0 || showAddRow) && viewMode === "table" && (() => {
            const SortTh = ({ label, sortId, align = "right" }: { label: string; sortId: string; align?: "left" | "right" }) => (
              <th
                className="px-1 py-0.5 cursor-pointer select-none whitespace-nowrap hover:opacity-80"
                style={{ color: sortKey === sortId ? "#00FFFF" : colors.textSecondary, textAlign: align }}
                onClick={() => {
                  if (sortKey === sortId) setSortDir((d) => d === "asc" ? "desc" : "asc");
                  else { setSortKey(sortId); setSortDir("asc"); }
                }}
              >
                <span className="text-[9px] font-bold tracking-wider">
                  {label}{sortKey === sortId ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                </span>
              </th>
            );
            return (
              <div className="overflow-x-auto">
                <table className="w-full text-[10px] font-mono" style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#0a0a0a", borderBottom: `1px solid ${colors.border}` }}>
                      <th className="px-0.5 py-0.5 w-3" />
                      <th className="px-1 py-0.5 w-4" />
                      <SortTh label="TICKER" sortId="symbol" align="left" />
                      <SortTh label="PRI"    sortId="priority" />
                      <SortTh label="LAST"   sortId="price" />
                      <SortTh label="CHG"    sortId="change" />
                      <SortTh label="%CHG"   sortId="pctChange" />
                      <SortTh label="VOLUME" sortId="volume" />
                      <SortTh label="MCAP"   sortId="mktCap" />
                      <SortTh label="P/E"    sortId="pe" />
                      <SortTh label="BETA"   sortId="beta" />
                      <SortTh label="DIV%"   sortId="divYield" />
                      <th className="px-1 py-0.5 text-right whitespace-nowrap">
                        <span className="text-[9px] font-bold tracking-wider" style={{ color: colors.textSecondary }}>52W RANGE</span>
                      </th>
                      <th className="px-1 py-0.5 text-right whitespace-nowrap">
                        <span className="text-[9px] font-bold tracking-wider" style={{ color: "#4ade80" }}>BUY</span>
                        <span className="text-[9px] mx-0.5" style={{ color: colors.textSecondary }}>/</span>
                        <span className="text-[9px] font-bold tracking-wider" style={{ color: "#f87171" }}>SELL</span>
                      </th>
                      <SortTh label="PIN RTN" sortId="sincePin" />
                      <th className="px-1 py-0.5 w-6" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPins.map((pin, visualIdx) => {
                      const q        = quotes[pin.symbol];
                      const group    = groups.find((g) => g.id === pin.groupId);
                      const dotColor = group?.color ?? "#94a3b8";
                      const price    = q?.regularMarketPrice;
                      const pct      = q?.regularMarketChangePercent ?? 0;
                      const chg      = q?.regularMarketChange ?? 0;
                      const isUp     = pct >= 0;
                      const pctColor = isUp ? "#00FF00" : "#FF0000";
                      const buyAlert  = price != null && pin.buyTarget  != null && price <= pin.buyTarget;
                      const sellAlert = price != null && pin.sellTarget != null && price >= pin.sellTarget;
                      const hasAlert  = buyAlert || sellAlert;
                      const sincePin  = price != null && pin.priceAtPin != null && pin.priceAtPin > 0
                        ? ((price - pin.priceAtPin) / pin.priceAtPin * 100) : null;
                      const pinTagObjects = (pin.tags ?? [])
                        .map((tid) => tags.find((t) => t.id === tid)).filter(Boolean) as PinTag[];
                      const isEditing = editingId === pin.id;
                      const isDragOver = dragOverIdx === visualIdx && dragIdx !== visualIdx;

                      return (
                        <tr key={pin.id}
                          draggable
                          onDragStart={() => setDragIdx(visualIdx)}
                          onDragOver={(e) => { e.preventDefault(); setDragOverIdx(visualIdx); }}
                          onDrop={() => { if (dragIdx !== null) handleReorder(dragIdx, visualIdx); setDragIdx(null); setDragOverIdx(null); }}
                          onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
                          className="group/row hover:bg-[#111] transition-colors"
                          style={{
                            borderBottom: `1px solid #1a1a1a`,
                            borderTop: isDragOver ? "2px solid #00FFFF" : undefined,
                            opacity: dragIdx === visualIdx ? 0.4 : 1,
                            background: isEditing
                              ? `${colors.accent}15`
                              : hasAlert ? (sellAlert ? "#ef444408" : "#22c55e08") : undefined,
                          }}>
                          <td className="px-0.5 py-0.5 cursor-grab active:cursor-grabbing">
                            <GripVertical className="h-2.5 w-2.5" style={{ color: colors.textSecondary, opacity: 0.4 }} />
                          </td>
                          <td className="px-1 py-0.5 text-center">
                            <span className="inline-block w-2 h-2" style={{ background: dotColor, boxShadow: `0 0 3px ${dotColor}66` }} />
                          </td>
                          <td className="px-1 py-0.5">
                            <div className="flex items-center gap-1">
                              <button className="font-bold hover:opacity-70 flex items-center gap-0.5"
                                style={{ color: colors.accent }}
                                onClick={() => handleSymbolClick(pin.symbol)}>
                                {pin.symbol}
                                <ExternalLink className="h-2 w-2 opacity-0 group-hover/row:opacity-50" />
                              </button>
                              {hasAlert && (
                                <span className="text-[8px] px-1 py-0 font-bold animate-pulse"
                                  style={{
                                    background: sellAlert ? "#ef444422" : "#22c55e22",
                                    color: sellAlert ? "#ef4444" : "#4ade80",
                                    border: `1px solid ${sellAlert ? "#ef444444" : "#22c55e44"}`,
                                  }}>
                                  {sellAlert ? "SELL" : "BUY"}
                                </span>
                              )}
                              {pinTagObjects.map((t) => <TagChip key={t.id} tag={t} />)}
                            </div>
                            {q?.shortName && (
                              <div className="text-[8px] truncate max-w-[120px]" style={{ color: colors.textSecondary }}>{q.shortName}</div>
                            )}
                            {pin.comment && (
                              <button className="flex items-center gap-0.5 text-[8px] hover:opacity-70 max-w-[120px]"
                                style={{ color: `${dotColor}99` }}
                                onClick={() => setExpandedComment(expandedComment === pin.id ? null : pin.id)}>
                                <MessageSquare className="h-2 w-2 shrink-0" />
                                <span className={expandedComment === pin.id ? "whitespace-pre-wrap" : "truncate"}>{pin.comment}</span>
                              </button>
                            )}
                          </td>
                          <td className="px-1 py-0.5 text-center">
                            <PriorityStars value={pin.priority ?? 1} onChange={(v) => handlePriorityChange(pin.id, v)} />
                          </td>
                          <td className="px-1 py-0.5 text-right font-bold" style={{ color: colors.text }}>
                            {price != null ? `$${fmtPrice(price)}` : "—"}
                          </td>
                          <td className="px-1 py-0.5 text-right" style={{ color: pctColor }}>
                            {q ? `${isUp ? "+" : ""}${chg.toFixed(2)}` : "—"}
                          </td>
                          <td className="px-1 py-0.5 text-right font-bold" style={{ color: pctColor }}>
                            {q ? (
                              <span className="flex items-center justify-end gap-0.5">
                                <span className="text-[8px]">{isUp ? "▲" : "▼"}</span>{fmtPct(pct)}
                              </span>
                            ) : "—"}
                          </td>
                          <td className="px-1 py-0.5 text-right">
                            <VolumeBar current={q?.regularMarketVolume} avg={q?.averageDailyVolume3Month} colors={colors} />
                          </td>
                          <td className="px-1 py-0.5 text-right" style={{ color: colors.text }}>{fmtCompact(q?.marketCap)}</td>
                          <td className="px-1 py-0.5 text-right">
                            {q?.trailingPE != null ? (
                              <span style={{ color: q.trailingPE > 40 ? "#ff9900" : q.trailingPE < 15 ? "#4ade80" : colors.text }}>
                                {q.trailingPE.toFixed(1)}
                                {q?.forwardPE != null && (
                                  <span className="text-[8px] ml-0.5" style={{ color: colors.textSecondary }}>/{q.forwardPE.toFixed(0)}f</span>
                                )}
                              </span>
                            ) : "—"}
                          </td>
                          <td className="px-1 py-0.5 text-right"
                            style={{ color: q?.beta != null ? (q.beta > 1.5 ? "#ff9900" : q.beta < 0.8 ? "#4ade80" : colors.text) : colors.textSecondary }}>
                            {q?.beta != null ? q.beta.toFixed(2) : "—"}
                          </td>
                          <td className="px-1 py-0.5 text-right"
                            style={{ color: q?.dividendYield != null && q.dividendYield > 0 ? "#4ade80" : colors.textSecondary }}>
                            {q?.dividendYield != null && q.dividendYield > 0 ? `${(q.dividendYield * 100).toFixed(2)}%` : "—"}
                          </td>
                          <td className="px-1 py-0.5">
                            {price != null && q?.fiftyTwoWeekLow != null && q?.fiftyTwoWeekHigh != null ? (
                              <RangeBar52W price={price} low={q.fiftyTwoWeekLow} high={q.fiftyTwoWeekHigh} colors={colors} />
                            ) : <span style={{ color: colors.textSecondary }}>—</span>}
                          </td>
                          <td className="px-1 py-0.5 text-right">
                            <div className="flex items-center justify-end gap-1">
                              {pin.buyTarget != null ? (
                                <span style={{ color: buyAlert ? "#4ade80" : colors.textSecondary }}>
                                  <span className="text-[8px]">B</span>${fmtPrice(pin.buyTarget)}
                                  {price != null && (
                                    <span className="text-[8px] ml-0.5" style={{ color: colors.textSecondary }}>
                                      ({((pin.buyTarget - price) / price * 100).toFixed(0)}%)
                                    </span>
                                  )}
                                </span>
                              ) : <span style={{ color: "#222" }}>—</span>}
                              <span style={{ color: "#333" }}>|</span>
                              {pin.sellTarget != null ? (
                                <span style={{ color: sellAlert ? "#ef4444" : colors.textSecondary }}>
                                  <span className="text-[8px]">S</span>${fmtPrice(pin.sellTarget)}
                                  {price != null && (
                                    <span className="text-[8px] ml-0.5" style={{ color: colors.textSecondary }}>
                                      ({((pin.sellTarget - price) / price * 100).toFixed(0)}%)
                                    </span>
                                  )}
                                </span>
                              ) : <span style={{ color: "#222" }}>—</span>}
                            </div>
                          </td>
                          <td className="px-1 py-0.5 text-right font-bold">
                            {sincePin != null ? (
                              <div>
                                <span style={{ color: sincePin >= 0 ? "#00FF00" : "#FF0000" }}>{fmtPct(sincePin)}</span>
                                {pin.priceAtPin != null && (
                                  <div className="text-[8px]" style={{ color: colors.textSecondary }}>@{fmtPrice(pin.priceAtPin)}</div>
                                )}
                              </div>
                            ) : <span style={{ color: colors.textSecondary }}>—</span>}
                          </td>
                          <td className="px-1 py-0.5 text-center">
                            <div className="flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity">
                              <button title="Edit" onClick={() => setEditingId(isEditing ? null : pin.id)}>
                                <Edit3 className="h-2.5 w-2.5" style={{ color: isEditing ? colors.accent : colors.textSecondary }} />
                              </button>
                              <button title="Delete" onClick={() => handleDeletePin(pin.id)}>
                                <Trash2 className="h-2.5 w-2.5 text-red-400" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}

                    {/* Footer row */}
                    {pins.length > 0 && (
                      <tr style={{ borderTop: `1px solid ${colors.border}`, background: "#0a0a0a" }}>
                        <td className="px-1 py-0.5" colSpan={3}>
                          <span className="text-[9px] font-bold tracking-wider" style={{ color: colors.accent }}>
                            TOTAL {filteredPins.length} ASSETS
                          </span>
                        </td>
                        <td colSpan={3} />
                        <td className="px-1 py-0.5 text-right text-[9px]" style={{ color: colors.textSecondary }}>
                          {(() => {
                            const pcts = filteredPins.map((p) => quotes[p.symbol]?.regularMarketChangePercent).filter((v): v is number => v != null);
                            if (!pcts.length) return null;
                            const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
                            return <span style={{ color: avg >= 0 ? "#00FF00" : "#FF0000" }}>Avg:{fmtPct(avg)}</span>;
                          })()}
                        </td>
                        <td className="px-1 py-0.5 text-right text-[9px]" style={{ color: colors.text }}>{fmtCompact(totalMktCap)}</td>
                        <td className="px-1 py-0.5 text-right text-[9px]" style={{ color: colors.text }}>{avgPE != null ? avgPE.toFixed(1) : ""}</td>
                        <td className="px-1 py-0.5 text-right text-[9px]"
                          style={{ color: avgBeta != null ? (avgBeta > 1.2 ? "#ff9900" : "#4ade80") : colors.textSecondary }}>
                          {avgBeta != null ? avgBeta.toFixed(2) : ""}
                        </td>
                        <td colSpan={4} />
                        <td className="px-1 py-0.5 text-right text-[9px]">
                          {(() => {
                            const rets = filteredPins.map((p) => {
                              const q = quotes[p.symbol];
                              if (!q?.regularMarketPrice || !p.priceAtPin || p.priceAtPin <= 0) return null;
                              return ((q.regularMarketPrice - p.priceAtPin) / p.priceAtPin * 100);
                            }).filter((v): v is number => v != null);
                            if (!rets.length) return null;
                            const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
                            return <span className="font-bold" style={{ color: avg >= 0 ? "#00FF00" : "#FF0000" }}>Avg:{fmtPct(avg)}</span>;
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
}
