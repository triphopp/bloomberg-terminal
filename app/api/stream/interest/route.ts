import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

/**
 * Change what a quote-stream session watches (backend `routers/stream.py`
 * `POST /api/stream/interest`). Status passes through: 404 = unknown or
 * expired session, and the client reopens its stream.
 */
export async function POST(request: Request) {
  try {
    const res = await fetch(`${PYTHON_API}/api/stream/interest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
