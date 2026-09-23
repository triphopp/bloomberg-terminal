import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

/** No proxy retries: preserve backend status and the actual retry deadline. */
export async function marketDataProxy(path: string, signal?: AbortSignal) {
  try {
    const response = await fetch(`${PYTHON_API}${path}`, {
      cache: "no-store",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) headers.set("Retry-After", retryAfter);
    return new Response(await response.text(), { status: response.status, headers });
  } catch {
    return NextResponse.json(
      { error: "Market data temporarily unavailable" },
      {
        status: 503,
        headers: { "Retry-After": "5", "Cache-Control": "no-store" },
      }
    );
  }
}
