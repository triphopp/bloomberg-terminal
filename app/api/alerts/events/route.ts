import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API as API } from "@/lib/constants";

export async function GET(req: NextRequest) {
  try {
    const qs = req.nextUrl.searchParams.toString();
    const r = await fetch(`${API}/api/alerts/events${qs ? `?${qs}` : ""}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[alerts/events GET]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
