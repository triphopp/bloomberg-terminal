import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// GET /api/polymarket/stocks?symbols=MU,TSLA → per-symbol implied summaries (watchlist row)
export async function GET(req: NextRequest) {
  const symbols = req.nextUrl.searchParams.get("symbols") ?? "";
  if (!symbols.trim()) return NextResponse.json({ summaries: {} });

  try {
    const res = await fetch(
      `${PYTHON_API}/api/polymarket/stocks?symbols=${encodeURIComponent(symbols)}`,
      { cache: "no-store", signal: AbortSignal.timeout(45_000) }
    );
    if (!res.ok) {
      return NextResponse.json(
        { summaries: {}, error: `Backend ${res.status}` },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[polymarket/stocks]", err);
    return NextResponse.json({ summaries: {}, error: "Backend unavailable" }, { status: 503 });
  }
}
