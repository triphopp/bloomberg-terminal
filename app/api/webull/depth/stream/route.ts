import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * SSE pass-through for the live order book (backend `routers/webull.py`,
 * `/api/webull/depth/stream`).
 *
 * `request.signal` goes to the upstream fetch so a closed panel closes the
 * backend stream too — that is what releases the Webull subscription, and the
 * backend hangs up on Webull 20 s after the last one is gone.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const qs = new URLSearchParams();
  for (const k of ["symbol", "depth", "overnight"]) {
    const v = searchParams.get(k);
    if (v) qs.set(k, v);
  }
  try {
    const res = await fetch(`${PYTHON_API}/api/webull/depth/stream?${qs}`, {
      signal: request.signal,
      cache: "no-store",
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      return NextResponse.json(body, { status: res.status });
    }
    return new Response(res.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
