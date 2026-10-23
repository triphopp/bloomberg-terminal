"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { QUAD_COLOR } from "../../lib/rrg-quadrant";
import { ROT_NEWS_KEY } from "./constants";
import { timeAgo } from "./helpers";
import { SectorScreen } from "./sector-screen";
import type { RotationHeadline, RotationNewsGroup, ThemeColors, Tone } from "./types";
import { useRotationMemberNews, useRotationNews } from "./useNewsQueries";

// Right column → ROTATION: every MKT → STRUCTURE → ROT group with its quadrant,
// the headlines that name it, and their tone counted. Tone is a word list, not
// a reading of meaning — the panel says so at the foot, as the backend does.

type Market = "US" | "TH";
type Sort = "tone" | "rot";

const KINDS: Record<Market, { id: string; label: string }[]> = {
  US: [
    { id: "sector", label: "SECTORS" },
    { id: "theme", label: "THEMES" },
  ],
  TH: [
    { id: "industry", label: "INDUSTRY" },
    { id: "sector", label: "SECTORS" },
  ],
};

const QUAD_SHORT: Record<string, string> = {
  Leading: "LEAD",
  Improving: "IMPR",
  Weakening: "WEAK",
  Lagging: "LAG",
};

const TONE_COLOR: Record<Tone, string> = { POS: "#4caf50", NEG: "#ef5350", NEU: "#616161" };
const TONE_MARK: Record<Tone, string> = { POS: "▲", NEG: "▼", NEU: "·" };

interface Saved {
  market: Market;
  kind: Record<Market, string>;
  sort: Sort;
}

const DEFAULT: Saved = { market: "US", kind: { US: "sector", TH: "industry" }, sort: "tone" };

function loadSaved(): Saved {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const s = localStorage.getItem(ROT_NEWS_KEY);
    if (s) return { ...DEFAULT, ...(JSON.parse(s) as Partial<Saved>) };
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

const shortName = (name: string) => name.replace(/\s*\([A-Z0-9.^]+\)$/, "");

function ToneBar({ g }: { g: RotationNewsGroup }) {
  const { n, pos, neg } = g.tone;
  if (!n) return <div className="flex-1 h-1" />;
  return (
    <div
      className="flex-1 h-1 flex rounded-sm overflow-hidden"
      style={{ backgroundColor: "#1a1a1a" }}
    >
      <div style={{ width: `${(pos / n) * 100}%`, backgroundColor: TONE_COLOR.POS }} />
      <div className="flex-1" />
      <div style={{ width: `${(neg / n) * 100}%`, backgroundColor: TONE_COLOR.NEG }} />
    </div>
  );
}

function GroupRow({
  g,
  market,
  colors,
  open,
  onToggle,
}: {
  g: RotationNewsGroup;
  market: Market;
  colors: ThemeColors;
  open: boolean;
  onToggle: () => void;
}) {
  const [view, setView] = useState<"group" | "stocks" | "screen">("group");
  const qColor = g.quadrant ? QUAD_COLOR[g.quadrant] : colors.textSecondary;
  const net = g.tone.net;
  const nColor = netColor(net, colors.textSecondary);
  return (
    <div className="border-b" style={{ borderColor: colors.border }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="w-full text-left px-2 py-0.5 hover:bg-[#111] transition-colors"
        title={`${g.name} · ${g.quadrant ?? "no quadrant"} · ${
          g.loading ? "loading" : `▲${g.tone.pos} ▼${g.tone.neg} of ${g.tone.n} headlines`
        }${
          g.read === "CONFIRMS"
            ? " · tone agrees with the quadrant"
            : g.read === "DIVERGES"
              ? " · tone points against the quadrant"
              : ""
        }`}
      >
        {/* One line: quadrant · name · tone bar · C/D · net · count */}
        <div className="flex items-center gap-1.5 font-mono">
          <span className="text-[7px] font-bold w-6 shrink-0" style={{ color: qColor }}>
            {g.quadrant ? QUAD_SHORT[g.quadrant] : "—"}
          </span>
          <span className="flex-1 min-w-0 truncate text-[9px]" style={{ color: colors.text }}>
            {shortName(g.name)}
          </span>
          <span className="w-10 shrink-0 flex">
            <ToneBar g={g} />
          </span>
          <span
            className="w-2 shrink-0 text-[7px] font-bold text-center"
            style={{ color: g.read === "CONFIRMS" ? qColor : "#ff9800" }}
          >
            {g.read === "CONFIRMS" ? "C" : g.read === "DIVERGES" ? "D" : ""}
          </span>
          <span className="text-[8px] w-6 text-right shrink-0" style={{ color: nColor }}>
            {signed(net)}
          </span>
          <span
            className="text-[7px] w-4 text-right shrink-0"
            style={{ color: colors.textSecondary }}
          >
            {g.loading ? "…" : g.tone.n}
          </span>
        </div>
      </button>

      {open && (
        <div className="pb-1">
          <div className="flex items-center gap-1 px-1 text-[7px] font-bold font-mono">
            {(["group", "stocks", "screen"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className="px-1 py-0.5 hover:opacity-80"
                style={{ color: view === v ? colors.accent : colors.textSecondary }}
                title={
                  v === "group"
                    ? "Headlines that name the group"
                    : v === "stocks"
                      ? "The group's largest members, each with its own headlines"
                      : "Members ranked by momentum, quality, value and low volatility inside the group; weights set by the market's state (F&G, VIX, MOVE)"
                }
              >
                {v === "group" ? "GROUP NEWS" : v === "stocks" ? "STOCKS" : "SCREEN"}
              </button>
            ))}
          </div>
          {view === "group" ? (
            <HeadlineList
              items={g.headlines}
              colors={colors}
              empty={
                g.loading
                  ? "loading…"
                  : g.error
                    ? `no headlines (${g.error})`
                    : "no headlines name this group"
              }
            />
          ) : view === "stocks" ? (
            <MemberNews market={market} group={g.id} colors={colors} />
          ) : (
            <SectorScreen market={market} group={g.id} colors={colors} />
          )}
        </div>
      )}
    </div>
  );
}

function HeadlineList({
  items,
  colors,
  empty,
}: {
  items: RotationHeadline[];
  colors: ThemeColors;
  empty: string;
}) {
  if (items.length === 0)
    return (
      <div className="px-2 py-2 text-[8px] font-mono" style={{ color: colors.textSecondary }}>
        {empty}
      </div>
    );
  return (
    <>
      {items.map((h) => (
        <a
          key={h.url}
          href={h.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex gap-1.5 px-2 py-1 hover:bg-[#111] group"
        >
          <span className="text-[8px] font-mono shrink-0 w-2" style={{ color: TONE_COLOR[h.tone] }}>
            {TONE_MARK[h.tone]}
          </span>
          <span className="min-w-0">
            <span
              className="block text-[9px] font-mono leading-snug line-clamp-2 group-hover:underline"
              style={{ color: colors.text }}
            >
              {h.title}
            </span>
            <span className="block text-[7px] font-mono" style={{ color: colors.textSecondary }}>
              {h.source}
              {h.published_at ? ` · ${timeAgo(h.published_at)}` : ""}
            </span>
          </span>
        </a>
      ))}
    </>
  );
}

const signed = (net: number | null) =>
  net == null ? "—" : `${net > 0 ? "+" : ""}${Math.round(net * 100)}`;
const netColor = (net: number | null, fallback: string) =>
  net == null || net === 0 ? fallback : net > 0 ? TONE_COLOR.POS : TONE_COLOR.NEG;

/** STOCKS: the group's largest members (by weight), each with the headlines
 *  that name it, and the tone rolled up by weight. Loaded on open only. */
function MemberNews({
  market,
  group,
  colors,
}: {
  market: "US" | "TH";
  group: string;
  colors: ThemeColors;
}) {
  const q = useRotationMemberNews(market, group, true);
  const [openSym, setOpenSym] = useState<string | null>(null);
  const d = q.data;
  if (!d)
    return (
      <div
        className="flex items-center gap-2 px-2 py-2 text-[8px] font-mono"
        style={{ color: colors.textSecondary }}
      >
        {q.isError ? (
          "member news unavailable"
        ) : (
          <>
            <RefreshCw className="h-2.5 w-2.5 animate-spin" /> pulling each member's news…
          </>
        )}
      </div>
    );
  if (d.error && d.members.length === 0)
    return (
      <div className="px-2 py-2 text-[8px] font-mono" style={{ color: colors.textSecondary }}>
        {d.error}
      </div>
    );
  const r = d.rollup;
  return (
    <div>
      {r && (
        <div
          className="flex items-center gap-1.5 px-2 py-1 text-[8px] font-mono"
          style={{ color: colors.textSecondary }}
          title={`weighted net tone over members with news (${r.weight_covered.toFixed(2)} of ${r.weight_listed.toFixed(2)} ${d.weight_basis ?? "weight"}); breadth = members with net tone above / below / at zero / no headlines`}
        >
          <span>
            WTD{" "}
            <span style={{ color: netColor(r.weighted_net, colors.text) }}>
              {signed(r.weighted_net)}
            </span>
          </span>
          <span>
            <span style={{ color: TONE_COLOR.POS }}>{r.breadth.positive}▲</span>{" "}
            <span style={{ color: TONE_COLOR.NEG }}>{r.breadth.negative}▼</span> {r.breadth.flat}={" "}
            {r.breadth.no_news}∅
          </span>
          {r.read && (
            <span
              className="font-bold"
              style={{ color: r.read === "CONFIRMS" ? colors.text : "#ff9800" }}
            >
              {r.read === "CONFIRMS" ? "CONF" : "DIV"}
            </span>
          )}
          {d.pending > 0 && <RefreshCw className="h-2 w-2 animate-spin ml-auto" />}
        </div>
      )}
      {d.members.map((m) => (
        <div key={m.symbol}>
          <button
            type="button"
            aria-expanded={openSym === m.symbol}
            onClick={() => setOpenSym((s) => (s === m.symbol ? null : m.symbol))}
            className="w-full flex items-center gap-1.5 px-2 py-0.5 text-[8px] font-mono hover:bg-[#111]"
            title={`${m.name ?? m.symbol} · weight ${m.weight?.toFixed(2) ?? "—"} · its own quadrant vs ${d.bench ?? "benchmark"}`}
          >
            <span
              className="w-7 shrink-0 text-left text-[7px] font-bold"
              style={{ color: m.quadrant ? QUAD_COLOR[m.quadrant] : colors.textSecondary }}
            >
              {m.quadrant ? QUAD_SHORT[m.quadrant] : "—"}
            </span>
            <span className="flex-1 min-w-0 truncate text-left" style={{ color: colors.text }}>
              {m.symbol}
            </span>
            <span className="w-9 text-right shrink-0" style={{ color: colors.textSecondary }}>
              {m.weight != null ? `${m.weight.toFixed(2)}%` : "—"}
            </span>
            <span
              className="w-7 text-right shrink-0"
              style={{ color: netColor(m.tone.net, colors.textSecondary) }}
            >
              {signed(m.tone.net)}
            </span>
            <span
              className="w-8 text-right shrink-0 text-[7px]"
              style={{ color: colors.textSecondary }}
            >
              {m.tone.pos}/{m.tone.neg}/{m.tone.n}
            </span>
          </button>
          {openSym === m.symbol && (
            <HeadlineList
              items={m.headlines}
              colors={colors}
              empty="no headline names this stock"
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function RotationNewsPanel({ colors }: { colors: ThemeColors }) {
  const [saved, setSaved] = useState<Saved>(loadSaved);
  useEffect(() => {
    try {
      localStorage.setItem(ROT_NEWS_KEY, JSON.stringify(saved));
    } catch {
      /* ignore */
    }
  }, [saved]);
  const { market, sort } = saved;
  const kind = saved.kind[market];
  const [open, setOpen] = useState<string | null>(null);

  const q = useRotationNews(market, kind, true);
  const data = q.data?.market === market ? q.data : undefined;
  const loading = q.isFetching || (data?.pending ?? 0) > 0;

  const groups = useMemo(() => {
    const rows = [...(data?.groups ?? [])];
    if (sort === "tone") rows.sort((a, b) => (b.tone.net ?? -9) - (a.tone.net ?? -9));
    else rows.sort((a, b) => (b.m1_vs_bench ?? -999) - (a.m1_vs_bench ?? -999));
    return rows;
  }, [data, sort]);
  const nConf = groups.filter((g) => g.read === "CONFIRMS").length;
  const nDiv = groups.filter((g) => g.read === "DIVERGES").length;

  const btn = (active: boolean) => ({ color: active ? colors.accent : colors.textSecondary });

  return (
    <>
      {/* Controls: market · group kind · sort */}
      <div
        className="shrink-0 flex items-center gap-1 px-1 py-0.5 border-b text-[8px] font-bold font-mono"
        style={{ borderColor: colors.border }}
      >
        {(["US", "TH"] as Market[]).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={market === m}
            onClick={() => {
              setSaved((s) => ({ ...s, market: m }));
              setOpen(null);
            }}
            className="px-1 hover:opacity-80"
            style={btn(market === m)}
          >
            {m}
          </button>
        ))}
        <span style={{ color: colors.border }}>|</span>
        {KINDS[market].map((k) => (
          <button
            key={k.id}
            type="button"
            aria-pressed={kind === k.id}
            onClick={() => {
              setSaved((s) => ({ ...s, kind: { ...s.kind, [market]: k.id } }));
              setOpen(null);
            }}
            className="px-1 hover:opacity-80"
            style={btn(kind === k.id)}
          >
            {k.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => q.refresh()}
          disabled={q.isFetching}
          className="ml-auto px-1 hover:opacity-70"
          title="Re-pull headlines"
        >
          <RefreshCw
            className={`h-2.5 w-2.5 ${loading ? "animate-spin" : ""}`}
            style={{ color: colors.accent }}
          />
        </button>
      </div>
      <div
        className="shrink-0 flex items-center gap-1 px-1 py-0.5 border-b text-[8px] font-mono"
        style={{ borderColor: colors.border, color: colors.textSecondary }}
      >
        <span className="px-1">SORT</span>
        <button
          type="button"
          aria-pressed={sort === "tone"}
          onClick={() => setSaved((s) => ({ ...s, sort: "tone" }))}
          className="px-1 font-bold hover:opacity-80"
          style={btn(sort === "tone")}
          title="Net tone: (positive − negative) / headlines"
        >
          TONE
        </button>
        <button
          type="button"
          aria-pressed={sort === "rot"}
          onClick={() => setSaved((s) => ({ ...s, sort: "rot" }))}
          className="px-1 font-bold hover:opacity-80"
          style={btn(sort === "rot")}
          title={`1M return vs ${data?.bench ?? "benchmark"}`}
        >
          1M vs {data?.bench ?? "BENCH"}
        </button>
        <span className="ml-auto pr-1">
          <span style={{ color: colors.text }}>{nConf}</span> conf ·{" "}
          <span style={{ color: "#ff9800" }}>{nDiv}</span> div
        </span>
      </div>

      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "#333 #000" }}
      >
        {!data && (
          <div
            className="flex items-center justify-center py-10 gap-2"
            style={{ color: colors.textSecondary }}
          >
            {q.isError ? (
              <span className="text-[9px] font-mono">rotation news unavailable</span>
            ) : (
              <>
                <RefreshCw className="h-3 w-3 animate-spin" />
                <span className="text-[9px] font-mono">loading…</span>
              </>
            )}
          </div>
        )}
        {data && groups.length === 0 && (
          <div
            className="py-8 text-center text-[9px] font-mono"
            style={{ color: colors.textSecondary }}
          >
            {data.error ?? "ROT has no groups right now"}
          </div>
        )}
        {groups.map((g) => (
          <GroupRow
            market={market}
            key={g.id}
            g={g}
            colors={colors}
            open={open === g.id}
            onToggle={() => setOpen((o) => (o === g.id ? null : g.id))}
          />
        ))}
        {data && (
          <p
            className="px-2 py-2 text-[7px] font-mono leading-snug"
            style={{ color: colors.textSecondary }}
          >
            quadrant = MKT → ROT{data.rotation_as_of ? ` (${data.rotation_as_of})` : ""} · bar = ▲
            pos / ▼ neg share · C = tone confirms the quadrant, D = diverges · then net tone ×100
            and headline count (hover a row for ▲/▼). {data.method}
          </p>
        )}
      </div>
    </>
  );
}
