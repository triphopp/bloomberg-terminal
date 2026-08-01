import { NextResponse } from "next/server";

import { PYTHON_API as API } from "@/lib/constants";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const r = await fetch(`${API}/api/alerts/rules/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Preview fetches a full history batch for every scope symbol — same
      // budget as the watchlist signals scan.
      signal: AbortSignal.timeout(45_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[alerts/rules/preview POST]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
