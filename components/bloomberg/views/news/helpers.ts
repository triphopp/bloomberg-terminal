export function timeAgo(iso: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff) || diff < 0) return "";
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function fmtVol(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

// Built once — `toLocale*String(locale, opts)` constructs a formatter per call,
// and fmtEndDate runs per Polymarket row.
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const HOUR_MINUTE = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" });

/**
 * `format()` throws on an invalid Date where `toLocale*String` returned the
 * text "Invalid Date" — keep the old output for bad input.
 */
function formatIso(f: Intl.DateTimeFormat, iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Invalid Date" : f.format(d);
}

export function fmtEndDate(iso: string): string {
  return formatIso(MONTH_DAY, iso);
}

export function polyUrl(slug: string, eventSlug: string): string {
  return `https://polymarket.com/event/${eventSlug || slug}`;
}

export function clockStr(iso: string): string {
  return formatIso(HOUR_MINUTE, iso);
}

/**
 * MACRO tab: is this story already WATCHLIST's? Yes when it was found by
 * searching a watchlist ticker, or when every ticker Yahoo ties it to is on the
 * watchlist. A story with no tickers (RSS, most macro pieces) always stays, and
 * so does one that also names a stock you do not watch.
 */
export function coveredByWatchlist(
  article: { topic: string; tickers?: string[] },
  watchlist: ReadonlySet<string>
): boolean {
  if (watchlist.size === 0) return false;
  if (watchlist.has(article.topic.trim().toUpperCase())) return true;
  const tickers = article.tickers ?? [];
  return tickers.length > 0 && tickers.every((t) => watchlist.has(t.toUpperCase()));
}

/** Topics saved before the MACRO rename still carry "market" — a Yahoo search
 *  that matches the word in any sense (airport management market, money-market
 *  rates). The general market feed is the RSS front pages, which always load. */
export function dropLegacyMarketTopic(saved: string[]): string[] {
  return saved.filter((t) => t.trim().toLowerCase() !== "market");
}
