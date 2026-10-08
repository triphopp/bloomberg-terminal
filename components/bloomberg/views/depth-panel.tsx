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
import { type PointerEvent, type ReactNode, memo, useRef } from "react";
import type { useDepth } from "../hooks/useDepth";
import { DEPTH_CHOICES, type DepthLadder, type DepthRow, SPLIT } from "../lib/depth-book";
import { fmtPriceStd, numberFormat } from "../lib/number-format";
import { SCROLLBAR_THIN } from "../lib/style-constants";
import type { bloombergColors } from "../lib/theme-config";
import type { TapeTotals, Trade } from "../lib/trade-tape";
import type { ProfileRow, VolumeProfile } from "../lib/volume-by-price";

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
 * reads as a thin market. So Level 1 is one line — size × bid | offer × size —
 * over a hairline showing which side is heavier, and the room goes to what
 * moves: the tape and the volume by price. Spread is in the strip above.
 */
function TopOfBook({ ladder, compact }: { ladder: DepthLadder; compact: boolean }) {
  const bid = ladder.rows[0]?.bid ?? null;
  const ask = ladder.rows[0]?.ask ?? null;
  const total = ladder.bidSize + ladder.askSize;
  const bidShare = total > 0 ? ladder.bidSize / total : 0.5;
  const price = `${compact ? "text-[13px] leading-[18px]" : "text-[26px] leading-9"} font-mono font-bold tabular-nums`;
  const size = `${compact ? "text-[8px]" : "text-[13px]"} font-mono tabular-nums`;
  return (
    <div className="shrink-0">
      <div className={`flex items-baseline ${compact ? "gap-1.5 px-1" : "gap-3 px-3"}`}>
        <span className={`${size} flex-1 text-right`} style={{ color: "#e6e6e6" }}>
          {bid ? fmtSize(bid.size) : ""}
        </span>
        <span className={price} style={{ color: BID }}>
          {bid ? fmtPriceStd(bid.price) : "—"}
        </span>
        <span className={price} style={{ color: ASK }}>
          {ask ? fmtPriceStd(ask.price) : "—"}
        </span>
        <span className={`${size} flex-1`} style={{ color: "#e6e6e6" }}>
          {ask ? fmtSize(ask.size) : ""}
        </span>
      </div>
      {/* Which side is heavier at the touch — size only, one level, so a hint and no more. */}
      <div
        className={`flex w-full ${compact ? "h-[2px]" : "h-1"}`}
        title={`Bid size ${total > 0 ? Math.round(bidShare * 100) : 50}% · offer size ${total > 0 ? Math.round((1 - bidShare) * 100) : 50}% at the best prices`}
        style={{ background: "#1a1a1a" }}
      >
        <div style={{ width: `${bidShare * 100}%`, background: BID }} />
        <div style={{ flex: 1, background: ASK }} />
      </div>
    </div>
  );
}

const SIDE_COLOR = { B: BID, S: ASK, N: "#8a8a8a" } as const;
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
// A print can be inside the spread, at a fraction of a cent.
const fmtPrint = (n: number) => numberFormat(2, 4).format(n);

/**
 * Time and sales under the book: what actually traded, newest first, coloured
 * by who crossed the spread. The totals are over the prints held — a minute or
 * two — and say so; they are not the day's.
 */
// Rows drawn. The tape holds more (the totals are over all of it), but a panel
// shows 40-odd and every row drawn is five elements kept alive.
const TAPE_DRAWN = 120;

/** One print. Memoised and keyed by the print's id: a new print adds one row
 *  at the top and drops one at the bottom — nothing in between is touched. */
const TapeRow = memo(function TapeRow({ trade, row }: { trade: Trade; row: string }) {
  return (
    <div className={`flex ${row}`} style={{ color: SIDE_COLOR[trade.side] }}>
      <span className="w-[30%]" style={{ color: "#8a8a8a" }}>
        {clock(trade.t)}
      </span>
      <span className="w-[32%] text-right font-bold">{fmtPrint(trade.price)}</span>
      <span className="flex-1 text-right">{fmtSize(trade.size)}</span>
      <span className="w-[10%] text-right">{trade.side === "N" ? "" : trade.side}</span>
    </div>
  );
});

// Memoised: the book changes three times a second, the tape only when somebody trades.
const Tape = memo(function Tape({
  trades,
  totals,
  error,
  colors,
  compact,
}: {
  trades: Trade[];
  totals: TapeTotals;
  error: string | null;
  colors: DepthPanelProps["colors"];
  compact: boolean;
}) {
  const row = `${compact ? "px-1 text-[8px] leading-[13px]" : "px-3 text-[12px] leading-5"} font-mono tabular-nums`;
  const head = `${compact ? "px-1 text-[6px] leading-3" : "px-3 text-[9px] leading-5"} font-mono font-bold tracking-wide`;
  const decided = totals.buy + totals.sell;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className={`flex items-center gap-2 shrink-0 ${head}`}
        style={{ background: "#0c0c0c", color: "#8a8a8a" }}
      >
        <span>TIME &amp; SALES</span>
        {totals.count > 0 && (
          <span
            className="ml-auto font-normal"
            title={`Buyer-initiated minus seller-initiated volume over the ${totals.count} prints held${totals.since ? `, since ${clock(totals.since)}` : ""}. Not the day's total. Nasdaq prints only.`}
          >
            <span style={{ color: BID }}>B {fmtSize(totals.buy)}</span>
            {" · "}
            <span style={{ color: ASK }}>S {fmtSize(totals.sell)}</span>
            {decided > 0 && (
              <span
                style={{
                  color: totals.delta > 0 ? BID : totals.delta < 0 ? ASK : colors.textSecondary,
                }}
              >
                {" · Δ "}
                {totals.delta > 0 ? "+" : ""}
                {fmtSize(totals.delta)}
              </span>
            )}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" style={SCROLLBAR_THIN}>
        {trades.length === 0 ? (
          <div
            className={row}
            style={{ color: error ? ASK : colors.textSecondary, whiteSpace: "normal" }}
          >
            {error ?? "No prints yet."}
          </div>
        ) : (
          trades
            .slice(0, TAPE_DRAWN)
            .map((t, i) => <TapeRow key={t.id ?? `${t.t}-${i}`} trade={t} row={row} />)
        )}
      </div>
    </div>
  );
});

const PROFILE = "#00A0C8";

/**
 * Volume by price beside the tape: how much traded at each price since the
 * panel was opened on this symbol — every print, whatever its side. The widest
 * bar is the price the market spent most volume at (POC); the brighter rows
 * hold 70% of it (value area); ◄ is where the mid is now.
 */
// Memoised: it changes when a pull lands (every 15 s) or the mid crosses a row.
const VolumeByPrice = memo(function VolumeByPrice({
  rows,
  profile,
  mid,
  error,
  colors,
  compact,
}: {
  error: string | null;
  rows: ProfileRow[];
  profile: VolumeProfile;
  mid: number | null;
  colors: DepthPanelProps["colors"];
  compact: boolean;
}) {
  const row = `${compact ? "px-1 text-[8px] leading-[13px]" : "px-3 text-[12px] leading-5"} font-mono tabular-nums`;
  const head = `${compact ? "px-1 text-[6px] leading-3" : "px-3 text-[9px] leading-5"} font-mono font-bold tracking-wide`;
  const step = rows.length > 1 ? rows[0].price - rows[1].price : 0.01;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className={`flex items-center gap-2 shrink-0 ${head}`}
        style={{ background: "#0c0c0c", color: "#8a8a8a" }}
        title={`Volume traded at each price, from ${profile.prints} prints${profile.from ? ` since ${clock(profile.from)}` : ""} — since this panel was opened on the symbol, not the whole day. Nasdaq prints only. Rows are ${fmtPrint(step)} wide.`}
      >
        <span>VOL BY PRICE</span>
        <span className="ml-auto font-normal">
          {profile.from ? `${clock(profile.from).slice(0, 5)}→ ` : ""}
          {fmtSize(profile.total)}
        </span>
        {error && rows.length > 0 && (
          <span className="font-normal" title={`Not updating: ${error}`} style={{ color: ASK }}>
            ⚠ STOPPED
          </span>
        )}
        {profile.gaps > 0 && (
          <span
            className="font-normal"
            title={`${profile.gaps} stretch(es) of trading were not seen (the panel was hidden, or more than 1000 prints came between two pulls). Volume there is missing from the bars.`}
            style={{ color: ACCENT }}
          >
            GAP ×{profile.gaps}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" style={SCROLLBAR_THIN}>
        {rows.length === 0 ? (
          <div
            className={row}
            style={{ color: error ? ASK : colors.textSecondary, whiteSpace: "normal" }}
          >
            {error ?? "Collecting…"}
          </div>
        ) : (
          rows.map((r) => {
            const here = mid != null && mid >= r.price && mid < r.price + step;
            return (
              <div key={r.price} className={`relative flex ${row}`}>
                <div
                  className="absolute inset-y-px left-0"
                  style={{
                    width: `${r.bar * 100}%`,
                    background: r.poc ? ACCENT : PROFILE,
                    opacity: r.poc ? 0.55 : r.value ? 0.4 : 0.18,
                  }}
                />
                <span
                  className="relative w-[46%] font-bold"
                  style={{ color: r.poc ? ACCENT : r.value ? "#e6e6e6" : "#8a8a8a" }}
                >
                  {fmtPrint(r.price)}
                </span>
                <span className="relative flex-1 text-right" style={{ color: "#e6e6e6" }}>
                  {r.volume ? fmtSize(r.volume) : ""}
                </span>
                <span className="relative w-[9%] text-right" style={{ color: "#e6e6e6" }}>
                  {here ? "◄" : ""}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});

/**
 * The tape and the volume by price side by side, with a divider that drags.
 * The share is the caller's (it is remembered, and common to the compact and
 * the expanded panel); the two halves are passed in already built, so a drag
 * resizes two boxes and re-renders neither list.
 */
function SplitRow({
  share,
  onShare,
  left,
  right,
  colors,
}: {
  share: number;
  onShare: (share: number) => void;
  left: ReactNode;
  right: ReactNode;
  colors: DepthPanelProps["colors"];
}) {
  const row = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const follow = (e: PointerEvent<HTMLDivElement>) => {
    const box = row.current?.getBoundingClientRect();
    if (dragging.current && box && box.width > 0) onShare((e.clientX - box.left) / box.width);
  };
  return (
    <div
      ref={row}
      className="flex flex-1 min-h-0"
      style={{ borderTop: `1px solid ${colors.border}` }}
    >
      <div className="flex min-h-0 min-w-0" style={{ flex: `${share} 1 0` }}>
        {left}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable splitter that is dragged and holds a grip — an <hr> can be neither */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Tape and volume-by-price split"
        aria-valuemin={Math.round(SPLIT.min * 100)}
        aria-valuemax={Math.round(SPLIT.max * 100)}
        aria-valuenow={Math.round(share * 100)}
        tabIndex={0}
        title="Drag to resize · double-click to reset · ← → when focused"
        className="shrink-0 cursor-col-resize flex items-center justify-center hover:opacity-80"
        style={{
          width: 7,
          background: "#111",
          borderLeft: `1px solid ${colors.border}`,
          borderRight: `1px solid ${colors.border}`,
          touchAction: "none",
        }}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.preventDefault(); // no text selection while dragging
        }}
        onPointerMove={follow}
        onPointerUp={(e) => {
          dragging.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onDoubleClick={() => onShare(SPLIT.initial)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") onShare(share - SPLIT.step);
          else if (e.key === "ArrowRight") onShare(share + SPLIT.step);
          else if (e.key === "Home") onShare(SPLIT.initial);
          else return;
          e.preventDefault();
        }}
      >
        <div className="h-10 w-px" style={{ background: colors.textSecondary, opacity: 0.4 }} />
      </div>
      <div className="flex min-h-0 min-w-0" style={{ flex: `${1 - share} 1 0` }}>
        {right}
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
  // What is about to end, said before it does: the token every 15 days, the
  // entitlement on the date written in backend/.env.
  const warnings: { text: string; title: string; urgent: boolean }[] = [];
  const left = model.tokenLeftS;
  if (left != null && left < 3 * 86_400)
    warnings.push({
      text: `TOKEN ENDS IN ${
        left < 3_600
          ? `${Math.max(0, Math.round(left / 60))}m`
          : left < 86_400
            ? `${Math.floor(left / 3_600)}h`
            : `${Math.floor(left / 86_400)}d ${Math.floor((left % 86_400) / 3_600)}h`
      }`,
      title:
        "A Webull access token lasts 15 days and cannot be renewed early. When it ends this panel will ask for a new one: Webull texts a code, to be entered in the Webull app within 5 minutes.",
      urgent: left < 86_400,
    });
  const feed = model.feed;
  if (feed?.error)
    warnings.push({
      text: "FEED END DATE ?",
      title: `${feed.error} (backend/.env)`,
      urgent: false,
    });
  else if (feed?.days_left != null && feed.days_left <= 14)
    warnings.push({
      text: feed.days_left > 0 ? `FEED ENDS IN ${feed.days_left}d` : "FEED END DATE PASSED",
      title: `The market-data entitlement ends on ${feed.ends} (WEBULL_SUBSCRIPTION_ENDS in backend/.env — the API does not say). Renew on the Webull website → avatar → Advanced Quotes → OpenAPI, then update the date.`,
      urgent: feed.days_left <= 3,
    });
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
      pending
        ? "WAITING FOR YOU IN THE WEBULL APP"
        : status.token?.status === "EXPIRED" || status.token?.status === "INVALID"
          ? "ACCESS TOKEN EXPIRED"
          : "NO ACCESS TOKEN",
      <>
        {pending ? (
          <span>
            Webull sent an SMS code. Open the Webull app → Menu → Messages → OpenAPI Notifications →
            Check Now, enter the code. You have 5 minutes; this panel picks it up by itself.
          </span>
        ) : (
          <span>
            {status.token?.status === "EXPIRED" || status.token?.status === "INVALID"
              ? "A Webull access token lasts 15 days; this one has ended."
              : "Webull wants the account owner to approve this app once."}
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
    const quoteAge = book.quote_time ? Date.now() - new Date(book.quote_time).getTime() : 0;
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
          {ladder.spread != null && (
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
          <span
            title={
              model.live
                ? "Pushed by Webull as the book changes (up to 3 times a second)"
                : model.streamError
                  ? `Live stream failed: ${model.streamError} — showing the 2-second request instead`
                  : "Asked for every 2 seconds — the live stream has nothing to send (market closed?) or is connecting"
            }
            style={{ color: model.live ? BID : model.streamError ? ACCENT : colors.textSecondary }}
          >
            {model.live ? "● LIVE" : model.streamError ? "⚠ 2s" : "○ 2s"}
          </span>
          {quoteAge > 60_000 && (
            <span
              title="The newest quote Webull has for this session. Nothing has changed since — the market is closed, or halted."
              style={{ color: ACCENT }}
            >
              AS OF {new Date(book.quote_time ?? 0).toLocaleTimeString("en-GB", { hour12: false })}
            </span>
          )}
        </div>

        {book.levels <= 1 ? (
          <TopOfBook ladder={ladder} compact={compact} />
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

            <div className="flex-1 min-h-0 overflow-y-auto" style={SCROLLBAR_THIN}>
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
        <SplitRow
          share={model.split}
          onShare={model.setSplit}
          colors={colors}
          left={
            <Tape
              trades={model.trades}
              totals={model.totals}
              error={model.tapeError}
              colors={colors}
              compact={compact}
            />
          }
          right={
            <VolumeByPrice
              rows={model.profileLevels}
              profile={model.profile}
              mid={ladder.mid}
              error={model.tapeError}
              colors={colors}
              compact={compact}
            />
          }
        />
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
        {warnings.length > 0 && (
          <span
            className={`${compact ? "text-[6px]" : "text-[9px]"} font-mono font-bold ml-auto flex gap-2`}
          >
            {warnings.map((w) => (
              <span key={w.text} title={w.title} style={{ color: w.urgent ? ASK : ACCENT }}>
                {w.text}
              </span>
            ))}
          </span>
        )}
        <button
          aria-pressed={model.overnight}
          type="button"
          className={`${button} ${warnings.length ? "ml-2" : "ml-auto"}`}
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
