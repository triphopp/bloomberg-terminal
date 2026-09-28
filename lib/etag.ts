import { createHash } from "node:crypto";

/**
 * Conditional GET for polled JSON proxies.
 *
 * A 60s poll mostly gets back the same payload (closed market, weekend, a
 * backend cache that has not rolled). With an ETag and `Cache-Control:
 * no-cache` the browser keeps the last body and revalidates each poll with
 * `If-None-Match`; an unchanged payload is answered `304` with no body, and
 * `fetch()` still resolves to a normal 200 from the browser cache — callers
 * change nothing. Client fetches must not pass `cache: "no-store"` (that skips
 * the cache and so the revalidation); `"no-cache"` or the default both work.
 *
 * Only 200s are tagged: an error must never be served from cache.
 */
export function etagOf(body: string): string {
  return `W/"${createHash("sha1").update(body).digest("base64url")}"`;
}

function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v === etag || `W/${v}` === etag;
  });
}

/** Serialized JSON `body` as a 200 with an ETag, or a 304 if the client has it. */
export function etagResponse(
  request: Request | undefined,
  body: string,
  extraHeaders?: HeadersInit
): Response {
  const etag = etagOf(body);
  const headers = new Headers(extraHeaders);
  headers.set("ETag", etag);
  headers.set("Cache-Control", "private, no-cache");
  if (request && matches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("Content-Type", "application/json");
  return new Response(body, { status: 200, headers });
}

/** `NextResponse.json(data)` with a conditional-GET ETag. */
export function etagJson(request: Request | undefined, data: unknown): Response {
  return etagResponse(request, JSON.stringify(data));
}
