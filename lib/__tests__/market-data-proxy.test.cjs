const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const ts = require("typescript");
const { NextResponse } = require("next/server");
const root = path.resolve(__dirname, "../..");

function load(relative, fetch) {
  const js = ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const requireMock = (name) => {
    if (name === "next/server") return { NextResponse };
    if (name === "@/lib/constants") return { PYTHON_API: "http://mock-python.invalid" };
    if (name === "@/lib/market-data-proxy") return load("lib/market-data-proxy.ts", fetch);
    throw new Error(`Unexpected dependency: ${name}`);
  };
  new Function("require", "exports", "fetch", js)(requireMock, exports, fetch);
  return exports;
}

for (const [file, route] of [
  ["app/api/stock/route.ts", "/api/stock?type=quote&symbol=TEST"],
  ["app/api/watchlist/quotes/route.ts", "/api/watchlist/quotes?symbols=TEST"],
  ["app/api/watchlist/signals/route.ts", "/api/watchlist/signals?symbols=TEST"],
  ["app/api/watchlist/sparklines/route.ts", "/api/watchlist/sparklines?symbols=TEST"],
  ["app/api/polymarket/stocks/route.ts", "/api/polymarket/stocks?symbols=TEST"],
]) {
  test(`${file} preserves throttling status, body and Retry-After without retrying`, async () => {
    let calls = 0;
    const { GET } = load(file, async () => {
      calls++;
      return Response.json(
        { detail: "limited" },
        { status: 429, headers: { "Retry-After": "60" } }
      );
    });
    const res = await GET(new Request(`http://mock-next.invalid${route}`));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "60");
    assert.deepEqual(await res.json(), { detail: "limited" });
    assert.equal(calls, 1);
  });
}

test("network failure produces retryable 503, not a successful empty result", async () => {
  const { marketDataProxy } = load("lib/market-data-proxy.ts", async () => {
    throw new TypeError("offline");
  });
  const res = await marketDataProxy("/api/watchlist/quotes?symbols=TEST");
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Retry-After"), "5");
});
