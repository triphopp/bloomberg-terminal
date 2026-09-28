import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { type EventSourceLike, createQuoteStreamClient } from "../quote-stream-client.ts";

const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));

class FakeES implements EventSourceLike {
  static all: FakeES[] = [];
  readyState = 0;
  handlers = new Map<string, ((e: { data: string }) => void)[]>();
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeES.all.push(this);
  }
  close() {
    this.readyState = 2;
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }
  fire(type: string, data: unknown = {}) {
    for (const fn of this.handlers.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
  attach(resumed = false) {
    this.readyState = 1;
    this.fire("ready", { session: "s", resumed });
  }
  symbols() {
    return new URL(this.url, "http://x").searchParams.get("symbols")?.split(",") ?? [];
  }
}

const clients: { dispose(): void }[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});

function setup(statusFor: (body: { symbols: string[] }) => number = () => 200) {
  FakeES.all = [];
  const posts: string[][] = [];
  let t = 1_000;
  const client = createQuoteStreamClient({
    EventSource: FakeES,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body) as { symbols: string[] };
      posts.push(body.symbols);
      await pause(1);
      return { status: statusFor(body) };
    },
    sessionId: "page-test-1",
    debounceMs: 0,
    retryMs: 5,
    freshnessMs: 60_000,
    now: () => t,
  });
  clients.push(client);
  const advance = (ms: number) => {
    t += ms;
  };
  return { client, posts, advance };
}

test("one EventSource for the union; a later change is a diff POST, not a reopen", async () => {
  const { client, posts } = setup();
  const offA = client.listen(["AAPL"], () => {});
  client.listen(["MSFT"], () => {});
  await pause();
  assert.equal(FakeES.all.length, 1);
  assert.deepEqual(FakeES.all[0].symbols(), ["AAPL", "MSFT"]);
  assert.match(FakeES.all[0].url, /session=page-test-1/);
  FakeES.all[0].attach(false);
  await pause();
  assert.deepEqual(posts, [], "fresh session from this URL already holds the union");

  client.listen(["NVDA"], () => {});
  offA();
  await pause(80);
  assert.equal(FakeES.all.length, 1, "no reopen");
  assert.deepEqual(posts, [["MSFT", "NVDA"]]);
  assert.equal(client.state().openKey, "MSFT,NVDA");
});

test("no POST before the backend says ready; ready sends the latest union", async () => {
  const { client, posts } = setup();
  client.listen(["A"], () => {});
  await pause();
  client.listen(["B"], () => {}); // arrives while still connecting
  await pause();
  assert.deepEqual(posts, []);
  FakeES.all[0].attach(false);
  await pause(80);
  assert.deepEqual(posts, [["A", "B"]]);
});

test("resumed session (tab came back) always gets the union resent", async () => {
  const { client, posts } = setup();
  client.listen(["A"], () => {});
  await pause();
  FakeES.all[0].attach(true);
  await pause(80);
  assert.deepEqual(posts, [["A"]]);
});

test("404 (session expired) reopens the stream with the current union", async () => {
  const { client } = setup(() => 404);
  client.listen(["A"], () => {});
  await pause();
  FakeES.all[0].attach(false);
  client.listen(["B"], () => {});
  await pause(80);
  assert.equal(FakeES.all.length, 2);
  assert.equal(FakeES.all[0].readyState, 2, "old stream closed");
  assert.deepEqual(FakeES.all[1].symbols(), ["A", "B"]);
});

test("a POST that outlives its stream does not close the new one", async () => {
  let first = true;
  const { client } = setup(() => {
    const s = first ? 404 : 200;
    first = false;
    return s;
  });
  const off = client.listen(["A"], () => {});
  await pause();
  FakeES.all[0].attach(false);
  client.listen(["B"], () => {}); // POST in flight (will 404)…
  await pause(0);
  off(); // …meanwhile the union changes and the stream is replaced
  await pause(120);
  const live = FakeES.all.filter((e) => e.readyState !== 2);
  assert.equal(live.length, 1, "exactly one open stream");
});

test("failed POST (5xx) retries without reopening", async () => {
  let n = 0;
  const { client, posts } = setup(() => (++n === 1 ? 503 : 200));
  client.listen(["A"], () => {});
  await pause();
  FakeES.all[0].attach(false);
  client.listen(["B"], () => {});
  await pause(150);
  assert.equal(FakeES.all.length, 1);
  assert.deepEqual(posts, [
    ["A", "B"],
    ["A", "B"],
  ]);
  assert.equal(client.state().openKey, "A,B");
});

test("empty union closes the stream", async () => {
  const { client } = setup();
  const off = client.listen(["A"], () => {});
  await pause();
  off();
  await pause();
  assert.equal(FakeES.all[0].readyState, 2);
  assert.equal(client.state().open, false);
});

test("ticks are split per listener; cadence follows coverage and tick age", async () => {
  const { client, advance } = setup();
  const got: Record<string, unknown>[] = [];
  client.listen(["A"], (t) => got.push(t));
  client.listen(["B"], () => {});
  await pause();
  const es = FakeES.all[0];
  es.attach(false);
  assert.equal(client.cadence("A"), null, "no coverage yet");
  es.fire("coverage", { live: 2, denied: [], connected: true });
  es.fire("message", { A: { price: 1 }, B: { price: 2 } });
  assert.deepEqual(got, [{ A: { price: 1 } }]);
  assert.equal(client.cadence("A"), "streamed");
  assert.equal(client.cadence(""), "quiet");
  advance(200_000);
  es.fire("coverage", { live: 2, denied: [], connected: true, _: 1 }); // any emit re-reads the clock
  assert.equal(client.cadence("A"), null, "tick too old");
  es.fire("error");
  assert.equal(client.cadence("A"), null);
});
