"use client";

/**
 * STRUCTURE → DEPTH: the resting bids and offers of the symbol on the MKT chart.
 *
 * Webull OpenAPI, US stocks and ETFs only. The ladder shows what the account is
 * entitled to — one level on the free feed, more with the OpenAPI TotalView
 * subscription — and says which, because a one-row "book" otherwise reads as a
 * thin market. Everything short of a ladder (no keys, no token, no entitlement)
 * is a sentence saying what to do next, never an empty table.
 */

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import type { useDepth } from "../hooks/useDepth";
import { DEPTH_CHOICES, type DepthLadder, type DepthRow } from "../lib/depth-book";
import { fmtPriceStd, numberFormat } from "../lib/number-format";
import { SCROLLBAR_THIN_LIGHTER } from "../lib/style-constants";
import type { bloombergColors } from "../lib/theme-config";

export interface DepthPanelProps {
  model: ReturnType<typeof useDepth>;
  colors: typeof bloombergColors.dark;
  compact?: boolean;
}

const BID = "#00C853";
const ASK = "#FF3B30";
const ACCENT = "#FF9800";
const fmtSize = (n: number) => numberFormat(0, 7).format(n);

function Notice({
  title,
  children,
  colors,
  compact,
}: {
  title: string;
  children?: ReactNode;
  colors: DepthPanelProps["colors"];
  compact: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1 font-mono ${compact ? "p-2 text-[8px]" : "p-4 text-[11px]"}`}
      style={{ color: colors.textSecondary, lineHeight: 1.5 }}
    >
      <span className="font-bold" style={{ color: ACCENT }}>
        {title}
      </span>
      {children}
    </div>
  );
}

function Side({
  level,
  side,
  showCount,
  cell,
}: {
  level: DepthRow["bid"];
  side: "bid" | "ask";
  showCount: boolean;
  cell: string;
}) {
  const color = side === "bid" ? BID : ASK;
  const count = showCount && (
    <span className={`${cell} w-[14%] text-center`} style={{ color: "#8a8a8a" }}>
      {level?.count ?? ""}
    </span>
  );
  const size = (
    <span className={`${cell} flex-1 text-center`} style={{ color: "#e6e6e6" }}>
      {level ? fmtSize(level.size) : ""}
    </span>
  );
  const price = (
    <span
      className={`${cell} w-[38%] font-bold ${side === "bid" ? "text-right" : "text-left"}`}
      style={{ color }}
    >
      {level ? fmtPriceStd(level.price) : ""}
    </span>
  );
  return (
    <div className="relative flex flex-1 items-center min-w-0">
      {/* The bar grows away from the spread: bids to the left, offers to the right. */}
      {level && (
        <div
          className="absolute inset-y-0"
          style={{
            [side === "bid" ? "right" : "left"]: 0,
            width: `${Math.max(level.bar * 100, 1)}%`,
            background: `${color}38`,
          }}
        />
      )}
      <div className="relative flex w-full items-center">
        {side === "bid" ? (
          <>
            {count}
            {size}
            {price}
          </>
        ) : (
          <>
            {price}
            {size}
            {count}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One level is a quote, not a book: drawn as a table it is a single row that
 * reads as a thin market. So Level 1 gets the quote laid out large — the two
 * prices, what rests at each, the gap between them, and which side is heavier.
 */
function TopOfBook({
  ladder,
  quoteTime,
  colors,
  compact,
}: {
  ladder: DepthLadder;
  quoteTime: string | null;
  colors: DepthPanelProps["colors"];
  compact: boolean;
}) {
  const bid = ladder.rows[0]?.bid ?? null;
  const ask = ladder.rows[0]?.ask ?? null;
  const total = ladder.bidSize + ladder.askSize;
  const bidShare = total > 0 ? ladder.bidSize / total : 0.5;
  const label = `${compact ? "text-[7px]" : "text-[11px]"} font-mono font-bold tracking-widest`;
  const price = `${compact ? "text-[20px] leading-6" : "text-[56px] leading-[60px]"} font-mono font-bold tabular-nums`;
  const size = `${compact ? "text-[9px]" : "text-[18px]"} font-mono tabular-nums`;
  const small = `${compact ? "text-[7px]" : "text-[12px]"} font-mono tabular-nums`;
  const quote = (side: "bid" | "ask", level: typeof bid) => (
    <div className={`flex flex-1 min-w-0 flex-col ${side === "bid" ? "items-end" : "items-start"}`}>
      <span className={label} style={{ color: "#8a8a8a" }}>
        {side === "bid" ? "BID" : "ASK"}
      </span>
      <span
        className={`${price} truncate max-w-full`}
        style={{ color: side === "bid" ? BID : ASK }}
      >
        {level ? fmtPriceStd(level.price) : "—"}
      </span>
      <span className={size} style={{ color: "#e6e6e6" }}>
        {level ? `× ${fmtSize(level.size)}` : ""}
      </span>
    </div>
  );
  return (
    <div
      className={`flex flex-1 min-h-0 flex-col justify-center ${compact ? "gap-2 px-2" : "gap-6 px-10"}`}
    >
      <div className={`flex items-start ${compact ? "gap-3" : "gap-10"}`}>
        {quote("bid", bid)}
        {quote("ask", ask)}
      </div>

      <div className={`flex justify-center ${compact ? "gap-3" : "gap-8"} ${small}`}>
        <span style={{ color: colors.textSecondary }}>
          SPREAD{" "}
          <span style={{ color: "#e6e6e6" }}>
            {ladder.spread != null ? fmtPriceStd(ladder.spread) : "—"}
          </span>
          {ladder.spreadBps != null && ` · ${ladder.spreadBps.toFixed(1)}bp`}
        </span>
        <span style={{ color: colors.textSecondary }}>
          MID{" "}
          <span style={{ color: "#e6e6e6" }}>
            {ladder.mid != null ? numberFormat(2, 4).format(ladder.mid) : "—"}
          </span>
        </span>
      </div>

      {/* Which side is heavier at the touch — size only, one level, so a hint and no more. */}
      <div className="flex flex-col gap-0.5">
        <div
          className={`flex w-full overflow-hidden ${compact ? "h-1.5" : "h-3"}`}
          title="Bid size against offer size at the best prices"
          style={{ background: "#1a1a1a" }}
        >
          <div style={{ width: `${bidShare * 100}%`, background: BID }} />
          <div style={{ flex: 1, background: ASK }} />
        </div>
        <div className={`flex justify-between ${small}`}>
          <span style={{ color: BID }}>{total > 0 ? `${(bidShare * 100).toFixed(0)}%` : ""}</span>
          <span style={{ color: colors.textSecondary }}>
            {quoteTime ? new Date(quoteTime).toLocaleTimeString("en-GB", { hour12: false }) : "—"}
          </span>
          <span style={{ color: ASK }}>
            {total > 0 ? `${((1 - bidShare) * 100).toFixed(0)}%` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

export function DepthPanel({ model, colors, compact = false }: DepthPanelProps) {
  const { symbol, supported, status, book, ladder, error } = model;
  const text = compact ? "text-[8px]" : "text-[12px]";
  const cell = `${compact ? "px-1 leading-[14px]" : "px-2 leading-6"} ${text} font-mono tabular-nums truncate`;
  const head = `${compact ? "px-1 text-[6px] leading-3" : "px-2 text-[9px] leading-5"} font-mono font-bold tracking-wide`;
  const button = `${compact ? "text-[7px] px-1 leading-4" : "text-[10px] px-2 py-0.5"} font-bold font-mono`;
  const notice = (title: string, body?: ReactNode) => (
    <Notice title={title} colors={colors} compact={compact}>
      {body}
    </Notice>
  );
  const env = status?.environment === "test" ? " · TEST HOST" : "";
  // Webull gave fewer levels than were asked for, and only one: the Level 1 feed.
  const levelOne = !error && !!book && book.levels <= 1 && book.depth_requested > 1;

  let body: ReactNode;
  if (!symbol) body = notice("NO SYMBOL", "Pick a symbol on the MKT chart.");
  else if (!supported)
    body = notice(
      `${symbol} — NOT IN THIS FEED`,
      "Depth comes from Webull OpenAPI: US stocks and ETFs only. No index, future, FX, crypto, option or non-US listing."
    );
  else if (model.statusLoading)
    body = (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-3 w-3 animate-spin" style={{ color: ACCENT }} />
      </div>
    );
  else if (!status?.configured || error?.code === "keys")
    body = notice(
      "WEBULL KEYS NOT SET",
      <>
        <span>
          Put WEBULL_APP_KEY and WEBULL_APP_SECRET in backend/.env, then restart the backend.
        </span>
        <span>Both come from the Webull Thailand website → OpenAPI.</span>
      </>
    );
  else if (error?.code === "token_missing" || error?.code === "token_pending") {
    const pending = error.code === "token_pending";
    const busy = model.requestToken.isPending || model.checkToken.isPending;
    const failed = model.requestToken.error ?? model.checkToken.error;
    body = notice(
      pending ? "WAITING FOR YOU IN THE WEBULL APP" : "NO ACCESS TOKEN",
      <>
        {pending ? (
          <span>
            Webull sent an SMS code. Open the Webull app → Menu → Messages → OpenAPI Notifications →
            Check Now, enter the code. You have 5 minutes; this panel picks it up by itself.
          </span>
        ) : (
          <span>
            Webull wants the account owner to approve this app once.
            {status.environment === "production"
              ? " Requesting a token sends an SMS code to the phone on the account, to be entered in the Webull app within 5 minutes."
              : " The test host approves at once — no SMS."}
          </span>
        )}
        <span className="flex gap-2 mt-1">
          <button
            type="button"
            data-frame
            className={button}
            disabled={busy}
            style={{ color: ACCENT, border: `1px solid ${ACCENT}66`, opacity: busy ? 0.5 : 1 }}
            onClick={() => model.requestToken.mutate()}
          >
            {pending ? "SEND A NEW CODE" : "REQUEST TOKEN"}
          </button>
          {pending && (
            <button
              type="button"
              data-frame
              className={button}
              disabled={busy}
              style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
              onClick={() => model.checkToken.mutate()}
            >
              CHECK NOW
            </button>
          )}
        </span>
        {failed && <span style={{ color: ASK }}>{failed.message}</span>}
      </>
    );
  } else if (error)
    body = notice(
      error.code === "subscription"
        ? "NOT SUBSCRIBED"
        : error.code === "empty"
          ? `${symbol} — NO BOOK`
          : error.code === "rate_limit"
            ? "RATE LIMIT"
            : "WEBULL ERROR",
      <span style={{ color: error.code === "empty" ? colors.textSecondary : ASK }}>
        {error.message}
      </span>
    );
  else if (!book || !ladder)
    body = (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-3 w-3 animate-spin" style={{ color: ACCENT }} />
      </div>
    );
  else {
    const showCount = book.has_counts;
    const lean = ladder.imbalance;
    body = (
      <div className="flex flex-col h-full min-h-0">
        {/* What the rows below add up to */}
        <div
          className={`flex items-center gap-2 shrink-0 font-mono ${compact ? "px-1 text-[7px] leading-4" : "px-2 text-[10px] leading-6"}`}
          style={{ color: colors.textSecondary, borderBottom: `1px solid ${colors.border}` }}
        >
          <span className="font-bold" style={{ color: "#e6e6e6" }}>
            {book.symbol}
          </span>
          {ladder.spread != null && book.levels > 1 && (
            <span title="Best offer − best bid, and that as basis points of the mid">
              SPR {fmtPriceStd(ladder.spread)}
              {ladder.spreadBps != null && ` · ${ladder.spreadBps.toFixed(1)}bp`}
            </span>
          )}
          {lean != null && book.levels > 1 && (
            <span
              title="(bid size − offer size) ÷ total, over the rows shown"
              style={{ color: lean > 0.1 ? BID : lean < -0.1 ? ASK : colors.textSecondary }}
            >
              {lean >= 0 ? "BID" : "ASK"} {Math.abs(lean * 100).toFixed(0)}%
            </span>
          )}
          <span
            className="ml-auto"
            title={
              book.levels < book.depth_requested
                ? `Asked for ${book.depth_requested} levels, Webull answered ${book.levels}. One level = the free Level 1 feed; more needs the OpenAPI TotalView subscription.`
                : undefined
            }
            style={{ color: book.levels <= 1 ? ACCENT : colors.textSecondary }}
          >
            {book.levels <= 1 ? "L1 ONLY" : `L2 ×${book.levels}`}
            {book.overnight ? " · OVN" : ""}
            {env}
          </span>
        </div>

        {book.levels <= 1 ? (
          <TopOfBook
            ladder={ladder}
            quoteTime={book.quote_time}
            colors={colors}
            compact={compact}
          />
        ) : (
          <>
            <div className="flex shrink-0" style={{ background: "#0c0c0c", color: "#8a8a8a" }}>
              <div className="flex flex-1 min-w-0">
                {showCount && <span className={`${head} w-[14%] text-center`}>CNT</span>}
                <span className={`${head} flex-1 text-center`}>QTY</span>
                <span className={`${head} w-[38%] text-right`}>BID</span>
              </div>
              <div className="flex flex-1 min-w-0">
                <span className={`${head} w-[38%] text-left`}>ASK</span>
                <span className={`${head} flex-1 text-center`}>QTY</span>
                {showCount && <span className={`${head} w-[14%] text-center`}>CNT</span>}
              </div>
            </div>

            <div className={`flex-1 min-h-0 overflow-y-auto ${SCROLLBAR_THIN_LIGHTER}`}>
              {ladder.rows.map((row, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: a ladder row is its rank, prices move through it
                  key={i}
                  className="flex"
                  style={{ borderBottom: "1px solid #111" }}
                >
                  <Side level={row.bid} side="bid" showCount={showCount} cell={cell} />
                  <Side level={row.ask} side="ask" showCount={showCount} cell={cell} />
                </div>
              ))}
            </div>

            <div
              className={`flex shrink-0 font-mono tabular-nums ${compact ? "px-1 text-[7px] leading-4" : "px-2 text-[10px] leading-6"}`}
              style={{ color: colors.textSecondary, borderTop: `1px solid ${colors.border}` }}
            >
              <span style={{ color: BID }}>Σ {fmtSize(ladder.bidSize)}</span>
              <span className="mx-auto">
                {book.quote_time
                  ? new Date(book.quote_time).toLocaleTimeString("en-GB", { hour12: false })
                  : "—"}
              </span>
              <span style={{ color: ASK }}>Σ {fmtSize(ladder.askSize)}</span>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0" style={{ background: "#000" }}>
      <div
        className={`flex items-center gap-1 shrink-0 ${compact ? "px-1 py-0.5" : "px-3 py-1"}`}
        style={{ background: "#080808", borderBottom: `1px solid ${colors.border}` }}
      >
        <span
          className={`${compact ? "text-[6px]" : "text-[9px]"} font-mono`}
          style={{ color: "#8a8a8a" }}
        >
          {levelOne ? "LEVEL 1 — BEST BID / OFFER" : "LEVELS"}
        </span>
        {/* A choice that changes nothing is not offered: on the Level 1 feed every
            request comes back one level. The chosen depth is kept and asked for again
            when the entitlement is re-read, so the buttons return with Level 2. */}
        {levelOne ? (
          <span
            className={`${compact ? "text-[6px]" : "text-[9px]"} font-mono`}
            title="More levels need the Nasdaq TotalView - Non Display subscription (Webull website → Advanced Quotes). Picked up within 10 minutes of subscribing."
            style={{ color: "#5a5a5a" }}
          >
            · L2 = TOTALVIEW NON-DISPLAY
          </span>
        ) : (
          DEPTH_CHOICES.map((n) => (
            <button
              aria-pressed={model.depth === n}
              type="button"
              key={n}
              className={button}
              style={{ color: model.depth === n ? ACCENT : colors.textSecondary }}
              onClick={() => model.setDepth(n)}
            >
              {n}
            </button>
          ))
        )}
        <button
          aria-pressed={model.overnight}
          type="button"
          className={`${button} ml-auto`}
          title="Include the overnight session (20:00–04:00 ET). Its depth is a separate OpenAPI subscription."
          style={{ color: model.overnight ? ACCENT : colors.textSecondary }}
          onClick={() => model.setOvernight(!model.overnight)}
        >
          OVN
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">{body}</div>
    </div>
  );
}
