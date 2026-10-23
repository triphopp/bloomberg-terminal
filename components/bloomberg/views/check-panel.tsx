"use client";

/**
 * MKT → STRUCTURE → CHECK: what we can measure that disagrees with buying the
 * symbol on the chart now (backend prebuy_check.py), the symbol's events for the
 * month (CAL), and its news tone as context. Plus `CheckChip`, the same answer
 * as one line on the chart header.
 *
 * A list of conflicts, not a score: nothing here averages a lagging sector
 * against a calm VIX, and nothing says buy / sell / hold. The tier only sizes
 * (A ×1 · B ×0.5 · C ×0), capped by TRADE GUARD. plans/pre-buy-check.md.
 */

import { memo, useMemo } from "react";

import { useOpenRisk } from "../alerts/useOpenRisk";
import { useOpenCalendar, useOpenTools } from "../alerts/useOpenTools";
import {
  type PrebuyCheck,
  type PrebuyCheckItem,
  type PrebuyEvent,
  checkApplies,
  usePrebuyCheck,
  useSymbolNews,
} from "../hooks/usePrebuyCheck";
import type { bloombergColors } from "../lib/theme-config";
import { summarizeTone } from "./news/tone-summary";

type Colors = typeof bloombergColors.dark;

const STATE_COLOR: Record<PrebuyCheckItem["state"], string> = {
  CONFLICT: "#FF4444",
  OPEN: "#FFB300",
  PASS: "#4CAF50",
  PENDING: "#888888",
};
const STATE_MARK: Record<PrebuyCheckItem["state"], string> = {
  CONFLICT: "✕",
  OPEN: "?",
  PASS: "✓",
  PENDING: "…",
};
const TIER_COLOR = { A: "#4CAF50", B: "#FFB300", C: "#FF4444" } as const;
const CAT_COLOR: Record<PrebuyEvent["category"], string> = {
  COMPANY: "#FF4444",
  MACRO: "#FFB300",
  THESIS: "#C77DFF",
  PORT: "#42a5f5",
};

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "CHECK C · 3 conflicts" — the chip text and its colour, or null for no chip. */
export function checkHeadline(
  data: PrebuyCheck | undefined
): { text: string; color: string } | null {
  if (!data || !data.applicable) return null;
  const n = data.counts?.conflict ?? 0;
  if (!data.tier)
    return { text: `CHECK … ${n ? plural(n, "conflict") : "loading"}`, color: "#888888" };
  const tail = n
    ? plural(n, "conflict")
    : (data.counts?.open ?? 0)
      ? plural(data.counts?.open ?? 0, "open question")
      : "no conflicts";
  return { text: `CHECK ${data.tier} · ${tail}`, color: TIER_COLOR[data.tier] };
}

// ── Chart-header chip ────────────────────────────────────────────────────────

export const CheckChip = memo(function CheckChip({
  symbol,
  onOpen,
}: {
  symbol: string | null;
  onOpen: () => void;
}) {
  const applies = checkApplies(symbol);
  const { data } = usePrebuyCheck(symbol, applies);
  const head = checkHeadline(data);
  if (!applies || !head) return null;
  const conflicts = data?.checks.filter((c) => c.state === "CONFLICT").map((c) => c.title) ?? [];
  return (
    <button
      type="button"
      className="text-[9px] font-bold font-mono whitespace-nowrap shrink-0 hover:opacity-70"
      style={{ color: head.color }}
      title={`${conflicts.length ? conflicts.join(" · ") : "Nothing measured argues against buying now"}\nOpen STRUCTURE → CHECK`}
      onClick={onOpen}
    >
      {head.text}
    </button>
  );
});

// ── Panel ────────────────────────────────────────────────────────────────────

interface CheckPanelProps {
  symbol: string | null;
  colors: Colors;
  compact?: boolean;
  /** Open the STRUCTURE panel on ROT (a sector check links there). */
  onOpenRot?: () => void;
  autoOpen: boolean;
  onToggleAutoOpen: () => void;
}

export const CheckPanel = memo(function CheckPanel({
  symbol,
  colors,
  compact = true,
  onOpenRot,
  autoOpen,
  onToggleAutoOpen,
}: CheckPanelProps) {
  const applies = checkApplies(symbol);
  const { data, isLoading, isError, error, refetch } = usePrebuyCheck(symbol, applies);
  const news = useSymbolNews(symbol, applies);
  const openRisk = useOpenRisk();
  const openCalendar = useOpenCalendar();
  const openTools = useOpenTools();

  const fs = compact ? "text-[9px]" : "text-[11px]";
  const fsSmall = compact ? "text-[8px]" : "text-[10px]";

  const tone = useMemo(
    () =>
      symbol && news.data
        ? summarizeTone(news.data.articles, symbol, Date.now(), compact ? 3 : 6)
        : null,
    [news.data, symbol, compact]
  );

  const go = (c: PrebuyCheckItem) => {
    if (c.view === "ROT") onOpenRot?.();
    else if (c.view === "CAL") openCalendar(c.date ? { date: c.date } : {});
    else if (c.view === "RISK") openRisk("summary");
    else if ((c.view === "THESES" || c.view === "TRACK") && c.thesis_id)
      openTools({ sub: "theses", thesisId: c.thesis_id });
  };
  const linkable = (c: PrebuyCheckItem) =>
    c.view === "ROT" ||
    c.view === "CAL" ||
    c.view === "RISK" ||
    ((c.view === "THESES" || c.view === "TRACK") && !!c.thesis_id);

  const autoToggle = (
    <button
      type="button"
      aria-pressed={autoOpen}
      className={`${fsSmall} font-mono ml-auto hover:opacity-70`}
      style={{ color: autoOpen ? "#FF9800" : colors.textSecondary }}
      title="Open CHECK every time the chart symbol changes (indices and futures excepted)"
      onClick={onToggleAutoOpen}
    >
      {autoOpen ? "✓ " : ""}OPEN ON EVERY SYMBOL
    </button>
  );

  if (!symbol) {
    return (
      <div className={`p-2 ${fs} font-mono`} style={{ color: colors.textSecondary }}>
        Pick a symbol on the chart.
      </div>
    );
  }
  if (!applies) {
    return (
      <div
        className={`p-2 ${fs} font-mono flex flex-col gap-1`}
        style={{ color: colors.textSecondary }}
      >
        <div className="flex items-center">
          <span style={{ color: "#FF9800" }}>{symbol}</span>
          {autoToggle}
        </div>
        <span>Index, FX, crypto or futures — no sector, earnings or thesis to check.</span>
      </div>
    );
  }

  const head = checkHeadline(data);
  const guard = data?.guard;
  const today = data?.as_of ?? new Date().toISOString().slice(0, 10);

  return (
    <div
      className={`h-full flex flex-col overflow-hidden font-mono ${fs}`}
      style={{ color: colors.text }}
    >
      {/* Head: symbol · tier · size · guard */}
      <div
        className="shrink-0 flex items-center gap-2 px-1.5 py-1 flex-wrap"
        style={{ borderBottom: `1px solid ${colors.border}` }}
      >
        <span className="font-bold" style={{ color: "#FF9800" }}>
          {symbol}
        </span>
        {head && (
          <span className="font-bold" style={{ color: head.color }}>
            {head.text.replace(/^CHECK /, "")}
          </span>
        )}
        {data?.size_multiplier != null && (
          <span
            style={{ color: colors.textSecondary }}
            title="Size the tier allows, capped by TRADE GUARD"
          >
            size ×{data.size_multiplier}
          </span>
        )}
        {guard && guard.light !== "GREEN" && (
          <button
            type="button"
            className="hover:opacity-70"
            style={{ color: guard.light === "RED" ? "#FF4444" : "#FFB300" }}
            title={`TRADE GUARD (whole book, not counted as a conflict): ${guard.why.join(" · ")}`}
            onClick={() => openRisk("summary")}
          >
            GUARD {guard.light} ×{guard.size_multiplier}
          </button>
        )}
        {autoToggle}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-1">
        {isLoading && (
          <div className="py-2" style={{ color: colors.textSecondary }}>
            CHECKING {symbol}…
          </div>
        )}
        {isError && (
          <div className="py-2" style={{ color: "#FF4444" }}>
            {(error as Error)?.message ?? "CHECK failed"}{" "}
            <button type="button" className="underline" onClick={() => refetch()}>
              RETRY
            </button>
          </div>
        )}

        {/* Checks — conflicts first (the server sorts) */}
        {data?.checks.map((c) => (
          <div
            key={c.id}
            className="grid items-start gap-x-1.5 py-[3px]"
            style={{
              gridTemplateColumns: "10px minmax(0,1fr) auto",
              borderTop: `1px solid ${colors.borderFaint}`,
            }}
          >
            <span
              className="font-bold"
              style={{ color: STATE_COLOR[c.state] }}
              aria-label={c.state}
            >
              {STATE_MARK[c.state]}
            </span>
            <span className="min-w-0">
              <span style={{ color: c.state === "PASS" ? colors.textSecondary : colors.text }}>
                {c.title}
              </span>
              {c.detail && (
                <span
                  className={`block truncate ${fsSmall}`}
                  style={{ color: colors.textDimmed }}
                  title={c.detail}
                >
                  {c.detail}
                </span>
              )}
            </span>
            {linkable(c) ? (
              <button
                type="button"
                className={`${fsSmall} hover:opacity-70`}
                style={{ color: colors.textSecondary }}
                title={`Open ${c.view}`}
                onClick={() => go(c)}
              >
                {c.view}↗
              </button>
            ) : (
              <span className={fsSmall} style={{ color: colors.textDimmed }}>
                {c.view === "chart" ? "" : c.view}
              </span>
            )}
          </div>
        ))}

        {/* Month strip + upcoming */}
        {data && (
          <MonthStrip
            events={data.events}
            today={today}
            colors={colors}
            compact={compact}
            onDay={(date) => openCalendar({ date })}
          />
        )}

        {/* News tone — context only */}
        {tone && (
          <div className="mt-1.5">
            <div
              className={`flex items-center gap-2 ${fsSmall}`}
              style={{ color: colors.textSecondary }}
            >
              <span>NEWS TONE · 72H</span>
              <span className="ml-auto" style={{ color: colors.textDimmed }}>
                context, not counted
              </span>
            </div>
            {tone.last72h.n === 0 ? (
              <div className={fsSmall} style={{ color: colors.textDimmed }}>
                {news.data?.pending ? "headlines loading…" : "no headlines in 72 h"}
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 py-0.5">
                  <ToneBar c={tone.last72h} />
                  <span>
                    <span style={{ color: "#4CAF50" }}>▲{tone.last72h.pos}</span>
                    <span style={{ color: colors.textSecondary }}> · {tone.last72h.neu} · </span>
                    <span style={{ color: "#FF4444" }}>▼{tone.last72h.neg}</span>
                  </span>
                  <span className={fsSmall} style={{ color: colors.textDimmed }}>
                    24h ▲{tone.last24h.pos} ▼{tone.last24h.neg}
                  </span>
                </div>
                {tone.latest.map((a) => (
                  <a
                    key={a.url || a.title}
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`flex gap-1 ${fsSmall} hover:opacity-70`}
                    title={`${a.source ?? ""} · ${a.published_at}`}
                  >
                    <span
                      style={{
                        color:
                          a.sentiment === "POS"
                            ? "#4CAF50"
                            : a.sentiment === "NEG"
                              ? "#FF4444"
                              : colors.textDimmed,
                      }}
                    >
                      {a.sentiment === "POS" ? "▲" : a.sentiment === "NEG" ? "▼" : "·"}
                    </span>
                    <span className="truncate" style={{ color: colors.textSecondary }}>
                      {a.title}
                    </span>
                  </a>
                ))}
              </>
            )}
          </div>
        )}

        {data && (
          <div className={`mt-1.5 ${fsSmall}`} style={{ color: colors.textDimmed }}>
            rules: earnings ≤{String(data.rules.earnings_days)}d · macro ≤
            {String(data.rules.macro_days)}d · sector Lagging · below 200D · caps{" "}
            {String(data.rules.max_weight_pct)}/{String(data.rules.max_sector_pct)}% at size{" "}
            {String(data.rules.buy_bucket)} · measured facts, not a buy / sell call
          </div>
        )}
      </div>
    </div>
  );
});

function ToneBar({ c }: { c: { n: number; pos: number; neg: number; neu: number } }) {
  const w = (x: number) => `${(x / Math.max(1, c.n)) * 100}%`;
  return (
    <div className="flex h-[5px] w-16 overflow-hidden" data-frame>
      <i style={{ width: w(c.pos), background: "#4CAF50" }} />
      <i style={{ width: w(c.neu), background: "#444" }} />
      <i style={{ width: w(c.neg), background: "#FF4444" }} />
    </div>
  );
}

function MonthStrip({
  events,
  today,
  colors,
  compact,
  onDay,
}: {
  events: PrebuyEvent[];
  today: string;
  colors: Colors;
  compact: boolean;
  onDay: (date: string) => void;
}) {
  const fsSmall = compact ? "text-[8px]" : "text-[10px]";
  const month = today.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const daysIn = new Date(y, m, 0).getDate();
  const byDay = new Map<string, PrebuyEvent[]>();
  for (const e of events) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const upcoming = events.filter((e) => e.days_until >= 0 && !e.done).slice(0, compact ? 6 : 12);
  const monthName = new Date(y, m - 1, 1).toLocaleString("en", { month: "short", year: "numeric" });
  return (
    <div className="mt-1.5">
      <div className={`flex items-center ${fsSmall}`} style={{ color: colors.textSecondary }}>
        <span>EVENTS · {monthName.toUpperCase()}</span>
        <span className="ml-auto" style={{ color: colors.textDimmed }}>
          from CAL
        </span>
      </div>
      <div className="flex py-0.5">
        {Array.from({ length: daysIn }, (_, i) => {
          const d = `${month}-${String(i + 1).padStart(2, "0")}`;
          const evs = byDay.get(d) ?? [];
          const top =
            evs.find((e) => e.category === "COMPANY") ??
            evs.find((e) => e.impact === "high") ??
            evs[0];
          const isToday = d === today;
          return (
            <button
              type="button"
              key={d}
              className="relative flex-1 h-[16px] text-left"
              style={{
                borderLeft: `1px solid ${colors.borderFaint}`,
                opacity: d < today ? 0.4 : 1,
                color: isToday ? "#FF9800" : colors.textDimmed,
              }}
              title={evs.length ? `${d}: ${evs.map((e) => e.title).join(" · ")}` : d}
              onClick={() => onDay(d)}
            >
              <span className="absolute top-0 left-[1px] text-[7px] leading-none">
                {isToday || (i + 1) % 5 === 0 || i === 0 ? i + 1 : ""}
              </span>
              {top && (
                <span
                  data-frame
                  className="absolute bottom-[1px] left-1/2 -translate-x-1/2 w-[5px] h-[5px]"
                  style={{ background: CAT_COLOR[top.category] }}
                />
              )}
            </button>
          );
        })}
      </div>
      {upcoming.map((e) => (
        <button
          type="button"
          key={e.id}
          className={`w-full grid items-center gap-x-1.5 py-[1px] text-left hover:opacity-70 ${fsSmall}`}
          style={{ gridTemplateColumns: "38px 30px minmax(0,1fr)" }}
          title={[e.detail, e.source, e.estimated ? "estimated date" : ""]
            .filter(Boolean)
            .join(" · ")}
          onClick={() => onDay(e.date)}
        >
          <span style={{ color: colors.textSecondary }}>{e.date.slice(5)}</span>
          <span style={{ color: colors.textDimmed }}>
            {e.days_until === 0 ? "today" : `${e.days_until}d`}
          </span>
          <span className="truncate">
            <span style={{ color: CAT_COLOR[e.category] }}>● </span>
            <span style={{ color: colors.text }}>
              {e.category === "COMPANY" && e.symbol ? `${e.symbol} ` : ""}
              {e.title}
              {e.estimated ? " ≈" : ""}
            </span>
            {e.impact === "high" && <span style={{ color: "#FFB300" }}> · high</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
