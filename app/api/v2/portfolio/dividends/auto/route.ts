import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

// Auto-dividend status + dry-run preview (backend/dividend_auto.py).
// Own folder: a GET here would otherwise not exist under dividends/[id] (PUT/DELETE only).
export async function GET() {
  try {
    const r = await fetch(`${API}/api/v2/portfolio/dividends/auto`, {
      signal: AbortSignal.timeout(60_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/dividends/auto GET]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
