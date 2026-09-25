import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

/** Most-searched symbols, top N by count (MKT left panel FREQ tab). */
export async function GET(req: Request) {
  const limit = new URL(req.url).searchParams.get("limit") ?? "30";
  try {
    const res = await fetch(
      `${PYTHON_API}/api/search-stats/top?limit=${encodeURIComponent(limit)}`,
      { cache: "no-store", signal: AbortSignal.timeout(5_000) }
    );
    if (!res.ok) throw new Error(`Python API ${res.status}`);
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ items: [], error: "backend unavailable" }, { status: 200 });
  }
}
