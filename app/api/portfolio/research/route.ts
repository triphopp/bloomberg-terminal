import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const res = await fetch(`${PYTHON_API}/api/portfolio/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // No AbortSignal timeout — SSE stream can be long
    });
    if (!res.ok || !res.body) {
      return NextResponse.json({ error: `Backend ${res.status}` }, { status: res.status });
    }
    // Pass the SSE stream through unchanged
    return new Response(res.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    console.error("[portfolio/research]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
