/**
 * WATCHLIST snapshot — the last quotes and signals this browser saw, kept in
 * localStorage so a fresh page paints rows at once instead of "PRICES 0/34 ·
 * updating" while the backend (cold after a restart: 4 s) answers.
 *
 * Each item keeps the time it was fetched; the hook seeds the query cache with
 * that time, so React Query treats it as stale and refetches immediately, and
 * the strip can say how many rows still show a cached value. Pure functions
 * over a Storage-like object — tested in __tests__/watchlist-snapshot.test.ts.
 */

export type SnapshotKind = "quotes" | "signals";

export interface SnapshotItem<T> {
  /** ms epoch when this value was fetched (the query's dataUpdatedAt) */
  at: number;
  data: T;
}

export type Snapshot<T> = Record<string, SnapshotItem<T>>;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SNAPSHOT_KEY_PREFIX = "bloomberg_watchlist_snapshot_v1_";
/** Older than this, a value is not shown at all — an empty row is more honest. */
export const SNAPSHOT_MAX_AGE_MS: Record<SnapshotKind, number> = {
  quotes: 4 * 24 * 3600_000, // covers a long weekend
  signals: 4 * 24 * 3600_000,
};
/** Bounds the stored size; a watchlist is tens of rows, not thousands. */
export const SNAPSHOT_MAX_ITEMS = 400;

export function readSnapshot<T>(
  storage: StorageLike | undefined,
  kind: SnapshotKind,
  now: number
): Snapshot<T> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SNAPSHOT_KEY_PREFIX + kind);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Snapshot<T> = {};
    for (const [sym, item] of Object.entries(parsed as Record<string, unknown>)) {
      const it = item as SnapshotItem<T> | null;
      if (!it || typeof it.at !== "number" || it.data == null) continue;
      if (it.at > now || now - it.at > SNAPSHOT_MAX_AGE_MS[kind]) continue;
      out[sym] = it;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Merge fresh items over what is stored (another symbol set — a second
 * watchlist group, another tab — keeps its rows) and keep the newest
 * SNAPSHOT_MAX_ITEMS. An item never replaces a newer one.
 */
export function writeSnapshot<T>(
  storage: StorageLike | undefined,
  kind: SnapshotKind,
  fresh: Snapshot<T>,
  now: number
): void {
  if (!storage || Object.keys(fresh).length === 0) return;
  const merged: Snapshot<T> = readSnapshot<T>(storage, kind, now);
  for (const [sym, it] of Object.entries(fresh)) {
    const old = merged[sym];
    if (!old || old.at <= it.at) merged[sym] = it;
  }
  const kept = Object.entries(merged)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, SNAPSHOT_MAX_ITEMS);
  try {
    storage.setItem(SNAPSHOT_KEY_PREFIX + kind, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* quota / private mode — the next page load simply starts empty */
  }
}

/** Calendar date (YYYY-MM-DD) of `now` in an IANA zone; null when the zone is unknown. */
export function dateInZone(now: number, timeZone: string | null | undefined): string | null {
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return null;
  }
}

interface SessionFields {
  quoteDate?: string | null;
  exchangeTimezone?: string | null;
  isCurrentSession?: boolean | null;
}

/**
 * A stored quote said `isCurrentSession: true` about the day it was fetched.
 * Shown on a later day that would print yesterday's move as today's, so the
 * verdict is re-derived from its own quoteDate and the exchange's date now.
 */
export function reviveQuote<T extends SessionFields>(q: T, now: number): T {
  if (!q.isCurrentSession) return q;
  const today = dateInZone(now, q.exchangeTimezone);
  if (!q.quoteDate || !today || q.quoteDate !== today) return { ...q, isCurrentSession: false };
  return q;
}
