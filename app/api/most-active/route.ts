import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

/**
 * US stocks with the most shares traded today (Yahoo `most_actives` screener)
 * for the MKT left panel ACTIVE tab. The Python side caches 2 min and
 * negative-caches failures, so no cache is needed here.
 */
export async function GET(req: Request) {
  const count = new URL(req.url).searchParams.get("count") ?? "30";
  try {
    const res = await fetch(`${PYTHON_API}/api/most-active?count=${encodeURIComponent(count)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Python API ${res.status}`);
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ items: [], error: "backend unavailable" }, { status: 200 });
  }
}
