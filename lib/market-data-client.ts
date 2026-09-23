/** Shared browser transport. Query cache owns freshness; this layer owns I/O. */
export class MarketDataError extends Error {
  status: number;
  retryAfter: number;
  constructor(message: string, status = 502, retryAfter = 5) {
    super(message);
    this.name = "MarketDataError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function retryAfterSeconds(value: string | null, now = Date.now()) {
  if (!value) return 5;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, (date - now) / 1000) : 5;
}

export async function marketJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new MarketDataError(
      typeof data.detail === "string" ? data.detail : data.error || `HTTP ${res.status}`,
      res.status,
      retryAfterSeconds(res.headers.get("Retry-After"))
    );
  return data;
}

export const marketRetry = (count: number, error: Error) =>
  count < 3 && (!(error instanceof MarketDataError) || error.status === 429 || error.status >= 500);
export const marketRetryDelay = (_count: number, error: Error) =>
  (error instanceof MarketDataError ? error.retryAfter : 5) * 1000 + Math.random() * 500;

const aborted = () => new DOMException("Request cancelled", "AbortError");

/** All batch kinds share this budget, including queued, cancellable optional work. */
export class RequestQueue {
  private active = 0;
  private jobs: Array<{ start: () => void; priority: number }> = [];
  private limit: number;
  private scheduled = false;
  private urgentStreak = 0;
  constructor(limit = 3) {
    this.limit = limit;
  }
  run<T>(job: () => Promise<T>, signal: AbortSignal, priority = 1): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const index = this.jobs.indexOf(queued);
        if (index >= 0) this.jobs.splice(index, 1);
        reject(aborted());
      };
      const start = () => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) {
          reject(aborted());
          return;
        }
        this.active++;
        job()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.schedule();
          });
      };
      const queued = { start, priority };
      if (signal.aborted) {
        reject(aborted());
        return;
      }
      signal.addEventListener("abort", cancel, { once: true });
      this.jobs.push(queued);
      this.schedule();
    });
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    // Let all resource batchers enqueue this render before choosing priorities.
    setTimeout(() => {
      this.scheduled = false;
      this.drain();
    }, 0);
  }
  private drain() {
    while (this.active < this.limit && this.jobs.length) {
      let index = this.urgentStreak >= 3 ? this.jobs.findIndex((job) => job.priority > 0) : -1;
      if (index < 0) {
        index = 0;
        for (let i = 1; i < this.jobs.length; i++) {
          if (this.jobs[i].priority < this.jobs[index].priority) index = i;
        }
      }
      const next = this.jobs.splice(index, 1)[0];
      this.urgentStreak = next.priority === 0 ? this.urgentStreak + 1 : 0;
      next.start();
    }
  }
}

interface ItemStatus {
  status: "ready" | "pending" | "error";
  error?: string;
  httpStatus?: number;
  retryAfter?: number;
}
interface BatchPayload {
  statuses?: Record<string, ItemStatus>;
  [field: string]: unknown;
}
interface Reader<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
interface Entry<T> {
  symbol: string;
  readers: Set<Reader<T>>;
  started: boolean;
  cancelBatch?: () => void;
}

const queue = new RequestQueue(3);

export class SymbolBatcher<T> {
  private entries = new Map<string, Entry<T>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private endpoint: string;
  private field: string;
  private size: number;
  private missing: T | undefined;
  private requestQueue: RequestQueue;
  constructor(endpoint: string, field: string, size = 20, missing?: T, requestQueue = queue) {
    this.endpoint = endpoint;
    this.field = field;
    this.size = size;
    this.missing = missing;
    this.requestQueue = requestQueue;
  }
  request(rawSymbol: string, signal?: AbortSignal): Promise<T> {
    const symbol = rawSymbol.trim().toUpperCase();
    if (signal?.aborted) return Promise.reject(aborted());
    let entry = this.entries.get(symbol);
    if (!entry) {
      entry = { symbol, readers: new Set(), started: false };
      this.entries.set(symbol, entry);
    }
    const current = entry;
    const result = new Promise<T>((resolve, reject) => {
      const cancel = () => {
        current.readers.delete(reader);
        reader.cleanup();
        reject(aborted());
        if (!current.readers.size) {
          // Only detach this generation. A later observer can enqueue fresh work.
          if (this.entries.get(symbol) === current) this.entries.delete(symbol);
          current.cancelBatch?.();
        }
      };
      const reader: Reader<T> = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", cancel),
      };
      current.readers.add(reader);
      signal?.addEventListener("abort", cancel, { once: true });
    });
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, 0);
    return result;
  }
  private flush() {
    const waiting = [...this.entries.values()].filter((e) => !e.started && e.readers.size);
    for (let i = 0; i < waiting.length; i += this.size) {
      const batch = waiting.slice(i, i + this.size);
      const controller = new AbortController();
      const cancelBatch = () => {
        if (batch.every((e) => !e.readers.size)) controller.abort();
      };
      for (const entry of batch) {
        entry.started = true;
        entry.cancelBatch = cancelBatch;
      }
      const url = `${this.endpoint}?symbols=${encodeURIComponent(batch.map((e) => e.symbol).join(","))}`;
      void this.requestQueue
        .run(
          () => marketJson<BatchPayload>(url, controller.signal),
          controller.signal,
          this.field === "quotes" ? 0 : 1
        )
        .then(
          (payload) => {
            const values = (payload[this.field] ?? {}) as Record<string, T>;
            for (const entry of batch) {
              const status = payload.statuses?.[entry.symbol];
              if (status && status.status !== "ready") {
                this.finish(
                  entry,
                  undefined,
                  new MarketDataError(
                    status.error || "Still loading",
                    status.httpStatus ?? 503,
                    status.retryAfter ?? 2
                  )
                );
              } else {
                const value = Object.hasOwn(values, entry.symbol)
                  ? values[entry.symbol]
                  : this.missing;
                this.finish(
                  entry,
                  value,
                  value === undefined
                    ? new MarketDataError("Missing symbol in response")
                    : undefined
                );
              }
            }
          },
          (error: Error) => {
            for (const entry of batch) this.finish(entry, undefined, error);
          }
        );
    }
  }
  private finish(entry: Entry<T>, value?: T, error?: Error) {
    if (this.entries.get(entry.symbol) === entry) this.entries.delete(entry.symbol);
    for (const reader of entry.readers) {
      reader.cleanup();
      if (error) reader.reject(error);
      else reader.resolve(value as T);
    }
    entry.readers.clear();
  }
}

// Field-compatible with the existing stock quote response; full payload is retained.
export interface StockQuote {
  regularMarketPrice: number;
  regularMarketChangePercent: number;
  regularMarketChange: number;
  shortName?: string;
  longName?: string;
  regularMarketVolume?: number;
  averageDailyVolume3Month?: number;
  regularMarketOpen?: number;
  regularMarketPreviousClose?: number;
  marketState?: string | null;
  preMarketPrice?: number | null;
  preMarketChange?: number | null;
  preMarketChangePercent?: number | null;
  postMarketPrice?: number | null;
  postMarketChange?: number | null;
  postMarketChangePercent?: number | null;
  quoteDate?: string | null;
  isCurrentSession?: boolean | null;
  fetchedAt?: string;
  source?: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy stock panels consume additional fields from the full provider payload
  [key: string]: any;
}
export const quoteBatcher = new SymbolBatcher<StockQuote>("/api/watchlist/quotes", "quotes");
export const sparklineBatcher = new SymbolBatcher<number[]>(
  "/api/watchlist/sparklines",
  "sparklines"
);
export const quoteQueryOptions = (symbol: string) => ({
  queryKey: ["stock", "quote", symbol.trim().toUpperCase()],
  queryFn: ({ signal }: { signal: AbortSignal }) => quoteBatcher.request(symbol, signal),
  staleTime: 55_000,
  gcTime: 30 * 60_000,
  retry: marketRetry,
  retryDelay: marketRetryDelay,
});
