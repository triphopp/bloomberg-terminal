import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedHosts, backendError, crossSiteReason } from "../ask-proxy.ts";
import { crossOriginReason } from "../request-origin.ts";

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});
const json = { "content-type": "application/json" };

test("the app's own page may post", () => {
  for (const host of [
    "bloomberg.localhost:9318",
    "localhost:9318",
    "127.0.0.1:9318",
    "[::1]:9318",
  ]) {
    const h = { ...json, host, origin: `http://${host}`, "sec-fetch-site": "same-origin" };
    assert.equal(crossSiteReason(headers(h)), null, host);
  }
  // A phone on the LAN, by address or by the machine's name.
  for (const host of ["192.168.100.4:9318", "desktop-abc:9318", "trader.local:9318"]) {
    assert.equal(crossSiteReason(headers({ ...json, host, origin: `http://${host}` })), null, host);
  }
});

test("a script without browser headers may post", () => {
  assert.equal(crossSiteReason(headers({ ...json, host: "localhost:9318" })), null);
});

test("a body that is not JSON is refused — that is what another site can send unasked", () => {
  for (const type of [
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
    "",
  ]) {
    const refusal = crossSiteReason(headers({ "content-type": type, host: "localhost:9318" }));
    assert.equal(refusal?.status, 415, type);
  }
});

test("another site is refused even with JSON", () => {
  const cases = [
    { ...json, host: "localhost:9318", origin: "https://evil.example" },
    { ...json, host: "localhost:9318", origin: "http://localhost:3000" },
    { ...json, host: "localhost:9318", "sec-fetch-site": "cross-site" },
    { ...json, host: "localhost:9318", "sec-fetch-site": "same-site" },
    { ...json, host: "localhost:9318", origin: "null" },
  ];
  for (const h of cases) assert.equal(crossSiteReason(headers(h))?.status, 403, JSON.stringify(h));
});

test("a public name pointed at this machine is refused", () => {
  const h = {
    ...json,
    host: "rebind.evil.example:9318",
    origin: "http://rebind.evil.example:9318",
  };
  assert.equal(crossSiteReason(headers(h))?.status, 403);
});

test("a name listed in DEV_ORIGINS is served", () => {
  const host = "desk.tailnet.ts.net:9318";
  const h = headers({ ...json, host, origin: `https://${host}` });
  assert.match(crossSiteReason(h)?.error ?? "", /DEV_ORIGINS/);
  assert.equal(crossSiteReason(h, allowedHosts(" Desk.tailnet.ts.net , other.example ")), null);
  assert.deepEqual(allowedHosts(undefined), []);
});

test("every other write: same origin whatever the body, another site never", () => {
  // proxy.ts — an upload or a beacon from the app's own page is not JSON.
  for (const type of ["multipart/form-data; boundary=x", "text/plain;charset=UTF-8", ""]) {
    const own = {
      "content-type": type,
      host: "bloomberg.localhost:9318",
      origin: "http://bloomberg.localhost:9318",
      "sec-fetch-site": "same-origin",
    };
    assert.equal(crossOriginReason(headers(own)), null, type);
  }
  // What a page on another site can send without asking: a plain form.
  const form = {
    "content-type": "text/plain",
    host: "localhost:9318",
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site",
  };
  assert.equal(crossOriginReason(headers(form))?.status, 403);
  // Another port on this machine is another origin too.
  const sibling = {
    host: "localhost:9318",
    origin: "http://localhost:3000",
    "sec-fetch-site": "same-site",
  };
  assert.equal(crossOriginReason(headers(sibling))?.status, 403);
  // A script: no browser headers.
  assert.equal(crossOriginReason(headers({ host: "127.0.0.1:9318" })), null);
});

test("backend errors keep their reason", () => {
  assert.equal(
    backendError('{"detail":"keys can only be saved from this machine"}', 403),
    "keys can only be saved from this machine"
  );
  const validation = JSON.stringify({
    detail: [{ loc: ["body", "images", 0], msg: "String should match pattern" }],
  });
  assert.equal(backendError(validation, 422), "images.0: String should match pattern");
  assert.equal(backendError("<html>bad gateway</html>", 502), "Backend 502");
  assert.equal(backendError("{}", 500), "Backend 500");
});
