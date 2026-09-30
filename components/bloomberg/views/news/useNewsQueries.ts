"use client";

import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type { Article, PolySearchResult, PolySignal, SocialHandle, SocialPost } from "./types";

// Server data for the NEWS tabs. These used to be `fetch` + `useState` inside
// each tab, so every tab switch (the tabs unmount) and every return to NEWS
// re-pulled the feed. In React Query they survive both for `staleTime`.

const FIVE_MIN = 5 * 60_000;

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * `refetch()` that also tells the backend to skip its own 5-min cache.
 * A plain refetch inside that window got the same cached answer back, so the
 * REFRESH button did nothing. The flag is read (and cleared) by the queryFn.
 */
export function useFreshFlag() {
  const ref = useRef(false);
  const take = useCallback(() => {
    const fresh = ref.current;
    ref.current = false;
    return fresh;
  }, []);
  const arm = useCallback(() => {
    ref.current = true;
  }, []);
  /** Read without clearing — for a refresh that spans several queries. */
  const peek = useCallback(() => ref.current, []);
  return { take, arm, peek };
}

export function useNewsFeed(topics: string[]) {
  const key = topics.join(",");
  const fresh = useFreshFlag();
  const query = useQuery<{ articles: Article[] }>({
    queryKey: ["news-feed", key],
    enabled: topics.length > 0,
    staleTime: FIVE_MIN,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      getJson(
        `/api/news/feed?topics=${encodeURIComponent(key)}&limit=80${fresh.take() ? "&fresh=1" : ""}`,
        signal
      ),
  });
  const refresh = useCallback(() => {
    fresh.arm();
    return query.refetch();
  }, [fresh, query.refetch]);
  return { ...query, refresh };
}

/** Posts kept per handle, and in the merged feed. The backend used to split
 *  80 across all handles, which tied every handle's request to the count. */
const SOCIAL_PER_HANDLE = 20;
const SOCIAL_LIMIT = 80;

/**
 * One query per handle: adding a handle fetches just that one, removing one
 * fetches nothing, and a slow Nitter instance no longer holds up the rest.
 */
export function useSocialFeed(handles: SocialHandle[]) {
  const fresh = useFreshFlag();
  const results = useQueries({
    queries: handles.map(({ platform, handle }) => ({
      queryKey: ["news-social", platform, handle],
      staleTime: FIVE_MIN,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getJson<{ posts: SocialPost[]; errors?: string[] }>(
          `/api/news/social?handles=${encodeURIComponent(JSON.stringify({ [platform]: [handle] }))}` +
            `&limit=${SOCIAL_PER_HANDLE}${fresh.peek() ? "&fresh=1" : ""}`,
          signal
        ),
    })),
  });

  const posts = results
    .flatMap((r) => r.data?.posts ?? [])
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))
    .slice(0, SOCIAL_LIMIT);
  const errors = results.flatMap((r, i) =>
    r.error
      ? [`${handles[i].platform}/${handles[i].handle}: ${String(r.error)}`]
      : (r.data?.errors ?? [])
  );
  const isFetching = results.some((r) => r.isFetching);

  const refresh = async () => {
    fresh.arm();
    try {
      await Promise.all(results.map((r) => r.refetch()));
    } finally {
      fresh.take();
    }
  };
  return { posts, errors, isFetching, refresh };
}

export function usePolymarketSignals() {
  return useQuery<{ signals: PolySignal[]; as_of?: string }>({
    queryKey: ["polymarket-signals"],
    staleTime: FIVE_MIN, // backend caches signals for 5 min too
    queryFn: ({ signal }) => getJson("/api/polymarket", signal),
  });
}

/** Debounce is the caller's job — pass the settled query text. */
export function usePolymarketSearch(q: string) {
  return useQuery<{ results: PolySearchResult[] }>({
    queryKey: ["polymarket-search", q],
    enabled: q.length >= 2,
    staleTime: FIVE_MIN,
    queryFn: ({ signal }) => getJson(`/api/polymarket?q=${encodeURIComponent(q)}`, signal),
  });
}
