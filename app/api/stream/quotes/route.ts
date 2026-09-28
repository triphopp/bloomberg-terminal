import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * SSE pass-through for live quotes (backend `routers/stream.py`).
 *
 * `request.signal` goes to the upstream fetch so a closed browser tab closes
 * the backend stream too — the backend releases its Yahoo subscriptions on
 * disconnect, and without this they would pile up until the socket timed out.
 */
export async function GET(request: Request) {
  // symbols / focus / mounted (priority tiers) and session pass through as sent.
  const { searchParams } = new URL(request.url);
  const qs = new URLSearchParams();
  for (const k of ["symbols", "focus", "mounted", "session"]) {
    const v = searchParams.get(k);
    if (v) qs.set(k, v);
  }
  try {
    const res = await fetch(`${PYTHON_API}/api/stream/quotes?${qs}`, {
      signal: request.signal,
      cache: "no-store",
    });
    if (!res.ok || !res.body) {
      return NextResponse.json({ error: `Backend ${res.status}` }, { status: res.status });
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
