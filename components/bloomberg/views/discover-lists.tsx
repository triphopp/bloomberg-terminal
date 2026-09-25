"use client";

/**
 * FREQ / ACTIVE — the two feeds that share the MKT left panel with WATCHLIST.
 *
 * Both use the TICK DATA grammar (one 13px line, 9px mono, SYM · LAST · CHG ·
 * one extra column) so switching tabs never changes how a row is read.
 *
 * - FREQ   the 30 symbols opened most often from a search box
 *          (`lib/search-stats.ts` → `/api/search-stats/*`, SQLite `search_hits`)
 * - ACTIVE today's most-traded US stocks by share volume
 *          (`/api/most-active`, Yahoo `most_actives` screener)
 */

import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo } from "react";
import { type SessionQuote, extendedSessionMove, staleMoveStyle } from "../core/market-session";
import { useWatchlistQuotes } from "../hooks/useWatchlistData";
import { SEARCH_HIT_EVENT } from "../lib/search-stats";
import type { bloombergColors } from "../lib/theme-config";

type Colors = typeof bloombergColors.dark;

const CELL = "pl-1 pr-0.5 py-0 text-right whitespace-nowrap tabular-nums";
const UP = "#00FF00";
const DOWN = "#FF0000";

function fmtPrice(n: number) {
  if (n >= 10000)
    return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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

function Head({
  extra,
  colors,
  extLabel,
}: { extra: string; colors: Colors; extLabel?: string | null }) {
  return (
    <thead>
      <tr
        className="text-[7px] font-bold tracking-wider leading-[12px]"
        style={{ background: "#050505", color: colors.textSecondary }}
      >
        <th className="px-1 py-0 text-left">SYM</th>
        <th className="px-1 py-0 text-right">LAST</th>
        <th className="px-1 py-0 text-right">CHG</th>
        {extLabel && <ExtHead label={extLabel} />}
        <th className="px-1 py-0 text-right">{extra}</th>
      </tr>
    </thead>
  );
}

function Notice({ text, colors, warn }: { text: string; colors: Colors; warn?: boolean }) {
  return (
    <div
      className="px-1 text-[8px] font-mono leading-[14px]"
      style={{ color: warn ? "#facc15" : colors.textSecondary }}
    >
      {text}
    </div>
  );
}

/**
 * Extended hours, inline: two extra columns (price · %chg) right after CHG, on
 * the same line as the regular-session numbers.
 *
 * The columns exist only while a pre/after-hours session is actually trading
 * (`extLabelOf` finds one in the list) — `extendedSessionMove` returns null in
 * regular hours and in the closed PREPRE/POSTPOST stretches, so outside those
 * windows the table keeps its plain four columns. Rows with no extended quote
 * (e.g. an index) get empty cells so the columns stay aligned.
 * Shared by WATCH (LIST view), FREQ and ACTIVE.
 */
export function extLabelOf(quotes: (SessionQuote | null | undefined)[]): string | null {
  for (const q of quotes) {
    const move = extendedSessionMove(q);
    if (move) return move.short;
  }
  return null;
}

export function ExtHead({ label }: { label: string }) {
  return (
    <th className="px-1 py-0 text-right" colSpan={2} title="Extended-hours price · %chg">
      {label}
    </th>
  );
}

export function ExtCells({
  quote,
  colors,
}: {
  quote: SessionQuote | null | undefined;
  colors: Colors;
}) {
  const move = extendedSessionMove(quote);
  if (!move) {
    return (
      <>
        <td />
        <td />
      </>
    );
  }
  const pct = move.pct;
  return (
    <>
      <td className={CELL} style={{ color: colors.text }} title={move.label}>
        {fmtPrice(move.price)}
      </td>
      <td
        className={CELL}
        style={{ color: pct == null ? colors.textSecondary : pct >= 0 ? UP : DOWN }}
        title={move.label}
      >
        {pct != null ? fmtPct(pct) : "—"}
      </td>
    </>
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
  showExt,
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
  /** render the two extended-hours columns (the list is in PRE/AH) */
  showExt?: boolean;
}) {
  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click shortcut, like TICK DATA rows */}
      <tr
        className="group cursor-pointer hover:bg-[#111]"
        style={{ borderBottom: "1px solid #111" }}
        title={title}
        onClick={() => onOpen(symbol)}
      >
        <td
          className="px-1 py-0 text-left font-bold truncate max-w-0 w-full"
          style={{ color: colors.accent }}
        >
          {symbol}
        </td>
        <td className={CELL} style={{ color: colors.text }}>
          {price != null ? fmtPrice(price) : "—"}
        </td>
        <td
          className={CELL}
          style={{
            color: pct == null ? colors.textSecondary : pct >= 0 ? UP : DOWN,
            opacity: dim,
          }}
        >
          {pct != null ? fmtPct(pct) : "—"}
        </td>
        {showExt && <ExtCells quote={ext} colors={colors} />}
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
  const extLabel = extLabelOf(symbols.map((sym) => quotes[sym]));

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
    <table
      className="w-full text-[9px] leading-[13px] font-mono"
      style={{ borderCollapse: "collapse" }}
    >
      <Head extra="HITS" colors={colors} extLabel={extLabel} />
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
              showExt={extLabel != null}
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
  const extLabel = extLabelOf(items);

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
      <table
        className="w-full text-[9px] leading-[13px] font-mono"
        style={{ borderCollapse: "collapse" }}
      >
        <Head extra="VOL" colors={colors} extLabel={extLabel} />
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
              showExt={extLabel != null}
            />
          ))}
        </tbody>
      </table>
    </>
  );
});
