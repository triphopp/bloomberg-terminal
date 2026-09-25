import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

/**
 * One whole equity market by sector (HMAP view / `heatmap(MARKET)` command).
 * The Python side caches 90s, negative-caches failures and falls back to the
 * last good map, so no cache is needed here.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const market = u.searchParams.get("market") ?? "US";
  const per = u.searchParams.get("per") ?? "25";
  try {
    const res = await fetch(
      `${PYTHON_API}/api/market-heatmap?market=${encodeURIComponent(market)}&per=${encodeURIComponent(per)}`,
      { cache: "no-store", signal: AbortSignal.timeout(20_000) }
    );
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json({ tiles: [], error: data?.detail ?? `backend ${res.status}` });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ tiles: [], error: "backend unavailable" });
  }
}
