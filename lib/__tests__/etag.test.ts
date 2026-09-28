import assert from "node:assert/strict";
import test from "node:test";
import { etagJson, etagOf, etagResponse } from "../etag.ts";

test("same body → same weak etag; different body → different", () => {
  assert.equal(etagOf('{"a":1}'), etagOf('{"a":1}'));
  assert.notEqual(etagOf('{"a":1}'), etagOf('{"a":2}'));
  assert.match(etagOf("x"), /^W\/"[A-Za-z0-9_-]+"$/);
});

test("first request: 200 with body, ETag and revalidate-always caching", async () => {
  const res = etagJson(new Request("http://x/api"), { a: 1 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { a: 1 });
  assert.equal(res.headers.get("Cache-Control"), "private, no-cache");
  assert.ok(res.headers.get("ETag"));
});

test("matching If-None-Match (weak, strong or in a list) → 304, no body", async () => {
  const tag = etagOf(JSON.stringify({ a: 1 }));
  for (const inm of [tag, tag.slice(2), `"zzz", ${tag}`]) {
    const res = etagJson(new Request("http://x/api", { headers: { "If-None-Match": inm } }), {
      a: 1,
    });
    assert.equal(res.status, 304, inm);
    assert.equal(await res.text(), "");
  }
});

test("changed payload → 200 again", () => {
  const old = etagOf(JSON.stringify({ a: 1 }));
  const res = etagJson(new Request("http://x/api", { headers: { "If-None-Match": old } }), {
    a: 2,
  });
  assert.equal(res.status, 200);
});

test("no request → always 200", () => {
  assert.equal(etagResponse(undefined, "{}").status, 200);
});
