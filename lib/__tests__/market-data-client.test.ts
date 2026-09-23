import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import {
  MarketDataError,
  RequestQueue,
  SymbolBatcher,
  quoteQueryOptions,
  retryAfterSeconds,
} from "../market-data-client.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function requestedSymbols(input: unknown): string[] {
  const value = new URL(String(input), "http://localhost").searchParams.get("symbols");
  assert.ok(value);
  return value.split(",");
}

test("1000 symbols in overlapping lists all load, within batch and concurrency limits", async () => {
  let calls = 0;
  let active = 0;
  let peak = 0;
  const seen = new Map<string, number>();
  globalThis.fetch = async (input) => {
    const symbols = requestedSymbols(input);
    assert.ok(symbols.length <= 20);
    calls++;
    active++;
    peak = Math.max(peak, active);
    for (const s of symbols) seen.set(s, (seen.get(s) ?? 0) + 1);
    await pause(1);
    active--;
    return Response.json({ quotes: Object.fromEntries(symbols.map((s) => [s, { symbol: s }])) });
  };
  const batcher = new SymbolBatcher<{ symbol: string }>(
    "/test",
    "quotes",
    20,
    undefined,
    new RequestQueue(3)
  );
  const requests = Array.from({ length: 1000 }, (_, i) => batcher.request(`S${i}`));
  const overlap = batcher.request("S999");
  const result = await Promise.all(requests);
  assert.equal(result.length, 1000);
  assert.equal((await overlap).symbol, "S999");
  assert.equal(calls, 50);
  assert.ok(peak <= 3);
  assert.ok([...seen.values()].every((n) => n === 1));
});

test("chart, watchlist, remount and membership change share per-symbol query cache", async () => {
  const fetched: string[] = [];
  globalThis.fetch = async (input) => {
    const syms = requestedSymbols(input);
    fetched.push(...syms);
    return Response.json({
      quotes: Object.fromEntries(syms.map((s) => [s, { regularMarketPrice: 12 }])),
    });
  };
  const qc = new QueryClient();
  try {
    await Promise.all([
      qc.fetchQuery(quoteQueryOptions("A")),
      qc.fetchQuery(quoteQueryOptions("a")),
      qc.fetchQuery(quoteQueryOptions("B")),
    ]);
    await Promise.all(["B", "A", "C"].map((s) => qc.fetchQuery(quoteQueryOptions(s))));
    assert.deepEqual(fetched.sort(), ["A", "B", "C"]);
  } finally {
    qc.clear();
  }
});

test("cancel one reader without cancelling the other reader's shared request", async () => {
  let upstreamAborted = false;
  globalThis.fetch = async (_input, opts) => {
    opts?.signal?.addEventListener("abort", () => {
      upstreamAborted = true;
    });
    await pause(10);
    return Response.json({ quotes: { A: 42 } });
  };
  const batcher = new SymbolBatcher<number>("/test", "quotes");
  const a = new AbortController();
  const first = batcher.request("A", a.signal);
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = batcher.request("A");
  await pause(3);
  a.abort();
  await rejected;
  assert.equal(await second, 42);
  assert.equal(upstreamAborted, false);
});

test("cancelled queued work never starts; replacement generation still resolves", async () => {
  const symbols: string[] = [];
  globalThis.fetch = async (input) => {
    const [symbol] = requestedSymbols(input);
    assert.ok(symbol);
    symbols.push(symbol);
    await pause(10);
    return Response.json({ quotes: { [symbol]: 1 } });
  };
  const batcher = new SymbolBatcher<number>("/test", "quotes", 1, undefined, new RequestQueue(1));
  const first = batcher.request("A");
  const abort = new AbortController();
  const old = batcher.request("B", abort.signal);
  const rejected = assert.rejects(old, { name: "AbortError" });
  await pause(2);
  abort.abort();
  const replacement = batcher.request("B");
  await Promise.all([first, rejected, replacement]);
  assert.deepEqual(symbols, ["A", "B"]);
});

test("partial error preserves siblings and retry guidance; no market is null", async () => {
  globalThis.fetch = async () =>
    Response.json({
      quotes: { GOOD: 12 },
      statuses: {
        GOOD: { status: "ready" },
        BAD: { status: "error", httpStatus: 429, error: "limited", retryAfter: 60 },
      },
    });
  const batcher = new SymbolBatcher<number>("/test", "quotes");
  const [good, bad] = await Promise.allSettled([batcher.request("GOOD"), batcher.request("BAD")]);
  assert.equal(good.status, "fulfilled");
  assert.equal(bad.status, "rejected");
  if (bad.status === "rejected") {
    assert.ok(bad.reason instanceof MarketDataError);
    assert.equal(bad.reason.retryAfter, 60);
  }
  globalThis.fetch = async () =>
    Response.json({ summaries: {}, statuses: { EMPTY: { status: "ready" } } });
  assert.equal(await new SymbolBatcher("/test", "summaries", 10, null).request("EMPTY"), null);
});

test("Retry-After accepts seconds and HTTP dates", () => {
  assert.equal(retryAfterSeconds("60"), 60);
  assert.equal(
    retryAfterSeconds("Wed, 23 Sep 2026 01:01:00 GMT", Date.parse("2026-09-23T01:00:00Z")),
    60
  );
});

test("quotes jump queued optional work without starving that work", async () => {
  const queue = new RequestQueue(1);
  const order: string[] = [];
  const controller = new AbortController();
  const jobs = [
    queue.run(
      async () => {
        order.push("optional");
      },
      controller.signal,
      1
    ),
  ];
  for (let i = 0; i < 6; i++)
    jobs.push(
      queue.run(
        async () => {
          order.push(`quote${i}`);
        },
        controller.signal,
        0
      )
    );
  await Promise.all(jobs);
  assert.deepEqual(order.slice(0, 4), ["quote0", "quote1", "quote2", "optional"]);
});
