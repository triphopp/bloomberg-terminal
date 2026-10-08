import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

// The one calendar (backend/routers/calendar_feed.py). Read-only: what the
// user adds goes through the theses / questions proxies.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const qs = searchParams.toString();
    const r = await fetch(`${API}/api/calendar${qs ? `?${qs}` : ""}`, {
      signal: AbortSignal.timeout(30_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[calendar GET]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
