import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

/**
 * VIX-family volatility indices for the TICK DATA board.
 *
 * Cached just under the Python side's 60s TTL, same as /api/market-data — these
 * are calculated indices that print continuously but are never worth a request
 * per render.
 */
let dataCache: { data: object; ts: number } | null = null;
const CACHE_TTL = 55_000;

export async function GET() {
  if (dataCache && Date.now() - dataCache.ts < CACHE_TTL) {
    return NextResponse.json(dataCache.data);
  }

  try {
    const res = await fetch(`${PYTHON_API}/api/volatility`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Python API ${res.status}`);
    const data = await res.json();
    dataCache = { data, ts: Date.now() };
    return NextResponse.json(data);
  } catch (err) {
    console.error("[volatility] Python backend unavailable:", err);
    // No static fallback: a stale VIX is worse than an empty section, since the
    // whole point of the row is telling the user what fear is priced at NOW.
    return NextResponse.json({ items: [], error: "backend unavailable" }, { status: 200 });
  }
}
