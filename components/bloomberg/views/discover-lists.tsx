"use client";

/**
 * FREQ / ACTIVE — the two feeds that share the MKT left panel with WATCHLIST.
 *
 * Both use the TICK DATA grammar (one mono line, sizes from lib/tick-grammar, SYM · LAST · CHG ·
 * one extra column) so switching tabs never changes how a row is read.
 *
 * - FREQ   the 30 symbols opened most often from a search box
 *          (`lib/search-stats.ts` → `/api/search-stats/*`, SQLite `search_hits`)
 * - ACTIVE today's most-traded US stocks by share volume
 *          (`/api/most-active`, Yahoo `most_actives` screener)
 */

import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo } from "react";
import {
  type SessionQuote,
  extendedSessionMove,
  sessionConfig,
  staleMoveStyle,
} from "../core/market-session";
import { useWatchlistQuotes } from "../hooks/useWatchlistData";
import { fmtPriceStd } from "../lib/number-format";
import { SEARCH_HIT_EVENT } from "../lib/search-stats";
import type { bloombergColors } from "../lib/theme-config";
import { TICK_HEAD, TICK_NOTE, TICK_TABLE } from "../lib/tick-grammar";

type Colors = typeof bloombergColors.dark;

const CELL = "pl-1 pr-0.5 py-0 text-right whitespace-nowrap tabular-nums";
const UP = "#00FF00";
const DOWN = "#FF0000";

const fmtPrice = fmtPriceStd;

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtVol(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

function Head({ extra, colors }: { extra: string; colors: Colors }) {
  return (
    <thead>
      <tr className={TICK_HEAD} style={{ background: "#050505", color: colors.textSecondary }}>
        <th className="px-1 py-0 text-left">SYM</th>
        <th className="px-1 py-0 text-right">LAST</th>
        <th className="px-1 py-0 text-right">CHG</th>
        <th className="px-1 py-0 text-right">{extra}</th>
      </tr>
    </thead>
  );
}

function Notice({ text, colors, warn }: { text: string; colors: Colors; warn?: boolean }) {
  return (
    <div className={`px-1 ${TICK_NOTE}`} style={{ color: warn ? "#facc15" : colors.textSecondary }}>
      {text}
    </div>
  );
}

const FeedRow = memo(function FeedRow({
  symbol,
  price,
  pct,
  dim,
  extra,
  extraColor,
  title,
  colors,
  onOpen,
  onForget,
  ext,
}: {
  symbol: string;
  price: number | null | undefined;
  pct: number | null | undefined;
  /** dim the move — it belongs to a session that has already ended */
  dim?: number;
  extra: string;
  extraColor?: string;
  title: string;
  colors: Colors;
  onOpen: (symbol: string) => void;
  onForget?: (symbol: string) => void;
  /** quote carrying pre/post fields */
  ext?: SessionQuote | null;
}) {
  // PRE/AH: the extended print takes over LAST/CHG, same as the WATCHLIST LIST
  // view — two extra columns squeezed SYM to 2 letters in a narrow panel. The
  // regular close moves to the tooltip; a P/A mark says which price this is.
  const move = extendedSessionMove(ext);
  const moveColor = move ? sessionConfig(ext?.marketState)?.color : undefined;
  const shownPrice = move ? move.price : price;
  const shownPct = move ? move.pct : pct;
  const rowTitle = move
    ? [
        title,
        `${move.label} ${fmtPrice(move.price)}${move.pct != null ? ` ${fmtPct(move.pct)}` : ""} · close ${
          price != null ? fmtPrice(price) : "—"
        }${pct != null ? ` ${fmtPct(pct)}` : ""}`,
      ].join("\n")
    : title;
  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click shortcut, like TICK DATA rows */}
      <tr
        className="group cursor-pointer hover:bg-[#111]"
        style={{ borderBottom: "1px solid #111" }}
        title={rowTitle}
        onClick={() => onOpen(symbol)}
      >
        <td
          className="px-1 py-0 text-left font-bold truncate max-w-0 w-full min-w-[5ch]"
          style={{ color: colors.accent }}
        >
          {symbol}
        </td>
        <td className={CELL} style={{ color: colors.text }}>
          {shownPrice != null ? fmtPrice(shownPrice) : "—"}
          {move && (
            <sup className="text-[7px] ml-px font-bold" style={{ color: moveColor }}>
              {move.short.charAt(0)}
            </sup>
          )}
        </td>
        <td
          className={CELL}
          style={{
            color: shownPct == null ? colors.textSecondary : shownPct >= 0 ? UP : DOWN,
            // the extended move is live — only a past session's regular move dims
            opacity: move ? undefined : dim,
          }}
        >
          {shownPct != null ? fmtPct(shownPct) : "—"}
        </td>
        <td className={CELL} style={{ color: extraColor ?? colors.textSecondary }}>
          {onForget ? (
            <>
              <span className="group-hover:hidden">{extra}</span>
              <button
                type="button"
                className="hidden group-hover:inline hover:opacity-70"
                style={{ color: "#f87171" }}
                title={`Forget ${symbol}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onForget(symbol);
                }}
              >
                ×
              </button>
            </>
          ) : (
            extra
          )}
        </td>
      </tr>
    </>
  );
});

// ── FREQ ──────────────────────────────────────────────────────────────────────

interface SearchStat {
  symbol: string;
  count: number;
  last_at: string;
}

export const FrequentSearchList = memo(function FrequentSearchList({
  colors,
  onSymbolClick,
}: {
  colors: Colors;
  onSymbolClick: (symbol: string) => void;
}) {
  const { data, isLoading, refetch } = useQuery<{ items: SearchStat[]; error?: string }>({
    queryKey: ["search-stats-top", 30],
    queryFn: () => fetch("/api/search-stats/top?limit=30").then((r) => r.json()),
    staleTime: 30_000,
  });
  // A search anywhere in the terminal bumps a count — refresh right away.
  useEffect(() => {
    const onHit = () => refetch();
    window.addEventListener(SEARCH_HIT_EVENT, onHit);
    return () => window.removeEventListener(SEARCH_HIT_EVENT, onHit);
  }, [refetch]);

  const items = data?.items ?? [];
  const symbols = useMemo(() => items.map((i) => i.symbol), [items]);
  const { quotes } = useWatchlistQuotes(symbols);

  const forget = useCallback(
    (symbol: string) => {
      fetch(`/api/search-stats/${encodeURIComponent(symbol)}`, { method: "DELETE" })
        .then(() => refetch())
        .catch(() => {});
    },
    [refetch]
  );

  if (data?.error) return <Notice text={data.error} colors={colors} warn />;
  if (isLoading) return <Notice text="loading…" colors={colors} />;
  if (items.length === 0)
    return (
      <Notice
        text="no searches yet — symbols you open from a search box land here"
        colors={colors}
      />
    );

  return (
    <table className={TICK_TABLE} style={{ borderCollapse: "collapse" }}>
      <Head extra="HITS" colors={colors} />
      <tbody>
        {items.map((it) => {
          const q = quotes[it.symbol];
          const stale = q ? staleMoveStyle(q) : null;
          return (
            <FeedRow
              key={it.symbol}
              symbol={it.symbol}
              price={q?.regularMarketPrice}
              pct={q?.regularMarketChangePercent}
              dim={stale?.opacity}
              extra={`${it.count}`}
              title={[
                q?.shortName ?? it.symbol,
                `searched ${it.count}× · last ${it.last_at} UTC`,
                stale?.title,
              ]
                .filter(Boolean)
                .join("\n")}
              colors={colors}
              onOpen={onSymbolClick}
              onForget={forget}
              ext={q}
            />
          );
        })}
      </tbody>
    </table>
  );
});

// ── ACTIVE ────────────────────────────────────────────────────────────────────

interface ActiveItem extends SessionQuote {
  symbol: string;
  name: string | null;
  price: number | null;
  pctChange: number | null;
  volume: number | null;
  avgVolume: number | null;
  rvol: number | null;
  marketState: string | null;
  time: number | null;
}

export const MostActiveList = memo(function MostActiveList({
  colors,
  onSymbolClick,
}: {
  colors: Colors;
  onSymbolClick: (symbol: string) => void;
}) {
  const { data, isLoading } = useQuery<{ items: ActiveItem[]; asOf?: number; error?: string }>({
    queryKey: ["most-active", 30],
    queryFn: () => fetch("/api/most-active?count=30").then((r) => r.json()),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const items = data?.items ?? [];

  if (data?.error) return <Notice text={data.error} colors={colors} warn />;
  if (isLoading) return <Notice text="loading…" colors={colors} />;
  if (items.length === 0) return <Notice text="no data" colors={colors} />;

  // Before the open the screener still ranks the previous session.
  const session = items[0]?.marketState;
  const lastTrade = items[0]?.time ? new Date(items[0].time * 1000) : null;
  const prevSession = session != null && session !== "REGULAR";

  return (
    <>
      <Notice
        text={`US · SHARE VOLUME${
          prevSession && lastTrade
            ? ` · session of ${lastTrade.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                timeZone: "America/New_York",
              })}`
            : " · today"
        }`}
        colors={colors}
      />
      <table className={TICK_TABLE} style={{ borderCollapse: "collapse" }}>
        <Head extra="VOL" colors={colors} />
        <tbody>
          {items.map((it) => (
            <FeedRow
              key={it.symbol}
              symbol={it.symbol}
              price={it.price}
              pct={it.pctChange}
              dim={prevSession ? 0.55 : undefined}
              extra={fmtVol(it.volume)}
              // rvol ≥ 2 = unusual participation, worth a look
              extraColor={it.rvol != null && it.rvol >= 2 ? "#ff9900" : undefined}
              title={[
                it.name ?? it.symbol,
                `volume ${fmtVol(it.volume)} · 3M avg ${fmtVol(it.avgVolume)}${
                  it.rvol != null ? ` · RVOL ${it.rvol.toFixed(2)}×` : ""
                }`,
              ].join("\n")}
              colors={colors}
              onOpen={onSymbolClick}
              ext={it}
            />
          ))}
        </tbody>
      </table>
    </>
  );
});
