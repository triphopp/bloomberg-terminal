import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

/**
 * Quotes for the rows a user added to the TICK DATA board (custom sections).
 * Same row shape as /api/market-data. No static fallback and no cache here:
 * the symbol set is the user's and changes as they edit; the backend caches
 * each set for its quote TTL.
 */
export async function GET(request: Request) {
  const symbols = new URL(request.url).searchParams.get("symbols") ?? "";
  if (!symbols.trim()) return NextResponse.json({ items: [], missing: [] });
  try {
    const res = await fetch(
      `${PYTHON_API}/api/tick-custom?symbols=${encodeURIComponent(symbols)}`,
      { cache: "no-store", signal: AbortSignal.timeout(20_000) }
    );
    if (!res.ok) throw new Error(`Python API ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[tick-custom] Python backend unavailable:", err);
    return NextResponse.json({ items: [], missing: [], error: "backend unavailable" });
  }
}
