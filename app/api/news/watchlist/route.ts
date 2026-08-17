import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

const EMPTY = { articles: [], symbols: [], sectors: [], markets: [], errors: [] };

// GET /api/news/watchlist?symbols=AAPL,MSFT&per_symbol=6&sources=all&polymarket=1
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const symbols = searchParams.get("symbols") ?? "";
  if (!symbols.trim()) return NextResponse.json(EMPTY);

  const qs = new URLSearchParams({ symbols });
  for (const key of ["per_symbol", "per_source", "sources", "polymarket"]) {
    const v = searchParams.get(key);
    if (v) qs.set(key, v);
  }

  try {
    const res = await fetch(`${PYTHON_API}/api/news/watchlist?${qs.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { ...EMPTY, error: `Backend ${res.status}`, detail },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[news/watchlist]", err);
    return NextResponse.json({ ...EMPTY, error: "Backend unavailable" }, { status: 503 });
  }
}
