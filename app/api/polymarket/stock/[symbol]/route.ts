import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// GET /api/polymarket/stock/MU?company=Micron → live price-ladder markets for one ticker
export async function GET(req: NextRequest, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const company = req.nextUrl.searchParams.get("company") ?? "";
  const qs = company ? `?company=${encodeURIComponent(company)}` : "";

  try {
    const res = await fetch(
      `${PYTHON_API}/api/polymarket/stock/${encodeURIComponent(symbol)}${qs}`,
      { cache: "no-store", signal: AbortSignal.timeout(30_000) }
    );
    if (!res.ok) {
      return NextResponse.json(
        { symbol, events: [], summary: {}, error: `Backend ${res.status}` },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[polymarket/stock]", err);
    return NextResponse.json(
      { symbol, events: [], summary: {}, error: "Backend unavailable" },
      { status: 503 }
    );
  }
}
